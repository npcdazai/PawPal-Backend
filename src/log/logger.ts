import { itemCount, moreKeys, redact } from './redact.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface LogSettings {
  /** The lowest level printed; 'silent' prints nothing. */
  level: LogLevel | 'silent';
  /** 'pretty': coloured, aligned lines for people. 'json': one object per line for log collectors. */
  format: 'pretty' | 'json';
  /** Bodies on request lines: 'off', 'changes' (everything except successful reads) or 'all'. */
  bodies: 'off' | 'changes' | 'all';
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const RANK: Record<LogSettings['level'], number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const detectColor = () => !process.env.NO_COLOR && (Boolean(process.env.FORCE_COLOR) || process.stdout.isTTY === true);

let settings: LogSettings = {
  // `node --test` sets NODE_TEST_CONTEXT in every test process, so test output stays clean.
  level: process.env.NODE_TEST_CONTEXT ? 'silent' : 'info',
  format: 'pretty',
  bodies: 'off',
};
let sink: ((line: string) => void) | null = null;
let color = detectColor();
/** The last line, when it was a repeatable read (an app polling): repeats rewrite it with a count. */
let lastPoll: { key: string; count: number } | null = null;

/** Applies the LOG_* settings. `write` captures lines instead of printing them (tests). */
export function configureLogging(next: Partial<LogSettings>, write?: (line: string) => void) {
  settings = { ...settings, ...next };
  sink = write ?? null;
  color = !write && detectColor();
  lastPoll = null;
}

export const logSettings = (): Readonly<LogSettings> => settings;

/** A time as people in India read it: "25 Oct 2026, 7:30 am". */
export const istTime = (ms: number) =>
  new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

