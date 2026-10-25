import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.ts';
import {
  CODES_PER_CLIENT,
  CODES_PER_PHONE,
  CODE_WINDOW_MS,
  createDevCodes,
  DEV_CODE_TTL_MS,
  MAX_WRONG_CODES,
  randomCode,
} from '../src/auth/devCodes.ts';
import { createPhoneVerifier } from '../src/auth/phoneVerification.ts';
import { createSessions } from '../src/auth/session.ts';
import { loadConfig } from '../src/config.ts';
import { createDispatcher } from '../src/domain/dispatch.ts';
import { createSubscriptions } from '../src/domain/subscriptions.ts';
import { createWalks } from '../src/domain/walks.ts';
import { configureLogging } from '../src/log/logger.ts';
import { createLogPush } from '../src/push/push.ts';
import { createMemoryStore } from '../src/store/memoryStore.ts';

describe('development codes', () => {
  const setup = (codes = ['111111', '222222', '333333']) => {
    let clock = 1_000_000;
    const queue = [...codes];
    const devCodes = createDevCodes({ now: () => clock, generate: () => queue.shift() ?? '999999' });
    return { devCodes, advance: (ms: number) => (clock += ms), at: () => clock };
  };

  test('random codes are 6 digits without a leading zero', () => {
    for (let i = 0; i < 200; i++) assert.match(randomCode(), /^[1-9]\d{5}$/);
  });

  test('a code lasts 10 minutes and a new one replaces it', () => {
    const { devCodes, advance, at } = setup();
    assert.deepEqual(devCodes.check('+919800000001', '111111'), { result: 'none' });
    const first = devCodes.issue('+919800000001');
    assert.deepEqual(first, { code: '111111', expiresAt: at() + DEV_CODE_TTL_MS });
    devCodes.issue('+919800000001');
    assert.deepEqual(devCodes.check('+919800000001', '111111'), { result: 'wrong', triesLeft: MAX_WRONG_CODES - 1 });
    advance(DEV_CODE_TTL_MS);
    assert.deepEqual(devCodes.check('+919800000001', '222222'), { result: 'none' });
  });

  test('missing, wrong, locked; a right code works once', () => {
    const { devCodes } = setup();
    devCodes.issue('+919800000002');
    assert.deepEqual(devCodes.check('+919800000002', undefined), { result: 'missing' });
    assert.deepEqual(devCodes.check('+919800000002', '000000'), { result: 'wrong', triesLeft: 4 });
    assert.deepEqual(devCodes.check('+919800000002', '111111'), { result: 'accepted' });
    assert.deepEqual(devCodes.check('+919800000002', '111111'), { result: 'none' });

    devCodes.issue('+919800000002'); // 222222
    for (const left of [4, 3, 2, 1]) assert.deepEqual(devCodes.check('+919800000002', '000000'), { result: 'wrong', triesLeft: left });
    assert.deepEqual(devCodes.check('+919800000002', '000000'), { result: 'locked' });
    // Locked means locked: even the right code (or none) is refused until a new code is sent.
    assert.deepEqual(devCodes.check('+919800000002', '222222'), { result: 'locked' });
    assert.deepEqual(devCodes.check('+919800000002', undefined), { result: 'locked' });
    devCodes.issue('+919800000002'); // 333333
    assert.deepEqual(devCodes.check('+919800000002', '333333'), { result: 'accepted' });
  });

  test('5 requests per phone and 20 per client in 10 minutes; refusals are not counted', () => {
    const { devCodes, advance } = setup();
    for (let i = 0; i < CODES_PER_PHONE; i++) assert.equal(devCodes.admit('+919800000003', 'ip-a'), null);
    assert.equal(devCodes.admit('+919800000003', 'ip-a'), 'phone');
    assert.equal(devCodes.admit('+919800000003', 'ip-b'), 'phone');
    advance(CODE_WINDOW_MS);
    assert.equal(devCodes.admit('+919800000003', 'ip-a'), null);

    for (let i = 1; i < CODES_PER_CLIENT; i++) assert.equal(devCodes.admit(`+9198000001${String(i).padStart(2, '0')}`, 'ip-a'), null);
    assert.equal(devCodes.admit('+919800000199', 'ip-a'), 'client');
    assert.equal(devCodes.admit('+919800000199', 'ip-b'), null);
    advance(CODE_WINDOW_MS);
    assert.equal(devCodes.admit('+919800000198', 'ip-a'), null);
  });
});

