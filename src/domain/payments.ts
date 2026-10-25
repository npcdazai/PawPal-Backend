import type { PaymentsConfig } from '../config.ts';
import { conflict, notFound, unauthorized } from '../http/errors.ts';
import { logger } from '../log/logger.ts';
import { toYoupiPayment, type Youpi, type YoupiPayment } from '../payments/youpi.ts';
import type { Push } from '../push/push.ts';
import type { Store } from '../store/store.ts';
import { rupees } from './dispatch.ts';
import type { Booking, BookingPayment } from './types.ts';
import type { Walks } from './walks.ts';

const FINAL_FAILURES = new Set(['FAILED', 'EXPIRED', 'CANCELLED']);

const log = logger('payment');

/** "3f2c…-uuid-2" → the booking id (UUIDs contain dashes, the attempt number follows the last one). */
const bookingIdFromOrder = (orderId: string) => orderId.slice(0, orderId.lastIndexOf('-'));

/**
 * YouPI checkout for bookings. The app only ever opens the checkout page; whether
 * a booking is paid is decided here, from the signed webhook or the merchant view
 * of the payment: the amount must match to the paisa and the gateway must have
 * matched the payment to a bank alert (verification level).
 */
export function createPayments({
  store,
  youpi,
  walks,
  push,
  config,
  now,
}: {
  store: Store;
  youpi: Youpi;
  walks: Walks;
  push: Push;
  config: PaymentsConfig;
  now: () => number;
}) {
  async function ownBooking(customerId: string, bookingId: string) {
    const booking = await store.get('bookings', bookingId);
    if (!booking || booking.customerId !== customerId) throw notFound('Walk');
    return booking;
  }

  /** Applies what the gateway reports. Returns the booking, and whether this call is what made it paid. */
  async function apply(report: YoupiPayment): Promise<{ booking: Booking | null; becamePaid: boolean }> {
    const bookingId = bookingIdFromOrder(report.orderId);
    const result = await store.transaction(async (tx) => {
      const booking = await tx.get('bookings', bookingId);
      if (!booking || booking.payment.provider !== 'youpi') return { booking, becamePaid: false };
      if (booking.payment.status === 'paid') return { booking, becamePaid: false };

      let status: BookingPayment['status'] = booking.payment.status;
      if (report.status === 'SUCCESS') {
        const expected = Math.round(booking.payment.amount * 100);
        if (report.amountPaise !== expected) {
          log.error('Amount doesn’t match; payment held for review', {
            order: report.orderId,
            paidPaise: report.amountPaise,
            expectedPaise: expected,
          });
          status = 'review';
        } else {
          status = report.verificationLevel >= config.minVerificationLevel ? 'paid' : 'review';
        }
      } else if (FINAL_FAILURES.has(report.status)) {
        // A late failure of an older attempt mustn't override a newer open one.
        if (report.orderId === booking.payment.orderId) status = 'failed';
      } else {
        status = 'pending';
      }

      const at = now();
      const paid = status === 'paid';
      // Money that arrives after the booking was released or cancelled is refunded by hand.
      const lateMoney = paid && booking.status !== 'awaiting_payment';
      const next: Booking = {
        ...booking,
        status: paid && booking.status === 'awaiting_payment' ? 'searching' : booking.status,
        payment: {
          ...booking.payment,
          status,
          paymentId: report.orderId === booking.payment.orderId ? report.paymentId : booking.payment.paymentId,
          utr: report.utr ?? booking.payment.utr,
          verificationLevel: report.verificationLevel,
          paidAt: paid ? at : booking.payment.paidAt,
          refundDue: booking.payment.refundDue || lateMoney,
        },
        updatedAt: at,
      };
      tx.set('bookings', bookingId, next);
      return { booking: next, becamePaid: paid && !lateMoney };
    });

    log.info('Gateway reported a payment', {
      order: report.orderId,
      gateway: report.status,
      verification: report.verificationLevel,
      now: result.booking?.payment.status ?? 'no such booking',
      refundDue: result.booking?.payment.refundDue || undefined,
    });
    if (result.becamePaid && result.booking) {
      log.info('Booking paid', { booking: result.booking.id, amount: rupees(result.booking.payment.amount) });
      await push.toUser(result.booking.customerId, 'customer', {
        title: `Payment received • ${rupees(result.booking.payment.amount)}`,
        body: `We’re finding a walker for ${result.booking.dog.name}.`,
        data: { type: 'booking', bookingId: result.booking.id },
      });
      return { booking: await walks.confirmed(result.booking.id), becamePaid: true };
    }
    return result;
  }

  return {
    /** Opens (or reuses) a YouPI checkout for an unpaid booking. */
    async checkout(customerId: string, bookingId: string) {
      const booking = await ownBooking(customerId, bookingId);
      if (booking.status !== 'awaiting_payment' || booking.payment.provider !== 'youpi') {
        throw conflict('nothing_to_pay', 'This walk doesn’t need a payment.');
      }
      // The open session may already be paid, or still usable.
      if (booking.payment.status === 'pending' && booking.payment.paymentId && booking.payment.checkoutUrl) {
        const { booking: refreshed } = await apply(await youpi.getPayment(booking.payment.paymentId));
        if (refreshed?.payment.status === 'pending') return { checkoutUrl: booking.payment.checkoutUrl, booking: refreshed };
        if (refreshed?.payment.status !== 'failed') return { checkoutUrl: null, booking: refreshed };
      }

      const attempt = booking.payment.attempts + 1;
      const orderId = `${booking.id}-${attempt}`;
      const session = await youpi.createPayment({
        orderId,
        amount: booking.payment.amount,
        description: booking.tier === 'subscription' ? `PawPal monthly walks for ${booking.dog.name}` : `PawPal walk for ${booking.dog.name}`,
        returnUrl: config.returnUrl,
        metadata: { bookingId: booking.id, tier: booking.tier },
      });
      const updated = await store.transaction(async (tx) => {
        const current = await tx.get('bookings', booking.id);
        if (!current) throw notFound('Walk');
        const next: Booking = {
          ...current,
          payment: { ...current.payment, status: 'pending', orderId, attempts: attempt, paymentId: session.paymentId, checkoutUrl: session.checkoutUrl },
          updatedAt: now(),
        };
        tx.set('bookings', booking.id, next);
        return next;
      });
      log.info('Checkout opened', { booking: booking.id, order: orderId, amount: rupees(booking.payment.amount), attempt });
      return { checkoutUrl: session.checkoutUrl, booking: updated };
    },

    /** The app's "I've paid" / return-from-checkout check: asks the gateway directly. */
    async refresh(customerId: string, bookingId: string): Promise<Booking> {
      const booking = await ownBooking(customerId, bookingId);
      if (!booking.payment.paymentId || booking.payment.status === 'paid') return booking;
      return (await apply(await youpi.getPayment(booking.payment.paymentId))).booking ?? booking;
    },

    /** POST from YouPI: `X-Gateway-Signature: sha256=HMAC(merchant key, raw body)`. */
    async webhook(rawBody: Buffer | undefined, signature: string | undefined): Promise<void> {
      if (!rawBody || !youpi.verifySignature(rawBody, signature)) {
        log.warn('Webhook rejected: signature doesn’t match', { signed: Boolean(signature) });
        throw unauthorized('bad_signature', 'Webhook signature doesn’t match.');
      }
      const report = toYoupiPayment(JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>);
      if (!report.orderId) return;
      await apply(report);
    },

    /** Releases bookings left unpaid for too long (after one last look at the gateway). Run every minute or so. */
    async sweepUnpaid(): Promise<number> {
      const cutoff = now() - config.holdMinutes * 60_000;
      let released = 0;
      for (const booking of await store.find('bookings', { status: 'awaiting_payment' })) {
        if (booking.createdAt > cutoff) continue;
        if (booking.payment.paymentId) {
          try {
            const { booking: checked } = await apply(await youpi.getPayment(booking.payment.paymentId));
            if (checked && checked.status !== 'awaiting_payment') continue;
          } catch {
            continue; // Gateway down: decide on a later sweep rather than release a possibly paid walk.
          }
        }
        const done = await store.transaction(async (tx) => {
          const current = await tx.get('bookings', booking.id);
          if (!current || current.status !== 'awaiting_payment' || current.payment.status === 'review') return false;
          tx.set('bookings', booking.id, { ...current, status: 'cancelled', updatedAt: now() });
          return true;
        });
        if (done) {
          released += 1;
          log.info('Unpaid booking released', { booking: booking.id, heldMinutes: config.holdMinutes });
        }
      }
      return released;
    },
  };
}

export type Payments = ReturnType<typeof createPayments>;
