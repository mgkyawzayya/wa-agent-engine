import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { automap, loadRules, resolveExternalTilesets } from '../../../src/core/automap/index.js';
import { readMap } from '../../../src/core/map-io.js';
import { describeMap, FIXTURES } from '../../helpers/automap.js';

// Every deterministic fixture is automapped by the engine and compared, cell by cell, with
// what Tiled 1.12.2 produced for it (expected.tmj, from scripts/tiled-automap-capture.ts).

const names = (await readdir(FIXTURES)).filter((n) => existsSync(join(FIXTURES, n, 'fixture.json'))).sort();
interface Meta {
  random: boolean;
  region?: { x: number; y: number; width: number; height: number };
  inputsHash: string;
  capturedInputsHash?: string;
}
const metas = new Map<string, Meta>();
for (const n of names) metas.set(n, JSON.parse(await readFile(join(FIXTURES, n, 'fixture.json'), 'utf8')) as Meta);
const deterministic = names.filter((n) => !metas.get(n)!.random);

describe('engine output equals Tiled 1.12.2 output', () => {
  test('every deterministic fixture has a Tiled output captured from its current inputs', () => {
    expect(deterministic.length).toBeGreaterThanOrEqual(45);
    for (const n of deterministic) {
      expect(existsSync(join(FIXTURES, n, 'expected.tmj')), n).toBe(true);
      expect(metas.get(n)!.capturedInputsHash, `${n}: inputs changed since the capture; run scripts/tiled-automap-capture.ts`).toBe(metas.get(n)!.inputsHash);
    }
  });

  test.each(deterministic)('%s', async (name) => {
    const dir = join(FIXTURES, name);
    const mapAbs = join(dir, 'map.tmj');
    const { map } = await readMap(mapAbs);
    const rules = await loadRules(FIXTURES, join(dir, 'rules.txt'));
    const region = metas.get(name)!.region;
    const externalTilesets = await resolveExternalTilesets(FIXTURES, map, mapAbs);
    automap(map, rules, { mapFileName: 'map.tmj', mapAbs, seed: 0, externalTilesets, ...(region !== undefined ? { region } : {}) });
    const { map: expected } = await readMap(join(dir, 'expected.tmj'));
    const ours = describeMap(map, mapAbs);
    const tiled = describeMap(expected, join(dir, 'expected.tmj'));
    expect(ours.layers).toEqual(tiled.layers);
    for (const layer of tiled.layers) expect(ours.cells[layer], `${name}: layer ${layer}`).toEqual(tiled.cells[layer]);
    expect(ours.properties).toEqual(tiled.properties);
  });
});
