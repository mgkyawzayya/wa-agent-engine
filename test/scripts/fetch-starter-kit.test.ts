import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { fetchStarterKit, lockDrift } from '../../scripts/fetch-starter-kit.js';
import { STARTER_KIT_FILES, STARTER_KIT_SHA } from '../../src/config/starter-kit.js';

const LOCK_URL = new URL('../../scripts/starter-kit.lock.json', import.meta.url);

describe('lockDrift', () => {
  test('matching sets report nothing', () => {
    expect(lockDrift([...STARTER_KIT_FILES].reverse(), STARTER_KIT_FILES)).toEqual([]);
  });

  test('a dropped or extra entry is named', () => {
    const lock = STARTER_KIT_FILES.filter((p) => p !== 'tilesets/WA_Room_Builder.png');
    expect(lockDrift([...lock, 'tilesets/Extra.png'], STARTER_KIT_FILES)).toEqual([
      'missing tilesets/WA_Room_Builder.png',
      'unexpected tilesets/Extra.png',
    ]);
  });
});

test('committed lock pins the configured commit and file list', async () => {
  const lock = JSON.parse(await readFile(LOCK_URL, 'utf8')) as { sha: string; files: Record<string, string> };
  expect(lock.sha).toBe(STARTER_KIT_SHA);
  expect(lockDrift(Object.keys(lock.files), STARTER_KIT_FILES)).toEqual([]);
});

// The global setup has already populated and verified the cache, so these need no network.
test('a verified cache downloads nothing', async () => {
  const result = await fetchStarterKit();
  expect(result.downloaded).toEqual([]);
});

test('a lock that drops a configured file is rejected before any download', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wa-lock-'));
  try {
    const lock = JSON.parse(await readFile(LOCK_URL, 'utf8')) as { files: Record<string, string> };
    delete lock.files['tilesets/WA_Room_Builder.png'];
    const lockPath = join(dir, 'starter-kit.lock.json');
    await writeFile(lockPath, JSON.stringify(lock));
    await expect(fetchStarterKit({ lockPath })).rejects.toThrow(/missing tilesets\/WA_Room_Builder\.png/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
