import { randomUUID } from 'node:crypto';
import type { Config } from '../config.ts';
import { conflict, notFound } from '../http/errors.ts';
import { istTime, logger } from '../log/logger.ts';
import type { Push } from '../push/push.ts';
import type { Store } from '../store/store.ts';
import { refreshPackWalkers } from './packWalkers.ts';
import { distanceKm } from './pricing.ts';
import { requiredTrustTier, type Booking, type LatLng, type Offer, type Partner, type Temperament } from './types.ts';
import { arrivalWindow } from './walkers.ts';
import { isDispatchDue } from './walks.ts';

export interface DispatchDeps {
  store: Store;
  push: Push;
  config: Config['dispatch'];
  now: () => number;
}

export type OfferAnswer = { kind: 'accepted'; booking: Booking } | { kind: 'declined' };

export const rupees = (amount: number) => `₹${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;

const log = logger('dispatch');

/**
 * Offers a booking to one nearby walker at a time: the closest online,
 * approved partner gets `offerSeconds` to accept, then the next one is asked,
 * up to `maxOffers`, after which the booking is marked unmatched. A monthly
 * pack's walks go to its primary walker first, then its backup.
 */
export function createDispatcher({ store, push, config, now }: DispatchDeps) {
  /** Online, approved walkers with a fresh location whose radius covers `point`, closest first. */
  async function covering(point: LatLng, excludeUserId: string): Promise<{ partner: Partner; km: number }[]> {
    const freshAfter = now() - config.locationMaxAgeMinutes * 60_000;
    const online = await store.find('partners', { online: true, approved: true });
    return online
      .filter((partner) => partner.location && partner.location.at >= freshAfter && partner.userId !== excludeUserId)
      .map((partner) => ({ partner, km: distanceKm(point, partner.location!) }))
      .filter(({ partner, km }) => km <= partner.radiusKm)
      .sort((a, b) => a.km - b.km);
  }

  async function nearbyPartners(booking: Booking): Promise<{ partner: Partner; km: number }[]> {
    const tier = requiredTrustTier(booking.dog.temperament);
    return (await covering(booking.pickup, booking.customerId)).filter(
      ({ partner }) => (partner.trustTier ?? 0) >= tier && (partner.walkRate ?? 0) <= booking.payout
    );
  }

  /** Who to ask, in order: for a pack walk its primary walker, then its backup (when they're among the nearby ones). */
  async function candidates(booking: Booking): Promise<{ partner: Partner; km: number }[]> {
    const nearby = await nearbyPartners(booking);
    if (!booking.subscriptionId) return nearby;
    const packId = booking.subscriptionId;
    // A failed refresh mustn't stop the walk being offered: use the walkers as saved.
    const pack = await refreshPackWalkers(store, packId, { at: now() }).catch((error: unknown) => {
      log.error('Couldn’t update the pack’s walkers', { pack: packId, error });
      return store.get('subscriptions', packId);
    });
    const preferred = [pack?.primaryWalkerId, pack?.backupWalkerId].filter((id): id is string => Boolean(id));
    const first = preferred.flatMap((id) => nearby.filter(({ partner }) => partner.userId === id));
    return [...first, ...nearby.filter(({ partner }) => !preferred.includes(partner.userId))];
  }

  /**
   * What the home screen may know about walkers near a place: how many, how many could take this dog,
   * and when one could arrive. Never who they are or where they stand.
   */
  async function availability(point: LatLng, options: { temperament?: Temperament; excludeUserId: string }) {
    const around = await covering(point, options.excludeUserId);
    const tier = options.temperament ? requiredTrustTier(options.temperament) : 0;
    const eligible = around.filter(({ partner }) => (partner.trustTier ?? 0) >= tier);
    const nearest = eligible[0]?.km;
    return {
      count: around.length,
      eligible: eligible.length,
      nearestKm: nearest === undefined ? null : Math.round(nearest * 10) / 10,
      arrival: nearest === undefined ? null : arrivalWindow(nearest),
    };
  }

  async function markUnmatched(bookingId: string) {
    const booking = await store.transaction(async (tx) => {
      const current = await tx.get('bookings', bookingId);
      if (!current || current.status !== 'searching') return null;
      const next: Booking = { ...current, status: 'unmatched', updatedAt: now() };
      tx.set('bookings', bookingId, next);
      return next;
    });
    if (booking) {
      log.warn('No walker free nearby; booking unmatched', { booking: bookingId, asked: booking.offeredTo.length });
      await push.toUser(booking.customerId, 'customer', {
        title: 'No walkers free nearby',
        body: `We couldn’t find a walker for ${booking.dog.name} right now. Try again in a few minutes.`,
        data: { type: 'booking', bookingId },
      });
    }
  }

  /** Asks the next closest walker, or gives up. Safe to call twice: only one new offer is made. */
  async function offerNext(bookingId: string): Promise<void> {
    const booking = await store.get('bookings', bookingId);
    if (!booking || booking.status !== 'searching') return;
    const next =
      booking.offeredTo.length < config.maxOffers
        ? (await candidates(booking)).find(({ partner }) => !booking.offeredTo.includes(partner.userId))
        : undefined;
    if (!next) {
      await markUnmatched(bookingId);
      return;
    }

    const at = now();
    const offer: Offer = {
      id: randomUUID(),
      bookingId,
      partnerId: next.partner.userId,
      status: 'pending',
      distanceKm: Math.round(next.km * 10) / 10,
      payout: booking.payout,
      expiresAt: at + config.offerSeconds * 1000,
      createdAt: at,
    };
    const created = await store.transaction(async (tx) => {
      const current = await tx.get('bookings', bookingId);
      // Someone else offered it (or it was taken or cancelled) since we looked.
      if (!current || current.status !== 'searching' || current.offeredTo.length !== booking.offeredTo.length) {
        return false;
      }
      tx.set('bookings', bookingId, { ...current, offeredTo: [...current.offeredTo, offer.partnerId], updatedAt: at });
      tx.set('offers', offer.id, offer);
      return true;
    });
    if (!created) return;

    log.info('Offered to walker', {
      booking: bookingId,
      walker: offer.partnerId,
      km: offer.distanceKm,
      payout: rupees(offer.payout),
      expires: `${config.offerSeconds}s`,
      try: `${booking.offeredTo.length + 1}/${config.maxOffers}`,
    });
    await push.toUser(offer.partnerId, 'partner', {
      title: `New walk request • ${rupees(offer.payout)}`,
      body: `${booking.dog.name} (${booking.dog.breed}) • ${offer.distanceKm} km away • ${booking.minutes} min. Accept within ${config.offerSeconds}s.`,
      data: { type: 'offer', offerId: offer.id, bookingId, expiresAt: String(offer.expiresAt) },
      urgent: true,
    });
  }

  /** The partner's answer. An offer that has run out is closed and passed on. */
  async function answer(offerId: string, partnerId: string, accept: boolean): Promise<OfferAnswer> {
    const at = now();
    const outcome = await store.transaction(async (tx) => {
      const offer = await tx.get('offers', offerId);
      if (!offer || offer.partnerId !== partnerId) return { kind: 'missing' as const };
      if (offer.status !== 'pending') return { kind: 'closed' as const };
      const booking = await tx.get('bookings', offer.bookingId);
      if (offer.expiresAt <= at) {
        tx.set('offers', offerId, { ...offer, status: 'expired' });
        return { kind: 'expired' as const, bookingId: offer.bookingId };
      }
      if (!booking || booking.status !== 'searching') {
        tx.set('offers', offerId, { ...offer, status: 'withdrawn' });
        return { kind: 'closed' as const };
      }
      if (!accept) {
        tx.set('offers', offerId, { ...offer, status: 'declined' });
        return { kind: 'declined' as const, bookingId: offer.bookingId };
      }
      const assigned: Booking = { ...booking, status: 'assigned', partnerId, updatedAt: at };
      tx.set('offers', offerId, { ...offer, status: 'accepted' });
      tx.set('bookings', booking.id, assigned);
      return { kind: 'accepted' as const, booking: assigned };
    });

    switch (outcome.kind) {
      case 'missing':
        throw notFound('Request');
      case 'closed':
        throw conflict('offer_closed', 'This request is no longer available.');
      case 'expired':
        log.info('Walker answered too late; asking the next one', { booking: outcome.bookingId, walker: partnerId });
        await offerNext(outcome.bookingId);
        throw conflict('offer_expired', 'This request timed out and went to another walker.');
      case 'declined':
        log.info('Walker declined; asking the next one', { booking: outcome.bookingId, walker: partnerId });
        await offerNext(outcome.bookingId);
        return { kind: 'declined' };
      case 'accepted': {
        log.info('Walker accepted', { booking: outcome.booking.id, walker: partnerId, dog: outcome.booking.dog.name });
        if (outcome.booking.subscriptionId) {
          // The walk is theirs either way; a failure here only delays naming the pack's walkers.
          await refreshPackWalkers(store, outcome.booking.subscriptionId, { at, acceptedBy: partnerId }).catch((error: unknown) =>
            log.error('Couldn’t update the pack’s walkers', { pack: outcome.booking.subscriptionId, error })
          );
        }
        const partner = await store.get('partners', partnerId);
        await push.toUser(outcome.booking.customerId, 'customer', {
          title: `${partner?.name || 'A walker'} is walking ${outcome.booking.dog.name}`,
          body: 'Share your pickup OTP at the door to start the walk.',
          data: { type: 'booking', bookingId: outcome.booking.id },
        });
        return { kind: 'accepted', booking: outcome.booking };
      }
    }
  }

  /** Closes pending offers that have run out and moves each booking on. Run every few seconds. */
  async function sweep(): Promise<number> {
    const at = now();
    const pending = await store.find('offers', { status: 'pending' });
    let expired = 0;
    for (const offer of pending.filter((entry) => entry.expiresAt <= at)) {
      const closed = await store.transaction(async (tx) => {
        const current = await tx.get('offers', offer.id);
        if (!current || current.status !== 'pending') return false;
        tx.set('offers', offer.id, { ...current, status: 'expired' });
        return true;
      });
      if (closed) {
        expired += 1;
        log.info('Offer timed out; asking the next walker', { booking: offer.bookingId, walker: offer.partnerId });
        await offerNext(offer.bookingId);
      }
    }
    return expired;
  }

  /** Withdraws offers still waiting on a booking (it was cancelled) or on a partner (they went offline). */
  async function withdrawPending(where: { bookingId: string } | { partnerId: string }): Promise<string[]> {
    const pending = await store.find('offers', { ...where, status: 'pending' });
    const bookings: string[] = [];
    for (const offer of pending) {
      const withdrawn = await store.transaction(async (tx) => {
        const current = await tx.get('offers', offer.id);
        if (!current || current.status !== 'pending') return false;
        tx.set('offers', offer.id, { ...current, status: 'withdrawn' });
        return true;
      });
      if (withdrawn) {
        log.debug('Offer withdrawn', { booking: offer.bookingId, walker: offer.partnerId });
        bookings.push(offer.bookingId);
      }
    }
    return bookings;
  }

  /** Starts looking for walkers for scheduled walks once they're within the lead time. Run every few seconds. */
  async function dispatchDue(): Promise<number> {
    const at = now();
    let started = 0;
    for (const booking of await store.find('bookings', { status: 'searching' })) {
      if (booking.offeredTo.length === 0 && isDispatchDue(booking, at)) {
        log.info('Scheduled walk is due; looking for walkers', { booking: booking.id, walk: istTime(booking.scheduledFor) });
        await offerNext(booking.id);
        started += 1;
      }
    }
    return started;
  }

  return { offerNext, answer, sweep, withdrawPending, nearbyPartners, availability, dispatchDue };
}

export type Dispatcher = ReturnType<typeof createDispatcher>;
