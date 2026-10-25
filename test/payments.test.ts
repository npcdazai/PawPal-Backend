import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.ts';
import { createPhoneVerifier } from '../src/auth/phoneVerification.ts';
import { createSessions } from '../src/auth/session.ts';
import { loadConfig } from '../src/config.ts';
import { createDispatcher } from '../src/domain/dispatch.ts';
import { createPayments } from '../src/domain/payments.ts';
import { createSubscriptions } from '../src/domain/subscriptions.ts';
import { createWalks } from '../src/domain/walks.ts';
import { createYoupi } from '../src/payments/youpi.ts';
import { createLogPush } from '../src/push/push.ts';
import { createMemoryStore } from '../src/store/memoryStore.ts';

// 7:00 AM UTC = 12:30 PM in India.
let clock = Date.UTC(2026, 9, 22, 7, 0);
const now = () => clock;

const config = loadConfig({
  NODE_ENV: 'test',
  SESSION_SECRET: 'p'.repeat(40),
  YOUPI_URL: 'https://youpi.test',
  YOUPI_MERCHANT_ID: 'merchant-1',
  YOUPI_MERCHANT_KEY: 'k'.repeat(40),
});
const payConfig = config.payments!;

/** In-memory YouPI behind the real client: sessions by id, created via POST, read via GET. */
const sessions = new Map<string, Record<string, unknown>>();
const gatewayCalls: { method: string; path: string; headers: Record<string, string> }[] = [];
const fakeYoupiFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const headers = (init?.headers ?? {}) as Record<string, string>;
  gatewayCalls.push({ method: init?.method ?? 'GET', path: url.pathname, headers });
  if (init?.method === 'POST' && url.pathname === '/api/v1/payments') {
    const body = JSON.parse(String(init.body)) as { orderId: string; amount: string };
    const paymentId = `pay_${sessions.size + 1}`;
    const session = {
      paymentId,
      orderId: body.orderId,
      amount: body.amount,
      amountPaise: String(Math.round(Number(body.amount) * 100)),
      status: 'INITIATED',
      checkoutUrl: `https://youpi.test/checkout/${paymentId}`,
      verificationLevel: 0,
    };
    sessions.set(paymentId, session);
    return Response.json(session, { status: 201 });
  }
  const found = sessions.get(url.pathname.split('/').pop() ?? '');
  return found ? Response.json(found) : Response.json({ error: 'not found' }, { status: 404 });
}) as typeof fetch;

const store = createMemoryStore();
const push = createLogPush({ quiet: true });
const dispatcher = createDispatcher({ store, push, config: config.dispatch, now });
const subscriptions = createSubscriptions({ store, now });
const walks = createWalks({ store, push, dispatcher, now, paymentsRequired: true, subscriptions });
const payments = createPayments({ store, youpi: createYoupi(payConfig.youpi, fakeYoupiFetch), walks, push, config: payConfig, now });
const app = createApp({
  config,
  store,
  push,
  sessions: createSessions(config.sessionSecret, 1),
  verifyPhone: createPhoneVerifier({ firebaseApp: null, devLogin: true }),
  dispatcher,
  walks,
  maps: null,
  verification: null,
  payments,
  subscriptions,
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

async function login(phone: string, app: 'customer' | 'partner', name = 'Test') {
  const { body } = await api('POST', '/auth/phone', { body: { token: `dev:${phone}`, app, name } });
  return body as { sessionToken: string; user: { id: string } };
}

/** What YouPI posts to the webhook, signed with the merchant key. */
async function webhook(paymentId: string, patch: Record<string, unknown>, key = payConfig.youpi.merchantKey) {
  const session = { ...sessions.get(paymentId)!, ...patch };
  sessions.set(paymentId, session);
  const raw = JSON.stringify({ event: session.status, ...session, amountPaise: Number(session.amountPaise), utr: '512345678901' });
  return fetch(`${base}/webhooks/youpi`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-gateway-event': String(session.status),
      'x-gateway-signature': `sha256=${createHmac('sha256', key).update(raw).digest('hex')}`,
    },
    body: raw,
  });
}

const PICKUP = { lat: 19.1176, lng: 72.906, address: 'Tower B, Hiranandani Gardens, Powai' };
const SOCIETY = { societyId: 'hiranandani', tower: 'B', flat: '1203' };
const walk = (tier: string, extra: Record<string, unknown> = {}) => ({
  tier,
  dog: { name: 'Bruno', breed: 'Indie', size: 'medium' },
  pickup: PICKUP,
  society: SOCIETY,
  ...extra,
});

