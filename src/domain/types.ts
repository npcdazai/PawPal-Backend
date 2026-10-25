/** Which app a session belongs to: PawPal (pet parents) or Pawsome Partner (walkers). */
export type AppKind = 'customer' | 'partner';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface User {
  id: string;
  /** E.164, e.g. "+919876543210". */
  phone: string;
  name: string;
  email: string | null;
  apps: AppKind[];
  createdAt: number;
  /** Bumped by "sign out everywhere": session tokens carry it and stop working once it changes. */
  sessionVersion?: number;
}

/** One FCM registration token; the token is also the document id. */
export interface Device {
  token: string;
  userId: string;
  app: AppKind;
  platform: 'android' | 'ios' | 'web';
  updatedAt: number;
}

export interface Partner {
  userId: string;
  name: string;
  /** "Springfield / Elm Creek District" in the app; the society or locality here. */
  area: string;
  roles: string[];
  sizes: string[];
  skills: string[];
  availability: string[];
  /** Rupees: the smallest payout per walk this walker accepts (dispatch skips cheaper walks). */
  walkRate: number;
  /** Rupees per hour for sitting / drop-ins (shown to pet parents; not used by walk dispatch). */
  hourlyRate: number;
  /** Where weekly payouts go, e.g. "name@okhdfcbank". */
  payoutVpa: string | null;
  radiusKm: number;
  applicationSubmittedAt: number | null;
  approved: boolean;
  /** 0 = not cleared, 1 = low-pull dogs only, 2 = all dogs, 3 = smart-lock home access. */
  trustTier: number;
  online: boolean;
  location: (LatLng & { at: number }) | null;
  /**
   * Pet parents' 1–5 stars, summed and counted as walks are rated (missing on profiles from before
   * ratings were kept, which count as no ratings).
   */
  ratingSum?: number;
  ratingCount?: number;
  updatedAt: number;
}

export type WalkTier = 'subscription' | 'trial' | 'express';

/** From the PawPal behaviour profile: friendly, pulls on the leash, or reactive. */
export type Temperament = 'friendly' | 'pulls' | 'reactive';

/** Trust tier a walker needs for a dog: anyone cleared can walk a friendly dog; pullers and reactive dogs need tier 2. */
export const requiredTrustTier = (temperament: Temperament) => (temperament === 'friendly' ? 1 : 2);

/** `awaiting_payment` → (paid) `searching` → `assigned` → `active` → `completed`, or `cancelled` / `unmatched`. */
export type BookingStatus =
  | 'awaiting_payment'
  | 'searching'
  | 'assigned'
  | 'active'
  | 'completed'
  | 'cancelled'
  | 'unmatched';

export type PaymentStatus =
  /** Payments are switched off on this server (development). */
  | 'not_required'
  /** Covered by a paid monthly pack. */
  | 'prepaid'
  | 'unpaid'
  /** A checkout is open at the gateway. */
  | 'pending'
  | 'paid'
  /** The gateway says paid but hasn't confirmed it against a bank alert yet. */
  | 'review'
  | 'failed';

export interface BookingPayment {
  provider: 'youpi' | 'subscription' | 'none';
  status: PaymentStatus;
  /** Rupees charged for this booking (the whole pack for a subscription's first walk). */
  amount: number;
  /** Our order id for the current attempt, `${bookingId}-${attempt}`; once paid, the attempt that paid. */
  orderId: string | null;
  attempts: number;
  /** The gateway's payment session. */
  paymentId: string | null;
  checkoutUrl: string | null;
  /** When the current checkout was opened (the unpaid hold runs from here). */
  checkoutAt?: number | null;
  utr: string | null;
  verificationLevel: number | null;
  paidAt: number | null;
  /**
   * Money is owed back, refunded by hand (UPI collections can't be reversed by API): the whole
   * amount when a paid walk was cancelled before it started, plus every entry of `extraPayments`.
   */
  refundDue: boolean;
  /** Further successful payments for an already paid booking (an older attempt that settled late). */
  extraPayments?: ExtraPayment[];
}

