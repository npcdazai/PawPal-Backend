import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../log/logger.ts';

/**
 * The development server's own session-signing key, made once and kept in
 * `file`, so sessions saved in the apps stay valid when `npm run dev` restarts.
 * Production sets SESSION_SECRET instead.
 */
export function devSessionSecret(file: string): Uint8Array {
  try {
    const saved = readFileSync(file, 'utf8').trim();
    if (saved.length >= 32) return new TextEncoder().encode(saved);
  } catch {
    // First run: no key yet.
  }
  const fresh = randomBytes(32).toString('hex');
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, fresh, { mode: 0o600 });
  } catch (error) {
    logger('auth').warn('Couldn’t keep the development session key; sessions end when the server restarts', { file, error });
  }
  return new TextEncoder().encode(fresh);
}