// ── Through the API ─────────────────────────────────────────────────────────

let clock = Date.UTC(2026, 9, 25, 6, 0);
const now = () => clock;

function appWith(env: Record<string, string>) {
  const config = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40), ...env });
  const store = createMemoryStore();
  const push = createLogPush({ quiet: true });
  const dispatcher = createDispatcher({ store, push, config: config.dispatch, now });
  return createApp({
    config,
    store,
    push,
    sessions: createSessions(config.sessionSecret, 1),
    verifyPhone: createPhoneVerifier({ firebaseApp: null, devLogin: config.devLogin }),
    dispatcher,
    walks: createWalks({ store, push, dispatcher, now }),
    maps: null,
    verification: null,
    payments: null,
    subscriptions: createSubscriptions({ store, now }),
    now,
  });
}

const lines: Record<string, unknown>[] = [];
const servers = [appWith({}).listen(0), appWith({ AUTH_DEV_LOGIN: 'false' }).listen(0)];
let base = '';
let noDevBase = '';
before(() => {
  configureLogging({ level: 'debug', format: 'json', bodies: 'changes' }, (line) => lines.push(JSON.parse(line)));
  [base, noDevBase] = servers.map((server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`) as [string, string];
});
after(() => {
  configureLogging({ level: 'silent' });
  for (const server of servers) server.close();
});

async function post(path: string, body: unknown, at = base) {
  const response = await fetch(at + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const sendCode = (phone: string, method: 'dev' | 'firebase' = 'dev', at = base) => post('/auth/phone/code', { phone, app: 'customer', method }, at);
const signIn = (phone: string, code?: string) => post('/auth/phone', { token: `dev:${phone}`, app: 'customer', code });
const logged = (msg: string | RegExp) => lines.filter((line) => (typeof msg === 'string' ? line.msg === msg : msg.test(String(line.msg))));

/** Request lines are written when the response finishes, a moment after the client has it. */
async function requestLine(path: string, count: number) {
  for (let i = 0; i < 50; i++) {
    const found = lines.filter((line) => line.scope === 'http' && line.path === path);
    if (found.length >= count) return found[count - 1];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`no request line ${count} for ${path}`);
}

describe('POST /auth/phone/code and the code on POST /auth/phone', () => {
  test('dev: issues a code, returns it and prints it in the API console', async () => {
    const sent = await sendCode('+919811110001');
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.method, 'dev');
    assert.match(sent.body.devCode, /^\d{6}$/);
    assert.equal(sent.body.expiresAt, clock + DEV_CODE_TTL_MS);

    const [line] = logged(/^📨 Verification code/);
    assert.equal(line?.msg, `📨 Verification code ${sent.body.devCode} for +91••••••0001 (development: no SMS is sent)`);
    assert.equal(line?.level, 'info');
    assert.equal(line?.app, 'customer');
    assert.equal(line?.expires, '10 min');
    // The reply line doesn't repeat it, and no line has the whole number.
    const reply = (await requestLine('/auth/phone/code', 1))?.reply as Record<string, unknown>;
    assert.equal(reply.devCode, '[hidden]');
    assert.ok(lines.every((entry) => !JSON.stringify(entry).includes('9811110001')));

    const signedIn = await signIn('+919811110001', sent.body.devCode);
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    assert.ok(signedIn.body.sessionToken);
    assert.equal(logged('Verification code accepted').length, 1);
    // The typed code never reaches a log line.
    const body = (await requestLine('/auth/phone', 1))?.body as Record<string, unknown>;
    assert.deepEqual(body, { token: '[hidden]', app: 'customer', code: '[hidden]' });
  });

  test('firebase: only logged, no code passes through', async () => {
    const sent = await sendCode('+919811110002', 'firebase');
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body, { method: 'firebase' });
    const [line] = logged('Verification SMS sent by Firebase');
    assert.equal(line?.phone, '+91••••••0002');
  });

  test('dev codes need development sign-in on the server', async () => {
    const refused = await sendCode('+919811110003', 'dev', noDevBase);
    assert.equal(refused.status, 403);
    assert.deepEqual(refused.body.error, { code: 'dev_login_off', message: 'Development sign-in is turned off on this server.' });
    assert.equal((await sendCode('+919811110003', 'firebase', noDevBase)).status, 200);
  });

  test('bad input is a 400', async () => {
    assert.equal((await post('/auth/phone/code', { phone: '9876543210', app: 'customer', method: 'dev' })).status, 400);
    assert.equal((await post('/auth/phone/code', { phone: '+919811110004', app: 'customer', method: 'sms' })).status, 400);
    assert.equal((await signIn('+919811110004', '12345')).status, 400);
  });

  test('code_required, wrong_code with tries left, code_locked after 5', async () => {
    const phone = '+919811110005';
    const { devCode } = (await sendCode(phone)).body as { devCode: string };
    const wrong = devCode === '123456' ? '654321' : '123456';

    const missing = await signIn(phone);
    assert.equal(missing.status, 401);
    assert.deepEqual(missing.body.error, { code: 'code_required', message: 'Enter the 6-digit code we sent.' });

    for (const left of [4, 3, 2]) {
      const refused = await signIn(phone, wrong);
      assert.equal(refused.status, 401);
      assert.deepEqual(refused.body.error, { code: 'wrong_code', message: `That code isn’t right. ${left} tries left.` });
    }
    assert.equal((await signIn(phone, wrong)).body.error.message, 'That code isn’t right. 1 try left.');
    const locked = await signIn(phone, wrong);
    assert.deepEqual(locked.body.error, { code: 'code_locked', message: 'Too many wrong codes. Send a new code.' });
    assert.equal((await signIn(phone, devCode)).body.error.code, 'code_locked');
    assert.equal(logged('Wrong verification code').length, 4);
    assert.equal(logged('Too many wrong verification codes; a new code is needed').length, 2);
    // (Leaving out the lines that announce issued codes, and timestamps, which could contain the digits by chance.)
    const others = lines.filter((entry) => !String(entry.msg).startsWith('📨')).map(({ time: _time, reply: _reply, ...rest }) => rest);
    assert.ok(others.every((entry) => !JSON.stringify(entry).includes(wrong)), 'a typed code was logged');

    // A new code starts over, and works once.
    const fresh = (await sendCode(phone)).body.devCode as string;
    assert.equal((await signIn(phone, fresh)).status, 200);
    const again = (await sendCode(phone)).body.devCode as string;
    if (again !== fresh) assert.equal((await signIn(phone, fresh)).body.error.code, 'wrong_code');
  });

  test('without a pending code, development sign-in works as before', async () => {
    const plain = await signIn('+919811110006');
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    assert.equal(logged('Development sign-in without a code (none was requested)').length, 1);

    // An expired code counts as none.
    await sendCode('+919811110007');
    clock += DEV_CODE_TTL_MS;
    assert.equal((await signIn('+919811110007')).status, 200);
  });

  test('a failed phone verification is logged without the token', async () => {
    const refused = await post('/auth/phone', { token: 'dev:12345', app: 'partner' });
    assert.equal(refused.status, 401);
    const [line] = logged('Phone verification failed');
    assert.deepEqual(
      { level: line?.level, app: line?.app, method: line?.method, kind: line?.kind, reason: line?.reason },
      { level: 'warn', app: 'partner', method: 'pnv', kind: 'dev', reason: 'invalid_phone_token' }
    );
    assert.equal((await post('/auth/phone', { token: 'eyJhbGciOi.real.jwt', method: 'sms', app: 'customer' })).status, 503);
    assert.equal(logged('Phone verification failed')[1]?.kind, 'firebase');
    assert.ok(lines.every((entry) => !JSON.stringify(entry).includes('eyJhbGciOi')));
  });

  test('too many codes: 5 per phone, 20 per client IP, in 10 minutes', async () => {
    clock += CODE_WINDOW_MS; // a fresh window for this client
    const phone = '+919811110008';
    for (let i = 0; i < CODES_PER_PHONE; i++) assert.equal((await sendCode(phone)).status, 200);
    const limited = await sendCode(phone, 'firebase');
    assert.equal(limited.status, 429);
    assert.deepEqual(limited.body.error, { code: 'too_many_codes', message: 'Too many codes requested. Wait a few minutes and try again.' });
    assert.equal(logged('Too many verification codes requested').at(-1)?.limit, 'per phone');

    for (let i = CODES_PER_PHONE; i < CODES_PER_CLIENT; i++) {
      assert.equal((await sendCode(`+9198111102${String(i).padStart(2, '0')}`)).status, 200);
    }
    assert.equal((await sendCode('+919811110299')).status, 429);
    assert.equal(logged('Too many verification codes requested').at(-1)?.limit, 'per client IP');

    clock += CODE_WINDOW_MS;
    assert.equal((await sendCode('+919811110299')).status, 200);
  });
});
