import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { logger, type Logger } from '../log/logger.ts';

/**
 * Development only. A dev build on a USB phone (or an emulator) loads its JavaScript from Metro over
 * `adb reverse` and calls the API at localhost:<port> on the device itself. That only works while adb
 * forwards the port to this computer, and adb drops every forward when the phone is replugged or adb
 * restarts. This keeps `adb reverse tcp:<port> tcp:<port>` in place for every connected device.
 *
 * It never starts adb's own server: that belongs to Expo, Android Studio or whoever ran adb. (Any adb
 * command starts one when none is running, and the start dies with the command when the command is
 * killed by a timeout or by `node --watch` restarting this process.) So each pass first checks that the
 * server is listening and otherwise waits for it.
 */

/** Runs adb with arguments (never through a shell) and resolves with its stdout. */
export type AdbExec = (adb: string, args: readonly string[]) => Promise<string>;

export interface AdbDevice {
  serial: string;
  /** "device" when usable; also "unauthorized", "offline", … */
  state: string;
  /** From `adb devices -l`, e.g. "RMX3171" or "Pixel 7". */
  model: string | null;
}

export interface AdbReverse {
  /** One pass over the connected devices. Never rejects; a pass already running is shared, not repeated. */
  check(): Promise<void>;
  /** True once adb turned out not to be installed: there's nothing more to do. */
  readonly gaveUp: boolean;
}

export interface AdbReverseOptions {
  /** The API's port: the device's tcp:<port> goes to this computer's tcp:<port>. */
  port: number;
  /** The adb binary; see findAdb(). */
  adb?: string;
  exec?: AdbExec;
  /** Whether adb's server is up; see adbServerRunning(). */
  serverRunning?: () => Promise<boolean>;
  log?: Logger;
}

const CHECK_EVERY_MS = 10_000;
/** Generous: a pass that takes long only delays the next one, but a killed adb command can take a server start down with it. */
const ADB_TIMEOUT_MS = 15_000;
/** "FM45SGHATWCQSOJR", "emulator-5554", "192.168.1.20:5555", "adb-R58M…._adb-tls-connect._tcp". */
const SERIAL = /^[\w.:][\w.:-]{0,127}$/;
const PORT_SPEC = /^[a-z]+:\S+$/;

/** The devices in `adb devices -l` output, in any state. */
export function parseDevices(stdout: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('List of devices') || line.startsWith('*')) continue;
    const [serial, state, ...details] = line.split(/\s+/);
    if (!serial || !state || !SERIAL.test(serial) || !/^[a-z]+$/.test(state)) continue;
    const model = details.find((detail) => detail.startsWith('model:'))?.slice('model:'.length).replaceAll('_', ' ');
    devices.push({ serial, state, model: model || null });
  }
  return devices;
}

/** Device side → computer side, from `adb reverse --list` ("UsbFfs tcp:8081 tcp:8081"). */
export function parseReverseList(stdout: string): Map<string, string> {
  const forwards = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const [onDevice, onComputer] = line.trim().split(/\s+/).slice(-2);
    if (onDevice && onComputer && PORT_SPEC.test(onDevice) && PORT_SPEC.test(onComputer)) forwards.set(onDevice, onComputer);
  }
  return forwards;
}

/**
 * Where adb is: ADB_PATH, then the SDK in ANDROID_HOME / ANDROID_SDK_ROOT, then the SDK's default
 * location, else "adb" on PATH. The SDK copy comes first, as Expo uses it: two different adb versions
 * restart each other's server, which drops every forward.
 */
export function findAdb(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = existsSync,
  home: string = homedir()
): string {
  const explicit = env.ADB_PATH?.trim();
  if (explicit) return explicit;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const defaultSdk =
    platform === 'win32'
      ? env.LOCALAPPDATA && paths.join(env.LOCALAPPDATA, 'Android', 'Sdk')
      : platform === 'darwin'
        ? paths.join(home, 'Library', 'Android', 'sdk')
        : paths.join(home, 'Android', 'Sdk');
  for (const sdk of [env.ANDROID_HOME?.trim(), env.ANDROID_SDK_ROOT?.trim(), defaultSdk]) {
    if (!sdk) continue;
    const candidate = paths.join(sdk, 'platform-tools', platform === 'win32' ? 'adb.exe' : 'adb');
    if (exists(candidate)) return candidate;
  }
  return 'adb';
}

/** Whether adb's server is listening (127.0.0.1:5037, or ANDROID_ADB_SERVER_PORT), without starting one. */
export function adbServerRunning(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  // A custom server socket (another host, say) is adb's business: let adb find it.
  if (env.ADB_SERVER_SOCKET?.trim()) return Promise.resolve(true);
  const port = Number.parseInt(env.ANDROID_ADB_SERVER_PORT ?? '', 10) || 5037;
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** adb through execFile: no shell, a timeout, no console window on Windows. */
export const runAdb: AdbExec = (adb, args) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, stdout = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(stdout);
    };
    // Starting adb's server can leave the pipes open past the exit; don't wait on that either.
    const deadline = setTimeout(() => finish(new Error(`adb ${args.join(' ')} took over ${ADB_TIMEOUT_MS / 1000} s`)), ADB_TIMEOUT_MS + 1_000);
    deadline.unref();
    execFile(adb, [...args], { timeout: ADB_TIMEOUT_MS, windowsHide: true, maxBuffer: 256 * 1024, encoding: 'utf8' }, (error, stdout) =>
      finish(error, stdout)
    );
  });

