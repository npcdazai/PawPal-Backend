import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../log/logger.ts';
import { createMemoryStore, type Snapshot } from './memoryStore.ts';
import type { Store } from './store.ts';

const log = logger('db');

/** The saved documents, or none. An unreadable file is set aside (not deleted) and the store starts empty. */
function load(file: string): Snapshot {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Not a JSON object.');
    return parsed as Snapshot;
  } catch (error) {
    const aside = `${file}.unreadable-${Date.now()}`;
    try {
      renameSync(file, aside);
    } catch {
      // Left in place; the next save overwrites it.
    }
    log.warn('Development data unreadable; starting empty', { file, keptAs: aside, error });
    return {};
  }
}

/**
 * Development store that survives restarts (`npm run dev` restarts on every
 * save): the in-memory store, written to a JSON file right after each change and
 * read back at startup, so accounts and sessions stay. One process on one
 * machine; production uses Firestore.
 */
export function createFileStore(file: string): Store & { flush(): void } {
  const initial = load(file);
  const documents = Object.values(initial).reduce((sum, rows) => sum + Object.keys(rows ?? {}).length, 0);
  if (documents > 0) log.info('Development data loaded', { file, documents });

  let pending = false;
  const save = () => {
    pending = false;
    try {
      mkdirSync(dirname(file), { recursive: true });
      // Written whole, then swapped in, so a crash mid-write never leaves half a file.
      const temp = `${file}.tmp`;
      writeFileSync(temp, JSON.stringify(store.snapshot()));
      renameSync(temp, file);
    } catch (error) {
      log.error('Couldn’t save the development data', { file, error });
    }
  };

  const store = createMemoryStore({
    initial,
    // The writes of one request or transaction are saved together, right after it.
    onWrite: () => {
      if (pending) return;
      pending = true;
      setImmediate(save);
    },
  });

  return {
    ...store,
    flush: () => {
      if (pending) save();
    },
  };
}
