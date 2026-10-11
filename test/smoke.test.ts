import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { STARTER_KIT_SHA, starterKitCacheDir } from '../src/config/starter-kit.js';
import { REPO_ROOT } from './e2e/helpers.js';

test('starter-kit cache holds the pinned tilesets', () => {
  const dir = starterKitCacheDir();
  expect(dir.endsWith(STARTER_KIT_SHA)).toBe(true);
  expect(existsSync(join(dir, 'tilesets', 'WA_Room_Builder.png'))).toBe(true);
});

test('the automap command prints its input schema', async () => {
  const help = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'automap', '--help'], { cwd: REPO_ROOT });
  expect(help.stdout).toContain('"dryRun"');
  expect(help.stdout).toContain('"rules"');
});

test('the automap-template command prints its input schema', async () => {
  const help = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'automap-template', '--help'], { cwd: REPO_ROOT });
  expect(help.stdout).toContain('"outDir"');
  expect(help.stdout).toContain('"tilesets"');
});
