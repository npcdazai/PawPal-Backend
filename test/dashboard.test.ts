import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { createApp, type AppDeps } from '../src/app.ts';
import { createPhoneVerifier } from '../src/auth/phoneVerification.ts';
import { createSessions } from '../src/auth/session.ts';
import { loadConfig } from '../src/config.ts';
import { createDispatcher } from '../src/domain/dispatch.ts';
import {
  checkoutAmount,
  EXPRESS_MINUTES,
  PACK_SLOT_MINUTES,
  routeKm,
  slotLabel,
  walkFare,
} from '../src/domain/pricing.ts';
import { createSubscriptions } from '../src/domain/subscriptions.ts';
import type { Partner } from '../src/domain/types.ts';
import { arrivalWindow, initials, ratingOf, shortName } from '../src/domain/walkers.ts';
import { createWalks } from '../src/domain/walks.ts';
import { HttpError } from '../src/http/errors.ts';
import { createLogPush } from '../src/push/push.ts';
import { createMemoryStore } from '../src/store/memoryStore.ts';
import { conditionFor, createOpenMeteoWeather, iconFor, WEATHER_CACHE_MS } from '../src/weather/openMeteo.ts';

/** An India-time moment in October 2026: ist(22, 7) is 22 Oct, 7:00 AM IST. */
const ist = (day: number, hour: number, minute = 0) => Date.UTC(2026, 9, day, hour, minute) - 330 * 60_000;

let clock = ist(21, 11, 30); // off-peak
const now = () => clock;

// ─── Fakes ──────────────────────────────────────────────────────────────────

/** Open-Meteo stand-in: answers from `weatherReply`, recording each URL asked. */
const weatherCalls: URL[] = [];
let weatherReply: () => Response = () =>
  Response.json({ current: { time: '2026-10-21T06:00', temperature_2m: 27.6, weather_code: 2, is_day: 1 } });
const fakeWeatherFetch = (async (input: string | URL | Request) => {
  weatherCalls.push(new URL(String(input)));
  return weatherReply();
}) as typeof fetch;

/** Gate pass numbers the verification pipeline would hold, by walker. */
const gatePasses = new Map<string, string>();

// ─── App under test ─────────────────────────────────────────────────────────

const config = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'd'.repeat(40), STORE: 'memory' });
const store = createMemoryStore();
const push = createLogPush({ quiet: true });
const dispatcher = createDispatcher({ store, push, config: config.dispatch, now });
const subscriptions = createSubscriptions({ store, now, gatePass: async (id) => gatePasses.get(id) ?? null });
const deps: AppDeps = {
  config,
  store,
  push,
  sessions: createSessions(config.sessionSecret, 1),
  verifyPhone: createPhoneVerifier({ firebaseApp: null, devLogin: true }),
  dispatcher,
  walks: createWalks({ store, push, dispatcher, now, subscriptions }),
  maps: null,
  verification: null,
  payments: null,
  subscriptions,
  weather: createOpenMeteoWeather(config.weather, { fetch: fakeWeatherFetch, now }),
  now,
};
const server = createApp(deps).listen(0);
// The same server with WEATHER_ENABLED=false.
const noWeather = createApp({ ...deps, weather: null }).listen(0);

