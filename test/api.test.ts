import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.ts';
import { createPhoneVerifier } from '../src/auth/phoneVerification.ts';
import { createSessions } from '../src/auth/session.ts';
import { loadConfig } from '../src/config.ts';
import { createDispatcher } from '../src/domain/dispatch.ts';
import { createSubscriptions } from '../src/domain/subscriptions.ts';
import { createWalks } from '../src/domain/walks.ts';
import { createLogPush } from '../src/push/push.ts';
import { createMemoryStore } from '../src/store/memoryStore.ts';

// 11:30 AM in India: off-peak, so an express walk is ₹299.
let clock = Date.UTC(2026, 9, 21, 6, 0);
const now = () => clock;

const config = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40), STORE: 'memory' });
const store = createMemoryStore();
const push = createLogPush({ quiet: true });
const dispatcher = createDispatcher({ store, push, config: config.dispatch, now });
const app = createApp({
  config,
  store,
  push,
  sessions: createSessions(config.sessionSecret, 1),
  verifyPhone: createPhoneVerifier({ firebaseApp: null, devLogin: true }),
  dispatcher,
  walks: createWalks({ store, push, dispatcher, now }),
  maps: null,
  verification: null,
  payments: null,
  subscriptions: createSubscriptions({ store, now }),
  now,
});