export interface ExtraPayment {
  orderId: string;
  paymentId: string;
  utr: string | null;
  amountPaise: number;
  at: number;
}

/** Where in a gated township the dog lives (PawPal's society profile). */
export interface SocietyAddress {
  societyId: string;
  tower: string;
  flat: string;
}

export type WalkEventType = 'pee' | 'poop' | 'photo' | 'note';

export interface WalkEvent {
  type: WalkEventType;
  at: number;
  lat: number | null;
  lng: number | null;
  note: string | null;
}

export interface TrackPoint {
  lng: number;
  lat: number;
  at: number;
}

export interface Booking {
  id: string;
  customerId: string;
  status: BookingStatus;
  tier: WalkTier;
  minutes: number;
  /** Rupees for this walk, priced by the server. */
  price: number;
  currency: 'INR';
  /** What the walker earns for it. */
  payout: number;
  scheduledFor: number;
  dog: { name: string; breed: string; size: string; temperament: Temperament; notes: string };
  pickup: LatLng & { address: string };
  society: SocietyAddress | null;
  payment: BookingPayment;
  /** The monthly pack this walk belongs to. */
  subscriptionId: string | null;
  partnerId: string | null;
  /** Partners already asked, so dispatch moves on to the next one. */
  offeredTo: string[];
  /** The offer waiting for an answer, written and cleared with the offer itself so dispatch can always recover. */
  pendingOffer?: { id: string; expiresAt: number } | null;
  /** A pack walk nobody was free for is looked at again from this time. */
  retryAt?: number | null;
  /** Shown to the pet parent only; the walker types it in at the door. */
  pickupOtp: string;
  otpAttempts: number;
  walkerLocation: (LatLng & { at: number }) | null;
  /** When the walker's doorstep selfie matched their enrolled face (gate 4). */
  shiftVerifiedAt: number | null;
  /** Vet & accident cover, switched on by the doorstep check. */
  insurance: { active: boolean; coverInr: number; activatedAt: number } | null;
  events: WalkEvent[];
  /**
   * The walked route while active (capped). Stored as objects because Firestore can't hold an array
   * inside an array; the API still sends `[lng, lat, at]` tuples (see bookingView).
   */
  track: TrackPoint[];
  /** Kilometres walked along `track` (2 decimals), stored at completion; null before (and on older walks). */
  distanceKm?: number | null;
  /** The pet parent's 1–5 rating after the walk. */
  rating: number | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

/** A paid monthly pack: one walk a day at a fixed time until the walks run out or it's cancelled. */
export interface Subscription {
  id: string;
  customerId: string;
  status: 'active' | 'cancelled' | 'finished';
  walksTotal: number;
  walksBooked: number;
  /** Minutes after midnight, India time. */
  slotMinute: number;
  /** The template every generated walk copies. */
  dog: Booking['dog'];
  pickup: Booking['pickup'];
  society: SocietyAddress | null;
  /** Epoch ms of the last walk generated; the next one is the following India-time day at `slotMinute`. */
  lastScheduledFor: number;
  /** Upcoming India-time days ("2026-10-27") the pet parent skipped; the generator books none on them. */
  skipDates?: string[];
  /** The pack's regular walker: the first walker to accept one of its walks. Offered its walks first. */
  primaryWalkerId?: string | null;
  /** Offered the pack's walks when the primary walker can't take them. */
  backupWalkerId?: string | null;
  createdAt: number;
  updatedAt: number;
}

export type OfferStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'withdrawn';

/** A booking offered to one partner, who has a few seconds to take it. */
export interface Offer {
  id: string;
  bookingId: string;
  partnerId: string;
  status: OfferStatus;
  distanceKm: number;
  payout: number;
  expiresAt: number;
  createdAt: number;
}

/** A phone-verification token that has been exchanged once (replay protection). */
export interface UsedPhoneToken {
  usedAt: number;
  /** When the token itself expires; the record can be deleted after that. */
  expiresAt: number;
}
