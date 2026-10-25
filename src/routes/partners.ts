import { Router } from 'express';
import { z } from 'zod';
import { requireSession, sessionOf } from '../auth/middleware.ts';
import { istDate, istDayStart } from '../domain/pricing.ts';
import type { Partner } from '../domain/types.ts';

const DAY_MS = 24 * 60 * 60_000;
import { bookingView } from '../domain/walks.ts';
import { badRequest, forbidden, notFound } from '../http/errors.ts';
import { latitude, longitude, parse } from '../http/validate.ts';
import { logger } from '../log/logger.ts';
import type { AppDeps } from '../app.ts';

const log = logger('partner');

const tags = z.array(z.string().trim().min(1).max(40)).max(20);

const profileUpdate = z
  .object({
    name: z.string().trim().min(1).max(80),
    area: z.string().trim().min(2).max(120),
    roles: tags,
    sizes: tags,
    skills: tags,
    availability: tags,
    /** Rupees: the smallest payout per walk you'll accept. */
    walkRate: z.number().min(0).max(5_000),
    hourlyRate: z.number().min(0).max(10_000),
    radiusKm: z.number().min(0.5).max(25),
    /** UPI ID for weekly payouts. */
    payoutVpa: z
      .string()
      .trim()
      .regex(/^[\w.-]{2,256}@[a-zA-Z]{2,64}$/, 'Enter a UPI ID like name@okhdfcbank.')
      .nullable(),
  })
  .partial();

const status = z
  .object({ online: z.boolean(), lat: latitude.optional(), lng: longitude.optional() })
  .refine((value) => !value.online || (value.lat !== undefined && value.lng !== undefined), {
    message: 'Going online needs your current lat and lng.',
  });

/** The walker side: profile, application, going online, and answering walk requests. */
export function partnerRoutes({ store, sessions, dispatcher, config, now }: AppDeps): Router {
  const router = Router();
  router.use(['/partners', '/offers'], requireSession(sessions, 'partner'));

  async function loadPartner(userId: string): Promise<Partner> {
    const partner = await store.get('partners', userId);
    if (!partner) throw notFound('Partner profile');
    return partner;
  }

  router.get('/partners/me', async (_req, res) => {
    res.json({ partner: await loadPartner(sessionOf(res).userId) });
  });

  router.patch('/partners/me', async (req, res) => {
    const { userId } = sessionOf(res);
    const patch = parse(profileUpdate, req.body);
    const partner: Partner = { ...(await loadPartner(userId)), ...patch, updatedAt: now() };
    // Only the edited fields, so a rating or position saved meanwhile isn't overwritten.
    await store.update('partners', userId, { ...patch, updatedAt: partner.updatedAt });
    res.json({ partner });
  });

  /**
   * "Submit Partner Application". With the verification pipeline on, approval and trust tier come
   * from its gates; without it, AUTO_APPROVE_PARTNERS clears walkers for all dogs.
   */
  router.post('/partners/me/application', async (_req, res) => {
    const { userId } = sessionOf(res);
    const current = await loadPartner(userId);
    if (!current.name || !current.area) throw badRequest('incomplete_profile', 'Add your name and service area first.');
    const autoApprove = config.autoApprovePartners && !config.verification;
    const partner: Partner = {
      ...current,
      applicationSubmittedAt: current.applicationSubmittedAt ?? now(),
      approved: current.approved || autoApprove,
      trustTier: autoApprove ? Math.max(current.trustTier ?? 0, 2) : (current.trustTier ?? 0),
      updatedAt: now(),
    };
    const { applicationSubmittedAt, approved, trustTier, updatedAt } = partner;
    await store.update('partners', userId, { applicationSubmittedAt, approved, trustTier, updatedAt });
    log.info('Application submitted', { walker: userId, approved: partner.approved, trustTier: partner.trustTier });
    res.json({ partner });
  });

  /** The online toggle. Going offline hands any waiting request to the next walker. */
  router.put('/partners/me/status', async (req, res) => {
    const { userId } = sessionOf(res);
    const body = parse(status, req.body);
    const current = await loadPartner(userId);
    if (body.online && !current.approved) throw forbidden('Your application hasn’t been approved yet.');
    const at = now();
    const partner: Partner = {
      ...current,
      online: body.online,
      location: body.lat !== undefined && body.lng !== undefined ? { lat: body.lat, lng: body.lng, at } : current.location,
      updatedAt: at,
    };
    // Sent every minute while online: only these fields, so a rating saved meanwhile isn't overwritten.
    await store.update('partners', userId, { online: partner.online, location: partner.location, updatedAt: at });
    if (body.online !== current.online) {
      log.info(body.online ? 'Walker online' : 'Walker offline', { walker: userId, lat: body.lat, lng: body.lng });
    } else if (body.online) {
      log.debug('Walker location', { walker: userId, lat: body.lat, lng: body.lng });
    }
    if (!body.online) {
      for (const bookingId of await dispatcher.withdrawPending({ partnerId: userId })) await dispatcher.offerNext(bookingId);
    }
    res.json({ partner });
  });

  /** Requests waiting for this walker's answer, with what they need to decide. */
  router.get('/partners/me/offers', async (_req, res) => {
    const { userId } = sessionOf(res);
    const at = now();
    const pending = (await store.find('offers', { partnerId: userId, status: 'pending' })).filter(
      (offer) => offer.expiresAt > at
    );
    const offers = await Promise.all(
      pending.map(async (offer) => {
        const booking = await store.get('bookings', offer.bookingId);
        return booking ? { ...offer, booking: bookingView(booking, 'partner') } : null;
      })
    );
    res.json({ offers: offers.filter((offer) => offer !== null) });
  });

  /** Completed walks' payouts per India-time day (`?days=7`, up to 31) and all-time totals. */
  router.get('/partners/me/earnings', async (req, res) => {
    const { userId } = sessionOf(res);
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(31).default(7) }), req.query);
    const walks = await store.find('bookings', { partnerId: userId, status: 'completed' });
    const firstDay = istDayStart(now()) - (days - 1) * DAY_MS;
    const buckets = Array.from({ length: days }, (_, index) => ({ date: istDate(firstDay + index * DAY_MS), amount: 0, walks: 0 }));
    let total = 0;
    for (const walk of walks) {
      total += walk.payout;
      const index = Math.floor((istDayStart(walk.completedAt ?? walk.updatedAt) - firstDay) / DAY_MS);
      const bucket = buckets[index];
      if (bucket) {
        bucket.amount = Math.round((bucket.amount + walk.payout) * 100) / 100;
        bucket.walks += 1;
      }
    }
    res.json({ currency: 'INR', days: buckets, totals: { amount: Math.round(total * 100) / 100, walks: walks.length } });
  });

  router.post('/offers/:id/accept', async (req, res) => {
    const outcome = await dispatcher.answer(req.params.id, sessionOf(res).userId, true);
    res.json(outcome.kind === 'accepted' ? { booking: bookingView(outcome.booking, 'partner') } : {});
  });

  router.post('/offers/:id/decline', async (req, res) => {
    await dispatcher.answer(req.params.id, sessionOf(res).userId, false);
    res.status(204).end();
  });

  return router;
}
