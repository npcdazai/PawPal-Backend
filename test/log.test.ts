import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, describe, test } from 'node:test';
import express from 'express';
import { requestLog } from '../src/http/requestLog.ts';
import { configureLogging, logger } from '../src/log/logger.ts';
import { redact } from '../src/log/redact.ts';

after(() => configureLogging({ level: 'silent' }));

describe('redact', () => {
  test('hides secrets, masks people, trims bulk', () => {
    const out = redact({
      token: 'dev:+919876543210',
      sessionToken: 'eyJhbGciOiJIUzI1NiJ9.payload.signature',
      pickupOtp: '4821',
      phone: '+919876543210',
      payoutVpa: 'asha@okhdfcbank',
      email: 'asha@example.com',
      photo: `data:image/jpeg;base64,${'A'.repeat(4000)}`,
      note: 'x'.repeat(300),
      track: [1, 2, 3, 4, 5, 6, 7],
      nested: { a: { b: { c: { d: 1 } } } },
      empty: null,
    });
    assert.deepEqual(out, {
      token: '[hidden]',
      sessionToken: '[hidden]',
      pickupOtp: '[hidden]',
      phone: '+91••••••3210',
      payoutVpa: 'a•••@okhdfcbank',
      email: 'a•••@example.com',
      photo: '<image/jpeg, 3 KB>',
      note: `${'x'.repeat(120)}… (300 chars)`,
      track: [1, 2, 3, 4, 5, '… 2 more'],
      nested: { a: { b: { c: '<…>' } } },
      empty: null,
    });
  });

  test('hides sign-in codes but keeps error codes', () => {
    assert.deepEqual(redact({ code: '482913', devCode: '482913', smsCode: 482913, reason: 'wrong_code', countryCode: 'IN' }), {
      code: '[hidden]',
      devCode: '[hidden]',
      smsCode: '[hidden]',
      reason: 'wrong_code',
      countryCode: 'IN',
    });
    assert.deepEqual(redact({ error: { code: 'wrong_code', message: 'That code isn’t right.' } }), {
      error: { code: 'wrong_code', message: 'That code isn’t right.' },
    });
    // However the digits are typed, they stay hidden.
    for (const code of [' 482913', '482 913', '482-913', '4829130000', 'a482913', ['482913'], { value: '482913' }]) {
      assert.deepEqual(redact({ token: 'dev:+919876543210', code }), { token: '[hidden]', code: '[hidden]' }, JSON.stringify(code));
    }
    // Error codes from Node, Firebase and gRPC still show.
    for (const code of ['ECONNREFUSED', 'ERR_INVALID_ARG_TYPE', 'auth/id-token-expired', 'entity.parse.failed', 5, null, '']) {
      assert.deepEqual(redact({ code }), { code }, JSON.stringify(code));
    }
  });

  test('turns errors into plain objects', () => {
    const out = redact({ error: new Error('boom') }) as { error: Record<string, unknown> };
    assert.equal(out.error.name, 'Error');
    assert.equal(out.error.message, 'boom');
    assert.match(String(out.error.stack), /boom/);
  });
});

describe('request log', () => {
  test('one JSON line per request, with the body and reply redacted', async () => {
    const lines: string[] = [];
    configureLogging({ level: 'debug', format: 'json', bodies: 'changes' }, (line) => lines.push(line));
    const app = express();
    app.use(requestLog());
    app.use(express.json());
    app.post('/auth/phone', (_req, res) => {
      res.locals.session = { userId: 'user-1', app: 'customer' };
      res.json({ sessionToken: 'secret', user: { phone: '+919876543210' } });
    });
    app.get('/missing', (_req, res) => {
      res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint.' } });
    });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await fetch(`${base}/auth/phone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'dev:+919876543210', app: 'customer' }),
      });
      await fetch(`${base}/missing`);
      for (let i = 0; i < 50 && lines.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      server.close();
    }

    const [post, missing] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(post && missing);
    assert.equal(post.level, 'info');
    assert.equal(post.scope, 'http');
    assert.equal(post.method, 'POST');
    assert.equal(post.path, '/auth/phone');
    assert.equal(post.status, 200);
    assert.equal(post.user, 'user-1');
    assert.equal(typeof post.ms, 'number');
    assert.deepEqual(post.body, { token: '[hidden]', app: 'customer' });
    assert.deepEqual(post.reply, { sessionToken: '[hidden]', user: { phone: '+91••••••3210' } });
    assert.equal(missing.level, 'warn');
    assert.equal(missing.problem, 'not_found: No such endpoint.');
    assert.equal(missing.reply, undefined);
  });

  test('pretty lines: scope, message, short ids and fields', () => {
    const lines: string[] = [];
    configureLogging({ level: 'debug', format: 'pretty' }, (line) => lines.push(line));
    logger('dispatch').info('Offered to walker', { booking: '3f2a1c2b-1111-4222-8333-944445555666', km: 1.2, error: undefined });
    logger('dispatch').debug('hidden below the level', {});
    configureLogging({ level: 'info' }, (line) => lines.push(line));
    logger('dispatch').debug('not printed', {});

    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? '', /^\d\d:\d\d:\d\d\.\d{3} ● dispatch Offered to walker {2}booking=3f2a1c2b… km=1\.2$/);
    assert.match(lines[1] ?? '', /· dispatch hidden below the level$/);
  });
});