/** The useful line of an adb failure: its stderr ("adb: error: …") or the error message. */
function reasonOf(error: unknown): string {
  const { stderr, message } = (error ?? {}) as { stderr?: unknown; message?: unknown };
  const text = (typeof stderr === 'string' && stderr.trim()) || String(message ?? error);
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? 'unknown error';
}

export function createAdbReverse({
  port,
  adb = findAdb(),
  exec = runAdb,
  serverRunning = adbServerRunning,
  log = logger('adb'),
}: AdbReverseOptions): AdbReverse {
  const spec = `tcp:${port}`;
  /** Devices whose forward was in place at the last pass. */
  const reachable = new Set<string>();
  /** Devices already warned about, until they disconnect or work. */
  const warned = new Set<string>();
  let installed = false;
  let serverDown = false;
  let listingFails = false;
  let gaveUp = false;
  let inFlight: Promise<void> | null = null;

  const warnOnce = (serial: string, message: string, fields: Record<string, unknown>) => {
    if (warned.has(serial)) return;
    warned.add(serial);
    log.warn(message, fields);
  };

  const announce = ({ serial, model }: AdbDevice) => {
    reachable.add(serial);
    warned.delete(serial);
    log.info('Phone can reach the API over USB', { serial, model: model ?? undefined, api: `localhost:${port}` });
  };

  async function ensure(device: AdbDevice) {
    const { serial, model } = device;
    try {
      const onComputer = parseReverseList(await exec(adb, ['-s', serial, 'reverse', '--list'])).get(spec);
      if (onComputer === spec) {
        if (!reachable.has(serial)) announce(device);
        return;
      }
      reachable.delete(serial);
      if (onComputer) {
        // Someone forwarded the port somewhere else on purpose; don't take it over.
        warnOnce(serial, `Port ${port} on the phone goes to ${onComputer} on this computer, not to this API; leaving it`, {
          serial,
          model: model ?? undefined,
          fix: `adb -s ${serial} reverse ${spec} ${spec}`,
        });
        return;
      }
      await exec(adb, ['-s', serial, 'reverse', spec, spec]);
      announce(device);
    } catch (error) {
      reachable.delete(serial);
      warnOnce(serial, 'Couldn’t forward the API port to the phone over USB', {
        serial,
        model: model ?? undefined,
        reason: reasonOf(error),
        fix: `adb -s ${serial} reverse ${spec} ${spec}`,
      });
    }
  }

  async function pass() {
    if (!installed) {
      try {
        // Only prints adb's version; it doesn't touch adb's server.
        await exec(adb, ['version']);
        installed = true;
      } catch (error) {
        gaveUp = true;
        const missing = (error as { code?: unknown } | null)?.code === 'ENOENT';
        log.info(`adb ${missing ? 'isn’t installed' : 'doesn’t run'}, so USB phones need \`adb reverse ${spec} ${spec}\` by hand`, {
          tried: adb,
          reason: missing ? undefined : reasonOf(error),
          fix: 'install Android platform-tools or set ADB_PATH',
        });
        return;
      }
    }

    if (!(await serverRunning())) {
      // Every forward went with the server; they are set up again once it is back.
      if (!serverDown) log.debug('adb server isn’t running; USB phones are set up once it is', {});
      serverDown = true;
      reachable.clear();
      warned.clear();
      return;
    }
    serverDown = false;

    let listed: string;
    try {
      listed = await exec(adb, ['devices', '-l']);
    } catch (error) {
      if (!listingFails) log.debug('adb devices failed; trying again every 10 s', { reason: reasonOf(error) });
      listingFails = true;
      return;
    }
    listingFails = false;

    const devices = parseDevices(listed).filter((device) => device.state === 'device');
    const present = new Set(devices.map((device) => device.serial));
    for (const serial of reachable) {
      if (present.has(serial)) continue;
      reachable.delete(serial);
      log.debug('Phone disconnected', { serial });
    }
    for (const serial of warned) if (!present.has(serial)) warned.delete(serial);
    for (const device of devices) await ensure(device);
  }

  return {
    check() {
      if (gaveUp) return Promise.resolve();
      inFlight ??= pass()
        .catch((error: unknown) => log.debug('adb check failed', { reason: reasonOf(error) }))
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    get gaveUp() {
      return gaveUp;
    },
  };
}

/** Checks now and every 10 s until stopped (or until adb turns out to be missing). The timer never keeps Node alive. */
export function startAdbReverse({ intervalMs = CHECK_EVERY_MS, ...options }: AdbReverseOptions & { intervalMs?: number }): { stop(): void } {
  const usb = createAdbReverse(options);
  const tick = () =>
    void usb.check().then(() => {
      if (usb.gaveUp) clearInterval(timer);
    });
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return { stop: () => clearInterval(timer) };
}
