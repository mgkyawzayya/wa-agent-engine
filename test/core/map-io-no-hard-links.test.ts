import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeProject, type TempProject } from '../helpers/project.js';

// Simulates a filesystem without hard links (FAT/exFAT, some network mounts).
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: async () => {
      throw Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' });
    },
  };
});

const { createEmptyMap, readMap, writeMap } = await import('../../src/core/map-io.js');

let project: TempProject;
beforeEach(async () => {
  project = await makeProject();
});
afterEach(() => project.cleanup());

test('new maps are still created exclusively without hard links', async () => {
  const abs = join(project.dir, 'maps', 'new.tmj');
  await writeMap(abs, createEmptyMap(3, 2), { projectDir: project.dir, expectedSha256: null });
  expect((await readMap(abs)).map.width).toBe(3);
  await expect(writeMap(abs, createEmptyMap(3, 2), { projectDir: project.dir, expectedSha256: null })).rejects.toMatchObject({
    code: 'MAP_CHANGED_ON_DISK',
  });
  expect((await readdir(join(project.dir, 'maps'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
});

test('the marker image of automapping asset sets is still written without hard links', async () => {
  const { ensureMarkerImage, MARKER_IMAGE, markerPng } = await import('../../src/core/markers.js');
  const { readFile } = await import('node:fs/promises');
  await ensureMarkerImage(project.dir);
  await ensureMarkerImage(project.dir);
  expect(Buffer.from(await readFile(join(project.dir, MARKER_IMAGE))).equals(Buffer.from(markerPng()))).toBe(true);
  expect((await readdir(join(project.dir, 'tilesets'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
});
