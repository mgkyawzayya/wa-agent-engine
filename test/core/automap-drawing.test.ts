import { chmod, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { BUILTIN_SETS_DIR, loadAssetSet } from '../../src/core/asset-set-registry.js';
import { buildRooms, placePrefab, scaffoldMap } from '../../src/core/compiler.js';
import { eachWrite, readState } from '../../src/core/engine-state.js';
import { readTileData, resolveRole, TILE_ROLES, tryResolveRole, writeTileData, type TileRole } from '../../src/core/layers.js';
import { readMap, writeMap } from '../../src/core/map-io.js';
import { ensureMarkerImage, MARKER_IMAGE, MARKER_TSJ, markerPng, markerTsj } from '../../src/core/markers.js';
import { decodePng } from '../../src/core/png.js';
import { composeMap, loadSheets } from '../../src/core/renderer.js';
import { validateMap } from '../../src/core/validator.js';
import type { TiledMap } from '../../src/schemas/tiled.schema.js';
import { OFFICE_AUTOMAP_DIR } from '../../scripts/gen-office-automap.js';
import { markerTsjText } from '../../scripts/gen-markers.js';
import { makeFullProject, type TempProject } from '../helpers/project.js';

const SET = 'office-automap';
const ROOM_A = { id: 'a', bounds: { x: 1, y: 1, width: 8, height: 7 }, doors: [{ wall: 'east', offset: 3 }] };
const ROOM_B = { id: 'b', bounds: { x: 8, y: 1, width: 7, height: 7 }, floorStyle: 'carpet-red', wallStyle: 'yellow' };

let project: TempProject;
let setDir: string;
beforeEach(async () => {
  project = await makeFullProject();
  setDir = join(project.dir, '.wa-asset-sets', SET);
  await cp(OFFICE_AUTOMAP_DIR, setDir, { recursive: true });
});
afterEach(() => project.cleanup());

const editJson = async (abs: string, edit: (value: Record<string, unknown>) => void): Promise<void> => {
  const value = JSON.parse(await readFile(abs, 'utf8')) as Record<string, unknown>;
  edit(value);
  await writeFile(abs, JSON.stringify(value));
};
const editSet = (edit: (set: Record<string, any>) => void): Promise<void> => editJson(join(setDir, 'set.json'), edit);
const editRuleMap = (name: string, edit: (map: Record<string, any>) => void): Promise<void> => editJson(join(setDir, 'automap', name), edit);

async function scaffold(mapPath = 'm.tmj', width = 16, height = 11, assetSet = SET): Promise<void> {
  await scaffoldMap({ projectDir: project.dir, mapPath, width, height, assetSet, spawn: { x: 0, y: height - 1 } });
}

const build = (rooms: unknown[], mapPath = 'm.tmj', extra: Record<string, unknown> = {}) =>
  buildRooms({ projectDir: project.dir, mapPath, dsl: { mapWidth: 16, mapHeight: 11, assetSet: SET, rooms, ...extra } });

const load = async (mapPath = 'm.tmj'): Promise<TiledMap> => (await readMap(join(project.dir, mapPath))).map;
const roleData = (map: TiledMap, role: TileRole): number[] => Array.from(readTileData(resolveRole(map, role).layer));

describe('markers', () => {
  test('the shipped tileset is the generated one, and the image is a 4x4 grid of flat colours', async () => {
    expect(await readFile(MARKER_TSJ, 'utf8')).toBe(markerTsjText());
    expect(markerTsj()).toMatchObject({ name: 'wa-markers', tilecount: 16, columns: 4, imagewidth: 128, imageheight: 128 });
    const png = await decodePng(markerPng());
    expect([png.width, png.height]).toEqual([128, 128]);
    expect(Array.from(png.data.slice(0, 4))).toEqual([0xe6, 0x19, 0x4b, 255]);
    expect(Buffer.from(markerPng()).equals(Buffer.from(markerPng()))).toBe(true);
  });

  test('ensureMarkerImage writes the image once and leaves an existing file alone', async () => {
    const abs = join(project.dir, MARKER_IMAGE);
    await ensureMarkerImage(project.dir);
    expect(Buffer.from(await readFile(abs)).equals(Buffer.from(markerPng()))).toBe(true);
    await writeFile(abs, 'mine');
    await ensureMarkerImage(project.dir);
    expect(await readFile(abs, 'utf8')).toBe('mine');
  });

  test('a marker image that cannot be written is IO_ERROR with the project path only', async () => {
    const tilesets = join(project.dir, 'tilesets');
    await chmod(tilesets, 0o555);
    try {
      const err = await ensureMarkerImage(project.dir).then(() => undefined, (e: unknown) => e);
      expect(err).toMatchObject({ code: 'IO_ERROR', message: 'cannot write the marker image tilesets/wa-markers.png (EACCES)' });
    } finally {
      await chmod(tilesets, 0o755);
    }
  });
});

describe('asset sets with drawing', () => {
  test('a set with drawing loads as an automap set with the built-in markers', async () => {
    const set = await loadAssetSet(SET, project.dir);
    expect(set.kind).toBe('automap');
    expect(set.tilesets.get('wa-markers')).toMatchObject({ tsjPath: MARKER_TSJ, image: MARKER_IMAGE });
  });

  test.each([
    ['a floor style without a marker', (s: Record<string, any>) => delete s.drawing.markers.floor['carpet-red'], 'floor style "carpet-red" has no marker'],
    ['a marker for no floor style', (s: Record<string, any>) => (s.drawing.markers.floor.grass = 9), '"grass" is not a floor style'],
    ['a wall style without a marker', (s: Record<string, any>) => delete s.drawing.markers.wallStyle.yellow, 'wall style "yellow" has no marker'],
    ['two sketch markers alike', (s: Record<string, any>) => (s.drawing.markers.door = 0), 'use the same marker 0 on wa_sketch'],
    ['a marker past the end of the marker tileset', (s: Record<string, any>) => (s.drawing.markers.wall = 16), 'wall marker: tile 16 is past the end of wa-markers'],
    ['no drawing and no wall terrain', (s: Record<string, any>) => delete s.drawing, 'a set without "drawing" needs wallTerrain, doorLintelTiles, faceRules'],
    ['half a floor tile', (s: Record<string, any>) => (s.floorStyles.styles['wood-light'] = { tile: 3 }), 'names both its tileset and its tile, or neither'],
    ['an unknown marker tileset', (s: Record<string, any>) => (s.drawing.markerTileset = 'nope'), 'unknown tileset "nope"'],
  ])('%s is ASSET_SET_INVALID', async (_name, edit, message) => {
    await editSet(edit);
    await expect(loadAssetSet(SET, project.dir)).rejects.toMatchObject({ code: 'ASSET_SET_INVALID', message: expect.stringContaining(message) });
  });

  test('missing rules are ASSET_SET_INVALID', async () => {
    await rm(join(setDir, 'automap', 'rules.txt'));
    await expect(loadAssetSet(SET, project.dir)).rejects.toMatchObject({ code: 'ASSET_SET_INVALID', message: expect.stringContaining('automapping rules automap/rules.txt are missing') });
  });

  test('a set extending an automap set draws with its rules', async () => {
    await writeExtendingSet();
    const set = await loadAssetSet('office-automap-screens', project.dir);
    expect(set).toMatchObject({ kind: 'automap', extends: SET });
    expect(set.tilesets.has('WA_Miscellaneous')).toBe(true);
  });
});

// A set that adds the built-in wall screen (a north-wall prefab) to office-automap.
async function writeExtendingSet(): Promise<void> {
  const dir = join(project.dir, '.wa-asset-sets', 'office-automap-screens');
  await mkdir(join(dir, 'tilesets'), { recursive: true });
  await mkdir(join(dir, 'prefabs'), { recursive: true });
  const builtin = join(BUILTIN_SETS_DIR, 'wa-starter-office');
  const starter = JSON.parse(await readFile(join(builtin, 'set.json'), 'utf8')) as { tilesets: { name: string }[]; prefabs: { id: string }[] };
  await cp(join(builtin, 'tilesets', 'WA_Miscellaneous.tsj'), join(dir, 'tilesets', 'WA_Miscellaneous.tsj'));
  await cp(join(builtin, 'prefabs', 'wall-screen-3x2.tmj'), join(dir, 'prefabs', 'wall-screen-3x2.tmj'));
  await writeFile(join(dir, 'set.json'), JSON.stringify({
    id: 'office-automap-screens',
    title: 'Screens',
    extends: SET,
    tilesets: starter.tilesets.filter((t) => t.name === 'WA_Miscellaneous'),
    prefabs: starter.prefabs.filter((p) => p.id === 'wall-screen-3x2'),
  }));
}

describe('building with automapping rules', () => {
  test('a map gets hidden sketch layers and the marker image', async () => {
    await scaffold();
    const map = await load();
    expect(tryResolveRole(map, 'sketch')?.layer).toMatchObject({ name: 'wa_sketch', visible: false });
    expect(tryResolveRole(map, 'sketchStyle')?.layer).toMatchObject({ name: 'wa_style', visible: false });
    const names = map.layers.map((l) => l.name);
    expect(names.indexOf('collisions')).toBeLessThan(names.indexOf('wa_sketch'));
    expect(names.indexOf('wa_style')).toBeLessThan(names.indexOf('floor'));
    expect((await stat(join(project.dir, MARKER_IMAGE))).isFile()).toBe(true);
  });

  test('the build records the rules and every tile the rules drew', async () => {
    await scaffold();
    const result = await build([ROOM_A, ROOM_B]);
    const map = await load();
    const state = readState(map)!;
    expect(state.automap).toEqual({ rulesHash: expect.stringMatching(/^[0-9a-f]{64}$/), seed: 0 });
    const recorded = new Set([...eachWrite(state.writes, map)].map((w) => `${w.role}:${w.x}:${w.y}`));
    for (const role of ['walls', 'floor', 'collisions', 'foreground1', 'sketch', 'sketchStyle'] as const) {
      roleData(map, role).forEach((raw, i) => {
        if (raw !== 0) expect(recorded.has(`${role}:${i % map.width}:${Math.floor(i / map.width)}`), `${role} ${i}`).toBe(true);
      });
    }
    const tiles = (['walls', 'floor', 'collisions', 'foreground1'] as const).reduce((n, role) => n + roleData(map, role).filter((raw) => raw !== 0).length, 0);
    expect(result.placedCells).toBe(tiles);
  });

  test('a rebuild with fewer rooms gives the same map as a fresh build of those rooms', async () => {
    await scaffold('two.tmj');
    await build([ROOM_A, ROOM_B], 'two.tmj');
    await build([{ ...ROOM_A, doors: [] }], 'two.tmj');
    await scaffold('one.tmj');
    await build([{ ...ROOM_A, doors: [] }], 'one.tmj');
    const [two, one] = [await load('two.tmj'), await load('one.tmj')];
    for (const role of TILE_ROLES) expect(roleData(two, role), role).toEqual(roleData(one, role));
  });

  test('building the same rooms again changes nothing', async () => {
    await scaffold();
    await build([ROOM_A, ROOM_B]);
    const before = await readFile(join(project.dir, 'm.tmj'), 'utf8');
    await build([ROOM_A, ROOM_B]);
    expect(await readFile(join(project.dir, 'm.tmj'), 'utf8')).toBe(before);
  });

  test('geometry checks run as with the wall terrain', async () => {
    await scaffold();
    await expect(build([{ id: 'a', bounds: { x: 1, y: 1, width: 6, height: 6 }, wallStyle: 'brick' }])).rejects.toMatchObject({ code: 'UNKNOWN_STYLE' });
    const junction = [
      { id: 'a', bounds: { x: 0, y: 0, width: 9, height: 6 }, doors: [{ wall: 'south', offset: 3 }] },
      { id: 'b', bounds: { x: 3, y: 5, width: 6, height: 6 } },
    ];
    await expect(build(junction)).rejects.toMatchObject({ code: 'DOOR_AT_JUNCTION' });
  });

  test('rules that draw on another layer are ASSET_SET_INVALID', async () => {
    await scaffold();
    await editRuleMap('floors.tmj', (m) => {
      for (const layer of m.layers) if (layer.name === 'output_floor') layer.name = 'output_decor';
    });
    await expect(build([ROOM_A])).rejects.toMatchObject({ code: 'ASSET_SET_INVALID', message: expect.stringContaining('draws on "decor"') });
  });

  test('rules that draw with a tileset the set does not list are ASSET_SET_INVALID', async () => {
    await scaffold();
    await editRuleMap('floors.tmj', (m) => {
      const first = Math.max(...m.tilesets.map((t: { firstgid: number; tilecount: number }) => t.firstgid + t.tilecount));
      m.tilesets.push({ columns: 1, firstgid: first, image: '../../../tilesets/WA_Tables.png', imageheight: 32, imagewidth: 32, margin: 0, name: 'other', spacing: 0, tilecount: 1, tileheight: 32, tilewidth: 32 });
      const output = m.layers.find((l: { name: string }) => l.name === 'output_floor');
      output.data = output.data.map((gid: number) => (gid === 0 ? 0 : first));
    });
    await expect(build([ROOM_A])).rejects.toMatchObject({ code: 'ASSET_SET_INVALID', message: expect.stringContaining('tileset "other"') });
  });

  test('rules that draw with a tileset the map has but the set does not list are ASSET_SET_INVALID', async () => {
    await scaffold('m.tmj', 16, 11, 'wa-starter-office');
    await editRuleMap('floors.tmj', (m) => {
      const first = Math.max(...m.tilesets.map((t: { firstgid: number; tilecount: number }) => t.firstgid + t.tilecount));
      m.tilesets.push({ columns: 1, firstgid: first, image: '../../../tilesets/WA_Tables.png', imageheight: 32, imagewidth: 32, margin: 0, name: 'WA_Tables', spacing: 0, tilecount: 1, tileheight: 32, tilewidth: 32 });
      const output = m.layers.find((l: { name: string }) => l.name === 'output_floor');
      output.data = output.data.map((gid: number) => (gid === 0 ? 0 : first));
    });
    // The map built with the starter set embeds WA_Tables, with the full image.
    const abs = join(project.dir, 'm.tmj');
    const { map, sha256 } = await readMap(abs);
    const tables = map.tilesets.find((t) => 'name' in t && t.name === 'WA_Tables')!;
    await editRuleMap('floors.tmj', (m) => {
      const own = m.tilesets.find((t: { name: string }) => t.name === 'WA_Tables');
      Object.assign(own, { columns: tables.columns, imageheight: tables.imageheight, imagewidth: tables.imagewidth, tilecount: tables.tilecount });
    });
    map.properties = (map.properties ?? []).filter((p) => !p.name.startsWith('wa-agent-engine:'));
    await writeMap(abs, map, { projectDir: project.dir, expectedSha256: sha256 });
    await expect(build([ROOM_A])).rejects.toMatchObject({ code: 'ASSET_SET_INVALID', message: expect.stringMatching(/tileset "WA_Tables", which the set does not list; list it/) });
  });

  test('ground needs a floor style with a tile', async () => {
    await scaffold();
    await expect(build([ROOM_A], 'm.tmj', { ground: 'wood-light' })).rejects.toMatchObject({ code: 'UNKNOWN_STYLE', message: expect.stringContaining('has no tile') });
  });

  test('a wall prefab hangs on the wall faces of the sketch', async () => {
    await writeExtendingSet();
    await scaffold();
    await build([{ id: 'a', bounds: { x: 1, y: 1, width: 8, height: 7 } }]);
    const options = { projectDir: project.dir, mapPath: 'm.tmj', prefabId: 'wall-screen-3x2', assetSet: 'office-automap-screens' };
    await expect(placePrefab({ ...options, x: 3, y: 2 })).resolves.toMatchObject({ instance: 'p1' });
    await expect(placePrefab({ ...options, x: 3, y: 5 })).rejects.toMatchObject({ code: 'PREFAB_PLACEMENT' });
  });
});

describe('checking maps drawn with automapping rules', () => {
  test('a fresh build has no issues', async () => {
    await scaffold();
    await build([ROOM_A, ROOM_B]);
    expect(await validateMap({ projectDir: project.dir, mapPath: 'm.tmj' })).toEqual({ ok: true, errors: [], warnings: [] });
  });

  test('rules changed since the build: ENGINE_STATE_INVALID asks for a rebuild', async () => {
    await scaffold();
    await build([ROOM_A]);
    await writeFile(join(setDir, 'automap', 'rules.txt'), 'walls.tmj\nfaces.tmj\nfloors.tmj\n# changed\n');
    const report = await validateMap({ projectDir: project.dir, mapPath: 'm.tmj' });
    expect(report.warnings).toEqual([expect.objectContaining({ code: 'ENGINE_STATE_INVALID', message: expect.stringContaining('rebuild it') })]);
  });

  test('rules that miss pieces are ASSET_SET_INCOMPLETE', async () => {
    await scaffold();
    await build([ROOM_A]);
    await writeFile(join(setDir, 'automap', 'rules.txt'), 'walls.tmj\nfloors.tmj\n');
    const report = await validateMap({ projectDir: project.dir, mapPath: 'm.tmj' });
    const incomplete = report.warnings.find((w) => w.code === 'ASSET_SET_INCOMPLETE');
    expect(incomplete?.message).toContain('face of wall style white, row 1, middle');
    expect(incomplete?.message).toContain('face outside rooms, row 2, open on both sides');
    expect(incomplete?.message).not.toContain('wall N');
  });

  test('a sketched wall without collision is WALL_WITHOUT_COLLISION', async () => {
    await scaffold();
    await build([ROOM_A]);
    const abs = join(project.dir, 'm.tmj');
    const { map, sha256 } = await readMap(abs);
    const { layer } = resolveRole(map, 'collisions');
    const data = readTileData(layer);
    data[1 * map.width + 3] = 0;
    writeTileData(layer, data);
    await writeMap(abs, map, { projectDir: project.dir, expectedSha256: sha256 });
    const report = await validateMap({ projectDir: project.dir, mapPath: 'm.tmj' });
    expect(report.errors).toEqual([expect.objectContaining({ code: 'WALL_WITHOUT_COLLISION', layer: 'wa_sketch', x: 3, y: 1 })]);
  });

  test('previews never draw the sketch', async () => {
    await scaffold();
    await build([ROOM_A]);
    const abs = join(project.dir, 'm.tmj');
    const map = await load();
    const hidden = composeMap(map, await loadSheets(project.dir, abs, map)).data;
    for (const role of ['sketch', 'sketchStyle'] as const) resolveRole(map, role).layer.visible = true;
    const shown = composeMap(map, await loadSheets(project.dir, abs, map)).data;
    expect(Buffer.from(shown).equals(Buffer.from(hidden))).toBe(true);
  });
});
