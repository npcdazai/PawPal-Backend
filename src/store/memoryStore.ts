import type { CollectionName, Collections, Store, Transaction, Where } from './store.ts';

/**
 * Firestore refuses an array directly inside another array ("Cannot convert an array value in an
 * array value"), but structuredClone doesn't: check here so tests catch it before production does.
 */
export function assertFirestoreValue(value: unknown, path = 'document', insideArray = false): void {
  if (Array.isArray(value)) {
    if (insideArray) throw new Error(`Firestore can't store an array inside an array (${path}).`);
    value.forEach((item, index) => assertFirestoreValue(item, `${path}[${index}]`, true));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) assertFirestoreValue(item, `${path}.${key}`, false);
  }
}

/** Every collection's documents as plain data: what the file store saves and loads. */
export type Snapshot = Partial<Record<CollectionName, Record<string, unknown>>>;

export interface MemoryStoreOptions {
  /** Documents to start with (a snapshot saved earlier). */
  initial?: Snapshot;
  /** Called after every write, once per committed transaction. */
  onWrite?: () => void;
}

/**
 * Process-local store for development and tests. Documents are cloned in and
 * out so callers can't mutate stored state, and transactions run one at a time.
 */
export function createMemoryStore({ initial, onWrite }: MemoryStoreOptions = {}): Store & {
  /** The live documents, to serialise straight away (not cloned). */
  snapshot(): Snapshot;
} {
  const data = new Map<CollectionName, Map<string, unknown>>();
  for (const [collection, rows] of Object.entries(initial ?? {})) {
    data.set(collection as CollectionName, new Map(Object.entries(rows ?? {})));
  }
  const table = (collection: CollectionName) => {
    let rows = data.get(collection);
    if (!rows) {
      rows = new Map();
      data.set(collection, rows);
    }
    return rows;
  };
  const read = <K extends CollectionName>(collection: K, id: string) => {
    const doc = table(collection).get(id);
    return doc === undefined ? null : (structuredClone(doc) as Collections[K]);
  };
  const stored = (collection: CollectionName, doc: unknown) => {
    assertFirestoreValue(doc, collection);
    return structuredClone(doc);
  };

  // Serialises transactions so check-then-write sequences can't interleave.
  let queue: Promise<unknown> = Promise.resolve();

  return {
    async get(collection, id) {
      return read(collection, id);
    },
    async set(collection, id, doc) {
      table(collection).set(id, stored(collection, doc));
      onWrite?.();
    },
    async update(collection, id, patch) {
      const rows = table(collection);
      const current = rows.get(id);
      if (current === undefined) return false;
      rows.set(id, stored(collection, { ...(current as object), ...patch }));
      onWrite?.();
      return true;
    },
    async create(collection, id, doc) {
      const rows = table(collection);
      if (rows.has(id)) return false;
      rows.set(id, stored(collection, doc));
      onWrite?.();
      return true;
    },
    async delete(collection, id) {
      if (table(collection).delete(id)) onWrite?.();
    },
    async find<K extends CollectionName>(collection: K, where: Where<K>, limit?: number) {
      const filters = Object.entries(where);
      const matches: Collections[K][] = [];
      for (const doc of table(collection).values()) {
        const row = doc as Record<string, unknown>;
        if (filters.every(([field, value]) => row[field] === value)) {
          matches.push(structuredClone(doc) as Collections[K]);
          if (limit !== undefined && matches.length >= limit) break;
        }
      }
      return matches;
    },
    transaction<T>(fn: (tx: Transaction) => Promise<T>) {
      const run = queue.then(async () => {
        const writes: [CollectionName, string, unknown][] = [];
        const tx: Transaction = {
          get: async (collection, id) => read(collection, id),
          set: (collection, id, doc) => {
            writes.push([collection, id, stored(collection, doc)]);
          },
        };
        const result = await fn(tx);
        for (const [collection, id, doc] of writes) table(collection).set(id, doc);
        if (writes.length > 0) onWrite?.();
        return result;
      });
      queue = run.catch(() => undefined);
      return run;
    },
    snapshot() {
      return Object.fromEntries([...data].map(([collection, rows]) => [collection, Object.fromEntries(rows)]));
    },
  };
}
