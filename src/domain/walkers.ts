import { round2 } from './pricing.ts';
import type { Partner } from './types.ts';

/**
 * How a walker is shown to pet parents: by name only. Never their phone number, and never where
 * they are (beyond a walk's own `walkerLocation` while it's on).
 */

const words = (name: string) => name.trim().split(/\s+/).filter(Boolean);

const displayName = (partner: Partner) => partner.name.trim() || 'Walker';

/** "Rohan Deshmukh" → "RD", "Rohan" → "R". */
export function initials(name: string): string {
  const parts = words(name);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '';
  return (first + last).toUpperCase() || 'W';
}

/** "Pratik Kulkarni" → "Pratik K.": first name and last initial. */
export function shortName(name: string): string {
  const parts = words(name);
  if (parts.length < 2) return parts[0] ?? 'Walker';
  return `${parts[0]} ${parts.at(-1)![0]!.toUpperCase()}.`;
}

/** The walker's average over all rated walks, or null before the first rating. */
export function ratingOf(partner: Partner): { average: number; count: number } | null {
  const count = partner.ratingCount ?? 0;
  return count > 0 ? { average: round2((partner.ratingSum ?? 0) / count), count } : null;
}

/** Trust tier 1 or more: the walker has cleared the verification gates for at least friendly dogs. */
export const isVerified = (partner: Partner) => (partner.trustTier ?? 0) >= 1;

/** A booking's `walker` as the pet parent sees it. */
export const walkerCard = (partner: Partner) => ({
  id: partner.userId,
  name: displayName(partner),
  initials: initials(displayName(partner)),
  rating: ratingOf(partner),
  verified: isVerified(partner),
});

/** A pack's backup walker: first name and last initial only. */
export const backupCard = (partner: Partner) => ({
  id: partner.userId,
  name: shortName(displayName(partner)),
  initials: initials(displayName(partner)),
});

/** Walking pace assumed for a walker heading to a pickup. */
export const WALKER_KMH = 4.5;
const ARRIVAL_BUFFER_MIN = 10;

/**
 * When a walker could be at the door: walking time from `km` away plus a 10-minute buffer, rounded to
 * 5 minutes, as a 15-minute window inside 10–120 minutes.
 */
export function arrivalWindow(km: number): { minMinutes: number; maxMinutes: number } {
  const minutes = (km / WALKER_KMH) * 60 + ARRIVAL_BUFFER_MIN;
  const minMinutes = Math.min(105, Math.max(10, Math.round(minutes / 5) * 5));
  return { minMinutes, maxMinutes: minMinutes + 15 };
}
