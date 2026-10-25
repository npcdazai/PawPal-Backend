import { Router } from 'express';
import { z } from 'zod';
import { requireSession, sessionOf } from '../auth/middleware.ts';
import type { Booking, Partner } from '../domain/types.ts';
import { walkerCard } from '../domain/walkers.ts';
import { bookingView, CANCELLABLE } from '../domain/walks.ts';
import { forbidden, unavailable } from '../http/errors.ts';
import { latitude, longitude, parse } from '../http/validate.ts';
import type { AppDeps } from '../app.ts';

const newBooking = z.object({
  tier: z.enum(['subscription', 'trial', 'express']),
  /** Express: 30, 45 or 60 (default 30); other tiers only their own length (checked by walks.create). */
  minutes: z.number().optional(),
  /** Epoch ms; omit for "now". */
  scheduledFor: z.number().int().positive().optional(),
  dog: z.object({
    name: z.string().trim().min(1).max(40),
    breed: z.string().trim().min(1).max(60),
    size: z.enum(['small', 'medium', 'large', 'giant']),
    temperament: z.enum(['friendly', 'pulls', 'reactive']).default('friendly'),
    notes: z.string().trim().max(500).default(''),
  }),
  pickup: z.object({ lat: latitude, lng: longitude, address: z.string().trim().min(3).max(300) }),
  society: z
    .object({
      societyId: z.string().trim().min(1).max(60),
      tower: z.string().trim().min(1).max(40),
      flat: z.string().trim().min(1).max(20),
    })
    .nullable()
    .optional(),
});

const rating = z.object({ rating: z.number().int().min(1).max(5) });

const otp = z.object({
  otp: z.string().regex(/^\d{4}$/, 'The OTP has 4 digits.'),
  /** From the doorstep selfie (gate 4), when partner verification is on. */
  handshakeToken: z.string().max(2048).optional(),
});

const walkEvent = z.object({
  type: z.enum(['pee', 'poop', 'photo', 'note']),
  lat: latitude.optional(),
  lng: longitude.optional(),
  note: z.string().trim().max(500).optional(),
});

const position = z.object({ lat: latitude, lng: longitude });

/** An India-time day, "2026-10-27". */
const skip = z.object({ date: z.iso.date('Use a date like 2026-10-27.').optional() });

const slot = z.object({ slotMinute: z.number().int() });

