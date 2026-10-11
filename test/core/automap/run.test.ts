import { copyFile, mkdir, readFile, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { automap, loadRules } from '../../../src/core/automap/index.js';
import { createRandom, RandomPicker } from '../../../src/core/automap/random.js';
import { Region } from '../../../src/core/automap/region.js';
import { readMap, serializeMap } from '../../../src/core/map-io.js';
import { forEachTileLayer, readTileData } from '../../../src/core/layers.js';
import { isWaEngineError } from '../../../src/core/errors.js';
import type { TiledMap } from '../../../src/schemas/tiled.schema.js';
import { makeProject, type TempProject } from '../../helpers/project.js';
import { FIXTURES } from '../../helpers/automap.js';

const layerData = (map: TiledMap, name: string): number[] => {
  let data: number[] = [];
  forEachTileLayer(map.layers, (l) => {
    if (l.name === name) data = Array.from(readTileData(l));
  });
  return data;
};

async function run(name: string, seed = 0, region?: { x: number; y: number; width: number; height: number }): Promise<{ map: TiledMap; report: ReturnType<typeof automap> }> {
  const dir = join(FIXTURES, name);
  const { map } = await readMap(join(dir, 'map.tmj'));
  const rules = await loadRules(FIXTURES, join(dir, 'rules.txt'));
  const report = automap(map, rules, { mapFileName: 'map.tmj', mapAbs: join(dir, 'map.tmj'), seed, ...(region === undefined ? {} : { region }) });
  return { map, report };
}

describe('seeded randomness', () => {
  test('mulberry32 gives a fixed sequence for seed 0', () => {
    const r = createRandom(0);
    expect([r(), r(), r(), r()].map((v) => Math.round(v * 2 ** 32))).toEqual([1144304738, 1416247, 958946056, 627933444]);
  });

  test('RandomPicker skips weights of 0 or less and returns a single entry without drawing', () => {
    const picker = new RandomPicker<string>();
    picker.add('never', 0);
    picker.add('never either', -1);
    picker.add('only', 2);
    let draws = 0;
    expect(picker.pick(() => (draws++, 0.5))).toBe('only');
    expect(draws).toBe(0);
    expect(picker.size).toBe(1);
  });

  test('output index weights 3:1 give about 75% and 25% over 200 runs', async () => {
    let b = 0;
    let c = 0;
    for (let seed = 0; seed < 200; seed++) {
      const { map } = await run('output-probability', seed);
      for (const v of layerData(map, 'ground')) {
        if (v === 2) b++;
        if (v === 3) c++;
      }
    }
    const share = b / (b + c);
    expect(b + c).toBe(200 * 64);
    expect(share).toBeGreaterThan(0.75 * 0.9);
    expect(share).toBeLessThan(0.75 * 1.1);
  });

  test('the same seed gives byte-identical output; another seed differs', async () => {
    const a = serializeMap((await run('output-probability', 0)).map);
    const b = serializeMap((await run('output-probability', 0)).map);
    const c = serializeMap((await run('output-probability', 1)).map);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  test('a rule Probability of 0.25 applies to about a quarter of the positions', async () => {
    let applied = 0;
    for (let seed = 0; seed < 50; seed++) applied += (await run('rule-probability', seed)).report.matches;
    const share = applied / (50 * 64);
    expect(share).toBeGreaterThan(0.25 * 0.9);
    expect(share).toBeLessThan(0.25 * 1.1);
  });
});

describe('reports', () => {
  test('counts rules, matches, changed cells and written layers', async () => {
    const { report } = await run('simple-replace');
    expect(report).toMatchObject({ rulesPath: 'simple-replace/rules.txt', ruleMaps: ['simple-replace/replace.tmj'], rules: 1, matches: 4, changedCells: 4, layersWritten: ['ground'] });
  });

  test('a new output layer is reported and appended at the top', async () => {
    const { map, report } = await run('new-layer');
    expect(report.layersWritten).toEqual(['overlay']);
    expect(map.layers.at(-1)!.name).toBe('overlay');
  });

  test('filtered-out rule maps are not listed', async () => {
    const { report } = await run('filters');
    expect(report.ruleMaps).toEqual(['filters/applied.tmj', 'filters/included.tmj']);
  });
});

describe('regions', () => {
  test('a region limits the automapped area', async () => {
    const { map } = await run('simple-replace', 0, { x: 0, y: 0, width: 2, height: 2 });
    // Only the A at (0,0) and (1,1) lie inside the region.
    expect(layerData(map, 'ground')).toEqual([2, 0, 0, 1, 0, 2, 0, 0, 0, 0, 0, 1]);
  });

  test('a region outside the map changes nothing', async () => {
    const { report } = await run('simple-replace', 0, { x: 10, y: 10, width: 2, height: 2 });
    expect(report.matches).toBe(0);
    expect(report.changedCells).toBe(0);
  });

  test('banded rectangles merge identical rows and keep Qt order', () => {
    const region = new Region();
    region.addRect({ left: 0, top: 0, right: 3, bottom: 1 });
    region.addRect({ left: 6, top: 1, right: 7, bottom: 1 });
    region.addRect({ left: 0, top: 2, right: 3, bottom: 2 });
    expect(region.rects()).toEqual([
      { left: 0, top: 0, right: 3, bottom: 0 },
      { left: 0, top: 1, right: 3, bottom: 1 },
      { left: 6, top: 1, right: 7, bottom: 1 },
      { left: 0, top: 2, right: 3, bottom: 2 },
    ]);
    const merged = Region.fromRect(0, 0, 2, 3);
    expect(merged.rects()).toEqual([{ left: 0, top: 0, right: 1, bottom: 2 }]);
    expect(merged.coversRect({ left: 0, top: 0, right: 1, bottom: 2 })).toBe(true);
    expect(merged.intersects(Region.fromRect(1, 2, 1, 1))).toBe(true);
    expect(merged.intersects(Region.fromRect(2, 0, 1, 1))).toBe(false);
  });
});

describe('working maps and tilesets', () => {
  let project: TempProject;
  beforeEach(async () => {
    project = await makeProject();
    await copyFile(join(FIXTURES, 'tilesets', 'colours.png'), join(project.dir, 'tilesets', 'colours.png'));
    await copyFile(join(FIXTURES, 'tilesets', 'rules.png'), join(project.dir, 'tilesets', 'rules.png'));
    await mkdir(join(project.dir, 'm'));
    for (const f of ['map.tmj', 'replace.tmj', 'rules.txt']) await copyFile(join(FIXTURES, 'simple-replace', f), join(project.dir, 'm', f));
  });
  afterEach(() => project.cleanup());

  test('a rule tileset the map lacks is added after the existing ones, only when used', async () => {
    const mapAbs = join(project.dir, 'm', 'map.tmj');
    const { map } = await readMap(mapAbs);
    map.tilesets = [];
    const rules = await loadRules(project.dir, join(project.dir, 'm', 'rules.txt'));
    const report = automap(map, rules, { mapFileName: 'map.tmj', mapAbs });
    // The map has no colours tileset, so no A ever matches: nothing is added.
    expect(report.changedCells).toBe(0);
    expect(map.tilesets).toEqual([]);
  });

  test('outputs from a tileset the map lacks embed it with the image relative to the map', async () => {
    await writeFile(
      join(project.dir, 'm', 'rules.txt'),
      'fill.tmj\n',
    );
    const rule = JSON.parse(serializeMap((await readMap(join(project.dir, 'm', 'replace.tmj'))).map)) as TiledMap;
    // input: Empty (rules tileset), output: B (colours tileset).
    (rule.layers[0] as { data: number[] }).data = [9];
    await writeFile(join(project.dir, 'm', 'fill.tmj'), JSON.stringify(rule));
    const mapAbs = join(project.dir, 'm', 'map.tmj');
    const { map } = await readMap(mapAbs);
    map.tilesets = [];
    (map.layers[0] as { data: number[] }).data = new Array(12).fill(0);
    const rules = await loadRules(project.dir, join(project.dir, 'm', 'rules.txt'));
    const report = automap(map, rules, { mapFileName: 'map.tmj', mapAbs });
    expect(report.changedCells).toBe(12);
    expect(map.tilesets).toHaveLength(1);
    expect(map.tilesets[0]).toMatchObject({ firstgid: 1, name: 'colours', image: '../tilesets/colours.png' });
    expect(layerData(map, 'ground').every((v) => v === 2)).toBe(true);
  });

  test('a different tileset with the same name is a TILESET_CONFLICT and the map is untouched', async () => {
    await writeFile(join(project.dir, 'm', 'rules.txt'), 'replace.tmj\n');
    const mapAbs = join(project.dir, 'm', 'map.tmj');
    const { map } = await readMap(mapAbs);
    // Same name, other image: not the same tileset, so B must be embedded and clashes.
    (map.tilesets[0] as { image: string }).image = '../tilesets/rules.png';
    const rule = JSON.parse(serializeMap((await readMap(join(project.dir, 'm', 'replace.tmj'))).map)) as TiledMap;
    (rule.layers[0] as { data: number[] }).data = [9];
    await writeFile(join(project.dir, 'm', 'replace.tmj'), JSON.stringify(rule));
    const before = serializeMap(map);
    const rules = await loadRules(project.dir, join(project.dir, 'm', 'rules.txt'));
    let error: unknown;
    try {
      automap(map, rules, { mapFileName: 'map.tmj', mapAbs });
    } catch (e) {
      error = e;
    }
    expect(isWaEngineError(error, 'TILESET_CONFLICT')).toBe(true);
    expect(serializeMap(map)).toBe(before);
  });

  test('non-orthogonal and infinite working maps are AUTOMAP_UNSUPPORTED', async () => {
    const mapAbs = join(project.dir, 'm', 'map.tmj');
    const rules = await loadRules(project.dir, join(project.dir, 'm', 'rules.txt'));
    const iso = (await readMap(mapAbs)).map;
    iso.orientation = 'isometric';
    expect(() => automap(iso, rules, { mapFileName: 'map.tmj', mapAbs })).toThrow(expect.objectContaining({ code: 'AUTOMAP_UNSUPPORTED', details: { feature: 'orientation' } }));
    const inf = (await readMap(mapAbs)).map;
    inf.infinite = true;
    expect(() => automap(inf, rules, { mapFileName: 'map.tmj', mapAbs })).toThrow(expect.objectContaining({ code: 'AUTOMAP_UNSUPPORTED', details: { feature: 'infinite' } }));
  });

  test('a map an external tileset the engine was told about compares by its source file', async () => {
    const mapAbs = join(project.dir, 'm', 'map.tmj');
    const { map } = await readMap(mapAbs);
    map.tilesets = [{ firstgid: 1, source: 'colours.tsj' }];
    const rules = await loadRules(project.dir, join(project.dir, 'm', 'rules.txt'));
    // An embedded rule tileset never equals an external one: nothing matches, nothing is added.
    const report = automap(map, rules, { mapFileName: 'map.tmj', mapAbs, externalTilesets: { 'colours.tsj': { sourceAbs: join(project.dir, 'm', 'colours.tsj'), tilecount: 8 } } });
    expect(report.changedCells).toBe(0);
  });
});

describe('hostile input stays bounded', () => {
  test('a region far larger than the map is clamped, not allocated', async () => {
    const started = Date.now();
    const { report } = await run('simple-replace', 0, { x: -1_000_000, y: -1_000_000, width: 20_000_000, height: 20_000_000 });
    expect(report.changedCells).toBe(4);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('a region with fractional tiles is INVALID_INPUT', async () => {
    await expect(run('simple-replace', 0, { x: 0.5, y: 0, width: 1, height: 1 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  test('a negative seed is INVALID_INPUT', async () => {
    await expect(run('simple-replace', -1)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  test('a 256x192 map with 100 rules and NoOverlappingOutput finishes quickly', async () => {
    const project = await makeProject();
    try {
      await copyFile(join(FIXTURES, 'tilesets', 'colours.png'), join(project.dir, 'tilesets', 'colours.png'));
      await copyFile(join(FIXTURES, 'tilesets', 'rules.png'), join(project.dir, 'tilesets', 'rules.png'));
      const base = (await readMap(join(FIXTURES, 'simple-replace', 'replace.tmj'))).map;
      // 100 rules side by side on a 200x1 rule map: A,B,C... cycling into the next colour.
      const rule = structuredClone(base);
      rule.width = 200;
      const input = new Array(200).fill(0);
      const output = new Array(200).fill(0);
      for (let i = 0; i < 100; i++) {
        input[i * 2] = 1 + (i % 8);
        output[i * 2] = 1 + ((i + 1) % 8);
      }
      Object.assign(rule.layers[0]!, { width: 200, data: input });
      Object.assign(rule.layers[1]!, { width: 200, data: output });
      rule.properties = [{ name: 'NoOverlappingOutput', type: 'bool', value: true }];
      await mkdir(join(project.dir, 'm'));
      await writeFile(join(project.dir, 'm', 'rules.tmj'), JSON.stringify(rule));
      const map = structuredClone((await readMap(join(FIXTURES, 'simple-replace', 'map.tmj'))).map);
      map.width = 256;
      map.height = 192;
      Object.assign(map.layers[0]!, { width: 256, height: 192, data: Array.from({ length: 256 * 192 }, (_, i) => 1 + (i % 8)) });
      const mapAbs = join(project.dir, 'm', 'map.tmj');
      const rules = await loadRules(project.dir, join(project.dir, 'm', 'rules.tmj'));
      const started = Date.now();
      const report = automap(map, rules, { mapFileName: 'map.tmj', mapAbs });
      expect(report.rules).toBe(100);
      expect(report.changedCells).toBe(256 * 192);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await project.cleanup();
    }
  });
});

describe('paths', () => {
  let project: TempProject;
  beforeEach(async () => {
    project = await makeProject();
    await copyFile(join(FIXTURES, 'tilesets', 'colours.png'), join(project.dir, 'tilesets', 'colours.png'));
    await copyFile(join(FIXTURES, 'tilesets', 'rules.png'), join(project.dir, 'tilesets', 'rules.png'));
    await mkdir(join(project.dir, 'm'));
    for (const f of ['map.tmj', 'replace.tmj', 'rules.txt']) await copyFile(join(FIXTURES, 'simple-replace', f), join(project.dir, 'm', f));
  });
  afterEach(() => project.cleanup());

  test('the project may be given through a symbolic link', async () => {
    const link = join(await realpath(tmpdir()), `wa-link-${process.pid}-${Date.now()}`);
    await symlink(project.dir, link);
    try {
      const rules = await loadRules(link, join(link, 'm', 'rules.txt'));
      expect(rules.rulesPath).toBe('m/rules.txt');
      const { map } = await readMap(join(project.dir, 'm', 'map.tmj'));
      expect(automap(map, rules, { mapFileName: 'map.tmj', mapAbs: join(project.dir, 'm', 'map.tmj') }).changedCells).toBe(4);
    } finally {
      await unlink(link);
    }
  });

  test('a map outside the rules\' project is INVALID_INPUT, not a silent no-op', async () => {
    const rules = await loadRules(project.dir, join(project.dir, 'm', 'rules.txt'));
    const { map } = await readMap(join(project.dir, 'm', 'map.tmj'));
    expect(() => automap(map, rules, { mapFileName: 'map.tmj', mapAbs: '/elsewhere/map.tmj' })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});

describe('Tiled details checked by the engine only', () => {
  let project: TempProject;
  beforeEach(async () => {
    project = await makeProject();
    await copyFile(join(FIXTURES, 'tilesets', 'colours.png'), join(project.dir, 'tilesets', 'colours.png'));
    await copyFile(join(FIXTURES, 'tilesets', 'rules.png'), join(project.dir, 'tilesets', 'rules.png'));
    await mkdir(join(project.dir, 'm'));
    for (const f of ['map.tmj', 'replace.tmj', 'rules.txt']) await copyFile(join(FIXTURES, 'simple-replace', f), join(project.dir, 'm', f));
  });
  afterEach(() => project.cleanup());

  const edit = async (file: string, change: (m: TiledMap) => void): Promise<void> => {
    const { map } = await readMap(join(project.dir, 'm', file));
    change(map);
    await writeFile(join(project.dir, 'm', file), JSON.stringify(map));
  };
  const runHere = async (): Promise<{ map: TiledMap; report: ReturnType<typeof automap> }> => {
    const rules = await loadRules(project.dir, join(project.dir, 'm', 'rules.txt'));
    const { map } = await readMap(join(project.dir, 'm', 'map.tmj'));
    return { map, report: automap(map, rules, { mapFileName: 'map.tmj', mapAbs: join(project.dir, 'm', 'map.tmj') }) };
  };

  test('a ModX of 2^31 or more tries one column per row instead of looping forever', async () => {
    await edit('replace.tmj', (m) => (m.properties = [{ name: 'ModX', type: 'int', value: -1 }]));
    await edit('map.tmj', (m) => Object.assign(m.layers[0]!, { data: new Array(12).fill(1) }));
    const { map } = await runHere();
    expect(layerData(map, 'ground')).toEqual([2, 1, 1, 1, 2, 1, 1, 1, 2, 1, 1, 1]);
  });

  test('a rule Probability that is not a number reads as 0, so the rule never applies', async () => {
    await edit('replace.tmj', (m) => (m.properties = [{ name: 'Probability', type: 'string', value: '50%' }]));
    expect((await runHere()).report.matches).toBe(0);
  });

  test('adding a tileset after an unreadable external tileset is EXTERNAL_TILESET_UNRESOLVED', async () => {
    await edit('replace.tmj', (m) => Object.assign(m.layers[0]!, { data: [9] }));
    await edit('map.tmj', (m) => {
      m.tilesets = [{ firstgid: 1, source: 'other.tsx' }];
      Object.assign(m.layers[0]!, { data: new Array(12).fill(0) });
    });
    await expect(runHere()).rejects.toMatchObject({ code: 'EXTERNAL_TILESET_UNRESOLVED' });
  });

  test('two added tilesets with the same name are a TILESET_CONFLICT', async () => {
    await writeFile(join(project.dir, 'tilesets', 'copy.png'), await readFile(join(FIXTURES, 'tilesets', 'colours.png')));
    await edit('replace.tmj', (m) => Object.assign(m.layers[0]!, { data: [9] }));
    const second = (await readMap(join(project.dir, 'm', 'replace.tmj'))).map;
    (second.tilesets[0] as { image: string }).image = '../tilesets/copy.png';
    await writeFile(join(project.dir, 'm', 'second.tmj'), JSON.stringify(second));
    await writeFile(join(project.dir, 'm', 'rules.txt'), 'replace.tmj\nsecond.tmj\n');
    await edit('map.tmj', (m) => {
      m.tilesets = [];
      Object.assign(m.layers[0]!, { data: new Array(12).fill(0) });
    });
    // Tilesets are only added when the result uses them: the first rule map fills ground from
    // colours.png, the second fills a new layer from copy.png, both named "colours".
    await edit('second.tmj', (m) => {
      Object.assign(m.layers[0]!, { data: [10] });
      m.layers[1]!.name = 'output_deco';
    });
    await expect(runHere()).rejects.toMatchObject({ code: 'TILESET_CONFLICT' });
  });
});
