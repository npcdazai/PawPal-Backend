import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createAdbReverse, findAdb, parseDevices, parseReverseList, startAdbReverse } from '../src/dev/adbReverse.ts';
import type { Logger } from '../src/log/logger.ts';

const DEVICES = `* daemon not running; starting now at tcp:5037
* daemon started successfully
List of devices attached
FM45SGHATWCQSOJR       device product:RMX3171 model:RMX3171 device:RMX3171 transport_id:5
emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:2
192.168.1.20:5555      offline transport_id:3
R58M12ABCDE            unauthorized usb:1-1 transport_id:4
-rf                    device
`;

describe('adb output', () => {
  test('devices: serial, state and model; daemon lines and odd serials skipped', () => {
    assert.deepEqual(parseDevices(DEVICES), [
      { serial: 'FM45SGHATWCQSOJR', state: 'device', model: 'RMX3171' },
      { serial: 'emulator-5554', state: 'device', model: 'sdk gphone64 x86 64' },
      { serial: '192.168.1.20:5555', state: 'offline', model: null },
      { serial: 'R58M12ABCDE', state: 'unauthorized', model: null },
    ]);
    // Plain `adb devices` (tab-separated, no details) and nothing attached.
    assert.deepEqual(parseDevices('List of devices attached\r\nFM45SGHATWCQSOJR\tdevice\r\n\r\n'), [
      { serial: 'FM45SGHATWCQSOJR', state: 'device', model: null },
    ]);
    assert.deepEqual(parseDevices('List of devices attached\n\n'), []);
  });

  test('reverse --list: device side to computer side, old and new formats', () => {
    const forwards = parseReverseList('UsbFfs tcp:8081 tcp:8081\r\nUsbFfs tcp:4000 tcp:4000\r\n(reverse) localabstract:x tcp:9000\n\n');
    assert.deepEqual([...forwards], [
      ['tcp:8081', 'tcp:8081'],
      ['tcp:4000', 'tcp:4000'],
      ['localabstract:x', 'tcp:9000'],
    ]);
    assert.equal(parseReverseList('').size, 0);
  });

  test('finding adb: ADB_PATH, the SDK variables, the default SDK, then PATH', () => {
    const none = () => false;
    const only = (file: string) => (candidate: string) => candidate === file;
    assert.equal(findAdb({ ADB_PATH: 'D:\\tools\\adb.exe', ANDROID_HOME: 'C:\\Sdk' }, 'win32', () => true), 'D:\\tools\\adb.exe');
    assert.equal(findAdb({ ANDROID_HOME: 'C:\\Sdk' }, 'win32', only('C:\\Sdk\\platform-tools\\adb.exe')), 'C:\\Sdk\\platform-tools\\adb.exe');
    assert.equal(
      findAdb({ ANDROID_HOME: '/missing', ANDROID_SDK_ROOT: '/opt/sdk' }, 'linux', only('/opt/sdk/platform-tools/adb')),
      '/opt/sdk/platform-tools/adb'
    );
    const local = 'C:\\Users\\asha\\AppData\\Local';
    assert.equal(findAdb({ LOCALAPPDATA: local }, 'win32', only(`${local}\\Android\\Sdk\\platform-tools\\adb.exe`)), `${local}\\Android\\Sdk\\platform-tools\\adb.exe`);
    assert.equal(
      findAdb({}, 'darwin', only('/Users/asha/Library/Android/sdk/platform-tools/adb'), '/Users/asha'),
      '/Users/asha/Library/Android/sdk/platform-tools/adb'
    );
    assert.equal(findAdb({}, 'linux', only('/home/asha/Android/Sdk/platform-tools/adb'), '/home/asha'), '/home/asha/Android/Sdk/platform-tools/adb');
    assert.equal(findAdb({ ANDROID_HOME: 'C:\\Sdk' }, 'win32', none), 'adb');
  });
});

/** A pretend adb: answers from `devices` and `reverses`, records every call. */
function fakeAdb(initial: { devices?: string; reverses?: Record<string, string> } = {}) {
  const state = {
    devices: initial.devices ?? 'List of devices attached\nFM45SGHATWCQSOJR       device model:RMX3171\n',
    reverses: { ...initial.reverses } as Record<string, string>,
    failReverse: false,
    missing: false,
    serverUp: true,
    calls: [] as string[],
  };
  const exec = async (_adb: string, args: readonly string[]) => {
    state.calls.push(args.join(' '));
    if (state.missing) throw Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' });
    if (args[0] === 'version') return 'Android Debug Bridge version 1.0.41\n';
    if (args[0] === 'devices') return state.devices;
    const serial = args[1] ?? '';
    if (args[3] === '--list') return state.reverses[serial] ?? '';
    if (state.failReverse) throw Object.assign(new Error('Command failed'), { stderr: 'adb.exe: error: cannot bind listener: Address in use\n' });
    state.reverses[serial] = `${state.reverses[serial] ?? ''}UsbFfs ${args[3]} ${args[4]}\n`;
    return '';
  };
  const lines: { level: string; message: string; fields: Record<string, unknown> }[] = [];
  const at = (level: string) => (message: string, fields: Record<string, unknown> = {}) => void lines.push({ level, message, fields });
  const log: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
  const usb = createAdbReverse({ port: 4000, adb: 'adb', exec, serverRunning: async () => state.serverUp, log });
  return { state, usb, lines, exec, log };
}

