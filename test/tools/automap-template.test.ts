import { cp, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { automapMap } from '../../src/core/automap/automap-map.js';
import { scaffoldMap } from '../../src/core/compiler.js';
import { BUILTIN_SETS_DIR, loadAssetSet, wangSet, type LoadedAutomapSet, type WallNeighbour } from '../../src/core/asset-set-registry.js';
import { automapTemplate, type AutomapTemplateResult } from '../../src/core/automap/automap-template.js';
import { drawingCoverage, loadDrawingRules } from '../../src/core/automap/drawing.js';
import { loadRules } from '../../src/core/automap/rules-file.js';
import { isWaEngineError } from '../../src/core/errors.js';
import { readTileData, resolveRole } from '../../src/core/layers.js';
import { readMap, writeMap } from '../../src/core/map-io.js';
import { MARKER_IMAGE, RULE_TILES_IMAGE } from '../../src/core/markers.js';
import type { AssetSet, FaceRow } from '../../src/schemas/asset-set.schema.js';
import { isExternalTileset, type TiledMap, type TiledObjectGroup, type TiledTileLayer } from '../../src/schemas/tiled.schema.js';
import { OFFICE_AUTOMAP_DIR } from '../../scripts/gen-office-automap.js';
import { makeFullProject, type TempProject } from '../helpers/project.js';
import { buildFixture, existingArt, gidOf, paint, readRoomFixture, roomFixtureNames } from '../helpers/room-fixtures.js';

// automap_template writes a rule map whose inputs hold the build's markers and whose outputs the
// user paints. Painted with the starter kit's tiles, it must draw every room fixture exactly as
// the proving set office-automap does.

const PROVING = 'office-automap';
const TEMPLATE = 'office-template';
const OUT = `.wa-asset-sets/${TEMPLATE}/automap`;
const TILESETS = [`.wa-asset-sets/${PROVING}/tilesets/WA_Room_Builder.tsj`, `.wa-asset-sets/${PROVING}/tilesets/WA_Special_Zones.tsj`];

let project: TempProject;
let written: AutomapTemplateResult;
beforeAll(async () => {
  project = await makeFullProject();
  await cp(OFFICE_AUTOMAP_DIR, join(project.dir, '.wa-asset-sets', PROVING), { recursive: true });
  written = await automapTemplate({ projectDir: project.dir, assetSet: PROVING, outDir: OUT, tilesets: TILESETS });
  // A set drawn with the template: the proving set's set.json and tilesets.
  const setDir = join(project.dir, '.wa-asset-sets', TEMPLATE);
  const setJson = JSON.parse(await readFile(join(OFFICE_AUTOMAP_DIR, 'set.json'), 'utf8')) as { id: string };
  setJson.id = TEMPLATE;
  await cp(join(OFFICE_AUTOMAP_DIR, 'tilesets'), join(setDir, 'tilesets'), { recursive: true });
  await writeFile(join(setDir, 'set.json'), JSON.stringify(setJson));
});

const coverage = async (): Promise<string[]> => {
  const set = (await loadAssetSet(TEMPLATE, project.dir)) as LoadedAutomapSet;
  return drawingCoverage(set, await loadDrawingRules(set, project.dir), project.dir, join(project.dir, 'coverage.tmj'));
};
afterAll(() => project.cleanup());

const code = (err: unknown): string => (isWaEngineError(err) ? err.code : String(err));

const tileLayers = (map: TiledMap): TiledTileLayer[] => map.layers.filter((l): l is TiledTileLayer => l.type === 'tilelayer');

// The starter set's tile for each piece the template names, per layer to paint.
async function starterArt(): Promise<(name: string) => Record<string, { tileset: string; tile: number }>> {
  const starter = wangSet(await loadAssetSet('wa-starter-office', project.dir));
  const { wallTerrain, faceRules } = starter.wang;
  const collision = starter.set.collisionTile;
  const wallTile = (n: WallNeighbour, e: WallNeighbour, s: WallNeighbour, w: WallNeighbour) => ({ tileset: wallTerrain.tileset, tile: starter.walls.tileFor(n, e, s, w)! });
  const lintel = { horizontal: wallTile(0, 2, 0, 2), vertical: wallTile(2, 0, 2, 0) };
  const doorWalls: Record<string, [WallNeighbour, WallNeighbour, WallNeighbour, WallNeighbour]> = {
    'wall west of a door': [0, 2, 0, 1],
    'wall east of a door': [0, 1, 0, 2],
    'wall above a door': [1, 0, 2, 0],
    'wall below a door': [2, 0, 1, 0],
    'wall between two doors, horizontal': [0, 2, 0, 2],
    'wall between two doors, vertical': [2, 0, 2, 0],
  };
  const variants: Record<string, keyof FaceRow> = { middle: 'mid', 'open west': 'openW', 'open east': 'openE', 'open on both sides': 'openWE' };
  return (name) => {
    const solid = (tile: { tileset: string; tile: number }) => ({ output_walls: tile, output_collisions: collision });
    const wall = /^wall N(\d) E(\d) S(\d) W(\d)$/.exec(name);
    if (wall !== null) return solid(wallTile(...(wall.slice(1).map(Number) as [WallNeighbour, WallNeighbour, WallNeighbour, WallNeighbour])));
    if (doorWalls[name] !== undefined) return solid(wallTile(...doorWalls[name]));
    const lintelRule = /^(horizontal|vertical) lintel$/.exec(name);
    if (lintelRule !== null) return { output_foreground1: lintel[lintelRule[1] as 'horizontal' | 'vertical'] };
    const oldLintel = /^clear an old (horizontal|vertical) lintel/.exec(name);
    if (oldLintel !== null) return { input1_foreground1: lintel[oldLintel[1] as 'horizontal' | 'vertical'] };
    const face = /^face (?:outside rooms|of wall style (\S+)), row ([12]), (.+)$/.exec(name);
    if (face !== null) {
      const style = faceRules.styles[face[1] ?? faceRules.exteriorStyle]!;
      return solid({ tileset: faceRules.tileset, tile: (face[2] === '1' ? style.row1 : style.row2)[variants[face[3]!]!] });
    }
    const floor = /^floor (\S+)/.exec(name);
    if (floor !== null) {
      const ref = starter.set.floorStyles.styles[floor[1]!]!;
      return { output_floor: { tileset: ref.tileset!, tile: ref.tile! } };
    }
    return {};
  };
}

describe('the written template', () => {
  test('has one rule per piece, in the order the rules run, each named on rule_options', async () => {
    const { map } = await readMap(join(project.dir, written.ruleMap));
    const names = written.rules.map((r) => r.name);
    // 4 clean-ups, 22 wall tops, 2 lintels, 8 faces outside rooms and per wall style, 4 floors on floors and on doors from 4 sides.
    expect(names.length).toBe(4 + 22 + 2 + 8 * 3 + 4 * 5);
    expect(new Set(names).size).toBe(names.length);
    const options = map.layers.find((l): l is TiledObjectGroup => l.name === 'rule_options')!;
    expect(options.objects.map((o) => o.name)).toEqual(names);
    // No property: Tiled and the engine would warn about every unknown rule option.
    expect(options.objects.every((o) => o.properties === undefined)).toBe(true);
    // Tiled runs the rules by their top, then their left.
    const order = [...written.rules].sort((a, b) => a.y - b.y || a.x - b.x);
    expect(order.map((r) => r.name)).toEqual(names);
    expect(map.tilesets.map((t) => (isExternalTileset(t) ? t.source : t.name))).toEqual(['wa-markers', 'wa-automap-rules', 'WA_Room_Builder', 'WA_Special_Zones']);
    expect(written.rulesFile).toBe(`${OUT}/rules.txt`);
    expect(await readFile(join(project.dir, written.rulesFile), 'utf8')).toMatch(/^walls\.tmj$/m);
    // The set.json snippet in the README names the rules relative to set.json.
    expect(await readFile(join(project.dir, written.readme), 'utf8')).toContain('"rules": "automap/rules.txt"');
    expect(written.markers).toEqual(JSON.parse(await readFile(join(OFFICE_AUTOMAP_DIR, 'set.json'), 'utf8')).drawing.markers);
    for (const image of [MARKER_IMAGE, RULE_TILES_IMAGE]) expect((await stat(join(project.dir, image))).isFile()).toBe(true);
  });

  test('loads with loadRules before it is painted: only the complete rules apply', async () => {
    const rules = await loadRules(project.dir, join(project.dir, written.rulesFile));
    expect(rules.warnings).toEqual([]);
    expect(rules.references.length).toBe(1);
    const { ruleMap } = rules.references[0]!;
    expect(ruleMap.warnings).toEqual([]);
    // The clean-ups and the lintels' clearing of the door cell.
    expect(ruleMap.rules.length).toBe(written.rules.filter((r) => r.name.startsWith('clear') || r.name.endsWith('lintel')).length);
  });

  test('before it is painted, every piece the coverage check names is a rule of the template', async () => {
    const missing = await coverage();
    expect(missing.length).toBe(16 + 2 * 3 + 8 * 3 + 4 + 4 * 4);
    const names = new Set(written.rules.map((r) => r.name));
    expect(missing.filter((m) => !names.has(m))).toEqual([]);
  });

  test('before it is painted, it changes nothing on a map: foreground on walls stays', async () => {
    const mapPath = 'unpainted.tmj';
    const abs = join(project.dir, mapPath);
    await scaffoldMap({ projectDir: project.dir, mapPath, width: 12, height: 8, assetSet: TEMPLATE, spawn: { x: 0, y: 7 } });
    const { map, sha256 } = await readMap(abs);
    for (let x = 1; x <= 9; x++) paint(map, 'sketch', [{ x, y: 2 }], gidOf(map, 'wa-markers', x === 6 ? 1 : 0));
    // A prop's foreground row over a wall cell.
    paint(map, 'foreground1', [{ x: 2, y: 2 }], gidOf(map, 'WA_Room_Builder', 10));
    await writeMap(abs, map, { projectDir: project.dir, expectedSha256: sha256 });
    const report = await automapMap({ projectDir: project.dir, mapPath, rules: written.rulesFile });
    expect(report.changedCells).toBe(0);
  });

  test('refuses to replace its files without overwrite', async () => {
    const again = { projectDir: project.dir, assetSet: PROVING, outDir: OUT, tilesets: TILESETS };
    const err = await automapTemplate(again).catch((e: unknown) => e);
    expect(code(err)).toBe('MAP_EXISTS');
    expect((err as { details: { files: string[] } }).details.files).toEqual([`${OUT}/walls.tmj`, `${OUT}/rules.txt`, `${OUT}/README.md`]);
    const before = await readFile(join(project.dir, written.ruleMap), 'utf8');
    expect((await automapTemplate({ ...again, overwrite: true })).rules).toEqual(written.rules);
    expect(await readFile(join(project.dir, written.ruleMap), 'utf8')).toBe(before);
  });

  test('never replaces a file it did not write, or a link, even with overwrite', async () => {
    await writeFile(join(project.dir, 'README.md'), '# My project\n');
    const intoRoot = await automapTemplate({ projectDir: project.dir, outDir: '.', tilesets: TILESETS, overwrite: true }).catch((e: unknown) => e);
    expect(code(intoRoot)).toBe('MAP_EXISTS');
    expect((intoRoot as { details: { files: string[] } }).details.files).toEqual(['README.md']);
    expect(await readFile(join(project.dir, 'README.md'), 'utf8')).toBe('# My project\n');
    await mkdir(join(project.dir, 'linked'));
    await symlink(join(project.dir, written.ruleMap), join(project.dir, 'linked', 'walls.tmj'));
    const viaLink = await automapTemplate({ projectDir: project.dir, outDir: 'linked', tilesets: TILESETS, overwrite: true }).catch((e: unknown) => e);
    expect(code(viaLink)).toBe('MAP_EXISTS');
    expect((viaLink as { details: { files: string[] } }).details.files).toEqual(['linked/walls.tmj']);
  });
});

describe('painted with the starter tiles, it draws like the proving set', async () => {
  beforeAll(async () => {
    // Paint every rule's anchor cell, as a user would in Tiled.
    const abs = join(project.dir, written.ruleMap);
    const { map } = await readMap(abs);
    const art = await starterArt();
    let painted = 0;
    for (const rule of written.rules) {
      const tiles = art(rule.name);
      expect(Object.keys(tiles).sort(), rule.name).toEqual([...rule.paint].sort());
      for (const layerName of rule.paint) {
        const layer = tileLayers(map).find((l) => l.name === layerName)!;
        const data = readTileData(layer);
        data[rule.y * map.width + rule.x] = gidOf(map, tiles[layerName]!.tileset, tiles[layerName]!.tile);
        layer.data = Array.from(data);
        painted++;
      }
    }
    expect(painted).toBeGreaterThan(100);
    await writeFile(abs, JSON.stringify(map));
  });

  // No room fixture re-sketches a drawn wall, so the clean-ups get their own run: a wall with
  // a door, drawn; then the door moves along the wall and the rules run again.
  test('the clean-ups clear old faces under a new door and the lintel of a closed door', async () => {
    const run = async (setId: string) => {
      const mapPath = `clean-up-${setId}.tmj`;
      const abs = join(project.dir, mapPath);
      await scaffoldMap({ projectDir: project.dir, mapPath, width: 12, height: 8, assetSet: setId, spawn: { x: 0, y: 7 } });
      const sketch = async (doorX: number): Promise<void> => {
        const { map, sha256 } = await readMap(abs);
        const at = (x: number) => [{ x, y: 2 }];
        for (let x = 1; x <= 9; x++) paint(map, 'sketch', at(x), gidOf(map, 'wa-markers', x === doorX ? 1 : 0));
        await writeMap(abs, map, { projectDir: project.dir, expectedSha256: sha256 });
        await automapMap({ projectDir: project.dir, mapPath, rules: `.wa-asset-sets/${setId}/automap/rules.txt` });
      };
      await sketch(3);
      await sketch(6);
      const { map } = await readMap(abs);
      const cell = (role: 'walls' | 'collisions' | 'foreground1', x: number, y: number) => readTileData(resolveRole(map, role).layer)[y * map.width + x];
      // The new door's faces are gone, the closed door's lintel too; the new door has one.
      expect([cell('walls', 6, 3), cell('walls', 6, 4), cell('collisions', 6, 3), cell('foreground1', 3, 2)]).toEqual([0, 0, 0, 0]);
      expect(cell('foreground1', 6, 2)).not.toBe(0);
      return tileLayers(map).map((l) => [l.name, Array.from(readTileData(l))]);
    };
    expect(await run(TEMPLATE)).toEqual(await run(PROVING));
  });

  test('the coverage check finds a tile for every piece', async () => {
    expect(await coverage()).toEqual([]);
  });

  for (const name of await roomFixtureNames()) {
    test(name, async () => {
      const fixture = await readRoomFixture(name);
      const art = fixture.existingWalls === undefined ? undefined : await existingArt(project.dir, name, fixture, PROVING);
      const layersOf = async (setId: string) => {
        const built = await buildFixture(project.dir, name, fixture, setId, art, { sketchExisting: true });
        return typeof built === 'string' ? built : tileLayers(built.map).map((l) => [l.name, Array.from(readTileData(l))]);
      };
      expect(await layersOf(TEMPLATE)).toEqual(await layersOf(PROVING));
    });
  }
});

describe('without a set, and with bad input', () => {
  test('one plain wall style and floor style', async () => {
    const result = await automapTemplate({ projectDir: project.dir, outDir: 'rules/plain', tilesets: TILESETS });
    expect(result.wallStyles).toEqual({ default: 'plain', names: ['plain'] });
    expect(result.floorStyles).toEqual({ default: 'plain', styles: { plain: {} } });
    expect(result.markers).toEqual({ wall: 0, door: 1, floor: { plain: 2 }, wallStyle: { plain: 3 } });
    expect(result.rules.length).toBe(4 + 22 + 2 + 8 * 2 + 1 * 5);
    // Outside a set's folder, the README cannot know the rules path relative to set.json.
    expect(await readFile(join(project.dir, result.readme), 'utf8')).toContain('"rules": "<rules.txt relative to set.json>"');
  });

  test('a set whose markers are one of its own tilesets keeps them, and that tileset is attached once', async () => {
    const setDir = join(project.dir, '.wa-asset-sets', 'own-markers');
    await cp(OFFICE_AUTOMAP_DIR, setDir, { recursive: true });
    const setJson = JSON.parse(await readFile(join(setDir, 'set.json'), 'utf8')) as { id: string; drawing: Record<string, unknown> };
    const markers = { wall: 0, door: 1, floor: { 'wood-light': 3, 'carpet-red': 4, 'carpet-navy': 5, 'slate-blue': 6 }, wallStyle: { white: 0, yellow: 1 } };
    setJson.id = 'own-markers';
    setJson.drawing = { ...setJson.drawing, markerTileset: 'WA_Special_Zones', markers };
    await writeFile(join(setDir, 'set.json'), JSON.stringify(setJson));
    const result = await automapTemplate({ projectDir: project.dir, assetSet: 'own-markers', outDir: '.wa-asset-sets/own-markers/template', tilesets: TILESETS });
    expect(result.markerTileset).toBe('WA_Special_Zones');
    expect(result.markers).toEqual(markers);
    const { map } = await readMap(join(project.dir, result.ruleMap));
    expect(map.tilesets.map((t) => (isExternalTileset(t) ? t.source : t.name))).toEqual(['WA_Special_Zones', 'wa-automap-rules', 'WA_Room_Builder']);
    expect(await readFile(join(project.dir, result.readme), 'utf8')).toContain('"rules": "template/rules.txt"');
  });

  test('from a set drawn with a wall terrain: the README block makes a set that loads', async () => {
    const setDir = join(project.dir, '.wa-asset-sets', 'office-small');
    await cp(join(BUILTIN_SETS_DIR, 'wa-starter-office'), setDir, { recursive: true });
    const base = JSON.parse(await readFile(join(setDir, 'set.json'), 'utf8')) as AssetSet;
    // Three floors: two of WA_Room_Builder, one of another tileset.
    const floors = ['wood-light', 'carpet-red', 'grass'];
    base.id = 'office-small';
    base.floorStyles = { default: 'wood-light', styles: Object.fromEntries(floors.map((f) => [f, base.floorStyles.styles[f]!])) };
    await writeFile(join(setDir, 'set.json'), JSON.stringify(base));
    const result = await automapTemplate({ projectDir: project.dir, assetSet: 'office-small', outDir: '.wa-asset-sets/office-small/automap', tilesets: TILESETS });
    expect(result.markers).toEqual({ wall: 0, door: 1, floor: { 'wood-light': 2, 'carpet-red': 3, grass: 4 }, wallStyle: { white: 5, yellow: 6 } });
    expect(result.floorStyles.styles.grass).toEqual({});
    expect(result.floorStyles.styles['wood-light']).toEqual(base.floorStyles.styles['wood-light']);
    // set.json as the README says: its block, the tilesets painted with, and the special tiles.
    const readme = await readFile(join(project.dir, result.readme), 'utf8');
    const block = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(readme)![1]!) as object;
    const tilesets = base.tilesets.filter((t) => t.name === 'WA_Room_Builder' || t.name === 'WA_Special_Zones');
    const { id, title, mapCopyright, collisionTile, startTile } = base;
    await writeFile(join(setDir, 'set.json'), JSON.stringify({ id, title, mapCopyright, tilesets, ...block, collisionTile, startTile, prefabs: [] }));
    const loaded = await loadAssetSet('office-small', project.dir);
    expect(loaded.kind).toBe('automap');
  });

  test('a template larger than a rule map may be', async () => {
    const setDir = join(project.dir, '.wa-asset-sets', 'many-floors');
    await cp(OFFICE_AUTOMAP_DIR, setDir, { recursive: true });
    const setJson = JSON.parse(await readFile(join(setDir, 'set.json'), 'utf8')) as AssetSet;
    const floors = Array.from({ length: 250 }, (_, i) => `floor-${i}`);
    setJson.id = 'many-floors';
    setJson.floorStyles = { default: floors[0]!, styles: Object.fromEntries(floors.map((f) => [f, {}])) };
    setJson.drawing = { ...setJson.drawing!, markerTileset: 'WA_Room_Builder', markers: { wall: 0, door: 1, floor: Object.fromEntries(floors.map((f, i) => [f, 2 + i])), wallStyle: { white: 0, yellow: 1 } } };
    await writeFile(join(setDir, 'set.json'), JSON.stringify(setJson));
    const err = await automapTemplate({ projectDir: project.dir, assetSet: 'many-floors', outDir: 'rules/many', tilesets: TILESETS }).catch((e: unknown) => e);
    expect(code(err)).toBe('INVALID_INPUT');
    expect(String((err as Error).message)).toMatch(/rule maps may have/);
  });

  test('an outDir that is a file', async () => {
    const err = await automapTemplate({ projectDir: project.dir, outDir: TILESETS[0]!, tilesets: TILESETS }).catch((e: unknown) => e);
    expect(code(err)).toBe('INVALID_INPUT');
  });

  test('a set with more floor styles than markers', async () => {
    const err = await automapTemplate({ projectDir: project.dir, assetSet: 'wa-starter-office', outDir: 'rules/starter', tilesets: TILESETS }).catch((e: unknown) => e);
    expect(code(err)).toBe('INVALID_INPUT');
  });

  test('tilesets that are not usable', async () => {
    const run = (tilesets: string[]) => automapTemplate({ projectDir: project.dir, outDir: 'rules/bad', tilesets }).catch((e: unknown) => code(e));
    expect(await run(['tilesets/WA_Room_Builder.png'])).toBe('PATH_BAD_EXTENSION');
    expect(await run(['tilesets/none.tsj'])).toBe('INVALID_INPUT');
    expect(await run(['../outside.tsj'])).toBe('PATH_OUTSIDE_PROJECT');
    const tsj = JSON.parse(await readFile(join(project.dir, TILESETS[0]!), 'utf8')) as Record<string, unknown>;
    await writeFile(join(project.dir, 'tilesets/gone.tsj'), JSON.stringify({ ...tsj, image: 'gone.png' }));
    expect(await run(['tilesets/gone.tsj'])).toBe('TILESET_IMAGE_MISSING');
    await writeFile(join(project.dir, 'tilesets/big.tsj'), JSON.stringify({ ...tsj, image: 'WA_Room_Builder.png', tilewidth: 16, tileheight: 16 }));
    expect(await run(['tilesets/big.tsj'])).toBe('INVALID_INPUT');
    await writeFile(join(project.dir, 'tilesets/empty.tsj'), JSON.stringify({ ...tsj, image: 'WA_Room_Builder.png', tilecount: 0 }));
    expect(await run(['tilesets/empty.tsj'])).toBe('INVALID_INPUT');
    // The image of a listed tileset with another grid.
    await writeFile(join(project.dir, 'tilesets/regrid.tsj'), JSON.stringify({ ...tsj, name: 'Regrid', image: 'WA_Room_Builder.png', columns: 5, tilecount: 50 }));
    expect(await run([TILESETS[0]!, 'tilesets/regrid.tsj'])).toBe('INVALID_INPUT');
    await writeFile(join(project.dir, 'tilesets/twin.tsj'), JSON.stringify({ ...tsj, image: 'WA_Special_Zones.png' }));
    expect(await run([TILESETS[0]!, 'tilesets/twin.tsj'])).toBe('INVALID_INPUT');
    // The same tileset twice is attached once.
    const twice = await automapTemplate({ projectDir: project.dir, outDir: 'rules/twice', tilesets: [TILESETS[0]!, TILESETS[0]!] });
    expect((await readMap(join(project.dir, twice.ruleMap))).map.tilesets.length).toBe(3);
  });
});
