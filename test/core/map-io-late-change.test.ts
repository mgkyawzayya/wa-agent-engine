import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeProject, type TempProject } from '../helpers/project.js';

// Simulates another program (Tiled, a second agent) saving the map at the last moment of a
// write: right after the engine's temp file is opened, or right after the engine re-read the
// map to check it.
const external = vi.hoisted(() => ({ target: '', on: '' as '' | 'temp-open' | 'after-check-read', content: '' }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const save = async (): Promise<void> => {
    external.on = '';
    await actual.writeFile(external.target, external.content);
  };
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (external.on === 'temp-open' && String(args[0]).endsWith('.tmp')) await save();
      return handle;
    },
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      const result = await actual.readFile(...args);
      if (external.on === 'after-check-read' && String(args[0]) === external.target) await save();
      return result;
    }) as typeof actual.readFile,
  };
});

const { readMap, writeMap } = await import('../../src/core/map-io.js');

let project: TempProject;
beforeEach(async () => {
  project = await makeProject({ maps: ['office.tmj'] });
});
afterEach(() => {
  external.on = '';
  return project.cleanup();
});

test.each(['temp-open', 'after-check-read'] as const)('a save landing at %s is kept and the engine write fails', async (on) => {
  const abs = join(project.dir, 'office.tmj');
  const { map, sha256 } = await readMap(abs);
  Object.assign(external, { target: abs, on, content: '{"saved":"by tiled"}' });
  await expect(writeMap(abs, map, { projectDir: project.dir, expectedSha256: sha256 })).rejects.toMatchObject({ code: 'MAP_CHANGED_ON_DISK' });
  expect(external.on).toBe('');
  expect(await readFile(abs, 'utf8')).toBe('{"saved":"by tiled"}');
  expect((await readdir(project.dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
});

test('without a late save the same write succeeds', async () => {
  const abs = join(project.dir, 'office.tmj');
  const { map, sha256 } = await readMap(abs);
  const written = await writeMap(abs, map, { projectDir: project.dir, expectedSha256: sha256 });
  expect((await readMap(abs)).sha256).toBe(written);
});
