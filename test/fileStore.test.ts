import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { devSessionSecret } from '../src/dev/devSecret.ts';
import { createFileStore } from '../src/store/fileStore.ts';
import type { User } from '../src/domain/types.ts';

const dir = mkdtempSync(join(tmpdir(), 'pawpal-file-store-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Saves happen right after the writes of the current turn. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const user = (id: string, name: string): User => ({ id, phone: `+9198000000${id}`, name, email: null, apps: ['customer'], createdAt: 1 });

describe('file store', () => {
  test('a restarted server sees every kind of write', async () => {
    const file = join(dir, 'restart', 'dev-store.json');
    const first = createFileStore(file);
    await first.set('users', '01', user('01', 'Asha'));
    await first.create('users', '02', user('02', 'Ravi'));
    await first.set('users', '03', user('03', 'Gone'));
    await first.update('users', '01', { name: 'Asha K' });
    await first.delete('users', '03');
    await first.transaction(async (tx) => {
      tx.set('phoneIndex', '+919800000001', { userId: '01' });
    });
    await settle();

    const second = createFileStore(file);
    assert.equal((await second.get('users', '01'))?.name, 'Asha K');
    assert.equal((await second.get('users', '02'))?.name, 'Ravi');
    assert.equal(await second.get('users', '03'), null);
    assert.deepEqual(await second.get('phoneIndex', '+919800000001'), { userId: '01' });
    assert.equal(existsSync(`${file}.tmp`), false);
  });

  test('flush saves writes that are still waiting', async () => {
    const file = join(dir, 'flush', 'dev-store.json');
    const store = createFileStore(file);
    await store.set('users', '04', user('04', 'Meera'));
    store.flush();
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).users['04'].name, 'Meera');
  });

  test('an unreadable file is set aside and the store starts empty', async () => {
    const folder = join(dir, 'broken');
    const file = join(folder, 'dev-store.json');
    mkdirSync(folder, { recursive: true });
    writeFileSync(file, '{ not json');
    const store = createFileStore(file);
    assert.equal(await store.get('users', '01'), null);
    assert.ok(readdirSync(folder).some((name) => name.startsWith('dev-store.json.unreadable-')));
  });
});

describe('development session key', () => {
  test('made once, then reused after a restart', () => {
    const file = join(dir, 'key', 'dev-session-secret');
    const first = devSessionSecret(file);
    const again = devSessionSecret(file);
    assert.equal(first.length, 64);
    assert.deepEqual(again, first);
  });
});

describe('store config', () => {
  test('development keeps data in a file by default; production refuses it', () => {
    assert.equal(loadConfig({}).store, 'file');
    assert.equal(loadConfig({}).storeFile, '.data/dev-store.json');
    assert.equal(loadConfig({ STORE: 'memory' }).store, 'memory');
    assert.equal(loadConfig({}).sessionSecretSet, false);
    assert.equal(loadConfig({ SESSION_SECRET: 'x'.repeat(40) }).sessionSecretSet, true);
    assert.throws(
      () => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), STORE: 'file' }),
      /STORE=file is for development/
    );
  });
});
