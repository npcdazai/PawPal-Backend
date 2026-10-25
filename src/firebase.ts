import { applicationDefault, cert, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { Config } from './config.ts';

/** The Admin SDK app, or null when no Firebase credentials are configured (local development). */
export function initFirebase(config: Config['firebase']): App | null {
  if (!config.configured) return null;
  return initializeApp({
    credential: config.serviceAccountPath ? cert(config.serviceAccountPath) : applicationDefault(),
    ...(config.projectId ? { projectId: config.projectId } : {}),
  });
}

export function firestoreFor(app: App): Firestore {
  const db = getFirestore(app);
  // Optional fields left undefined are skipped instead of failing the write.
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}
