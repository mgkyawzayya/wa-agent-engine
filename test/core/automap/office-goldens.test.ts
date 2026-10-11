import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { loadAssetSet, type LoadedAutomapSet } from '../../../src/core/asset-set-registry.js';
import { drawingCoverage } from '../../../src/core/automap/drawing.js';
import { automap, loadRules } from '../../../src/core/automap/index.js';
import { readMap } from '../../../src/core/map-io.js';
import {
  ART_ROLES,
  buildOfficeRooms,
  goldenRooms,
  makeOfficeProject,
  OFFICE_GOLDENS_DIR,
  OFFICE_RULES,
  officeGoldenNames,
  staleOfficeGoldens,
  type GoldenMeta,
  type OfficeProject,
} from '../../../scripts/gen-office-goldens.js';
import { describeMap } from '../../helpers/automap.js';

// The proving set's rules (office-automap) run by Tiled 1.12.2 on the sketch of every piece
// validate_wa_map checks them with, and on the sketch of each room fixture (expected.tmj, from
// scripts/tiled-automap-capture.ts): the engine must draw the same, both running the rules on
// that map and building the rooms.

const names = await officeGoldenNames();
const metas = new Map<string, GoldenMeta>();
for (const n of names) metas.set(n, JSON.parse(await readFile(join(OFFICE_GOLDENS_DIR, n, 'fixture.json'), 'utf8')) as GoldenMeta);

let project: OfficeProject;
beforeAll(async () => {
  project = await makeOfficeProject();
});
afterAll(() => project.cleanup());

describe('office-automap draws what Tiled 1.12.2 draws', () => {
  test('every golden was captured from its current inputs, and the inputs are current', async () => {
    expect(names).toContain('all-pieces');
    expect(names.length).toBe((await goldenRooms()).length + 1);
    for (const n of names) expect(metas.get(n)!.capturedInputsHash, `${n}: run scripts/tiled-automap-capture.ts`).toBe(metas.get(n)!.inputsHash);
    expect(await staleOfficeGoldens()).toEqual([]);
  });

  test.each(names)('%s: the engine runs the rules like Tiled', async (name) => {
    const mapAbs = join(project.dir, `${name}.tmj`);
    await copyFile(join(OFFICE_GOLDENS_DIR, name, 'map.tmj'), mapAbs);
    const { map } = await readMap(mapAbs);
    automap(map, await loadRules(project.dir, join(project.dir, OFFICE_RULES)), { mapAbs, mapFileName: `${name}.tmj`, seed: 0 });
    const ours = describeMap(map, mapAbs);
    const tiled = describeMap((await readMap(join(OFFICE_GOLDENS_DIR, name, 'expected.tmj'))).map, join(OFFICE_GOLDENS_DIR, name, 'expected.tmj'));
    expect(ours.layers).toEqual(tiled.layers);
    for (const layer of tiled.layers) expect(ours.cells[layer], `${name}: layer ${layer}`).toEqual(tiled.cells[layer]);
  });

  test.each(names.filter((n) => n !== 'all-pieces'))('%s: building the rooms draws what Tiled draws on their sketch', async (name) => {
    const fixture = JSON.parse(await readFile(join(OFFICE_GOLDENS_DIR, '..', metas.get(name)!.source), 'utf8')) as Parameters<typeof buildOfficeRooms>[2];
    const mapPath = `${name}-built.tmj`;
    await buildOfficeRooms(project.dir, mapPath, fixture);
    const built = describeMap((await readMap(join(project.dir, mapPath))).map, join(project.dir, mapPath));
    const tiled = describeMap((await readMap(join(OFFICE_GOLDENS_DIR, name, 'expected.tmj'))).map, join(OFFICE_GOLDENS_DIR, name, 'expected.tmj'));
    // The engine's layers carry the role names the rules use.
    for (const layer of ART_ROLES) expect(built.cells[layer], `${name}: layer ${layer}`).toEqual(tiled.cells[layer]);
  });

  test('the rules draw every piece validate_wa_map checks', async () => {
    const set = (await loadAssetSet('office-automap', project.dir)) as LoadedAutomapSet;
    const rules = await loadRules(project.dir, join(project.dir, OFFICE_RULES));
    expect(await drawingCoverage(set, rules, project.dir, join(project.dir, 'all-pieces.tmj'))).toEqual([]);
  });
});
