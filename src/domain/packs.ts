import { randomUUID } from 'node:crypto';
import { SUBSCRIPTION_WALKS, istMinuteOfDay } from './pricing.ts';
import type { Booking, Subscription } from './types.ts';

/**
 * Monthly-pack records as pure data, so the pack can be written in the same transaction as the
 * booking change that causes it (paid, cancelled, nobody free) and never half-happens.
 */

/** The pack a paid first walk buys; that walk is its first of 26. */
export function newSubscription(booking: Booking, at: number): Subscription {
  return {
    id: randomUUID(),
    customerId: booking.customerId,
    status: 'active',
    walksTotal: SUBSCRIPTION_WALKS,
    walksBooked: 1,
    slotMinute: istMinuteOfDay(booking.scheduledFor),
    dog: booking.dog,
    pickup: booking.pickup,
    society: booking.society,
    lastScheduledFor: booking.scheduledFor,
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * A walk the pack paid for didn't happen (cancelled before it started, or nobody was free): give it
 * back, so the pack books one more day at the end. A pack the customer stopped isn't credited.
 */
export function creditedPack(pack: Subscription, at: number): Subscription | null {
  if (pack.status === 'cancelled') return null;
  return { ...pack, walksBooked: Math.max(0, pack.walksBooked - 1), status: 'active', updatedAt: at };
}
