import { randomInt, randomUUID } from 'node:crypto';
import { badRequest, conflict, notFound } from '../http/errors.ts';
import { istTime, logger } from '../log/logger.ts';
import type { Push } from '../push/push.ts';
import type { Store, Transaction } from '../store/store.ts';
import type { ShiftHandshake } from '../verification/handshake.ts';
import type { Dispatcher } from './dispatch.ts';
import { creditedPack } from './packs.ts';
import { allowedMinutes, checkoutAmount, routeKm, walkFare } from './pricing.ts';
import type { Subscriptions } from './subscriptions.ts';
import type {
  AppKind,
  Booking,
  BookingPayment,
  BookingStatus,
  LatLng,
  Partner,
  SocietyAddress,
  WalkEvent,
  WalkEventType,
  WalkTier,
} from './types.ts';

/** Wrong pickup OTPs allowed before the walk has to be rebooked. */
export const MAX_OTP_ATTEMPTS = 5;
/** Walkers are looked for this long before a scheduled walk (express walks: straight away). */
export const DISPATCH_LEAD_MS = 45 * 60_000;
/** Route points kept per walk (one every few seconds covers an hour). */
const MAX_TRACK_POINTS = 900;
const TRACK_EVERY_MS = 4_000;
/** Events logged per walk; far more than any real walk, small enough to keep the booking document small. */
export const MAX_WALK_EVENTS = 200;
/** The pet parent gets at most one push per kind of event in this window (every event is still logged). */
const EVENT_PUSH_GAP_MS = 60_000;
/** Statuses a pet parent can cancel from. */
export const CANCELLABLE: readonly BookingStatus[] = ['awaiting_payment', 'searching', 'assigned', 'unmatched'];

export const isDispatchDue = (booking: Booking, at: number) => booking.scheduledFor - DISPATCH_LEAD_MS <= at;

const log = logger('booking');

export interface NewBooking {
  tier: WalkTier;
  /** Express walks: 30, 45 or 60 (default 30). Other tiers have one length, which this may repeat. */
  minutes?: number;
  /** Defaults to now (express walks). */
  scheduledFor?: number;
  dog: Booking['dog'];
  pickup: Booking['pickup'];
  society?: SocietyAddress | null;
}

/** A fresh booking record; subscriptions use it for the walks they generate. */
export function buildBooking(
  customerId: string,
  input: NewBooking & { scheduledFor: number },
  at: number,
  payment: Omit<BookingPayment, 'amount'> & { amount?: number },
  subscriptionId: string | null = null
): Booking {
  const { price, payout, minutes } = walkFare(input.tier, input.scheduledFor, input.minutes);
  const paid = payment.status === 'not_required' || payment.status === 'prepaid';
  return {
    id: randomUUID(),
    customerId,
    status: paid ? 'searching' : 'awaiting_payment',
    tier: input.tier,
    minutes,
    price,
    currency: 'INR',
    payout,
    scheduledFor: input.scheduledFor,
    dog: input.dog,
    pickup: input.pickup,
    society: input.society ?? null,
    payment: { ...payment, amount: payment.amount ?? checkoutAmount(input.tier, input.scheduledFor, minutes) },
    subscriptionId,
    partnerId: null,
    offeredTo: [],
    pendingOffer: null,
    retryAt: null,
    pickupOtp: String(randomInt(1000, 10000)),
    otpAttempts: 0,
    walkerLocation: null,
    shiftVerifiedAt: null,
    insurance: null,
    events: [],
    track: [],
    distanceKm: null,
    rating: null,
    createdAt: at,
    updatedAt: at,
    startedAt: null,
    completedAt: null,
  };
}

/** A payment record before any checkout: `none/not_required`, `youpi/unpaid` or `subscription/prepaid`. */
export const paymentRecord = (provider: BookingPayment['provider'], status: BookingPayment['status']) => ({
  provider,
  status,
  orderId: null,
  attempts: 0,
  paymentId: null,
  checkoutUrl: null,
  checkoutAt: null,
  utr: null,
  verificationLevel: null,
  paidAt: null,
  refundDue: false,
  extraPayments: [],
});

/**
 * What each side may see. The walker never gets the pickup OTP or payment details, and
 * sees the flat number only once the walk is theirs. The route goes out as `[lng, lat, at]`.
 */
export function bookingView(booking: Booking, viewer: AppKind) {
  const { pickupOtp, otpAttempts, offeredTo, pendingOffer, retryAt, track: points, ...rest } = booking;
  const shared = {
    ...rest,
    track: points.map(({ lng, lat, at }) => [lng, lat, at] as [number, number, number]),
    distanceKm: booking.distanceKm ?? null,
  };
  if (viewer === 'customer') return { ...shared, pickupOtp };
  const { payment, ...forWalker } = shared;
  const assigned = booking.status !== 'searching' && booking.status !== 'awaiting_payment';
  return {
    ...forWalker,
    society: booking.society && !assigned ? { ...booking.society, flat: '' } : booking.society,
  };
}

