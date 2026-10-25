import { mkdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { logger } from '../log/logger.ts';

/** The slice of a Postgres client the repositories use (pg.Pool in the server, PGlite in tests). */
export interface Db {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * `postgres://…` → a connection pool. `pglite://<folder>` (development only) → Postgres + pgvector
 * compiled to WASM, running in this process and saved in that folder, so no database server is needed.
 */
export async function connect(databaseUrl: string): Promise<Db & { exec?(sql: string): Promise<unknown>; end(): Promise<void> }> {
  if (!databaseUrl.startsWith('pglite://')) return createPool(databaseUrl);
  const [{ PGlite }, { vector }] = await Promise.all([import('@electric-sql/pglite'), import('@electric-sql/pglite-pgvector')]);
  const folder = databaseUrl.slice('pglite://'.length);
  if (folder) await mkdir(folder, { recursive: true });
  const db = await PGlite.create(folder ? `file://${folder}` : undefined, { extensions: { vector } });
  return {
    query: async <R,>(text: string, params?: unknown[]) => ({ rows: (await db.query<R>(text, params)).rows }),
    exec: (sql: string) => db.exec(sql),
    end: () => db.close(),
  };
}

export function createPool(databaseUrl: string): Db & { end(): Promise<void> } {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  pool.on('error', (error) => logger('db').error('Idle Postgres client failed', { error }));
  return {
    query: async <R,>(text: string, params?: unknown[]) => ({ rows: (await pool.query(text, params)).rows as R[] }),
    end: () => pool.end(),
  };
}

export const SCHEMA_URL = new URL('../../db/schema.sql', import.meta.url);

/** Applies db/schema.sql (idempotent). */
export async function migrate(db: { exec?: (sql: string) => Promise<unknown> } & Db) {
  const sql = await readFile(SCHEMA_URL, 'utf8');
  if (db.exec) await db.exec(sql);
  else await db.query(sql);
}

/** pgvector literal: [0.1,0.2,…] */
export const toVector = (values: readonly number[]) => `[${values.join(',')}]`;

/** pgvector comes back as text "[0.1,0.2,…]". */
export const fromVector = (value: unknown): number[] | null =>
  typeof value === 'string' ? (JSON.parse(value) as number[]) : Array.isArray(value) ? (value as number[]) : null;