let base = '';
const server = app.listen(0);
before(() => {
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function api(method: string, path: string, options: { token?: string; body?: unknown } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function login(phone: string, app: 'customer' | 'partner', name?: string) {
  const { status, body } = await api('POST', '/auth/phone', { body: { token: `dev:${phone}`, app, name } });
  assert.equal(status, 200, JSON.stringify(body));
  return body as { sessionToken: string; user: { id: string } };
}

// Hiranandani Gardens, Powai: the pickup, and two walkers 300 m and 900 m away.
const PICKUP = { lat: 19.1176, lng: 72.9060, address: 'Tower B, Hiranandani Gardens, Powai' };
const NEAR = { lat: 19.1203, lng: 72.906 };
const FAR = { lat: 19.1257, lng: 72.906 };

async function onlinePartner(phone: string, name: string, at: { lat: number; lng: number }) {
  const { sessionToken, user } = await login(phone, 'partner', name);
  assert.equal((await api('PATCH', '/partners/me', { token: sessionToken, body: { area: 'Powai' } })).status, 200);
  const applied = await api('POST', '/partners/me/application', { token: sessionToken });
  assert.equal(applied.body.partner.approved, true);
  const online = await api('PUT', '/partners/me/status', { token: sessionToken, body: { online: true, ...at } });
  assert.equal(online.status, 200, JSON.stringify(online.body));
  return { token: sessionToken, id: user.id };
}

/** The two online walkers, shared by the dispatch tests. */
const walkers: { token: string; id: string }[] = [];
const walker = (id: string | undefined) => {
  const found = walkers.find((entry) => entry.id === id);
  assert.ok(found, `no walker ${id}`);
  return found;
};

const expressWalk = (name = 'Bruno') => ({
  tier: 'express',
  dog: { name, breed: 'Indie', size: 'medium' },
  pickup: PICKUP,
});

describe('PawPal API', () => {
  test('health reports the local setup', async () => {
    const { status, body } = await api('GET', '/health');
    assert.equal(status, 200);
    assert.deepEqual(body, {
      ok: true,
      store: 'memory',
      push: 'log',
      phoneVerification: 'dev-only',
      maps: 'off',
      verification: 'off',
      payments: 'off',
    });
    const maps = await api('GET', '/maps/route?from=19.1,72.9&to=19.2,72.9', { token: (await login('+919800000099', 'customer')).sessionToken });
    assert.equal(maps.status, 503);
  });

  test('signing in twice with one number gives one account in both apps', async () => {
    const first = await login('+919800000001', 'customer', 'Asha');
    const second = await login('+919800000001', 'partner');
    assert.equal(first.user.id, second.user.id);
    const me = await api('GET', '/me', { token: second.sessionToken });
    assert.deepEqual(me.body.user.apps, ['customer', 'partner']);
    assert.equal(me.body.user.name, 'Asha');
  });

  test('requests without a valid session are refused', async () => {
    assert.equal((await api('GET', '/bookings')).status, 401);
    assert.equal((await api('GET', '/bookings', { token: 'forged' })).status, 401);
    const badPhone = await api('POST', '/auth/phone', { body: { token: 'dev:12345', app: 'customer' } });
    assert.equal(badPhone.status, 401);
    for (const method of ['pnv', 'sms']) {
      const noFirebase = await api('POST', '/auth/phone', { body: { token: 'eyJhbGciOi.real.jwt', method, app: 'customer' } });
      assert.equal(noFirebase.status, 503);
    }
  });

  test('a walk goes from booking to the nearest walker, through the OTP, to home', async () => {
    const customer = await login('+919800000010', 'customer', 'Meera');
    await api('POST', '/devices', { token: customer.sessionToken, body: { token: 'fcm-token-customer-0123456789', platform: 'android' } });
    const near = await onlinePartner('+919800000011', 'Rohan', NEAR);
    walkers.push(near, await onlinePartner('+919800000012', 'Pratik', FAR));

    const created = await api('POST', '/bookings', { token: customer.sessionToken, body: expressWalk() });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const booking = created.body.booking;
    assert.equal(booking.status, 'searching');
    assert.equal(booking.price, 299);
    assert.equal(booking.payout, 254.15);
    assert.match(booking.pickupOtp, /^\d{4}$/);
    assert.equal(booking.offeredTo, undefined);

    // The closest walker is asked first, by push and in their offer list.
    const offerPush = push.sent.findLast((sent) => sent.data.type === 'offer');
    assert.equal(offerPush?.userId, near.id);
    assert.equal(offerPush?.urgent, true);
    const offers = await api('GET', '/partners/me/offers', { token: near.token });
    assert.equal(offers.body.offers.length, 1);
    assert.equal(offers.body.offers[0].distanceKm, 0.3);
    assert.equal(offers.body.offers[0].booking.pickupOtp, undefined);

    const accepted = await api('POST', `/offers/${offers.body.offers[0].id}/accept`, { token: near.token });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.booking.status, 'assigned');
    assert.equal(push.sent.at(-1)?.title, 'Rohan is walking Bruno');

    const seen = await api('GET', `/bookings/${booking.id}`, { token: customer.sessionToken });
    // Name, rating and verification only: never the walker's phone or area (docs/DASHBOARD_API.md §5).
    assert.deepEqual(seen.body.booking.walker, { id: near.id, name: 'Rohan', initials: 'R', rating: null, verified: true });

    const wrong = booking.pickupOtp === '1111' ? '2222' : '1111';
    const refused = await api('POST', `/bookings/${booking.id}/start`, { token: near.token, body: { otp: wrong } });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error.code, 'wrong_otp');
    const started = await api('POST', `/bookings/${booking.id}/start`, { token: near.token, body: { otp: booking.pickupOtp } });
    assert.equal(started.body.booking.status, 'active');

    clock += 8 * 60_000;
    await api('POST', `/bookings/${booking.id}/location`, { token: near.token, body: NEAR });
    const pee = await api('POST', `/bookings/${booking.id}/events`, { token: near.token, body: { type: 'pee', ...NEAR } });
    assert.equal(pee.status, 201);
    assert.equal(push.sent.at(-1)?.title, '💧 Bruno had a pee break');

    clock += 22 * 60_000;
    const done = await api('POST', `/bookings/${booking.id}/complete`, { token: near.token });
    assert.equal(done.body.booking.status, 'completed');
    assert.equal(push.sent.at(-1)?.body, 'Walk complete: 1 pee and 0 poop breaks, 0 photos.');

    const history = await api('GET', '/bookings', { token: customer.sessionToken });
    assert.equal(history.body.bookings[0].walkerLocation.lat, NEAR.lat);
  });

  test('an unanswered request moves on, and nobody left means unmatched', async () => {
    // Half an hour has passed: both walkers report where they are now.
    for (const [index, { token }] of walkers.entries()) {
      await api('PUT', '/partners/me/status', { token, body: { online: true, ...(index === 0 ? NEAR : FAR) } });
    }
    const customer = await login('+919800000020', 'customer', 'Kabir');
    const created = await api('POST', '/bookings', { token: customer.sessionToken, body: expressWalk('Coco') });
    const first = push.sent.findLast((sent) => sent.data.type === 'offer' && sent.data.bookingId === created.body.booking.id);
    assert.ok(first);

    clock += (config.dispatch.offerSeconds + 1) * 1000;
    assert.equal(await dispatcher.sweep(), 1);
    const second = push.sent.findLast((sent) => sent.data.type === 'offer' && sent.data.bookingId === created.body.booking.id);
    assert.ok(second && second.userId !== first.userId);

    // The first walker answers too late.
    const late = await api('POST', `/offers/${first.data.offerId}/accept`, { token: walker(first.userId).token });
    assert.equal(late.status, 409);
    assert.equal(late.body.error.code, 'offer_closed');

    const declined = await api('POST', `/offers/${second.data.offerId}/decline`, { token: walker(second.userId).token });
    assert.equal(declined.status, 204);

    const after = await api('GET', `/bookings/${created.body.booking.id}`, { token: customer.sessionToken });
    assert.equal(after.body.booking.status, 'unmatched');
    assert.equal(push.sent.at(-1)?.title, 'No walkers free nearby');

    const retried = await api('POST', `/bookings/${created.body.booking.id}/retry`, { token: customer.sessionToken });
    assert.equal(retried.body.booking.status, 'searching');
    const cancelled = await api('POST', `/bookings/${created.body.booking.id}/cancel`, { token: customer.sessionToken });
    assert.equal(cancelled.body.booking.status, 'cancelled');
    for (const { token } of walkers) {
      const open = await api('GET', '/partners/me/offers', { token });
      assert.equal(open.body.offers.length, 0);
    }
  });

  test('each side is limited to its own actions and walks', async () => {
    const customer = await login('+919800000030', 'customer');
    const stranger = await login('+919800000031', 'customer');
    const partner = await login('+919800000011', 'partner');

    assert.equal((await api('POST', '/bookings', { token: partner.sessionToken, body: expressWalk() })).status, 403);
    assert.equal((await api('GET', '/partners/me', { token: customer.sessionToken })).status, 403);

    const created = await api('POST', '/bookings', { token: customer.sessionToken, body: expressWalk('Momo') });
    const peek = await api('GET', `/bookings/${created.body.booking.id}`, { token: stranger.sessionToken });
    assert.equal(peek.status, 404);

    const invalid = await api('POST', '/bookings', { token: customer.sessionToken, body: { ...expressWalk(), tier: 'vip' } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'invalid_input');
  });

  test('express walks cost ₹349 in the evening rush', async () => {
    clock = Date.UTC(2026, 9, 21, 12, 0); // 5:30 PM in India
    const customer = await login('+919800000040', 'customer');
    const created = await api('POST', '/bookings', { token: customer.sessionToken, body: expressWalk('Simba') });
    assert.equal(created.body.booking.price, 349);
  });
});
