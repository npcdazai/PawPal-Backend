import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PaymentsConfig } from '../config.ts';
import { HttpError } from '../http/errors.ts';
import { logger } from '../log/logger.ts';

const TIMEOUT_MS = 15_000;

const log = logger('payment');

/** A payment session as YouPI reports it (API response or webhook body). */
export interface YoupiPayment {
  paymentId: string;
  orderId: string;
  /** INITIATED · QUEUED · ACTIVE · PROCESSING · SUCCESS · FAILED · EXPIRED · CANCELLED */
  status: string;
  amountPaise: number;
  checkoutUrl: string | null;
  utr: string | null;
  verificationLevel: number;
}

export interface Youpi {
  createPayment(input: { orderId: string; amount: number; description: string; returnUrl: string; metadata: Record<string, string> }): Promise<YoupiPayment>;
  /** The merchant view (the merchant key unlocks verification details). */
  getPayment(paymentId: string): Promise<YoupiPayment>;
  /** `X-Gateway-Signature: sha256=<hex>` = HMAC-SHA256(merchant key, raw body). */
  verifySignature(rawBody: Buffer, header: string | undefined): boolean;
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : null);

/** Normalises the API's and the webhook's slightly different shapes. */
export function toYoupiPayment(data: Record<string, unknown>): YoupiPayment {
  const paise = Number(data.amountPaise ?? Math.round(Number(data.amount ?? 0) * 100));
  return {
    paymentId: text(data.paymentId) ?? '',
    orderId: text(data.orderId) ?? '',
    status: (text(data.status) ?? text(data.event) ?? '').toUpperCase(),
    amountPaise: Number.isFinite(paise) ? paise : 0,
    checkoutUrl: text(data.checkoutUrl),
    utr: text(data.utr),
    verificationLevel: Number(data.verificationLevel ?? 0) || 0,
  };
}

/** YouPI PG's merchant API, called from this server only (the apps never see the merchant key). */
export function createYoupi(config: PaymentsConfig['youpi'], fetchImpl: typeof fetch = fetch): Youpi {
  async function call(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const started = Date.now();
    let response: Response;
    try {
      response = await fetchImpl(`${config.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      log.error('YouPI unreachable', { call: `${init.method ?? 'GET'} ${path}`, error });
      throw new HttpError(503, 'payments_unavailable', 'Payments are unavailable right now. Try again in a minute.');
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const call = `${init.method ?? 'GET'} ${path}`;
    if (!response.ok || !body) {
      log.error('YouPI refused', { call, status: response.status, ms: Date.now() - started, says: body?.message ?? body?.error });
      throw new HttpError(502, 'payments_unavailable', 'The payment gateway couldn’t start the payment. Try again.');
    }
    log.debug('YouPI answered', { call, status: response.status, ms: Date.now() - started });
    return body;
  }

  return {
    async createPayment({ orderId, amount, description, returnUrl, metadata }) {
      const body = await call('/api/v1/payments', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Merchant-Id': config.merchantId,
          // One order id per attempt doubles as the idempotency key: a retried request never charges twice.
          'Idempotency-Key': orderId,
        },
        body: JSON.stringify({
          orderId,
          amount: amount.toFixed(2),
          currency: 'INR',
          description,
          returnUrl,
          metadata,
          merchantId: config.merchantId,
        }),
      });
      const payment = toYoupiPayment(body);
      if (!payment.paymentId || !payment.checkoutUrl) {
        throw new HttpError(502, 'payments_unavailable', 'The payment gateway sent an unexpected reply.');
      }
      return payment;
    },

    async getPayment(paymentId) {
      return toYoupiPayment(
        await call(`/api/v1/payments/${encodeURIComponent(paymentId)}`, { headers: { 'X-Merchant-Key': config.merchantKey } })
      );
    },

    verifySignature(rawBody, header) {
      if (!header?.startsWith('sha256=')) return false;
      const given = Buffer.from(header.slice('sha256='.length), 'hex');
      const expected = createHmac('sha256', config.merchantKey).update(rawBody).digest();
      return given.length === expected.length && timingSafeEqual(given, expected);
    },
  };
}
