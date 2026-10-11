import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// Mirrors the package.json `files` allowlist plus what npm always includes.
const ALLOWED = [
  /^package\.json$/,
  /^README(\.md)?$/i,
  /^LICEN[CS]E(\.\w+)?$/i,
  /^dist\/.+\.(js|d\.ts)$/,
  /^assets\/sets\/.+\.(tsj|tmj)$/,
  /^assets\/sets\/.+\/set\.json$/,
  /^assets\/markers\/[^/]+\.tsj$/,
  /^skills\/.+\.md$/,
];

interface PackEntry {
  files: { path: string }[];
}

// The starter-kit PNGs are licensed for WA maps only: no PNG may ever enter the package.
test('npm pack ships the asset set, only allowlisted files, and no PNG', async () => {
  const { stdout } = await run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: REPO_ROOT,
    maxBuffer: 16 * 1024 * 1024,
  });
  const [entry] = JSON.parse(stdout) as PackEntry[];
  const paths = entry?.files.map((f) => f.path) ?? [];
  expect(paths).toContain('package.json');
  expect(paths).toContain('LICENSE');
  expect(paths.filter((p) => p.toLowerCase().endsWith('.png'))).toEqual([]);
  expect(paths.filter((p) => !ALLOWED.some((re) => re.test(p)))).toEqual([]);
  // The built-in asset set must ship: set.json, its 9 tilesets, and the 69 prefabs.
  const set = paths.filter((p) => p.startsWith('assets/sets/wa-starter-office/'));
  expect(set).toContain('assets/sets/wa-starter-office/set.json');
  expect(set.filter((p) => p.endsWith('.tsj'))).toHaveLength(9);
  expect(set.filter((p) => p.endsWith('.tmj'))).toHaveLength(69);
  // The marker tileset of automapping asset sets ships as a .tsj; its image is generated.
  expect(paths.filter((p) => p.startsWith('assets/markers/'))).toEqual(['assets/markers/wa-markers.tsj']);
});

test('the package is MIT-licensed, and says so in package.json and LICENSE', async () => {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { license: string };
  expect(pkg.license).toBe('MIT');
  expect(await readFile(new URL('../LICENSE', import.meta.url), 'utf8')).toMatch(/^MIT License\n/);
});

test('the version the server reports is the package version', async () => {
  const { readFile } = await import('node:fs/promises');
  const { VERSION } = await import('../src/version.js');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  expect(VERSION).toBe(pkg.version);
});