let base = '';
let noWeatherBase = '';
before(() => {
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  noWeatherBase = `http://127.0.0.1:${(noWeather.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  noWeather.close();
});

async function api(method: string, path: string, options: { token?: string; body?: unknown; base?: string } = {}) {
  const response = await fetch((options.base ?? base) + path, {
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

async function login(phone: string, app: 'customer' | 'partner', name: string) {
  const { status, body } = await api('POST', '/auth/phone', { body: { token: `dev:${phone}`, app, name } });
  assert.equal(status, 200, JSON.stringify(body));
  return body as { sessionToken: string; user: { id: string } };
}

// Hiranandani Gardens, Powai, and points due north of it.
const PICKUP = { lat: 19.1176, lng: 72.906, address: 'Tower B, Hiranandani Gardens, Powai' };
const north = (km: number) => ({ lat: Math.round((PICKUP.lat + km / 111.2) * 10_000) / 10_000, lng: PICKUP.lng });

interface TestWalker {
  id: string;
  token: string;
  at: { lat: number; lng: number };
}
const walkers = new Map<string, TestWalker>();
const tokenOf = (id: string) => {
  const found = [...walkers.values()].find((entry) => entry.id === id);
  assert.ok(found, `no walker ${id}`);
  return found.token;
};

/** An approved, online walker (trust tier 2 unless given). */
async function onlineWalker(key: string, phone: string, name: string, at: { lat: number; lng: number }, trustTier = 2) {
  const { sessionToken, user } = await login(phone, 'partner', name);
  assert.equal((await api('PATCH', '/partners/me', { token: sessionToken, body: { area: 'Powai' } })).status, 200);
  assert.equal((await api('POST', '/partners/me/application', { token: sessionToken })).body.partner.approved, true);
  if (trustTier !== 2) await store.update('partners', user.id, { trustTier });
  const online = await api('PUT', '/partners/me/status', { token: sessionToken, body: { online: true, ...at } });
  assert.equal(online.status, 200, JSON.stringify(online.body));
  const walker = { id: user.id, token: sessionToken, at };
  walkers.set(key, walker);
  return walker;
}

/** Every walker reports where they are now (locations go stale after 15 minutes). */
async function refreshWalkers() {
  for (const { token, at } of walkers.values()) {
    assert.equal((await api('PUT', '/partners/me/status', { token, body: { online: true, ...at } })).status, 200);
  }
}

async function pendingOffer(bookingId: string) {
  const offers = await store.find('offers', { bookingId, status: 'pending' });
  assert.equal(offers.length, 1, `one open offer for ${bookingId}`);
  return offers[0]!;
}

async function acceptOffer(bookingId: string) {
  const offer = await pendingOffer(bookingId);
  const accepted = await api('POST', `/offers/${offer.id}/accept`, { token: tokenOf(offer.partnerId) });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  return offer.partnerId;
}

const dog = (temperament: 'friendly' | 'pulls' | 'reactive', name = 'Barnaby') => ({
  name,
  breed: 'Corgi',
  size: 'medium',
  temperament,
});
const SOCIETY = { societyId: 'hiranandani', tower: 'A', flat: '1402' };

// ─── Pricing ────────────────────────────────────────────────────────────────

describe('pricing', () => {
  test('express walks are ₹299 / ₹379 / ₹449 for 30 / 45 / 60 minutes, ₹50 more at peak, 85% to the walker', () => {
    const offPeak = ist(21, 11, 30);
    const morningRush = ist(21, 7, 30);
    const eveningRush = ist(21, 18, 59);
    assert.deepEqual(EXPRESS_MINUTES.map((minutes) => walkFare('express', offPeak, minutes).price), [299, 379, 449]);
    assert.deepEqual(EXPRESS_MINUTES.map((minutes) => walkFare('express', morningRush, minutes).price), [349, 429, 499]);
    assert.deepEqual(EXPRESS_MINUTES.map((minutes) => walkFare('express', eveningRush, minutes).price), [349, 429, 499]);
    // The rush is 7–9 AM and 5–7 PM: 6:59, 9:00 and 7:00 PM are off-peak.
    for (const at of [ist(21, 6, 59), ist(21, 9, 0), ist(21, 19, 0)]) assert.equal(walkFare('express', at, 60).price, 449);
    assert.deepEqual(walkFare('express', offPeak, 45), { price: 379, payout: 322.15, minutes: 45 });
    assert.deepEqual(walkFare('express', morningRush, 60), { price: 499, payout: 424.15, minutes: 60 });
    assert.deepEqual(walkFare('express', offPeak), { price: 299, payout: 254.15, minutes: 30 });
    // Pack and trial walks don't change at peak.
    assert.deepEqual(walkFare('subscription', morningRush), { price: 120, payout: 102, minutes: 30 });
    assert.deepEqual(walkFare('trial', morningRush), { price: 99, payout: 84.15, minutes: 15 });
    assert.equal(checkoutAmount('express', eveningRush, 45), 429);
    assert.equal(checkoutAmount('subscription', eveningRush), 3120);
  });

  test('pack slots are the morning and evening half hours, labelled as their block', () => {
    assert.deepEqual(PACK_SLOT_MINUTES, [360, 390, 420, 450, 480, 510, 540, 1020, 1050, 1080, 1110, 1140, 1170, 1200]);
    assert.equal(slotLabel(420), '7:00 – 7:30 AM');
    assert.equal(slotLabel(1170), '7:30 – 8:00 PM');
    assert.equal(slotLabel(705), '11:45 AM – 12:15 PM');
  });

  test('GET /pricing is public and prices any moment', async () => {
    const offPeak = await api('GET', '/pricing');
    assert.equal(offPeak.status, 200);
    assert.deepEqual({ ...offPeak.body, subscription: { ...offPeak.body.subscription, slots: undefined } }, {
      currency: 'INR',
      peak: false,
      peakWindows: ['07:00–09:00', '17:00–19:00'],
      express: [
        { minutes: 30, price: 299 },
        { minutes: 45, price: 379 },
        { minutes: 60, price: 449 },
      ],
      subscription: { perWalk: 120, walks: 26, total: 3120, minutes: 30, slots: undefined },
      trial: { price: 99, minutes: 15 },
    });
    // The apps' batches: starts 6:00–9:00 AM and 5:00–8:00 PM, every half hour.
    assert.equal(offPeak.body.subscription.slots.length, 14);
    assert.deepEqual(offPeak.body.subscription.slots[0], { slotMinute: 360, label: '6:00 – 6:30 AM' });
    assert.deepEqual(offPeak.body.subscription.slots[6], { slotMinute: 540, label: '9:00 – 9:30 AM' });
    assert.deepEqual(offPeak.body.subscription.slots[13], { slotMinute: 1200, label: '8:00 – 8:30 PM' });

    const rush = await api('GET', `/pricing?at=${ist(21, 17, 15)}`);
    assert.equal(rush.body.peak, true);
    assert.deepEqual(rush.body.express.map((entry: { price: number }) => entry.price), [349, 429, 499]);

    const bad = await api('GET', '/pricing?at=soon');
    assert.deepEqual([bad.status, bad.body.error.code], [400, 'invalid_input']);
  });

  test('POST /bookings takes 30, 45 or 60 minutes for express, and only the tier’s own length otherwise', async () => {
    const { sessionToken: token } = await login('+919833300001', 'customer', 'Nisha');
    const book = (body: Record<string, unknown>) =>
      api('POST', '/bookings', { token, body: { dog: dog('friendly'), pickup: PICKUP, ...body } });

    const long = await book({ tier: 'express', minutes: 45 });
    assert.equal(long.status, 201, JSON.stringify(long.body));
    assert.deepEqual([long.body.booking.minutes, long.body.booking.price, long.body.booking.payout, long.body.booking.payment.amount], [45, 379, 322.15, 379]);

    // Peak is judged at the walk's time.
    const rush = await book({ tier: 'express', minutes: 60, scheduledFor: ist(22, 18, 0) });
    assert.deepEqual([rush.body.booking.minutes, rush.body.booking.price], [60, 499]);
    await api('POST', `/bookings/${rush.body.booking.id}/cancel`, { token });

    const plain = await book({ tier: 'express' });
    assert.deepEqual([plain.body.booking.minutes, plain.body.booking.price], [30, 299]);

    const trial = await book({ tier: 'trial', minutes: 15 });
    assert.deepEqual([trial.status, trial.body.booking.minutes, trial.body.booking.price], [201, 15, 99]);

    for (const body of [
      { tier: 'express', minutes: 20 },
      { tier: 'express', minutes: 30.5 },
      { tier: 'trial', minutes: 30 },
      { tier: 'subscription', minutes: 45 },
    ]) {
      const refused = await book(body);
      assert.deepEqual([refused.status, refused.body.error.code], [400, 'minutes_not_allowed'], JSON.stringify(body));
    }
  });
});

// ─── Walkers near a place ───────────────────────────────────────────────────

describe('walkers near a place', () => {
  let customer: { sessionToken: string; user: { id: string } };

  test('counts online walkers whose radius covers the point, eligible ones for a temperament, and an arrival window', async () => {
    customer = await login('+919833300010', 'customer', 'Meera');
    // Asha is closest but only cleared for friendly dogs.
    await onlineWalker('asha', '+919833300101', 'Asha Patil', north(0.3), 1);
    await onlineWalker('rohan', '+919833300102', 'Rohan Deshmukh', north(0.6));
    await onlineWalker('pratik', '+919833300103', 'Pratik Kulkarni', north(0.9));
    await onlineWalker('kiran', '+919833300104', 'Kiran Rao', north(1.2));
    // Not counted: a stale location, offline, and too far for their 3 km radius.
    const stale = await onlineWalker('stale', '+919833300105', 'Old Position', north(0.2));
    await store.update('partners', stale.id, { location: { ...north(0.2), at: clock - 20 * 60_000 } });
    const offline = await onlineWalker('offline', '+919833300106', 'Gone Home', north(0.2));
    await api('PUT', '/partners/me/status', { token: offline.token, body: { online: false } });
    const away = await onlineWalker('away', '+919833300107', 'Far Away', north(5));

    const all = await api('GET', `/walkers/nearby?lat=${PICKUP.lat}&lng=${PICKUP.lng}`, { token: customer.sessionToken });
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.deepEqual(all.body, { count: 4, eligible: 4, nearestKm: 0.3, arrival: { minMinutes: 15, maxMinutes: 30 } });

    const reactive = await api('GET', `/walkers/nearby?lat=${PICKUP.lat}&lng=${PICKUP.lng}&temperament=reactive`, { token: customer.sessionToken });
    // Rohan, 0.6 km: 8 minutes' walk + 10 → 20–35.
    assert.deepEqual(reactive.body, { count: 4, eligible: 3, nearestKm: 0.6, arrival: { minMinutes: 20, maxMinutes: 35 } });

    const friendly = await api('GET', `/walkers/nearby?lat=${PICKUP.lat}&lng=${PICKUP.lng}&temperament=friendly`, { token: customer.sessionToken });
    assert.equal(friendly.body.eligible, 4);

    // Never who or where.
    const text = JSON.stringify([all.body, reactive.body]);
    for (const walker of walkers.values()) assert.ok(!text.includes(walker.id));
    assert.ok(!/Rohan|Asha|lat|lng/.test(text));

    for (const id of [stale.id, offline.id, away.id]) await store.delete('partners', id);
    for (const key of ['stale', 'offline', 'away']) walkers.delete(key);
  });

  test('nobody around means no arrival window; it needs a customer session and a valid point', async () => {
    const pune = await api('GET', '/walkers/nearby?lat=18.52&lng=73.85', { token: customer.sessionToken });
    assert.deepEqual(pune.body, { count: 0, eligible: 0, nearestKm: null, arrival: null });

    assert.equal((await api('GET', `/walkers/nearby?lat=${PICKUP.lat}&lng=${PICKUP.lng}`)).status, 401);
    assert.equal((await api('GET', `/walkers/nearby?lat=${PICKUP.lat}&lng=${PICKUP.lng}`, { token: walkers.get('rohan')!.token })).status, 403);
    const bad = await api('GET', '/walkers/nearby?lat=north&lng=72.9', { token: customer.sessionToken });
    assert.deepEqual([bad.status, bad.body.error.code], [400, 'invalid_input']);
    const badTemperament = await api('GET', `/walkers/nearby?lat=${PICKUP.lat}&lng=${PICKUP.lng}&temperament=grumpy`, { token: customer.sessionToken });
    assert.equal(badTemperament.status, 400);
  });

  test('arrival is walking time at 4.5 km/h + 10 minutes, rounded to 5, a 15-minute window inside 10–120', () => {
    assert.deepEqual(arrivalWindow(0), { minMinutes: 10, maxMinutes: 25 });
    assert.deepEqual(arrivalWindow(0.4), { minMinutes: 15, maxMinutes: 30 });
    assert.deepEqual(arrivalWindow(5), { minMinutes: 75, maxMinutes: 90 });
    assert.deepEqual(arrivalWindow(50), { minMinutes: 105, maxMinutes: 120 });
  });
});

// ─── Monthly packs ──────────────────────────────────────────────────────────

describe('monthly packs on the home screen', () => {
  let meera: string;
  let packId: string;
  let firstWalk: { id: string; pickupOtp: string };
  const pack = async () => {
    const list = await api('GET', '/subscriptions', { token: meera });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const found = list.body.subscriptions.find((entry: { id: string }) => entry.id === packId);
    assert.ok(found);
    return found;
  };
  const packWalkOn = async (scheduledFor: number) => {
    const found = (await store.find('bookings', { subscriptionId: packId })).find((walk) => walk.scheduledFor === scheduledFor);
    assert.ok(found, `a pack walk at ${new Date(scheduledFor).toISOString()}`);
    return found;
  };

  test('a pack shows its progress, time, next walk and the pickup OTP', async () => {
    meera = (await login('+919833300010', 'customer', 'Meera')).sessionToken;
    const created = await api('POST', '/bookings', {
      token: meera,
      body: { tier: 'subscription', scheduledFor: ist(22, 7, 0), dog: dog('pulls'), pickup: PICKUP, society: SOCIETY },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    firstWalk = created.body.booking;
    packId = created.body.booking.subscriptionId;
    assert.ok(packId);

    const view = await pack();
    assert.deepEqual(
      {
        status: view.status,
        walksTotal: view.walksTotal,
        walksBooked: view.walksBooked,
        walksDone: view.walksDone,
        walksLeft: view.walksLeft,
        perWalk: view.perWalk,
        slotMinute: view.slotMinute,
        slotLabel: view.slotLabel,
        skipDates: view.skipDates,
        walker: view.walker,
        backup: view.backup,
      },
      {
        status: 'active',
        walksTotal: 26,
        walksBooked: 1,
        walksDone: 0,
        walksLeft: 25,
        perWalk: 120,
        slotMinute: 420,
        slotLabel: '7:00 – 7:30 AM',
        skipDates: [],
        walker: null,
        backup: null,
      }
    );
    assert.deepEqual(view.nextWalk, {
      bookingId: firstWalk.id,
      scheduledFor: ist(22, 7, 0),
      date: '2026-10-22',
      status: 'searching',
      pickupOtp: firstWalk.pickupOtp,
    });
    assert.deepEqual(view.dog, { ...dog('pulls'), notes: '' });
    assert.deepEqual(view.society, SOCIETY);
    assert.equal(view.primaryWalkerId, undefined, 'internal walker ids stay internal');
  });

  test('the first walker to accept becomes the pack’s walker; the closest other qualified walker is the backup', async () => {
    clock = ist(22, 6, 20);
    await refreshWalkers();
    gatePasses.set(walkers.get('rohan')!.id, 'MYGATE-4092');
    await dispatcher.offerNext(firstWalk.id);
    // Asha is closer but isn't cleared for a dog that pulls.
    assert.equal(await acceptOffer(firstWalk.id), walkers.get('rohan')!.id);

    const view = await pack();
    assert.deepEqual(view.walker, {
      id: walkers.get('rohan')!.id,
      name: 'Rohan Deshmukh',
      initials: 'RD',
      rating: null,
      verified: true,
      gatePass: '4092',
    });
    assert.deepEqual(view.backup, { id: walkers.get('pratik')!.id, name: 'Pratik K.', initials: 'PK' });
    assert.equal(view.nextWalk.status, 'assigned');
    assert.equal(view.nextWalk.pickupOtp, firstWalk.pickupOtp);

    const booking = await api('GET', `/bookings/${firstWalk.id}`, { token: meera });
    assert.deepEqual(booking.body.booking.walker, { id: walkers.get('rohan')!.id, name: 'Rohan Deshmukh', initials: 'RD', rating: null, verified: true });
    assert.equal(booking.body.booking.distanceKm, null);
    assert.equal(JSON.stringify(booking.body.booking.walker).includes('+91'), false, 'no phone number');
  });

  test('a finished walk stores its walked distance, hides the OTP once started, and ratings build the walker’s average', async () => {
    const rohan = walkers.get('rohan')!;
    const started = await api('POST', `/bookings/${firstWalk.id}/start`, { token: rohan.token, body: { otp: firstWalk.pickupOtp } });
    assert.equal(started.body.booking.status, 'active');
    const during = await pack();
    assert.deepEqual([during.nextWalk.status, during.nextWalk.pickupOtp], ['active', null]);

    const route = [north(0.6), north(0.7), north(0.9)];
    for (const point of route) {
      clock += 5_000;
      assert.equal((await api('POST', `/bookings/${firstWalk.id}/location`, { token: rohan.token, body: point })).status, 204);
    }
    const walking = await api('GET', `/bookings/${firstWalk.id}`, { token: meera });
    assert.equal(walking.body.booking.distanceKm, null, 'only once the walk is completed');
    clock += 25 * 60_000;
    const done = await api('POST', `/bookings/${firstWalk.id}/complete`, { token: rohan.token });
    // 0.6 → 0.7 → 0.9 km north: 0.3 km along the route.
    assert.equal(done.body.booking.distanceKm, routeKm(route));
    assert.equal(done.body.booking.distanceKm, 0.3);

    const rated = await api('POST', `/bookings/${firstWalk.id}/rating`, { token: meera, body: { rating: 5 } });
    assert.deepEqual(rated.body.booking.walker.rating, { average: 5, count: 1 });

    const view = await pack();
    assert.equal(view.walksDone, 1);
    assert.deepEqual(view.nextWalk, { bookingId: null, scheduledFor: ist(23, 7, 0), date: '2026-10-23', status: 'scheduled', pickupOtp: null });

    // A second walk with Rohan, rated 4.
    await refreshWalkers();
    const dev = (await login('+919833300011', 'customer', 'Dev')).sessionToken;
    const express = await api('POST', '/bookings', {
      token: dev,
      body: { tier: 'express', dog: dog('pulls', 'Simba'), pickup: { ...north(0.6), address: 'Tower D, Hiranandani Gardens' } },
    });
    assert.equal(await acceptOffer(express.body.booking.id), rohan.id);
    await api('POST', `/bookings/${express.body.booking.id}/start`, { token: rohan.token, body: { otp: express.body.booking.pickupOtp } });
    await api('POST', `/bookings/${express.body.booking.id}/complete`, { token: rohan.token });
    await api('POST', `/bookings/${express.body.booking.id}/rating`, { token: dev, body: { rating: 4 } });

    const profile = await api('GET', '/partners/me', { token: rohan.token });
    assert.deepEqual([profile.body.partner.ratingSum, profile.body.partner.ratingCount], [9, 2]);
    const history = await api('GET', '/bookings', { token: dev });
    assert.deepEqual(history.body.bookings[0].walker.rating, { average: 4.5, count: 2 });
    assert.equal(history.body.bookings[0].distanceKm, 0, 'a walk without route points walked 0 km');
    assert.deepEqual((await pack()).walker.rating, { average: 4.5, count: 2 });
    // Averages keep 2 decimals.
    assert.deepEqual(ratingOf({ ratingSum: 13, ratingCount: 3 } as Partner), { average: 4.33, count: 3 });
    assert.equal(ratingOf({} as Partner), null);
    assert.deepEqual([initials('Rohan Deshmukh'), initials('rohan'), shortName('Pratik Kulkarni'), shortName('Pratik')], ['RD', 'R', 'Pratik K.', 'Pratik']);
  });

  test('a backup who stops qualifying is replaced by the next closest', async () => {
    await store.update('partners', walkers.get('pratik')!.id, { trustTier: 1 });
    const view = await pack();
    assert.deepEqual(view.backup, { id: walkers.get('kiran')!.id, name: 'Kiran R.', initials: 'KR' });
    assert.equal(view.walker.id, walkers.get('rohan')!.id);
  });

  test('pack walks are offered to the primary walker first, then the backup, then the nearest', async () => {
    clock = ist(22, 19, 30);
    assert.equal(await subscriptions.sweep(), 1);
    const second = await packWalkOn(ist(23, 7, 0));

    // Zoya is now the closest walker of all.
    await onlineWalker('zoya', '+919833300108', 'Zoya Khan', north(0.1));
    clock = ist(23, 6, 20);
    await refreshWalkers();
    await dispatcher.offerNext(second.id);

    const toPrimary = await pendingOffer(second.id);
    assert.equal(toPrimary.partnerId, walkers.get('rohan')!.id);
    assert.equal((await api('POST', `/offers/${toPrimary.id}/decline`, { token: walkers.get('rohan')!.token })).status, 204);

    const toBackup = await pendingOffer(second.id);
    assert.equal(toBackup.partnerId, walkers.get('kiran')!.id);
    assert.equal((await api('POST', `/offers/${toBackup.id}/decline`, { token: walkers.get('kiran')!.token })).status, 204);

    assert.equal(await acceptOffer(second.id), walkers.get('zoya')!.id);
    const view = await pack();
    assert.equal(view.walker.id, walkers.get('rohan')!.id, 'the primary is set by the first acceptance only');
    assert.equal(view.backup.id, walkers.get('kiran')!.id);
  });

  test('skipping a booked walk cancels it, credits it back to the pack and tells the walker', async () => {
    const second = await packWalkOn(ist(23, 7, 0));
    const skipped = await api('POST', `/subscriptions/${packId}/skip`, { token: meera });
    assert.equal(skipped.status, 200, JSON.stringify(skipped.body));
    const view = skipped.body.subscription;
    assert.deepEqual([view.walksBooked, view.walksLeft, view.skipDates], [1, 25, ['2026-10-23']]);
    assert.deepEqual(view.nextWalk, { bookingId: null, scheduledFor: ist(24, 7, 0), date: '2026-10-24', status: 'scheduled', pickupOtp: null });
    assert.equal((await store.get('bookings', second.id))!.status, 'cancelled');
    const told = push.sent.at(-1)!;
    assert.deepEqual([told.userId, told.app, told.title], [walkers.get('zoya')!.id, 'partner', 'Walk cancelled']);

    // Skipping the same day again changes nothing.
    const sent = push.sent.length;
    const again = await api('POST', `/subscriptions/${packId}/skip`, { token: meera, body: { date: '2026-10-23' } });
    assert.deepEqual([again.status, again.body.subscription.skipDates, again.body.subscription.walksBooked], [200, ['2026-10-23'], 1]);
    assert.equal(push.sent.length, sent);
  });

  test('skipping a day that isn’t booked yet makes the generator pass over it', async () => {
    const ahead = await api('POST', `/subscriptions/${packId}/skip`, { token: meera, body: { date: '2026-10-25' } });
    assert.equal(ahead.status, 200, JSON.stringify(ahead.body));
    assert.deepEqual([ahead.body.subscription.skipDates, ahead.body.subscription.walksBooked], [['2026-10-23', '2026-10-25'], 1]);

    clock = ist(23, 19, 30);
    assert.equal(await subscriptions.sweep(), 1);
    await packWalkOn(ist(24, 7, 0));

    clock = ist(24, 19, 30);
    assert.equal(await subscriptions.sweep(), 0, 'the 25th is skipped');
    // The 24th's walk was never started and its time is over, so the next walk is the 26th.
    assert.equal((await pack()).nextWalk.date, '2026-10-26');

    clock = ist(25, 19, 30);
    assert.equal(await subscriptions.sweep(), 1);
    await packWalkOn(ist(26, 7, 0));
    const view = await pack();
    assert.deepEqual([view.skipDates, view.walksBooked], [['2026-10-25'], 3]);
    assert.equal((await store.get('subscriptions', packId))!.skipDates!.includes('2026-10-23'), false, 'past days are dropped');
  });

  test('skips are refused for a past day, a started walk or a stopped pack', async () => {
    const refuse = async (body: unknown, status = 409, code = 'cannot_skip', token = meera) => {
      const response = await api('POST', `/subscriptions/${packId}/skip`, { token, body });
      assert.deepEqual([response.status, response.body.error?.code], [status, code], JSON.stringify(body));
    };
    await refuse({ date: '2026-10-24' });
    await refuse({ date: '2026-12-31' });
    await refuse({ date: '2026-13-01' }, 400, 'invalid_input');
    await refuse({}, 404, 'not_found', (await login('+919833300012', 'customer', 'Stranger')).sessionToken);

    const fourth = await packWalkOn(ist(26, 7, 0));
    clock = ist(26, 6, 20);
    await refreshWalkers();
    await dispatcher.offerNext(fourth.id);
    assert.equal(await acceptOffer(fourth.id), walkers.get('rohan')!.id, 'the primary walker is asked first');
    await api('POST', `/bookings/${fourth.id}/start`, { token: walkers.get('rohan')!.token, body: { otp: fourth.pickupOtp } });
    await refuse({});
    await refuse({ date: '2026-10-26' });

    const cancelled = await api('POST', `/subscriptions/${packId}/cancel`, { token: meera });
    assert.deepEqual([cancelled.body.subscription.status, cancelled.body.subscription.slotLabel], ['cancelled', '7:00 – 7:30 AM']);
    assert.equal(cancelled.body.subscription.nextWalk.status, 'active');
    await refuse({ date: '2026-10-28' });
    const patch = await api('PATCH', `/subscriptions/${packId}`, { token: meera, body: { slotMinute: 1080 } });
    assert.deepEqual([patch.status, patch.body.error.code], [409, 'pack_cancelled']);
  });

  test('changing the daily time moves walks without a walker and keeps assigned ones', async () => {
    clock = ist(26, 12, 0);
    const kabir = (await login('+919833300013', 'customer', 'Kabir')).sessionToken;
    const created = await api('POST', '/bookings', {
      token: kabir,
      body: { tier: 'subscription', scheduledFor: ist(27, 7, 0), dog: dog('friendly', 'Coco'), pickup: PICKUP },
    });
    const id = created.body.booking.subscriptionId as string;
    const first = created.body.booking.id as string;
    const change = (slotMinute: unknown) => api('PATCH', `/subscriptions/${id}`, { token: kabir, body: { slotMinute } });

    for (const slotMinute of [425, 570, 1230, 300]) {
      const refused = await change(slotMinute);
      assert.deepEqual([refused.status, refused.body.error.code], [400, 'invalid_slot'], String(slotMinute));
    }
    assert.equal((await change('18:00')).body.error.code, 'invalid_input');

    // Dispatch has started (an offer is out) when the time moves to 6 PM.
    clock = ist(27, 6, 20);
    await refreshWalkers();
    await dispatcher.offerNext(first);
    const offer = await pendingOffer(first);
    const evening = await change(1080);
    assert.equal(evening.status, 200, JSON.stringify(evening.body));
    assert.deepEqual([evening.body.subscription.slotMinute, evening.body.subscription.slotLabel], [1080, '6:00 – 6:30 PM']);
    assert.equal(evening.body.subscription.nextWalk.scheduledFor, ist(27, 18, 0));
    const moved = (await store.get('bookings', first))!;
    assert.deepEqual([moved.scheduledFor, moved.offeredTo], [ist(27, 18, 0), []]);
    assert.equal((await store.get('offers', offer.id))!.status, 'withdrawn');

    // Assigned walks keep their time.
    clock = ist(27, 17, 20);
    await refreshWalkers();
    await dispatcher.offerNext(first);
    await acceptOffer(first);
    const morning = await change(390);
    assert.deepEqual([morning.body.subscription.slotLabel, morning.body.subscription.nextWalk.scheduledFor], ['6:30 – 7:00 AM', ist(27, 18, 0)]);
    assert.equal((await store.get('bookings', first))!.scheduledFor, ist(27, 18, 0));

    // The next walk generated uses the new time.
    clock = ist(27, 18, 40);
    assert.equal(await subscriptions.sweep(), 1);
    const next = (await store.find('bookings', { subscriptionId: id })).find((walk) => walk.id !== first)!;
    assert.equal(next.scheduledFor, ist(28, 6, 30));

    // A walk whose new time has already passed keeps its time; the pack's time still changes.
    clock = ist(28, 6, 20);
    const early = await change(360);
    assert.equal(early.body.subscription.slotMinute, 360);
    assert.equal((await store.get('bookings', next.id))!.scheduledFor, ist(28, 6, 30));
    assert.equal((await change(360)).status, 200, 'the same time again is fine');
  });
});

// ─── Weather ────────────────────────────────────────────────────────────────

describe('weather', () => {
  test('WMO codes map to our conditions and icons', () => {
    const cases: [number, string][] = [
      [0, 'clear'], [1, 'clear'], [2, 'partly-cloudy'], [3, 'cloudy'], [45, 'fog'], [48, 'fog'], [53, 'drizzle'],
      [57, 'drizzle'], [63, 'rain'], [67, 'rain'], [81, 'rain'], [75, 'snow'], [86, 'snow'], [95, 'thunderstorm'],
      [99, 'thunderstorm'], [42, 'cloudy'],
    ];
    for (const [code, condition] of cases) assert.equal(conditionFor(code), condition, `code ${code}`);
    assert.deepEqual([iconFor('clear'), iconFor('clear', false), iconFor('rain', false)], ['☀️', '🌙', '🌧️']);
  });

  test('readings are fetched once per ~1 km cell and kept for 15 minutes', async () => {
    let at = 1_000_000;
    const calls: URL[] = [];
    const weather = createOpenMeteoWeather(
      { enabled: true, url: 'https://weather.test/v1/forecast?apikey=paid-key' },
      {
        fetch: (async (input: string | URL | Request) => {
          calls.push(new URL(String(input)));
          return Response.json({ current: { temperature_2m: 27.6, weather_code: 2, is_day: 0 } });
        }) as typeof fetch,
        now: () => at,
      }
    );
    // Three people in one cell at once: one request.
    const [reading] = await Promise.all([
      weather.current({ lat: 19.1176, lng: 72.906 }),
      weather.current({ lat: 19.1201, lng: 72.9089 }),
      weather.current({ lat: 19.12, lng: 72.91 }),
    ]);
    assert.deepEqual(reading, { tempC: 28, condition: 'partly-cloudy', icon: '☁️', updatedAt: 1_000_000 });
    assert.equal(calls.length, 1);
    assert.deepEqual(
      ['latitude', 'longitude', 'current', 'apikey'].map((key) => calls[0]!.searchParams.get(key)),
      ['19.12', '72.91', 'temperature_2m,weather_code,is_day', 'paid-key']
    );

    // Later in the same cell: from the cache.
    at += WEATHER_CACHE_MS - 1;
    assert.equal((await weather.current(PICKUP)).updatedAt, 1_000_000);
    assert.equal(calls.length, 1);
    await weather.current({ lat: 19.13, lng: 72.91 });
    assert.equal(calls.length, 2, 'another cell is asked separately');

    at += 2;
    assert.equal((await weather.current(PICKUP)).updatedAt, at, 'refetched after 15 minutes');
    assert.equal(calls.length, 3);
  });

  test('an upstream failure is a 503 weather_unavailable, retried after a minute', async () => {
    let at = 0;
    let answer: () => Response | Promise<Response> = () => new Response('down', { status: 502 });
    let calls = 0;
    const weather = createOpenMeteoWeather(config.weather, {
      fetch: (async () => {
        calls += 1;
        return answer();
      }) as typeof fetch,
      now: () => at,
    });
    const unavailable = (error: unknown) => error instanceof HttpError && error.status === 503 && error.code === 'weather_unavailable';
    await assert.rejects(weather.current(PICKUP), unavailable);
    await assert.rejects(weather.current(PICKUP), unavailable);
    assert.equal(calls, 1, 'a failure is remembered briefly');

    at += 61_000;
    answer = () => Response.json({ current: { temperature_2m: 'warm' } });
    await assert.rejects(weather.current(PICKUP), unavailable, 'a reply without a reading');
    at += 61_000;
    answer = () => Promise.reject(new TypeError('fetch failed'));
    await assert.rejects(weather.current(PICKUP), unavailable, 'no network');
    at += 61_000;
    answer = () => Response.json({ current: { temperature_2m: 31.2, weather_code: 95, is_day: 1 } });
    assert.deepEqual(await weather.current(PICKUP), { tempC: 31, condition: 'thunderstorm', icon: '⛈️', updatedAt: at });
    assert.equal(calls, 4);
  });

  test('GET /weather needs a customer session, and answers 503 when weather is off', async () => {
    const customer = (await login('+919833300020', 'customer', 'Asha')).sessionToken;
    const reading = await api('GET', `/weather?lat=${PICKUP.lat}&lng=${PICKUP.lng}`, { token: customer });
    assert.equal(reading.status, 200, JSON.stringify(reading.body));
    assert.deepEqual(reading.body, { tempC: 28, condition: 'partly-cloudy', icon: '⛅', updatedAt: clock });
    assert.equal(weatherCalls[0]!.host, 'api.open-meteo.com');

    assert.equal((await api('GET', `/weather?lat=${PICKUP.lat}&lng=${PICKUP.lng}`)).status, 401);
    assert.equal((await api('GET', '/weather?lat=95&lng=72.9', { token: customer })).status, 400);

    const off = await api('GET', `/weather?lat=${PICKUP.lat}&lng=${PICKUP.lng}`, { token: customer, base: noWeatherBase });
    assert.deepEqual([off.status, off.body.error.code], [503, 'weather_unavailable']);

    weatherReply = () => new Response('busy', { status: 429 });
    const failing = await api('GET', '/weather?lat=28.61&lng=77.21', { token: customer });
    assert.deepEqual([failing.status, failing.body.error.code], [503, 'weather_unavailable']);
  });

  test('WEATHER_ENABLED and WEATHER_URL configure it', () => {
    assert.deepEqual(loadConfig({ NODE_ENV: 'test' }).weather, { enabled: true, url: 'https://api.open-meteo.com/v1/forecast' });
    assert.equal(loadConfig({ NODE_ENV: 'test', WEATHER_ENABLED: 'false' }).weather.enabled, false);
    assert.equal(loadConfig({ NODE_ENV: 'test', WEATHER_URL: 'https://weather.example/v1/forecast' }).weather.url, 'https://weather.example/v1/forecast');
    assert.throws(() => loadConfig({ NODE_ENV: 'test', WEATHER_URL: 'open-meteo' }), /WEATHER_URL/);
  });
});
