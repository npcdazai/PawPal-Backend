import type { Firestore, Query } from 'firebase-admin/firestore';
import type { CollectionName, Collections, Store, Where } from './store.ts';

/** gRPC ALREADY_EXISTS, returned by `create()` when the document is already there. */
const ALREADY_EXISTS = 6;
/** gRPC NOT_FOUND, returned by `update()` when there's no document to update. */
const NOT_FOUND = 5;

export function createFirestoreStore(db: Firestore): Store {
  const ref = (collection: CollectionName, id: string) => db.collection(collection).doc(id);

  return {
    async get<K extends CollectionName>(collection: K, id: string) {
      const snap = await ref(collection, id).get();
      return snap.exists ? (snap.data() as Collections[K]) : null;
    },
    async set(collection, id, doc) {
      await ref(collection, id).set(doc);
    },
    async update(collection, id, patch) {
      try {
        // Top-level keys only (none contain dots), so each one replaces just that field.
        await ref(collection, id).update(patch as Record<string, unknown>);
        return true;
      } catch (error) {
        if ((error as { code?: unknown }).code === NOT_FOUND) return false;
        throw error;
      }
    },
    async create(collection, id, doc) {
      try {
        await ref(collection, id).create(doc);
        return true;
      } catch (error) {
        if ((error as { code?: unknown }).code === ALREADY_EXISTS) return false;
        throw error;
      }
    },
    async delete(collection, id) {
      await ref(collection, id).delete();
    },
    async find<K extends CollectionName>(collection: K, where: Where<K>, limit?: number) {
      // Equality-only filters are served by Firestore's automatic single-field indexes.
      let query: Query = db.collection(collection);
      for (const [field, value] of Object.entries(where)) query = query.where(field, '==', value);
      if (limit !== undefined) query = query.limit(limit);
      const snap = await query.get();
      return snap.docs.map((doc) => doc.data() as Collections[K]);
    },
    transaction(fn) {
      return db.runTransaction((t) =>
        fn({
          get: async <K extends CollectionName>(collection: K, id: string) => {
            const snap = await t.get(ref(collection, id));
            return snap.exists ? (snap.data() as Collections[K]) : null;
          },
          set: (collection, id, doc) => {
            t.set(ref(collection, id), doc);
          },
        })
      );
    },
  };
}