describe('payments (YouPI) and monthly packs', () => {
  let customer: { sessionToken: string; user: { id: string } };
  let walker: { sessionToken: string; user: { id: string } };

  test('a booking waits for payment, and a signed, verified SUCCESS starts the search', async () => {
    customer = await login('+919822200001', 'customer', 'Meera');
    walker = await login('+919822200002', 'partner', 'Rohan');
    await api('PATCH', '/partners/me', { token: walker.sessionToken, body: { area: 'Powai' } });
    await api('POST', '/partners/me/application', { token: walker.sessionToken });
    // Payments on doesn't auto-approve here (no verification module), so approve for the test.
    const partner = (await store.get('partners', walker.user.id))!;
    await store.set('partners', walker.user.id, { ...partner, approved: true, trustTier: 2 });
    await api('PUT', '/partners/me/status', { token: walker.sessionToken, body: { online: true, lat: 19.118, lng: 72.906 } });

    const created = await api('POST', '/bookings', { token: customer.sessionToken, body: walk('express') });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const booking = created.body.booking;
    assert.equal(booking.status, 'awaiting_payment');
    assert.deepEqual([booking.payment.status, booking.payment.amount], ['unpaid', 299]);
    assert.equal((await api('GET', '/partners/me/offers', { token: walker.sessionToken })).body.offers.length, 0);

    const checkout = await api('POST', `/bookings/${booking.id}/payment`, { token: customer.sessionToken });
    assert.equal(checkout.status, 200, JSON.stringify(checkout.body));
    assert.match(checkout.body.checkoutUrl, /^https:\/\/youpi\.test\/checkout\//);
    const create = gatewayCalls.find((call) => call.method === 'POST')!;
    assert.equal(create.headers['X-Merchant-Id'], 'merchant-1');
    assert.equal(create.headers['Idempotency-Key'], `${booking.id}-1`);

    // Opening the checkout again reuses the open session.
    const again = await api('POST', `/bookings/${booking.id}/payment`, { token: customer.sessionToken });
    assert.equal(again.body.checkoutUrl, checkout.body.checkoutUrl);
    assert.equal(sessions.size, 1);

    const forged = await webhook('pay_1', { status: 'SUCCESS', verificationLevel: 2 }, 'not-the-key');
    assert.equal(forged.status, 401);

    const paid = await webhook('pay_1', { status: 'SUCCESS', verificationLevel: 1 });
    assert.equal(paid.status, 204);
    const after = await api('GET', `/bookings/${booking.id}`, { token: customer.sessionToken });
    assert.equal(after.body.booking.status, 'searching');
    assert.deepEqual([after.body.booking.payment.status, after.body.booking.payment.utr], ['paid', '512345678901']);
    assert.equal(push.sent.find((sent) => sent.title.startsWith('Payment received'))?.userId, customer.user.id);

    const offers = await api('GET', '/partners/me/offers', { token: walker.sessionToken });
    assert.equal(offers.body.offers.length, 1);
    assert.equal(offers.body.offers[0].booking.payment, undefined, 'walkers never see payment details');
    assert.equal(offers.body.offers[0].booking.society.flat, '', 'the flat number stays hidden until the walk is accepted');
    await api('POST', `/offers/${offers.body.offers[0].id}/accept`, { token: walker.sessionToken });
    const assigned = await api('GET', `/bookings/${booking.id}`, { token: walker.sessionToken });
    assert.equal(assigned.body.booking.society.flat, '1203');

    // A replayed SUCCESS doesn't do anything twice.
    await webhook('pay_1', { status: 'SUCCESS', verificationLevel: 1 });
    assert.equal(push.sent.filter((sent) => sent.title.startsWith('Payment received')).length, 1);
  });

  test('a wrong amount or an unverified SUCCESS is held for review, not dispatched', async () => {
    const short = (await api('POST', '/bookings', { token: customer.sessionToken, body: walk('trial') })).body.booking;
    await api('POST', `/bookings/${short.id}/payment`, { token: customer.sessionToken });
    await webhook('pay_2', { status: 'SUCCESS', verificationLevel: 2, amountPaise: '100' });
    const held = await api('GET', `/bookings/${short.id}`, { token: customer.sessionToken });
    assert.deepEqual([held.body.booking.status, held.body.booking.payment.status], ['awaiting_payment', 'review']);

    const unverified = (await api('POST', '/bookings', { token: customer.sessionToken, body: walk('trial') })).body.booking;
    await api('POST', `/bookings/${unverified.id}/payment`, { token: customer.sessionToken });
    sessions.set('pay_3', { ...sessions.get('pay_3')!, status: 'SUCCESS', verificationLevel: 0 });
    // The app's return-from-checkout check asks the gateway directly.
    const refreshed = await api('GET', `/bookings/${unverified.id}/payment`, { token: customer.sessionToken });
    assert.equal(refreshed.body.booking.payment.status, 'review');
  });

  test('a failed attempt can be retried with a new order, and unpaid bookings are released', async () => {
    const booking = (await api('POST', '/bookings', { token: customer.sessionToken, body: walk('express') })).body.booking;
    await api('POST', `/bookings/${booking.id}/payment`, { token: customer.sessionToken });
    const paymentId = `pay_${sessions.size}`;
    await webhook(paymentId, { status: 'EXPIRED' });
    assert.equal((await store.get('bookings', booking.id))!.payment.status, 'failed');

    const retry = await api('POST', `/bookings/${booking.id}/payment`, { token: customer.sessionToken });
    assert.notEqual(retry.body.checkoutUrl, null);
    assert.equal((await store.get('bookings', booking.id))!.payment.orderId, `${booking.id}-2`);

    clock += (payConfig.holdMinutes + 1) * 60_000;
    assert.ok((await payments.sweepUnpaid()) >= 1);
    assert.equal((await store.get('bookings', booking.id))!.status, 'cancelled');

    // Money that lands after the release is flagged for a manual refund instead of reviving the walk.
    await webhook(`pay_${sessions.size}`, { status: 'SUCCESS', verificationLevel: 2 });
    const late = (await store.get('bookings', booking.id))!;
    assert.deepEqual([late.status, late.payment.refundDue], ['cancelled', true]);
  });

  test('a paid monthly pack books one walk a day and looks for a walker 45 minutes before each', async () => {
    // Tomorrow 7:00 AM India time.
    const firstWalk = Date.UTC(2026, 9, 23, 1, 30);
    const booking = (await api('POST', '/bookings', { token: customer.sessionToken, body: walk('subscription', { scheduledFor: firstWalk }) })).body.booking;
    assert.equal(booking.payment.amount, 3120);
    assert.equal(booking.price, 120);
    await api('POST', `/bookings/${booking.id}/payment`, { token: customer.sessionToken });
    await webhook(`pay_${sessions.size}`, { status: 'SUCCESS', verificationLevel: 1 });

    const paid = (await store.get('bookings', booking.id))!;
    assert.equal(paid.status, 'searching');
    assert.ok(paid.subscriptionId);
    assert.equal(paid.offeredTo.length, 0, 'a walk tomorrow isn’t offered yet');

    const packs = await api('GET', '/subscriptions', { token: customer.sessionToken });
    assert.deepEqual([packs.body.subscriptions[0].walksBooked, packs.body.subscriptions[0].slotMinute], [1, 7 * 60]);

    assert.equal(await subscriptions.sweep(), 0, 'the second walk is more than 12 hours away');
    clock = firstWalk - 40 * 60_000;
    // The walker's app reports its position while online (the last one is from yesterday).
    await api('PUT', '/partners/me/status', { token: walker.sessionToken, body: { online: true, lat: 19.118, lng: 72.906 } });
    assert.equal(await dispatcher.dispatchDue(), 1);
    assert.equal((await store.get('bookings', booking.id))!.offeredTo.length, 1);

    clock = firstWalk + 13 * 60 * 60_000;
    assert.equal(await subscriptions.sweep(), 1);
    assert.equal(await subscriptions.sweep(), 0, 'one walk per day');
    const generated = (await store.find('bookings', { subscriptionId: paid.subscriptionId! })).find((entry) => entry.id !== booking.id)!;
    assert.equal(generated.scheduledFor, firstWalk + 24 * 60 * 60_000);
    assert.deepEqual([generated.status, generated.payment.status, generated.price], ['searching', 'prepaid', 120]);

    const cancelled = await api('POST', `/subscriptions/${paid.subscriptionId}/cancel`, { token: customer.sessionToken });
    assert.equal(cancelled.body.subscription.status, 'cancelled');
    clock += 24 * 60 * 60_000;
    assert.equal(await subscriptions.sweep(), 0);
  });

  test('walkers see their earnings per India-time day', async () => {
    const accepted = (await store.find('bookings', { partnerId: walker.user.id })).find((entry) => entry.status === 'assigned')!;
    await store.set('bookings', accepted.id, { ...accepted, status: 'completed', completedAt: clock });
    const earnings = await api('GET', '/partners/me/earnings?days=7', { token: walker.sessionToken });
    assert.equal(earnings.status, 200);
    assert.equal(earnings.body.days.length, 7);
    assert.deepEqual(earnings.body.days.at(-1), { date: new Date(clock + 5.5 * 3600_000).toISOString().slice(0, 10), amount: accepted.payout, walks: 1 });
    assert.deepEqual(earnings.body.totals, { amount: accepted.payout, walks: 1 });
  });

  test('deleting an account removes it, and the number can sign up again', async () => {
    const leaving = await login('+919822200009', 'customer', 'Leaving');
    const open = (await api('POST', '/bookings', { token: leaving.sessionToken, body: walk('trial') })).body.booking;
    assert.equal((await api('DELETE', '/me', { token: leaving.sessionToken })).status, 204);
    assert.equal((await store.get('bookings', open.id))!.status, 'cancelled');
    assert.equal((await api('GET', '/me', { token: leaving.sessionToken })).status, 401);
    const again = await login('+919822200009', 'customer');
    assert.notEqual(again.user.id, leaving.user.id);
  });
});
