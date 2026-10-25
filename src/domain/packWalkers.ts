import { logger } from '../log/logger.ts';
import type { Store } from '../store/store.ts';
import { distanceKm, walkFare } from './pricing.ts';
import { requiredTrustTier, type Partner, type Subscription } from './types.ts';

const log = logger('pack');

/**
 * Whether a walker can stay a pack's primary or backup walker: their account exists, they're
 * approved, cleared for the dog's temperament, and not the pet parent themselves.
 */
export function canWalkPack(partner: Partner | null, pack: Subscription): partner is Partner {
  return (
    partner !== null &&
    partner.approved &&
    (partner.trustTier ?? 0) >= requiredTrustTier(pack.dog.temperament) &&
    partner.userId !== pack.customerId
  );
}

/**
 * The backup for a pack: of the walkers who can walk it (other than the primary), the closest to the
 * pickup by their last reported position, among those whose radius covers it and who'd take its payout.
 */
async function closestBackup(store: Store, pack: Subscription, primaryId: string): Promise<string | null> {
  const payout = walkFare('subscription', pack.lastScheduledFor).payout;
  const ranked = (await store.find('partners', { approved: true }))
    .filter((partner) => partner.userId !== primaryId && partner.location && canWalkPack(partner, pack))
    .filter((partner) => (partner.walkRate ?? 0) <= payout)
    .map((partner) => ({ id: partner.userId, km: distanceKm(pack.pickup, partner.location!), radius: partner.radiusKm }))
    .filter(({ km, radius }) => km <= radius)
    .sort((a, b) => a.km - b.km || a.id.localeCompare(b.id));
  return ranked[0]?.id ?? null;
}

/**
 * Keeps a pack's primary and backup walkers current, and returns the pack as saved.
 *
 * - The primary is the first walker to accept one of its walks (`acceptedBy`). One who stops qualifying
 *   (see canWalkPack) is cleared, and the next walker to accept takes over.
 * - The backup is chosen once there is a primary, and chosen again when it stops qualifying, becomes
 *   the primary, or was null (nobody qualified last time). No primary, no backup.
 */
export async function refreshPackWalkers(
  store: Store,
  packId: string,
  { at, acceptedBy }: { at: number; acceptedBy?: string }
): Promise<Subscription | null> {
  const pack = await store.get('subscriptions', packId);
  if (!pack) return null;
  const before = { primary: pack.primaryWalkerId ?? null, backup: pack.backupWalkerId ?? null };

  let primary = before.primary;
  let primaryCleared = false;
  if (primary && !canWalkPack(await store.get('partners', primary), pack)) {
    primary = null;
    primaryCleared = true;
  }
  if (!primary && acceptedBy) primary = acceptedBy;

  let backup = primary ? before.backup : null;
  if (primary && (!backup || backup === primary || !canWalkPack(await store.get('partners', backup), pack))) {
    backup = await closestBackup(store, pack, primary);
  }
  if (primary === before.primary && backup === before.backup) return pack;

  const saved = await store.transaction(async (tx) => {
    const current = await tx.get('subscriptions', packId);
    if (!current) return null;
    // Another acceptance changed the walkers since we looked: the first one wins.
    if ((current.primaryWalkerId ?? null) !== before.primary || (current.backupWalkerId ?? null) !== before.backup) {
      return { pack: current, changed: false };
    }
    const next: Subscription = { ...current, primaryWalkerId: primary, backupWalkerId: backup, updatedAt: at };
    tx.set('subscriptions', packId, next);
    return { pack: next, changed: true };
  });
  if (!saved?.changed) return saved?.pack ?? null;

  if (primaryCleared) log.warn('Pack walker no longer qualifies; cleared', { pack: packId, walker: before.primary });
  if (primary && primary !== before.primary) log.info('Pack walker assigned', { pack: packId, walker: primary });
  if (backup !== before.backup) {
    if (backup) log.info('Backup walker chosen', { pack: packId, walker: backup, primary });
    else if (primary) log.info('No backup walker available for the pack', { pack: packId, primary });
  }
  return saved.pack;
}
