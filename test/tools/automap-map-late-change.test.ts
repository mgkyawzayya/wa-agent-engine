import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeFullProject, type TempProject } from '../helpers/project.js';

// Another program (Tiled) saves the map while automap_map writes it: the write must fail with
// MAP_CHANGED_ON_DISK and leave Tiled's version, with no temp file behind.
const external = vi.hoisted(() => ({ target: '', on: false, content: '' }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (external.on && String(args[0]).endsWith('.tmp')) {
        external.on = false;
        await actual.writeFile(external.target, external.content);
      }
      return handle;
    },
  };
});

const { scaffoldMap } = await import('../../src/core/compiler.js');
const { automapMapTool } = await import('../../src/tools/automap-map.js');
const { runTool } = await import('../../src/tools/tool.js');
const { writeStartRule } = await import('../helpers/automap.js');

let project: TempProject;
beforeEach(async () => {
  project = await makeFullProject();
  await scaffoldMap({ projectDir: project.dir, mapPath: 'm.tmj', width: 10, height: 8, spawn: { x: 2, y: 3 }, assetSet: 'wa-starter-office' });
  await writeStartRule(project.dir, 'm.tmj', '.');
}, 60_000);
afterEach(() => {
  external.on = false;
  return project.cleanup();
});

test('a save in Tiled during the write is MAP_CHANGED_ON_DISK and wins', async () => {
  const mapAbs = join(project.dir, 'm.tmj');
  const saved = `${await readFile(mapAbs, 'utf8')}\n`;
  Object.assign(external, { target: mapAbs, on: true, content: saved });
  expect(await runTool(automapMapTool, { projectDir: project.dir, mapPath: 'm.tmj' })).toMatchObject({ ok: false, error: { code: 'MAP_CHANGED_ON_DISK' } });
  expect(await readFile(mapAbs, 'utf8')).toBe(saved);
  expect((await readdir(project.dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
});
