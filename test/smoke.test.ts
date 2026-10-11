import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { STARTER_KIT_SHA, starterKitCacheDir } from '../src/config/starter-kit.js';

test('starter-kit cache holds the pinned tilesets', () => {
  const dir = starterKitCacheDir();
  expect(dir.endsWith(STARTER_KIT_SHA)).toBe(true);
  expect(existsSync(join(dir, 'tilesets', 'WA_Room_Builder.png'))).toBe(true);
});