describe('adb reverse loop', () => {
  test('adds the missing forward and says so once', async () => {
    const { state, usb, lines } = fakeAdb({ reverses: { FM45SGHATWCQSOJR: 'UsbFfs tcp:8081 tcp:8081\n' } });
    await usb.check();
    assert.ok(state.calls.includes('-s FM45SGHATWCQSOJR reverse tcp:4000 tcp:4000'));
    assert.deepEqual(lines, [
      { level: 'info', message: 'Phone can reach the API over USB', fields: { serial: 'FM45SGHATWCQSOJR', model: 'RMX3171', api: 'localhost:4000' } },
    ]);
    state.calls.length = 0;
    await usb.check();
    assert.deepEqual(state.calls, ['devices -l', '-s FM45SGHATWCQSOJR reverse --list']);
    assert.equal(lines.length, 1);
  });

  test('a forward already in place is left alone; offline and unauthorized devices are skipped', async () => {
    const { state, usb, lines } = fakeAdb({ devices: DEVICES, reverses: { FM45SGHATWCQSOJR: 'UsbFfs tcp:4000 tcp:4000\n' } });
    await usb.check();
    assert.deepEqual(state.calls, [
      'version',
      'devices -l',
      '-s FM45SGHATWCQSOJR reverse --list',
      '-s emulator-5554 reverse --list',
      '-s emulator-5554 reverse tcp:4000 tcp:4000',
    ]);
    assert.deepEqual(
      lines.map((line) => [line.message, line.fields.serial]),
      [
        ['Phone can reach the API over USB', 'FM45SGHATWCQSOJR'],
        ['Phone can reach the API over USB', 'emulator-5554'],
      ]
    );
  });

  test('a phone that leaves and comes back is set up again', async () => {
    const { state, usb, lines } = fakeAdb();
    await usb.check();
    state.devices = 'List of devices attached\n\n';
    state.reverses = {}; // unplugging drops the forwards
    await usb.check();
    assert.deepEqual(lines.at(-1), { level: 'debug', message: 'Phone disconnected', fields: { serial: 'FM45SGHATWCQSOJR' } });
    state.devices = 'List of devices attached\nFM45SGHATWCQSOJR       device model:RMX3171\n';
    await usb.check();
    assert.equal(lines.filter((line) => line.message === 'Phone can reach the API over USB').length, 2);
    assert.equal(state.calls.filter((call) => call.endsWith('reverse tcp:4000 tcp:4000')).length, 2);
  });

  test('a failing reverse warns once per device, without throwing', async () => {
    const { state, usb, lines } = fakeAdb();
    state.failReverse = true;
    await usb.check();
    await usb.check();
    const warnings = lines.filter((line) => line.level === 'warn');
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0]?.fields, {
      serial: 'FM45SGHATWCQSOJR',
      model: 'RMX3171',
      reason: 'adb.exe: error: cannot bind listener: Address in use',
      fix: 'adb -s FM45SGHATWCQSOJR reverse tcp:4000 tcp:4000',
    });
    state.failReverse = false;
    await usb.check();
    assert.equal(lines.at(-1)?.message, 'Phone can reach the API over USB');
  });

  test('a port forwarded elsewhere on purpose is not taken over', async () => {
    const { state, usb, lines } = fakeAdb({ reverses: { FM45SGHATWCQSOJR: 'UsbFfs tcp:4000 tcp:4100\n' } });
    await usb.check();
    await usb.check();
    assert.ok(!state.calls.some((call) => call.endsWith('reverse tcp:4000 tcp:4000')));
    assert.deepEqual(
      lines.map((line) => [line.level, line.message]),
      [['warn', 'Port 4000 on the phone goes to tcp:4100 on this computer, not to this API; leaving it']]
    );
  });

  test('never starts adb’s server: waits while it is down, then sets phones up again', async () => {
    const { state, usb, lines } = fakeAdb();
    await usb.check();
    state.serverUp = false;
    state.reverses = {};
    state.calls.length = 0;
    await usb.check();
    await usb.check();
    assert.equal(state.calls.length, 0, 'adb ran while its server was down');
    assert.equal(lines.filter((line) => line.message.startsWith('adb server isn’t running')).length, 1);
    state.serverUp = true;
    await usb.check();
    assert.ok(state.calls.includes('-s FM45SGHATWCQSOJR reverse tcp:4000 tcp:4000'));
    assert.equal(lines.filter((line) => line.message === 'Phone can reach the API over USB').length, 2);
  });

  test('without adb: one hint, then it stops asking', async () => {
    const { state, usb, lines } = fakeAdb();
    state.missing = true;
    await usb.check();
    await usb.check();
    assert.equal(state.calls.length, 1);
    assert.equal(usb.gaveUp, true);
    assert.deepEqual(lines, [
      {
        level: 'info',
        message: 'adb isn’t installed, so USB phones need `adb reverse tcp:4000 tcp:4000` by hand',
        fields: { tried: 'adb', reason: undefined, fix: 'install Android platform-tools or set ADB_PATH' },
      },
    ]);
  });

  test('passes never overlap, and the timer stops', async () => {
    const { state, exec, log } = fakeAdb();
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = async (adb: string, args: readonly string[]) => {
      if (args[0] === 'devices') await gate;
      return exec(adb, args);
    };
    const usb = createAdbReverse({ port: 4000, adb: 'adb', exec: slow, serverRunning: async () => true, log });
    const first = usb.check();
    const second = usb.check();
    assert.equal(first, second);
    release();
    await first;
    assert.equal(state.calls.filter((call) => call === 'devices -l').length, 1);

    const listings = () => state.calls.filter((call) => call === 'devices -l').length;
    const before = listings();
    const loop = startAdbReverse({ port: 4000, adb: 'adb', exec, serverRunning: async () => true, log, intervalMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    loop.stop();
    const counted = state.calls.length;
    assert.ok(listings() - before >= 2, `only ${listings() - before} passes`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(state.calls.length, counted);
  });
});
