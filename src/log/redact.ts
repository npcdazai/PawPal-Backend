/** Field names whose values never reach a log line (session and phone tokens, OTPs, sign-in codes, signatures, keys). */
const SECRET = /token|secret|password|signature|authorization|cookie|otp|apikey|merchantkey|pepper/i;
/**
 * Sign-in codes ({ code: "482913" }). Under these keys only what looks like an error code shows:
 * "wrong_code", "ECONNREFUSED", "auth/id-token-expired" (no digits), or a small number such as an
 * exit or gRPC status. Anything else is hidden, however it's typed (" 482913", "482-913", 482913).
 */
const ONE_TIME_CODE = /^(code|smsCode|devCode|verificationCode)$/i;
const ERROR_CODE = /^[A-Za-z]+(?:[_./-][A-Za-z]+)*$/;
const looksLikeErrorCode = (value: unknown) =>
  value === null ||
  value === undefined ||
  value === '' ||
  (typeof value === 'string' && ERROR_CODE.test(value)) ||
  (typeof value === 'number' && Number.isInteger(value) && Math.abs(value) < 1000);
const PHONE = /phone/i;
const EMAIL = /email/i;
const UPI_ID = /vpa|upi/i;

const MAX_DEPTH = 4;
const MAX_ITEMS = 5;
const MAX_KEYS = 16;
const MAX_STRING = 120;

/** "+919876543210" → "+91•••••3210". */
export function maskPhone(phone: string): string {
  if (phone.length <= 4) return '••••';
  const prefix = phone.startsWith('+') ? phone.slice(0, 3) : '';
  return `${prefix}${'•'.repeat(Math.max(1, phone.length - prefix.length - 4))}${phone.slice(-4)}`;
}

/** "asha@okhdfcbank" → "a•••@okhdfcbank"; works for emails and UPI IDs alike. */
export function maskHandle(handle: string): string {
  const at = handle.indexOf('@');
  return at > 0 ? `${handle[0]}•••${handle.slice(at)}` : '•••';
}

/** The value under an object's "…" key when keys were left out. */
export const moreKeys = (count: number) => `${count} more ${count === 1 ? 'key' : 'keys'}`;

/** What stands in for an array too deep to show. */
export const itemCount = (count: number) => `<${count} ${count === 1 ? 'item' : 'items'}>`;

function trimString(text: string): string {
  const dataUrl = /^data:([\w/+.-]+);base64,/.exec(text);
  if (dataUrl) return `<${dataUrl[1]}, ${Math.round((text.length * 3) / 4 / 1024)} KB>`;
  return text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}… (${text.length} chars)` : text;
}

function errorView(error: Error): Record<string, unknown> {
  const { code, status } = error as Error & { code?: unknown; status?: unknown };
  return { name: error.name, message: error.message, code, status, stack: error.stack };
}

/**
 * A copy of `value` that is safe and short enough to log: secrets hidden, phone
 * numbers, emails and UPI IDs masked, long strings, arrays and objects trimmed,
 * errors turned into plain objects.
 */
export function redact(value: unknown, key = '', depth = 0): unknown {
  if (key && SECRET.test(key)) return value === null || value === undefined || value === '' ? value : '[hidden]';
  if (ONE_TIME_CODE.test(key) && !looksLikeErrorCode(value)) return '[hidden]';
  if (typeof value === 'string') {
    if (PHONE.test(key)) return maskPhone(value);
    if (EMAIL.test(key) || UPI_ID.test(key)) return maskHandle(value);
    return trimString(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return errorView(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? itemCount(value.length) : '<…>';
  if (Array.isArray(value)) {
    const shown = value.slice(0, MAX_ITEMS).map((item) => redact(item, key, depth + 1));
    return value.length > MAX_ITEMS ? [...shown, `… ${value.length - MAX_ITEMS} more`] : shown;
  }
  const entries = Object.entries(value);
  const out: Record<string, unknown> = {};
  for (const [name, item] of entries.slice(0, MAX_KEYS)) out[name] = redact(item, name, depth + 1);
  if (entries.length > MAX_KEYS) out['…'] = moreKeys(entries.length - MAX_KEYS);
  return out;
}