/** Walks: booked (and paid) by pet parents, then started, logged and finished by the walker. */
export function bookingRoutes({ store, sessions, walks, payments, subscriptions }: AppDeps): Router {
  const router = Router();

  // YouPI's webhook: authenticated by its signature, so it sits before the session check.
  router.post('/webhooks/youpi', async (req, res) => {
    if (!payments) throw unavailable('payments_off', 'Payments aren’t set up on this server.');
    await payments.webhook((req as typeof req & { rawBody?: Buffer }).rawBody, req.get('x-gateway-signature'));
    res.status(204).end();
  });

  router.use(['/bookings', '/subscriptions'], requireSession(sessions));

  /** The pet parent also sees who their walker is (by name, rating and verification only). */
  const forCustomer = (booking: Booking, partner: Partner | null) => ({
    ...bookingView(booking, 'customer'),
    walker: partner ? walkerCard(partner) : null,
  });

  async function present(booking: Booking, viewer: 'customer' | 'partner') {
    if (viewer === 'partner') return bookingView(booking, viewer);
    return forCustomer(booking, booking.partnerId ? await store.get('partners', booking.partnerId) : null);
  }

  /** A list for either side; for the pet parent each walker is looked up once. */
  async function presentAll(bookings: Booking[], viewer: 'customer' | 'partner') {
    if (viewer === 'partner') return bookings.map((booking) => bookingView(booking, viewer));
    const ids = [...new Set(bookings.map((booking) => booking.partnerId).filter((id): id is string => Boolean(id)))];
    const partners = new Map(await Promise.all(ids.map(async (id) => [id, await store.get('partners', id)] as const)));
    return bookings.map((booking) => forCustomer(booking, booking.partnerId ? (partners.get(booking.partnerId) ?? null) : null));
  }

  const customerOnly = (app: string) => {
    if (app !== 'customer') throw forbidden('Only the pet parent can do that.');
  };
  const partnerOnly = (app: string) => {
    if (app !== 'partner') throw forbidden('Only the walker can do that.');
  };

  router.post('/bookings', async (req, res) => {
    const { userId, app } = sessionOf(res);
    customerOnly(app);
    const booking = await walks.create(userId, parse(newBooking, req.body));
    res.status(201).json({ booking: await present(booking, 'customer') });
  });

  router.get('/bookings', async (_req, res) => {
    const session = sessionOf(res);
    res.json({ bookings: await presentAll(await walks.list(session), session.app) });
  });

  router.get('/bookings/:id', async (req, res) => {
    const session = sessionOf(res);
    res.json({ booking: await present(await walks.get(req.params.id, session), session.app) });
  });

  router.post('/bookings/:id/cancel', async (req, res) => {
    const { userId, app } = sessionOf(res);
    customerOnly(app);
    res.json({ booking: await present(await walks.cancel(userId, req.params.id), 'customer') });
  });

  router.post('/bookings/:id/retry', async (req, res) => {
    const { userId, app } = sessionOf(res);
    customerOnly(app);
    res.json({ booking: await present(await walks.retry(userId, req.params.id), 'customer') });
  });

  router.post('/bookings/:id/start', async (req, res) => {
    const { userId, app } = sessionOf(res);
    partnerOnly(app);
    const body = parse(otp, req.body);
    const booking = await walks.start(userId, req.params.id, body.otp, body.handshakeToken);
    res.json({ booking: bookingView(booking, 'partner') });
  });

  router.post('/bookings/:id/events', async (req, res) => {
    const { userId, app } = sessionOf(res);
    partnerOnly(app);
    const booking = await walks.addEvent(userId, req.params.id, parse(walkEvent, req.body));
    res.status(201).json({ booking: bookingView(booking, 'partner') });
  });

  router.post('/bookings/:id/location', async (req, res) => {
    const { userId, app } = sessionOf(res);
    partnerOnly(app);
    await walks.updateLocation(userId, req.params.id, parse(position, req.body));
    res.status(204).end();
  });

  router.post('/bookings/:id/complete', async (req, res) => {
    const { userId, app } = sessionOf(res);
    partnerOnly(app);
    res.json({ booking: bookingView(await walks.complete(userId, req.params.id), 'partner') });
  });

  router.post('/bookings/:id/rating', async (req, res) => {
    const { userId, app } = sessionOf(res);
    customerOnly(app);
    const booking = await walks.rate(userId, req.params.id, parse(rating, req.body).rating);
    res.json({ booking: await present(booking, 'customer') });
  });

  /** Opens (or reuses) the YouPI checkout for an unpaid booking → `{ checkoutUrl }` for the in-app browser. */
  router.post('/bookings/:id/payment', async (req, res) => {
    const { userId, app } = sessionOf(res);
    customerOnly(app);
    if (!payments) throw unavailable('payments_off', 'Payments aren’t set up on this server.');
    const { checkoutUrl, booking } = await payments.checkout(userId, req.params.id);
    res.json({ checkoutUrl, booking: booking && (await present(booking, 'customer')) });
  });

  /** After the checkout page returns: asks the gateway whether it's paid. */
  router.get('/bookings/:id/payment', async (req, res) => {
    const { userId, app } = sessionOf(res);
    customerOnly(app);
    if (!payments) throw unavailable('payments_off', 'Payments aren’t set up on this server.');
    res.json({ booking: await present(await payments.refresh(userId, req.params.id), 'customer') });
  });

  router.get('/subscriptions', async (_req, res) => {
    const { userId, app } = sessionOf(res);
    customerOnly(app);
    res.json({ subscriptions: await subscriptions.views(userId) });
  });

  /** Skips a day (default: the next walk's): a booked walk is cancelled and credited back to the pack. */
  router.post('/subscriptions/:id/skip', async (req, res) => {
    const { userId, app } = sessionOf(res);
    customerOnly(app);
    const { date } = parse(skip, req.body ?? {});
    const subscription = await subscriptions.skip(userId, req.params.id, date, (bookingId) =>
      walks.cancel(userId, bookingId, CANCELLABLE)
    );
    res.json({ subscription });
  });

  /** Moves the daily time to another batch slot. */
  router.patch('/subscriptions/:id', async (req, res) => {
    const { userId, app } = sessionOf(res);
    customerOnly(app);
    const { slotMinute } = parse(slot, req.body);
    res.json({ subscription: await subscriptions.changeSlot(userId, req.params.id, slotMinute) });
  });

  router.post('/subscriptions/:id/cancel', async (req, res) => {
    const { userId, app } = sessionOf(res);
    customerOnly(app);
    res.json({ subscription: await subscriptions.view(await subscriptions.cancel(userId, req.params.id)) });
  });

  return router;
}