const EVENT_COPY: Partial<Record<WalkEventType, (dog: string) => { title: string; body: string }>> = {
  pee: (dog) => ({ title: `💧 ${dog} had a pee break`, body: 'Logged on the walk map.' }),
  poop: (dog) => ({ title: `💩 ${dog} did a poop`, body: 'Bagged and binned by your walker.' }),
  photo: (dog) => ({ title: `📸 New photo of ${dog}`, body: 'Open the live walk to see it.' }),
};

export function createWalks({
  store,
  push,
  dispatcher,
  now,
  shiftHandshake = null,
  paymentsRequired = false,
  subscriptions = null,
}: {
  store: Store;
  push: Push;
  dispatcher: Dispatcher;
  now: () => number;
  /** When set, the walker must pass the doorstep selfie (gate 4) before the OTP can start a walk. */
  shiftHandshake?: ShiftHandshake | null;
  /** New bookings wait for payment (YouPI) before walkers are looked for. */
  paymentsRequired?: boolean;
  /** Turns a paid subscription walk into a monthly pack. */
  subscriptions?: Subscriptions | null;
}) {
  /** Loads a booking inside a transaction and checks who's asking and what state it's in. */
  async function load(
    tx: Transaction,
    bookingId: string,
    who: { customerId: string } | { partnerId: string },
    allowed: readonly BookingStatus[]
  ): Promise<Booking> {
    const booking = await tx.get('bookings', bookingId);
    if (!booking) throw notFound('Walk');
    const mine = 'customerId' in who ? booking.customerId === who.customerId : booking.partnerId === who.partnerId;
    if (!mine) throw notFound('Walk');
    if (!allowed.includes(booking.status)) {
      throw conflict('wrong_status', `This walk is ${booking.status}, so that can’t be done now.`);
    }
    return booking;
  }

  async function partnerName(partnerId: string | null) {
    const partner = partnerId ? await store.get('partners', partnerId) : null;
    return partner?.name || 'Your walker';
  }

  /** A booking is paid (or needs no payment): start its monthly pack, and look for a walker once it's due. */
  async function confirmed(bookingId: string): Promise<Booking | null> {
    let booking = await store.get('bookings', bookingId);
    if (!booking || booking.status !== 'searching') return booking;
    if (booking.tier === 'subscription' && !booking.subscriptionId && subscriptions) {
      booking = (await subscriptions.startFromBooking(booking)) ?? booking;
    }
    if (isDispatchDue(booking, now())) await dispatcher.offerNext(booking.id);
    return store.get('bookings', booking.id);
  }

  return {
    confirmed,

    async create(customerId: string, input: NewBooking): Promise<Booking> {
      const at = now();
      if (input.minutes !== undefined && !allowedMinutes(input.tier).includes(input.minutes)) {
        const lengths = allowedMinutes(input.tier);
        throw badRequest(
          'minutes_not_allowed',
          input.tier === 'express'
            ? 'Express walks are 30, 45 or 60 minutes.'
            : `A ${input.tier === 'trial' ? 'trial' : 'pack'} walk is ${lengths[0]} minutes.`
        );
      }
      const scheduledFor = input.scheduledFor ?? at;
      if (scheduledFor < at - 5 * 60_000) throw badRequest('in_the_past', 'Pick a time that hasn’t passed.');
      if (scheduledFor > at + 31 * 24 * 60 * 60_000) throw badRequest('too_far_ahead', 'Book walks up to a month ahead.');
      const booking = buildBooking(
        customerId,
        { ...input, scheduledFor },
        at,
        paymentsRequired ? paymentRecord('youpi', 'unpaid') : paymentRecord('none', 'not_required')
      );
      await store.set('bookings', booking.id, booking);
      log.info('Booking created', {
        booking: booking.id,
        customer: customerId,
        tier: booking.tier,
        minutes: booking.minutes,
        dog: `${booking.dog.name} (${booking.dog.breed})`,
        price: `₹${booking.price}`,
        walk: istTime(scheduledFor),
        status: booking.status,
      });
      return (await confirmed(booking.id)) ?? booking;
    },

    /** Searches again after nobody was free. */
    async retry(customerId: string, bookingId: string): Promise<Booking> {
      const booking = await store.transaction(async (tx) => {
        const current = await load(tx, bookingId, { customerId }, ['unmatched']);
        const next: Booking = { ...current, status: 'searching', offeredTo: [], updatedAt: now() };
        tx.set('bookings', bookingId, next);
        return next;
      });
      log.info('Searching for a walker again', { booking: booking.id });
      await dispatcher.offerNext(booking.id);
      return (await store.get('bookings', booking.id)) ?? booking;
    },

    /** Before the walk starts. `allowed` narrows the statuses (account deletion refuses assigned walks). */
    async cancel(customerId: string, bookingId: string, allowed: readonly BookingStatus[] = CANCELLABLE): Promise<Booking> {
      const at = now();
      const { booking, hadWalker } = await store.transaction(async (tx) => {
        const current = await load(tx, bookingId, { customerId }, allowed);
        const pack = current.subscriptionId ? await tx.get('subscriptions', current.subscriptionId) : null;
        // A pack's walk goes back into the pack (its first walk paid for the whole pack, which carries on).
        const credited = pack && creditedPack(pack, at);
        if (credited) tx.set('subscriptions', credited.id, credited);
        const refundDue = current.payment.refundDue || (current.payment.status === 'paid' && !current.subscriptionId);
        const next: Booking = {
          ...current,
          status: 'cancelled',
          pendingOffer: null,
          payment: { ...current.payment, refundDue },
          updatedAt: at,
        };
        tx.set('bookings', bookingId, next);
        return { booking: next, hadWalker: current.status === 'assigned' };
      });
      log.info('Booking cancelled by the pet parent', { booking: booking.id, walkerNotified: hadWalker });
      if (booking.payment.refundDue) logger('payment').warn('Refund due', { booking: booking.id, amount: `₹${booking.payment.amount}` });
      await dispatcher.withdrawPending({ bookingId });
      if (hadWalker && booking.partnerId) {
        await push.toUser(booking.partnerId, 'partner', {
          title: 'Walk cancelled',
          body: `${booking.dog.name}’s walk was cancelled by the pet parent.`,
          data: { type: 'booking', bookingId },
        });
      }
      return booking;
    },

    /** The walker types the pet parent's OTP at the door; the walk (and its insurance) starts. */
    async start(partnerId: string, bookingId: string, otp: string, handshakeToken?: string): Promise<Booking> {
      if (shiftHandshake && !(handshakeToken && (await shiftHandshake.verify(handshakeToken, partnerId, bookingId)))) {
        throw conflict('shift_selfie_required', 'Take your doorstep selfie first to unlock the pickup OTP.');
      }
      const outcome = await store.transaction(async (tx) => {
        const current = await load(tx, bookingId, { partnerId }, ['assigned']);
        if (current.otpAttempts >= MAX_OTP_ATTEMPTS) return { kind: 'locked' as const };
        if (otp !== current.pickupOtp) {
          tx.set('bookings', bookingId, { ...current, otpAttempts: current.otpAttempts + 1, updatedAt: now() });
          return { kind: 'wrong' as const, left: MAX_OTP_ATTEMPTS - current.otpAttempts - 1 };
        }
        const at = now();
        const next: Booking = { ...current, status: 'active', startedAt: at, updatedAt: at };
        tx.set('bookings', bookingId, next);
        return { kind: 'started' as const, booking: next };
      });
      if (outcome.kind === 'locked') {
        log.warn('Pickup OTP locked after too many wrong tries', { booking: bookingId, walker: partnerId });
        throw conflict('otp_locked', 'Too many wrong OTPs. Ask the pet parent to rebook the walk.');
      }
      if (outcome.kind === 'wrong') {
        log.warn('Wrong pickup OTP', { booking: bookingId, walker: partnerId, triesLeft: outcome.left });
        throw badRequest('wrong_otp', outcome.left > 0 ? `Wrong OTP. ${outcome.left} tries left.` : 'Wrong OTP. No tries left.');
      }
      const { booking } = outcome;
      log.info('Walk started', { booking: booking.id, walker: partnerId, dog: booking.dog.name, minutes: booking.minutes });
      await push.toUser(booking.customerId, 'customer', {
        title: `${booking.dog.name}’s walk has started 🐾`,
        body: `${await partnerName(partnerId)} is out with ${booking.dog.name}. Follow along live.`,
        data: { type: 'booking', bookingId },
      });
      return booking;
    },

    async addEvent(
      partnerId: string,
      bookingId: string,
      event: { type: WalkEventType; lat?: number; lng?: number; note?: string }
    ): Promise<Booking> {
      const { booking, notify } = await store.transaction(async (tx) => {
        const current = await load(tx, bookingId, { partnerId }, ['active']);
        if (current.events.length >= MAX_WALK_EVENTS) throw conflict('too_many_events', 'This walk’s log is full.');
        const entry: WalkEvent = {
          type: event.type,
          at: now(),
          lat: event.lat ?? null,
          lng: event.lng ?? null,
          note: event.note ?? null,
        };
        const recent = current.events.some((logged) => logged.type === event.type && entry.at - logged.at < EVENT_PUSH_GAP_MS);
        const next: Booking = { ...current, events: [...current.events, entry], updatedAt: entry.at };
        tx.set('bookings', bookingId, next);
        return { booking: next, notify: !recent };
      });
      log.info('Walk event', { booking: booking.id, event: event.type, note: event.note });
      const copy = notify ? EVENT_COPY[event.type]?.(booking.dog.name) : undefined;
      if (copy) {
        await push.toUser(booking.customerId, 'customer', { ...copy, data: { type: 'walk_event', bookingId, event: event.type } });
      }
      return booking;
    },

    /** The walker's position, for the pet parent's live map (on the way and during the walk). */
    async updateLocation(partnerId: string, bookingId: string, location: LatLng): Promise<void> {
      const at = now();
      await store.transaction(async (tx) => {
        const current = await load(tx, bookingId, { partnerId }, ['assigned', 'active']);
        // While walking, positions also draw the route (thinned, and capped so the record stays small).
        const last = current.track.at(-1);
        const track: Booking['track'] =
          current.status === 'active' && (!last || at - last.at >= TRACK_EVERY_MS)
            ? [...current.track, { lng: location.lng, lat: location.lat, at }].slice(-MAX_TRACK_POINTS)
            : current.track;
        tx.set('bookings', bookingId, { ...current, walkerLocation: { ...location, at }, track, updatedAt: at });
      });
      // Only the position: approval, trust tier and the online flag are never written back from an older read.
      await store.update('partners', partnerId, { location: { ...location, at }, updatedAt: at });
    },

    async complete(partnerId: string, bookingId: string): Promise<Booking> {
      const booking = await store.transaction(async (tx) => {
        const current = await load(tx, bookingId, { partnerId }, ['active']);
        const at = now();
        const next: Booking = { ...current, status: 'completed', completedAt: at, distanceKm: routeKm(current.track), updatedAt: at };
        tx.set('bookings', bookingId, next);
        return next;
      });
      const count = (type: WalkEventType) => booking.events.filter((event) => event.type === type).length;
      log.info('Walk completed', {
        booking: booking.id,
        walker: partnerId,
        minutes: booking.startedAt ? Math.round(((booking.completedAt ?? booking.updatedAt) - booking.startedAt) / 60_000) : null,
        km: booking.distanceKm,
        pee: count('pee'),
        poop: count('poop'),
        photos: count('photo'),
      });
      await push.toUser(booking.customerId, 'customer', {
        title: `${booking.dog.name} is home 🏡`,
        body: `Walk complete: ${count('pee')} pee and ${count('poop')} poop breaks, ${count('photo')} photos.`,
        data: { type: 'booking', bookingId },
      });
      return booking;
    },

    /** The pet parent's 1–5 stars, once, after the walk; also added to the walker's running average. */
    async rate(customerId: string, bookingId: string, rating: number): Promise<Booking> {
      const { rated, walker } = await store.transaction(async (tx) => {
        const current = await load(tx, bookingId, { customerId }, ['completed']);
        if (current.rating !== null) throw conflict('already_rated', 'You’ve already rated this walk.');
        const partner = current.partnerId ? await tx.get('partners', current.partnerId) : null;
        const at = now();
        const next: Booking = { ...current, rating, updatedAt: at };
        tx.set('bookings', bookingId, next);
        let updated: Partner | null = null;
        if (partner) {
          updated = { ...partner, ratingSum: (partner.ratingSum ?? 0) + rating, ratingCount: (partner.ratingCount ?? 0) + 1 };
          tx.set('partners', partner.userId, updated);
        }
        return { rated: next, walker: updated };
      });
      log.info('Walk rated', {
        booking: bookingId,
        walker: rated.partnerId,
        stars: rating,
        walkerAverage: walker ? Math.round(((walker.ratingSum ?? 0) / (walker.ratingCount ?? 1)) * 100) / 100 : undefined,
        walkerRatings: walker?.ratingCount,
      });
      return rated;
    },

    /** A booking either side of it may read. */
    async get(bookingId: string, viewer: { userId: string; app: AppKind }): Promise<Booking> {
      const booking = await store.get('bookings', bookingId);
      const allowed =
        booking &&
        (viewer.app === 'customer' ? booking.customerId === viewer.userId : booking.partnerId === viewer.userId);
      if (!allowed) throw notFound('Walk');
      return booking;
    },

    async list(viewer: { userId: string; app: AppKind }): Promise<Booking[]> {
      const bookings =
        viewer.app === 'customer'
          ? await store.find('bookings', { customerId: viewer.userId })
          : await store.find('bookings', { partnerId: viewer.userId });
      return bookings.sort((a, b) => b.scheduledFor - a.scheduledFor);
    },
  };
}

export type Walks = ReturnType<typeof createWalks>;
