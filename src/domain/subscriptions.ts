import { badRequest, conflict, HttpError, notFound } from '../http/errors.ts';
import { istTime, logger } from '../log/logger.ts';
import type { Store } from '../store/store.ts';
import { refreshPackWalkers } from './packWalkers.ts';
import { newSubscription } from './packs.ts';
import { FARES, PACK_SLOT_MINUTES, istDate, istDayStart, slotLabel } from './pricing.ts';
import type { Booking, BookingStatus, Subscription } from './types.ts';
import { backupCard, walkerCard } from './walkers.ts';
import { buildBooking, paymentRecord } from './walks.ts';

const DAY_MS = 24 * 60 * 60_000;
/** A pack's next walk is created this long ahead, so it shows in both apps the evening before. */
const GENERATE_AHEAD_MS = 12 * 60 * 60_000;
/** Days can be skipped this far ahead (keeps `skipDates` short). */
const MAX_SKIP_AHEAD_DAYS = 31;
/** Statuses after which a walk is no longer "the next walk". */
const FINISHED: readonly BookingStatus[] = ['completed', 'cancelled'];

const log = logger('pack');

/**
 * The pack's next walk time: the India-time day after the last walk generated, at `slotMinute`; if the
 * server was down past that, the first upcoming occurrence of the slot (missed days aren't booked in
 * the past). Skipped days are passed over.
 */
export function nextSlot(subscription: Subscription, at: number): number {
  let next = istDayStart(subscription.lastScheduledFor) + DAY_MS + subscription.slotMinute * 60_000;
  if (next < at) next += Math.ceil((at - next) / DAY_MS) * DAY_MS;
  const skipped = new Set(subscription.skipDates ?? []);
  for (let days = 0; days <= MAX_SKIP_AHEAD_DAYS + 1 && skipped.has(istDate(next)); days += 1) next += DAY_MS;
  return next;
}

export interface NextWalk {
  /** Null for a walk the generator hasn't booked yet. */
  bookingId: string | null;
  scheduledFor: number;
  /** India-time day, "2026-10-26". */
  date: string;
  status: BookingStatus | 'scheduled';
  /** The pet parent's pickup OTP until the walk starts; null once it has, and for a walk not booked yet. */
  pickupOtp: string | null;
}

/**
 * The pack's earliest walk that isn't over (not completed or cancelled, and either walking now or not
 * yet past its end time), else the day the generator will book next, else null.
 */
export function nextWalkOf(pack: Subscription, bookings: readonly Booking[], at: number): NextWalk | null {
  const booked = bookings
    .filter((walk) => !FINISHED.includes(walk.status) && (walk.status === 'active' || walk.scheduledFor + walk.minutes * 60_000 > at))
    .sort((a, b) => a.scheduledFor - b.scheduledFor)[0];
  if (booked) {
    return {
      bookingId: booked.id,
      scheduledFor: booked.scheduledFor,
      date: istDate(booked.scheduledFor),
      status: booked.status,
      pickupOtp: booked.status === 'active' ? null : booked.pickupOtp,
    };
  }
  if (pack.status !== 'active') return null;
  const scheduledFor = nextSlot(pack, at);
  return { bookingId: null, scheduledFor, date: istDate(scheduledFor), status: 'scheduled', pickupOtp: null };
}

/** `dates` plus `date`, without days before `today`, sorted. */
const withSkip = (dates: readonly string[] | undefined, date: string, today: string) =>
  [...new Set([...(dates ?? []), date])].filter((day) => day >= today).sort();

const cannotSkip = (message: string) => conflict('cannot_skip', message);

export interface SubscriptionsDeps {
  store: Store;
  now: () => number;
  /** The walker's society gate pass number, when the verification pipeline has one (only its last 4 characters are shown). */
  gatePass?: ((partnerId: string) => Promise<string | null>) | null;
}

