import { chmod, copyFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { scaffoldMap } from '../../src/core/compiler.js';
import { readMap } from '../../src/core/map-io.js';
import { forEachTileLayer, readTileData } from '../../src/core/layers.js';
import { automapMapTool } from '../../src/tools/automap-map.js';
import { runTool } from '../../src/tools/tool.js';
import { writeStartRule } from '../helpers/automap.js';
import { makeFullProject, type TempProject } from '../helpers/project.js';

let project: TempProject;
const mapPath = 'maps/m.tmj';

beforeEach(async () => {
  project = await makeFullProject();
  await scaffoldMap({ projectDir: project.dir, mapPath, width: 10, height: 8, spawn: { x: 2, y: 3 }, assetSet: 'wa-starter-office' });
}, 60_000);
afterEach(() => project.cleanup());

const call = (args: Record<string, unknown>) => runTool(automapMapTool, { projectDir: project.dir, mapPath, ...args });
const marks = async (): Promise<number[] | undefined> => {
  let data: number[] | undefined;
  forEachTileLayer((await readMap(join(project.dir, mapPath))).map.layers, (l) => {
    if (l.name === 'marks') data = Array.from(readTileData(l));
  });
  return data;
};

describe('automap_map', () => {
  test('without a rules file it is AUTOMAP_RULES_NOT_FOUND', async () => {
    expect(await call({})).toMatchObject({ ok: false, error: { code: 'AUTOMAP_RULES_NOT_FOUND' } });
  });

  test('a dry run reports the change and writes nothing', async () => {
    await writeStartRule(project.dir, mapPath, 'maps');
    const before = await readFile(join(project.dir, mapPath), 'utf8');
    const outcome = await call({ dryRun: true });
    expect(outcome).toMatchObject({
      ok: true,
      data: { rulesPath: 'maps/rules.txt', ruleMaps: ['maps/start-marks.tmj'], rules: 1, matches: 1, changedCells: 1, layersWritten: ['marks'], written: false },
    });
    expect(await readFile(join(project.dir, mapPath), 'utf8')).toBe(before);
  });

  test('writes the map; running it again changes nothing', async () => {
    await writeStartRule(project.dir, mapPath, 'maps');
    expect(await call({})).toMatchObject({ ok: true, data: { written: true, changedCells: 1 } });
    const data = await marks();
    expect(data?.filter((v) => v !== 0)).toHaveLength(1);
    expect(data?.[3 * 10 + 2]).not.toBe(0);
    expect(await call({})).toMatchObject({ ok: true, data: { written: false, changedCells: 0, matches: 1 } });
  });

  test('an engine-built map gets the AUTOMAP_ON_ENGINE_MAP warning; a plain map does not', async () => {
    await writeStartRule(project.dir, mapPath, 'maps');
    const outcome = await call({ dryRun: true });
    expect(outcome.ok && (outcome.data as { warnings: { code: string }[] }).warnings.map((w) => w.code)).toEqual(['AUTOMAP_ON_ENGINE_MAP']);
    const { map } = await readMap(join(project.dir, mapPath));
    map.properties = (map.properties ?? []).filter((p) => !p.name.startsWith('wa-agent-engine:'));
    await writeFile(join(project.dir, mapPath), JSON.stringify(map));
    const plain = await call({ dryRun: true });
    expect(plain.ok && (plain.data as { warnings: unknown[] }).warnings).toEqual([]);
  });

  test('rules.txt in the project is used when the map\'s folder has none; an explicit rules path wins', async () => {
    await writeStartRule(project.dir, mapPath, '.');
    expect(await call({ dryRun: true })).toMatchObject({ ok: true, data: { rulesPath: 'rules.txt' } });
    await writeStartRule(project.dir, mapPath, 'maps');
    expect(await call({ dryRun: true })).toMatchObject({ ok: true, data: { rulesPath: 'maps/rules.txt' } });
    expect(await call({ dryRun: true, rules: 'start-marks.tmj' })).toMatchObject({ ok: true, data: { rulesPath: 'start-marks.tmj', ruleMaps: ['start-marks.tmj'] } });
  });

  test('a region limits the run and must lie inside the map', async () => {
    await writeStartRule(project.dir, mapPath, 'maps');
    expect(await call({ dryRun: true, region: { x: 5, y: 0, width: 5, height: 8 } })).toMatchObject({ ok: true, data: { matches: 0, changedCells: 0 } });
    expect(await call({ dryRun: true, region: { x: 0, y: 0, width: 5, height: 8 } })).toMatchObject({ ok: true, data: { matches: 1 } });
    expect(await call({ region: { x: 8, y: 0, width: 5, height: 8 } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await call({ region: { x: 0.5, y: 0, width: 1, height: 1 } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  test.each([
    ['rules outside the project', { rules: '../rules.txt' }, 'PATH_OUTSIDE_PROJECT'],
    ['rules with the wrong extension', { rules: 'maps/rules.md' }, 'PATH_BAD_EXTENSION'],
    ['a missing rules file', { rules: 'maps/none.txt' }, 'AUTOMAP_RULES_NOT_FOUND'],
    ['a negative seed', { seed: -1 }, 'INVALID_INPUT'],
    ['a missing map', { mapPath: 'maps/none.tmj' }, 'MAP_NOT_FOUND'],
  ])('%s is %s', async (_label, args, code) => {
    await writeStartRule(project.dir, mapPath, 'maps');
    expect(await call(args)).toMatchObject({ ok: false, error: { code } });
  });

  test('a broken rule map is AUTOMAP_RULES_INVALID and the map is not touched', async () => {
    await writeStartRule(project.dir, mapPath, 'maps');
    await writeFile(join(project.dir, 'maps', 'start-marks.tmj'), '{"oops": true}');
    const before = await readFile(join(project.dir, mapPath), 'utf8');
    expect(await call({})).toMatchObject({ ok: false, error: { code: 'AUTOMAP_RULES_INVALID' } });
    expect(await readFile(join(project.dir, mapPath), 'utf8')).toBe(before);
  });

  test('an isometric map is AUTOMAP_UNSUPPORTED', async () => {
    await writeStartRule(project.dir, mapPath, 'maps');
    const { map } = await readMap(join(project.dir, mapPath));
    map.orientation = 'isometric';
    await writeFile(join(project.dir, mapPath), JSON.stringify(map));
    expect(await call({})).toMatchObject({ ok: false, error: { code: 'AUTOMAP_UNSUPPORTED', details: { feature: 'orientation' } } });
  });
});

describe('automap_map details', () => {
  const ruleMapPath = (): string => join(project.dir, 'maps', 'start-marks.tmj');
  const editRuleMap = async (change: (m: Record<string, any>) => void): Promise<void> => {
    const rule = JSON.parse(await readFile(ruleMapPath(), 'utf8')) as Record<string, any>;
    change(rule);
    await writeFile(ruleMapPath(), JSON.stringify(rule));
  };

  test('the seed reaches the engine: two weighted outputs differ across seeds and repeat for one seed', async () => {
    await writeStartRule(project.dir, mapPath, 'maps');
    await editRuleMap((r) => {
      r.layers[1].name = 'output1_marks';
      r.layers.push({ ...r.layers[1], id: 3, name: 'output2_marks', data: [3] });
    });
    const seen = new Set<string>();
    for (let seed = 0; seed < 12; seed++) {
      await call({ seed });
      seen.add(JSON.stringify(await marks()));
      // Undo: remove the marks layer for the next seed.
      const { map } = await readMap(join(project.dir, mapPath));
      map.layers = map.layers.filter((l) => l.name !== 'marks');
      await writeFile(join(project.dir, mapPath), JSON.stringify(map));
    }
    expect(seen.size).toBe(2);
    await call({ seed: 5 });
    const first = JSON.stringify(await marks());
    const { map } = await readMap(join(project.dir, mapPath));
    map.layers = map.layers.filter((l) => l.name !== 'marks');
    await writeFile(join(project.dir, mapPath), JSON.stringify(map));
    await call({ seed: 5 });
    expect(JSON.stringify(await marks())).toBe(first);
  });

  test('a missing map is MAP_NOT_FOUND even without rules', async () => {
    expect(await call({ mapPath: 'maps/none.tmj' })).toMatchObject({ ok: false, error: { code: 'MAP_NOT_FOUND' } });
  });

  test('an unreadable rules file is AUTOMAP_RULES_INVALID without an absolute path', async () => {
    await writeStartRule(project.dir, mapPath, 'maps');
    await chmod(join(project.dir, 'maps', 'rules.txt'), 0o000);
    try {
      const outcome = await call({});
      expect(outcome).toMatchObject({ ok: false, error: { code: 'AUTOMAP_RULES_INVALID' } });
      expect(JSON.stringify(outcome)).not.toContain(project.dir);
    } finally {
      await chmod(join(project.dir, 'maps', 'rules.txt'), 0o644);
    }
  });

  test('a linked rules.txt reads its rule maps next to the link, as Tiled does', async () => {
    await writeStartRule(project.dir, mapPath, 'maps');
    await mkdir(join(project.dir, 'shared'));
    await copyFile(join(project.dir, 'maps', 'rules.txt'), join(project.dir, 'shared', 'rules.txt'));
    await rm(join(project.dir, 'maps', 'rules.txt'));
    await symlink(join(project.dir, 'shared', 'rules.txt'), join(project.dir, 'maps', 'rules.txt'));
    expect(await call({ dryRun: true })).toMatchObject({ ok: true, data: { ruleMaps: ['maps/start-marks.tmj'], changedCells: 1 } });
  });

  test('a change to layer properties only is written and reported', async () => {
    await writeStartRule(project.dir, mapPath, 'maps');
    await editRuleMap((r) => {
      r.layers[1].name = 'output_start';
      r.layers[1].properties = [{ name: 'tint', type: 'string', value: 'warm' }];
    });
    expect(await call({})).toMatchObject({ ok: true, data: { written: true, changedCells: 0, layersWritten: ['start'] } });
  });

  test('a different tileset with the same name as the map\'s is TILESET_CONFLICT', async () => {
    await writeStartRule(project.dir, mapPath, 'maps');
    await copyFile(join(project.dir, 'tilesets', 'WA_Special_Zones.png'), join(project.dir, 'tilesets', 'copy.png'));
    await editRuleMap((r) => (r.tilesets[0].image = '../tilesets/copy.png'));
    // Input: the map's own start tile is no longer the rule's (other image), so match empty.
    await editRuleMap((r) => {
      r.tilesets.push({ ...r.tilesets[0], name: 'automap-rules', firstgid: 13, image: '../tilesets/WA_Exterior.png', tilecount: 850, columns: 25, imagewidth: 800, imageheight: 1088, tiles: [{ id: 0, properties: [{ name: 'MatchType', type: 'string', value: 'Empty' }] }] });
      r.layers[0].data = [13];
    });
    expect(await call({})).toMatchObject({ ok: false, error: { code: 'TILESET_CONFLICT' } });
  });

  test('adding a tileset to a map with an unreadable external tileset is EXTERNAL_TILESET_UNRESOLVED', async () => {
    await writeStartRule(project.dir, mapPath, 'maps');
    const { map } = await readMap(join(project.dir, mapPath));
    const zones = map.tilesets.find((t) => (t as { name?: string }).name === 'WA_Special_Zones')!;
    map.tilesets = map.tilesets.filter((t) => t !== zones);
    map.tilesets.push({ firstgid: 900000, source: 'old.tsx' });
    await writeFile(join(project.dir, mapPath), JSON.stringify(map));
    await editRuleMap((r) => {
      r.tilesets.push({ ...r.tilesets[0], name: 'automap-rules', firstgid: 13, image: '../tilesets/WA_Exterior.png', tilecount: 850, columns: 25, imagewidth: 800, imageheight: 1088, tiles: [{ id: 0, properties: [{ name: 'MatchType', type: 'string', value: 'Empty' }] }] });
      r.layers[0].data = [13];
      r.layers[0].name = 'input_floor';
    });
    expect(await call({})).toMatchObject({ ok: false, error: { code: 'EXTERNAL_TILESET_UNRESOLVED' } });
  });

  test('an unreadable external tileset the rules need not add to is an EXTERNAL_TILESET_UNRESOLVED warning', async () => {
    await writeStartRule(project.dir, mapPath, 'maps');
    const { map } = await readMap(join(project.dir, mapPath));
    map.tilesets.push({ firstgid: 900000, source: 'old.tsx' });
    await writeFile(join(project.dir, mapPath), JSON.stringify(map));
    const outcome = await call({ dryRun: true });
    expect(outcome).toMatchObject({ ok: true, data: { matches: 1, changedCells: 1 } });
    expect(outcome.ok && (outcome.data as { warnings: { code: string; details?: unknown }[] }).warnings).toContainEqual(
      expect.objectContaining({ code: 'EXTERNAL_TILESET_UNRESOLVED', details: { source: 'old.tsx' } }),
    );
  });

  test('a .tmx rule map is PATH_BAD_EXTENSION; a missing project is PROJECT_DIR_INVALID', async () => {
    await mkdir(join(project.dir, 'maps'), { recursive: true });
    await writeFile(join(project.dir, 'maps', 'rules.txt'), 'walls.tmx\n');
    expect(await call({})).toMatchObject({ ok: false, error: { code: 'PATH_BAD_EXTENSION' } });
    expect(await runTool(automapMapTool, { projectDir: join(project.dir, 'nowhere'), mapPath })).toMatchObject({ ok: false, error: { code: 'PROJECT_DIR_INVALID' } });
  });
});
