import type { LatLng, WalkTier } from './types.ts';

/**
 * Per-walk fares in rupees, matching the PawPal app (src/booking/walkPlans.ts): a subscription walk
 * is ₹120 (₹3,120 for 26), the trial ₹99, and an express walk ₹299 / ₹379 / ₹449 for 30 / 45 / 60
 * minutes, ₹50 more during the 7–9 AM and 5–7 PM rush.
 */
export const FARES: Record<WalkTier, number> = { subscription: 120, trial: 99, express: 299 };
export const TIER_MINUTES: Record<WalkTier, number> = { subscription: 30, trial: 15, express: 30 };
/** Express walk lengths and their off-peak fares; 30 minutes when the booking doesn't say. */
export const EXPRESS_MINUTES = [30, 45, 60] as const;
export const EXPRESS_FARES: Readonly<Record<number, number>> = { 30: 299, 45: 379, 60: 449 };
/** Added to an express walk that starts in the morning or evening rush. */
export const PEAK_SURCHARGE = 50;
export const PEAK_WINDOWS = ['07:00–09:00', '17:00–19:00'] as const;
/** What the walker keeps; the rest is the platform fee. */
export const PARTNER_SHARE = 0.85;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export const round2 = (value: number) => Math.round(value * 100) / 100;

/** Peak hours are judged in India time whatever the server's time zone. */
export function isPeakHour(at: number): boolean {
  const hour = new Date(at + IST_OFFSET_MS).getUTCHours();
  return (hour >= 7 && hour < 9) || (hour >= 17 && hour < 19);
}

/** The lengths a booking of this tier may ask for (express: 30, 45 or 60; the others their one length). */
export const allowedMinutes = (tier: WalkTier): readonly number[] =>
  tier === 'express' ? EXPRESS_MINUTES : [TIER_MINUTES[tier]];

/** Price, the walker's payout and length of one walk starting at `at`. `minutes` only matters for express walks. */
export function walkFare(tier: WalkTier, at: number, minutes?: number): { price: number; payout: number; minutes: number } {
  const length = tier === 'express' && minutes !== undefined && EXPRESS_FARES[minutes] !== undefined ? minutes : TIER_MINUTES[tier];
  const base = tier === 'express' ? EXPRESS_FARES[length]! : FARES[tier];
  const price = tier === 'express' && isPeakHour(at) ? base + PEAK_SURCHARGE : base;
  return { price, payout: round2(price * PARTNER_SHARE), minutes: length };
}

/** Walks in a monthly pack (₹3,120 = 26 × ₹120). */
export const SUBSCRIPTION_WALKS = 26;

/** What the customer pays when booking: the first walk of a subscription buys the whole pack. */
export const checkoutAmount = (tier: WalkTier, at: number, minutes?: number) =>
  tier === 'subscription' ? FARES.subscription * SUBSCRIPTION_WALKS : walkFare(tier, at, minutes).price;

const DAY_MS = 24 * 60 * 60_000;

/** Midnight (India time) at the start of the day containing `at`, as epoch ms. */
export const istDayStart = (at: number) => at - ((at + IST_OFFSET_MS) % DAY_MS);

/** "2026-10-22" for the India-time day containing `at`. */
export const istDate = (at: number) => new Date(istDayStart(at) + IST_OFFSET_MS).toISOString().slice(0, 10);

/** Midnight (India time) at the start of "2026-10-22", as epoch ms. */
export const istDateStart = (date: string) => Date.parse(`${date}T00:00:00.000Z`) - IST_OFFSET_MS;

/** Minutes after midnight in India for an instant. */
export const istMinuteOfDay = (at: number) => {
  const date = new Date(at + IST_OFFSET_MS);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
};

/**
 * Daily start times a monthly pack can move to (minutes after midnight, India time): the apps' morning
 * batch (6:00–9:30 AM) and evening batch (5:00–8:30 PM), a 30-minute walk starting every half hour,
 * so starts 6:00–9:00 AM and 5:00–8:00 PM.
 */
export const PACK_SLOT_MINUTES: readonly number[] = [
  ...Array.from({ length: 7 }, (_, index) => 6 * 60 + index * 30),
  ...Array.from({ length: 7 }, (_, index) => 17 * 60 + index * 30),
];

const clockTime = (minuteOfDay: number) => {
  const minute = ((minuteOfDay % 1440) + 1440) % 1440;
  const hour = Math.floor(minute / 60);
  return { text: `${hour % 12 || 12}:${String(minute % 60).padStart(2, '0')}`, meridiem: hour < 12 ? 'AM' : 'PM' };
};

/** "7:00 – 7:30 AM", or "11:45 AM – 12:15 PM" across noon. */
export function slotLabel(startMinute: number, minutes = TIER_MINUTES.subscription): string {
  const start = clockTime(startMinute);
  const end = clockTime(startMinute + minutes);
  return start.meridiem === end.meridiem
    ? `${start.text} – ${end.text} ${end.meridiem}`
    : `${start.text} ${start.meridiem} – ${end.text} ${end.meridiem}`;
}

/** Everything the app shows before checkout (GET /pricing), priced as of `at`. */
export function priceList(at: number) {
  return {
    currency: 'INR' as const,
    peak: isPeakHour(at),
    peakWindows: PEAK_WINDOWS,
    express: EXPRESS_MINUTES.map((minutes) => ({ minutes, price: walkFare('express', at, minutes).price })),
    subscription: {
      perWalk: FARES.subscription,
      walks: SUBSCRIPTION_WALKS,
      total: FARES.subscription * SUBSCRIPTION_WALKS,
      minutes: TIER_MINUTES.subscription,
      slots: PACK_SLOT_MINUTES.map((slotMinute) => ({ slotMinute, label: slotLabel(slotMinute) })),
    },
    trial: { price: FARES.trial, minutes: TIER_MINUTES.trial },
  };
}

const EARTH_RADIUS_KM = 6371;
const rad = (degrees: number) => (degrees * Math.PI) / 180;

/** Straight-line distance, good enough to rank walkers inside one township. */
export function distanceKm(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** Length of a recorded route, point to point, in km (2 decimals). */
export function routeKm(points: readonly LatLng[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) total += distanceKm(points[index - 1]!, points[index]!);
  return round2(total);
}