/** A named logger: `logger('dispatch').info('Offered to walker', { booking, walker, km })`. */
export function logger(scope: string): Logger {
  const at = (level: LogLevel) => (message: string, fields: LogFields = {}) => emit(level, scope, message, fields);
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** The startup box: where the server listens and how it's configured. */
export function logBanner(title: string, rows: ReadonlyArray<readonly [string, string]>) {
  if (RANK.info < RANK[settings.level]) return;
  if (settings.format === 'json') {
    write(JSON.stringify({ time: new Date().toISOString(), level: 'info', scope: 'server', msg: title, ...Object.fromEntries(rows) }));
    return;
  }
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const width = Math.max(title.length, ...rows.map(([, value]) => labelWidth + 2 + value.length)) + 4;
  const row = (plain: string, painted = plain) => `${gray('│')}  ${painted}${' '.repeat(width - 2 - plain.length)}${gray('│')}`;
  print([
    gray(`╭${'─'.repeat(width)}╮`),
    row(title, bold(title)),
    gray(`├${'─'.repeat(width)}┤`),
    ...rows.map(([label, value]) => row(`${label.padEnd(labelWidth)}  ${value}`, `${gray(label.padEnd(labelWidth))}  ${value}`)),
    gray(`╰${'─'.repeat(width)}╯`),
  ]);
}

function emit(level: LogLevel, scope: string, message: string, fields: LogFields) {
  if (RANK[level] < RANK[settings.level]) return;
  const time = new Date();
  const clean = redact(fields) as LogFields;
  if (settings.format === 'json') {
    write(JSON.stringify({ time: time.toISOString(), level, scope, msg: message, ...clean }));
  } else if (scope === 'http' && typeof clean.status === 'number') {
    const { lines, poll } = requestLines(time, clean);
    print(lines, poll);
  } else {
    print(eventLines(level, scope, message, clean, time));
  }
}

// ── Output ──────────────────────────────────────────────────────────────────

const write = (line: string) => (sink ? sink(line) : process.stdout.write(`${line}\n`));

const ANSI = /\x1b\[[0-9;]*m/g;

function print(lines: string[], pollKey?: string) {
  const [first = ''] = lines;
  const fits = first.replace(ANSI, '').length + 6 < (process.stdout.columns ?? 80);
  if (pollKey && lastPoll?.key === pollKey && !sink && process.stdout.isTTY && fits) {
    lastPoll.count += 1;
    process.stdout.write(`\x1b[1A\x1b[2K${first}${gray(` ×${lastPoll.count}`)}\n`);
    return;
  }
  for (const line of lines) write(line);
  lastPoll = pollKey ? { key: pollKey, count: 1 } : null;
}

// ── Pretty format ───────────────────────────────────────────────────────────

const paint = (code: number) => (text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = paint(1);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);
const blue = paint(34);
const magenta = paint(35);
const cyan = paint(36);
const gray = paint(90);

const SCOPE_COLOR: Record<string, (text: string) => string> = {
  http: blue,
  server: magenta,
  auth: cyan,
  booking: green,
  dispatch: yellow,
  partner: yellow,
  payment: magenta,
  pack: green,
  push: cyan,
  kyc: magenta,
  face: magenta,
  vlm: magenta,
  maps: gray,
  weather: gray,
  db: gray,
  adb: green,
};

const MARK: Record<LogLevel, () => string> = {
  debug: () => gray('·'),
  info: () => cyan('●'),
  warn: () => yellow('▲'),
  error: () => red('✖'),
};

const METHOD_COLOR: Record<string, (text: string) => string> = {
  GET: cyan,
  HEAD: cyan,
  OPTIONS: gray,
  POST: green,
  PUT: yellow,
  PATCH: yellow,
  DELETE: red,
};

/** Detail lines start under the message: "HH:MM:SS.mmm ● scope    ". */
const GUTTER = ' '.repeat(24);

const two = (n: number) => String(n).padStart(2, '0');
const clock = (time: Date) =>
  `${two(time.getHours())}:${two(time.getMinutes())}:${two(time.getSeconds())}.${String(time.getMilliseconds()).padStart(3, '0')}`;

const head = (time: Date, mark: string, scope: string) =>
  `${gray(clock(time))} ${mark} ${(SCOPE_COLOR[scope] ?? bold)(scope.padEnd(8))} `;

/** Ids print as their first 8 characters (JSON keeps them whole); order ids keep their attempt number. */
const UUID = /^([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-\d+)?$/i;
const shortId = (text: string) => text.replace(UUID, (_match, start: string, attempt?: string) => `${start}…${attempt ?? ''}`);
const shortIdsIn = (path: string) => path.replace(/([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '$1…');

/** Replies on request lines stay short: 8 keys per object, two levels deep (JSON lines keep them whole). */
function brief(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) {
    if (depth >= 2) return itemCount(value.length);
    const shown = value.slice(0, 3).map((item) => brief(item, depth + 1));
    return value.length > 3 ? [...shown, `… ${value.length - 3} more`] : shown;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 2) return '<…>';
  // redact() may already have left keys out and said how many under "…".
  const { '…': leftOut, ...rest } = value as Record<string, unknown>;
  const entries = Object.entries(rest).filter(([, item]) => item !== undefined);
  const out: Record<string, unknown> = Object.fromEntries(entries.slice(0, 8).map(([key, item]) => [key, brief(item, depth + 1)]));
  const hidden = Math.max(0, entries.length - 8) + (Number.parseInt(String(leftOut ?? 0), 10) || 0);
  if (hidden > 0) out['…'] = moreKeys(hidden);
  return out;
}

/** What redact() put in place of a value: shown grey and unquoted. */
const PLACEHOLDER = /^(\[hidden\]|<.*>|… \d+ more.*)$/;

function scalar(value: unknown): string {
  if (typeof value === 'number') return yellow(String(value));
  if (typeof value === 'boolean') return magenta(String(value));
  if (value === null) return gray('null');
  const text = shortId(String(value));
  if (PLACEHOLDER.test(text)) return gray(text);
  return /\s/.test(text) ? `"${text}"` : text;
}

function render(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(render).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    const parts = entries.map(([key, item]) => (key === '…' ? gray(`…${String(item)}`) : `${gray(key)}: ${render(item)}`));
    return parts.length ? `{ ${parts.join(', ')} }` : '{}';
  }
  if (typeof value === 'string') return PLACEHOLDER.test(value) ? gray(value) : green(`"${shortId(value)}"`);
  return scalar(value);
}

const detail = (key: string, value: unknown) => `${GUTTER}${gray(`↳ ${key.padEnd(5)}`)} ${render(value)}`;

function errorLines(error: unknown): string[] {
  const view = (error !== null && typeof error === 'object' ? error : { message: String(error) }) as {
    name?: unknown;
    message?: unknown;
    stack?: unknown;
  };
  const frames =
    typeof view.stack === 'string'
      ? view.stack
          .split('\n')
          .map((frame) => frame.trim())
          .filter((frame) => frame.startsWith('at ') && !frame.includes('node:internal') && !frame.includes('node_modules'))
          .slice(0, 6)
      : [];
  return [
    `${GUTTER}${red(`${String(view.name ?? 'Error')}: ${String(view.message ?? '')}`)}`,
    ...frames.map((frame) => `${GUTTER}  ${gray(frame)}`),
  ];
}

function eventLines(level: LogLevel, scope: string, message: string, fields: LogFields, time: Date): string[] {
  const { error, ...rest } = fields;
  const inline: string[] = [];
  const blocks: string[] = [];
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === 'object') blocks.push(detail(key, value));
    else inline.push(`${gray(`${key}=`)}${scalar(value)}`);
  }
  const text = level === 'error' ? red(message) : level === 'warn' ? yellow(message) : message;
  return [
    `${head(time, MARK[level](), scope)}${text}${inline.length ? `  ${inline.join(' ')}` : ''}`,
    ...blocks,
    ...(error === undefined ? [] : errorLines(error)),
  ];
}

/** "12:04:31.218 ✔ http     POST   /bookings    201   38 ms  customer·3f2a1c2b…" plus body and reply. */
function requestLines(time: Date, fields: LogFields): { lines: string[]; poll?: string } {
  const method = String(fields.method ?? '');
  const path = shortIdsIn(String(fields.path ?? ''));
  const status = fields.status as number;
  const ms = typeof fields.ms === 'number' ? fields.ms : 0;
  const tone = status >= 500 ? red : status >= 400 ? yellow : status >= 300 ? cyan : green;
  const mark = status >= 500 ? red('✖') : status >= 400 ? yellow('▲') : status >= 300 ? cyan('↪') : green('✔');
  const took = `${ms} ms`.padStart(8);
  const who = fields.user ? cyan(`${String(fields.app)}·${shortId(String(fields.user))}`) : gray('guest');
  const line =
    head(time, mark, 'http') +
    `${(METHOD_COLOR[method] ?? bold)(method.padEnd(8))}${path.padEnd(34)} ${bold(tone(String(status)))}` +
    `${ms >= 1000 ? red(took) : ms >= 300 ? yellow(took) : gray(took)}  ${who}` +
    (fields.problem ? `  ${tone(String(fields.problem))}` : '');

  const lines = [line];
  if (fields.body !== undefined) lines.push(detail('body', fields.body));
  if (fields.reply !== undefined) lines.push(detail('reply', brief(fields.reply)));
  if (fields.error !== undefined) lines.push(...errorLines(fields.error));
  const read = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  return { lines, poll: read && status < 400 && lines.length === 1 ? `${method} ${path} ${status} ${String(fields.user)}` : undefined };
}