/** Monthly packs: 26 prepaid walks, one a day at the booked time (India time). */
export function createSubscriptions({ store, now, gatePass = null }: SubscriptionsDeps) {
  async function own(customerId: string, subscriptionId: string): Promise<Subscription> {
    const pack = await store.get('subscriptions', subscriptionId);
    if (!pack || pack.customerId !== customerId) throw notFound('Subscription');
    return pack;
  }

  async function gatePassOf(partnerId: string): Promise<string | null> {
    if (!gatePass) return null;
    try {
      const pass = (await gatePass(partnerId))?.trim();
      return pass ? pass.slice(-4) : null;
    } catch (error) {
      log.warn('Gate pass lookup failed; shown without it', { walker: partnerId, error });
      return null;
    }
  }

  /** What the pet parent's app shows for a pack (see docs/DASHBOARD_API.md §4). */
  async function view(pack: Subscription) {
    const at = now();
    // A cancelled pack keeps the walkers it had; a failed refresh shows the walkers as saved.
    const current =
      pack.status === 'cancelled'
        ? pack
        : ((await refreshPackWalkers(store, pack.id, { at }).catch((error: unknown) => {
            log.error('Couldn’t update the pack’s walkers', { pack: pack.id, error });
            return null;
          })) ?? pack);
    const bookings = await store.find('bookings', { subscriptionId: current.id });
    const [primary, backup] = await Promise.all([
      current.primaryWalkerId ? store.get('partners', current.primaryWalkerId) : null,
      current.backupWalkerId ? store.get('partners', current.backupWalkerId) : null,
    ]);
    const { primaryWalkerId: _primary, backupWalkerId: _backup, skipDates, ...record } = current;
    const today = istDate(at);
    return {
      ...record,
      walksDone: bookings.filter((walk) => walk.status === 'completed').length,
      walksLeft: Math.max(0, current.walksTotal - current.walksBooked),
      perWalk: FARES.subscription,
      slotLabel: slotLabel(current.slotMinute),
      skipDates: [...new Set(skipDates ?? [])].filter((day) => day >= today).sort(),
      nextWalk: nextWalkOf(current, bookings, at),
      walker: primary ? { ...walkerCard(primary), gatePass: await gatePassOf(primary.userId) } : null,
      backup: backup ? backupCard(backup) : null,
    };
  }

  /** Adds a skipped day to the pack (after its booked walk was cancelled). */
  async function recordSkip(subscriptionId: string, date: string, at: number): Promise<Subscription> {
    return store.transaction(async (tx) => {
      const current = await tx.get('subscriptions', subscriptionId);
      if (!current) throw notFound('Subscription');
      const next: Subscription = { ...current, skipDates: withSkip(current.skipDates, date, istDate(at)), updatedAt: at };
      tx.set('subscriptions', subscriptionId, next);
      return next;
    });
  }

  return {
    view,

    /**
     * The pack bought with this first walk, when it needed no payment (payments off). Paid packs are
     * created in the payment's own transaction. Idempotent, and never for a walk that was cancelled
     * or refunded meanwhile.
     */
    async startFromBooking(booking: Booking): Promise<Booking | null> {
      const at = now();
      const result = await store.transaction(async (tx) => {
        const current = await tx.get('bookings', booking.id);
        if (!current || current.subscriptionId || current.tier !== 'subscription') return current;
        const live = current.status === 'searching' || current.status === 'assigned';
        const settled = current.payment.status === 'paid' || current.payment.status === 'not_required';
        if (!live || !settled || current.payment.refundDue) return current;
        const subscription = newSubscription(current, at);
        const next: Booking = { ...current, subscriptionId: subscription.id, updatedAt: at };
        tx.set('subscriptions', subscription.id, subscription);
        tx.set('bookings', current.id, next);
        return next;
      });
      if (result?.subscriptionId && result.subscriptionId !== booking.subscriptionId) {
        log.info('Monthly pack started', { pack: result.subscriptionId, booking: booking.id, customer: booking.customerId });
      }
      return result;
    },

    /** Creates each active pack's next walk once it's within 12 hours. Run every minute or so. */
    async sweep(): Promise<number> {
      let created = 0;
      for (const pack of await store.find('subscriptions', { status: 'active' })) {
        const at = now();
        if (nextSlot(pack, at) - GENERATE_AHEAD_MS > at) continue;
        const made = await store.transaction(async (tx) => {
          const current = await tx.get('subscriptions', pack.id);
          // Another sweep got here first, or the pack was cancelled meanwhile.
          if (!current || current.status !== 'active' || current.lastScheduledFor !== pack.lastScheduledFor) return null;
          // Worked out again from the pack as it is now: a day may have been skipped since we looked.
          const scheduledFor = nextSlot(current, at);
          if (scheduledFor - GENERATE_AHEAD_MS > at) return null;
          const walk = buildBooking(
            current.customerId,
            { tier: 'subscription', scheduledFor, dog: current.dog, pickup: current.pickup, society: current.society },
            at,
            { ...paymentRecord('subscription', 'prepaid'), amount: 0 },
            current.id
          );
          const walksBooked = current.walksBooked + 1;
          const today = istDate(at);
          tx.set('bookings', walk.id, walk);
          tx.set('subscriptions', current.id, {
            ...current,
            walksBooked,
            lastScheduledFor: scheduledFor,
            ...(current.skipDates ? { skipDates: current.skipDates.filter((day) => day >= today) } : {}),
            status: walksBooked >= current.walksTotal ? 'finished' : 'active',
            updatedAt: at,
          });
          return { walk: walk.id, number: `${walksBooked}/${current.walksTotal}`, scheduledFor };
        });
        if (made) {
          created += 1;
          log.info('Pack walk booked', { pack: pack.id, booking: made.walk, walk: istTime(made.scheduledFor), number: made.number });
        }
      }
      return created;
    },

    /** The customer's packs as the app shows them, newest first. */
    async views(customerId: string) {
      const packs = (await store.find('subscriptions', { customerId })).sort((a, b) => b.createdAt - a.createdAt);
      return Promise.all(packs.map(view));
    },

    /** Stops future walks; walks already created stay and can be cancelled one by one. */
    async cancel(customerId: string, subscriptionId: string): Promise<Subscription> {
      const cancelled = await store.transaction(async (tx) => {
        const current = await tx.get('subscriptions', subscriptionId);
        if (!current || current.customerId !== customerId) throw notFound('Subscription');
        const next: Subscription = { ...current, status: current.status === 'active' ? 'cancelled' : current.status, updatedAt: now() };
        tx.set('subscriptions', subscriptionId, next);
        return next;
      });
      log.info('Monthly pack stopped', { pack: subscriptionId, customer: customerId, walksBooked: cancelled.walksBooked });
      return cancelled;
    },

    /**
     * Skips one India-time day (default: the next walk's). A booked walk that hasn't started is
     * cancelled through `cancelWalk` (which credits the pack and tells the walker); a day not booked
     * yet is noted in `skipDates`, which the generator passes over. Skipping a day twice is harmless.
     */
    async skip(
      customerId: string,
      subscriptionId: string,
      requested: string | undefined,
      cancelWalk: (bookingId: string) => Promise<unknown>
    ) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const pack = await own(customerId, subscriptionId);
        if (pack.status === 'cancelled') throw cannotSkip('This pack is cancelled, so there’s nothing to skip.');
        const at = now();
        const today = istDate(at);
        const bookings = await store.find('bookings', { subscriptionId });
        const date = requested ?? nextWalkOf(pack, bookings, at)?.date;
        if (!date) throw cannotSkip('This pack has no upcoming walk to skip.');
        if (date < today) throw cannotSkip('That day has already passed.');
        if (date > istDate(at + MAX_SKIP_AHEAD_DAYS * DAY_MS)) throw cannotSkip('Walks can be skipped up to a month ahead.');

        const onDay = bookings
          .filter((walk) => walk.status !== 'cancelled' && istDate(walk.scheduledFor) === date)
          .sort((a, b) => a.scheduledFor - b.scheduledFor);
        if (onDay.some((walk) => walk.status === 'active' || walk.status === 'completed')) {
          throw cannotSkip('That day’s walk has already started.');
        }
        const booked = onDay[0];
        if (booked) {
          try {
            await cancelWalk(booked.id);
          } catch (error) {
            // It started (or changed) since we looked: look again.
            if (error instanceof HttpError && error.code === 'wrong_status') continue;
            throw error;
          }
          const saved = await recordSkip(subscriptionId, date, at);
          log.info('Pack walk skipped', { pack: subscriptionId, date, booking: booked.id, walkerTold: booked.status === 'assigned' });
          return view(saved);
        }

        if ((pack.skipDates ?? []).includes(date)) return view(pack);
        if (date <= istDate(pack.lastScheduledFor)) throw cannotSkip('There’s no walk booked that day.');
        if (pack.status !== 'active') throw cannotSkip('All of this pack’s walks are already booked.');
        const saved = await store.transaction(async (tx) => {
          const current = await tx.get('subscriptions', subscriptionId);
          // The generator booked a walk (or the pack changed) since we looked: look again.
          if (!current || current.status !== 'active' || current.lastScheduledFor !== pack.lastScheduledFor) return null;
          const next: Subscription = { ...current, skipDates: withSkip(current.skipDates, date, today), updatedAt: at };
          tx.set('subscriptions', subscriptionId, next);
          return next;
        });
        if (!saved) continue;
        log.info('Pack day skipped before it was booked', { pack: subscriptionId, date });
        return view(saved);
      }
      throw cannotSkip('That walk just changed. Try again.');
    },

    /**
     * Moves the pack's daily time to one of the batch slots. Walks already booked that have no walker
     * yet (`searching`) move to the new time that day if it's still ahead, and are offered afresh;
     * walks with a walker, unmatched ones and ones whose new time has passed keep their time.
     */
    async changeSlot(customerId: string, subscriptionId: string, slotMinute: number) {
      if (!PACK_SLOT_MINUTES.includes(slotMinute)) {
        throw badRequest('invalid_slot', 'Pick a half-hour slot starting between 6:00 and 9:00 AM or 5:00 and 8:00 PM.');
      }
      const pack = await own(customerId, subscriptionId);
      if (pack.status === 'cancelled') throw conflict('pack_cancelled', 'This pack is cancelled.');
      if (pack.slotMinute === slotMinute) return view(pack);

      const at = now();
      const open = (await store.find('bookings', { subscriptionId })).filter((walk) => walk.status === 'searching' && !walk.partnerId);
      const offers = (await Promise.all(open.map((walk) => store.find('offers', { bookingId: walk.id, status: 'pending' })))).flat();
      const { saved, moved } = await store.transaction(async (tx) => {
        const current = await tx.get('subscriptions', subscriptionId);
        if (!current || current.customerId !== customerId) throw notFound('Subscription');
        if (current.status === 'cancelled') throw conflict('pack_cancelled', 'This pack is cancelled.');
        const walks = await Promise.all(open.map((walk) => tx.get('bookings', walk.id)));
        const pending = await Promise.all(offers.map((offer) => tx.get('offers', offer.id)));

        const movedWalks: Booking[] = [];
        let lastScheduledFor = current.lastScheduledFor;
        for (const walk of walks) {
          if (!walk || walk.status !== 'searching' || walk.partnerId) continue;
          const scheduledFor = istDayStart(walk.scheduledFor) + slotMinute * 60_000;
          if (scheduledFor <= at) continue;
          if (walk.scheduledFor === current.lastScheduledFor) lastScheduledFor = scheduledFor;
          movedWalks.push({ ...walk, scheduledFor, offeredTo: [], pendingOffer: null, updatedAt: at });
        }
        const movedIds = new Set(movedWalks.map((walk) => walk.id));
        for (const walk of movedWalks) tx.set('bookings', walk.id, walk);
        for (const offer of pending) {
          if (offer?.status === 'pending' && movedIds.has(offer.bookingId)) tx.set('offers', offer.id, { ...offer, status: 'withdrawn' });
        }
        const next: Subscription = { ...current, slotMinute, lastScheduledFor, updatedAt: at };
        tx.set('subscriptions', subscriptionId, next);
        return { saved: next, moved: movedWalks };
      });
      log.info('Pack time changed', {
        pack: subscriptionId,
        from: slotLabel(pack.slotMinute),
        to: slotLabel(slotMinute),
        walksMoved: moved.length,
        walks: moved.length ? moved.map((walk) => istTime(walk.scheduledFor)).join(', ') : undefined,
      });
      return view(saved);
    },
  };
}

export type Subscriptions = ReturnType<typeof createSubscriptions>;
export type SubscriptionView = Awaited<ReturnType<Subscriptions['view']>>;
