import type { Booking, Device, Offer, Partner, Subscription, UsedPhoneToken, User } from '../domain/types.ts';

/** Every collection and the document type stored in it. */
export interface Collections {
  users: User;
  devices: Device;
  partners: Partner;
  bookings: Booking;
  offers: Offer;
  subscriptions: Subscription;
  usedPhoneTokens: UsedPhoneToken;
  /** Keyed by E.164 phone number, so each number maps to exactly one user. */
  phoneIndex: { userId: string };
}

export type CollectionName = keyof Collections;

type Primitive = string | number | boolean | null;

/** Equality filters on top-level primitive fields: `{ status: 'pending', partnerId }`. */
export type Where<K extends CollectionName> = {
  [F in keyof Collections[K] as Collections[K][F] extends Primitive ? F : never]?: Collections[K][F];
};

/** Reads first, then writes; the writes land together or not at all. */
export interface Transaction {
  get<K extends CollectionName>(collection: K, id: string): Promise<Collections[K] | null>;
  set<K extends CollectionName>(collection: K, id: string, doc: Collections[K]): void;
}

export interface Store {
  get<K extends CollectionName>(collection: K, id: string): Promise<Collections[K] | null>;
  set<K extends CollectionName>(collection: K, id: string, doc: Collections[K]): Promise<void>;
  /**
   * Writes only the given top-level fields, leaving the rest of the document as it is now (never
   * as some earlier read saw it). Returns false when the document doesn't exist.
   */
  update<K extends CollectionName>(collection: K, id: string, patch: Partial<Collections[K]>): Promise<boolean>;
  /** Writes only if the document doesn't exist yet; returns false when it already did. */
  create<K extends CollectionName>(collection: K, id: string, doc: Collections[K]): Promise<boolean>;
  delete(collection: CollectionName, id: string): Promise<void>;
  find<K extends CollectionName>(collection: K, where: Where<K>, limit?: number): Promise<Collections[K][]>;
  /** Runs `fn` atomically; it may be retried, so it must not have side effects outside `tx`. */
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
}
