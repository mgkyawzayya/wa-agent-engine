import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildRooms, scaffoldMap } from '../../src/core/compiler.js';
import { resolveRole, readTileData, writeTileData } from '../../src/core/layers.js';
import { serializeMap } from '../../src/core/map-io.js';
import { MAX_REPORTED_ERRORS, validateMap } from '../../src/core/validator.js';
import { setProperty, type TiledMap, type TiledObjectGroup } from '../../src/schemas/tiled.schema.js';
import { makeFullProject, type TempProject } from '../helpers/project.js';

let project: TempProject;
let clean: TiledMap;

beforeEach(async () => {
  project = await makeFullProject(['office.tmj', 'conference.tmj']);
  await scaffoldMap({ projectDir: project.dir, mapPath: 'venue.tmj', width: 20, height: 16, assetSet: 'wa-starter-office', spawn: { x: 1, y: 14 } });
  await buildRooms({
    projectDir: project.dir,
    mapPath: 'venue.tmj',
    dsl: {
      mapWidth: 20,
      mapHeight: 16,
      assetSet: 'wa-starter-office',
      rooms: [
        { id: 'a', bounds: { x: 0, y: 0, width: 9, height: 8 }, doors: [{ wall: 'south', offset: 3 }], waProperties: { silent: true } },
        { id: 'b', bounds: { x: 8, y: 0, width: 9, height: 8 }, doors: [{ wall: 'west', offset: 4 }] },
      ],
    },
  });
  clean = JSON.parse(await readFile(join(project.dir, 'venue.tmj'), 'utf8')) as TiledMap;
});
afterEach(() => project.cleanup());

async function validateVariant(mutate: (map: TiledMap) => void): Promise<{ errors: string[]; warnings: string[] }> {
  const map = structuredClone(clean);
  mutate(map);
  await writeFile(join(project.dir, 'variant.tmj'), serializeMap(map));
  const report = await validateMap({ projectDir: project.dir, mapPath: 'variant.tmj' });
  return { errors: report.errors.map((e) => e.code), warnings: report.warnings.map((w) => w.code) };
}

function setCell(map: TiledMap, role: Parameters<typeof resolveRole>[1] & string, x: number, y: number, raw: number): void {
  const layer = resolveRole(map, role as 'walls').layer;
  const data = readTileData(layer);
  data[y * map.width + x] = raw;
  writeTileData(layer, data);
}

const zones = (map: TiledMap): TiledObjectGroup => resolveRole(map, 'zones').layer;
const gidOf = (map: TiledMap, tileset: string, local: number): number =>
  (map.tilesets.find((t) => t.name === tileset) as { firstgid: number }).firstgid + local;
const area = (name: string, extra: Record<string, unknown> = {}) => ({ height: 64, id: 900, name, properties: [{ name: 'silent', type: 'bool', value: true }], rotation: 0, type: 'area', visible: true, width: 64, x: 32, y: 32, ...extra });

test('the built venue is clean', async () => {
  expect(await validateVariant(() => {})).toEqual({ errors: [], warnings: [] });
});

describe('each rule fires on its fixture', () => {
  test.each<[string, (map: TiledMap) => void, string]>([
    ['NOT_ORTHOGONAL', (m) => { m.orientation = 'isometric'; }, 'NOT_ORTHOGONAL'],
    ['TILE_SIZE_NOT_32', (m) => { m.tilewidth = 16; }, 'TILE_SIZE_NOT_32'],
    ['INFINITE_MAP', (m) => { m.infinite = true; }, 'INFINITE_MAP'],
    ['MISSING_FLOOR_LAYER', (m) => { m.layers = m.layers.filter((l) => l.name !== 'floorLayer'); }, 'MISSING_FLOOR_LAYER'],
    ['MISSING_START_LAYER', (m) => { m.layers = m.layers.filter((l) => l.name !== 'start'); }, 'MISSING_START_LAYER'],
    ['NON_EMBEDDED_TILESET', (m) => { m.tilesets.push({ firstgid: 9000, source: 'tilesets/x.tsj' }); }, 'NON_EMBEDDED_TILESET'],
    ['TILESET_IMAGE_MISSING', (m) => { (m.tilesets[1] as { image: string }).image = 'tilesets/missing.png'; }, 'TILESET_IMAGE_MISSING'],
    ['COLLIDES_NOT_BOOL', (m) => { (m.tilesets[0] as { tiles: { properties: { type: string }[] }[] }).tiles[0]!.properties[0]!.type = 'string'; }, 'COLLIDES_NOT_BOOL'],
    ['INVALID_GID', (m) => setCell(m, 'floor', 10, 12, 99_999), 'INVALID_GID'],
    ['OVERLAY_ABOVE_FLOOR', (m) => { const start = m.layers.shift()!; m.layers.splice(4, 0, start); }, 'OVERLAY_ABOVE_FLOOR'],
    ['WALL_WITHOUT_COLLISION', (m) => setCell(m, 'collisions', 0, 3, 0), 'WALL_WITHOUT_COLLISION'],
    ['DOOR_UNREACHABLE', (m) => setCell(m, 'collisions', 3, 7, gidOf(m, 'WA_Special_Zones', 2)), 'DOOR_UNREACHABLE'],
    ['NEGATIVE_COORDS', (m) => { zones(m).objects.push(area('neg', { x: -32 })); }, 'NEGATIVE_COORDS'],
    ['OUT_OF_BOUNDS_OBJECT', (m) => { zones(m).objects.push(area('far', { x: 620 })); }, 'OUT_OF_BOUNDS_OBJECT'],
    ['AREA_WITHOUT_SIZE', (m) => { zones(m).objects.push(area('flat', { width: 0 })); }, 'AREA_WITHOUT_SIZE'],
    ['DUPLICATE_AREA_NAME', (m) => { zones(m).objects.push(area('a')); }, 'DUPLICATE_AREA_NAME'],
    ['INVALID_ZONE_PROPERTY', (m) => { zones(m).objects.push(area('bad', { properties: [{ name: 'audioVolume', type: 'float', value: 3 }] })); }, 'INVALID_ZONE_PROPERTY'],
    ['BAD_URL', (m) => { zones(m).objects.push(area('evil', { properties: [{ name: 'openWebsite', type: 'string', value: 'javascript:alert(1)' }] })); }, 'BAD_URL'],
    ['BAD_URL (script)', (m) => { setProperty(m, 'script', 'string', 'javascript:alert(1)'); }, 'BAD_URL'],
    ['LAYER_DATA_UNSUPPORTED', (m) => { const floor = resolveRole(m, 'floor').layer; floor.data = 'AAAA'; floor.encoding = 'base64'; }, 'LAYER_DATA_UNSUPPORTED'],
    ['DOOR_UNREACHABLE (furniture before the door)', (m) => setCell(m, 'collisions', 3, 6, gidOf(m, 'WA_Special_Zones', 2)), 'DOOR_UNREACHABLE'],
    ['LAYER_SIZE_MISMATCH', (m) => { const f = resolveRole(m, 'furniture2').layer; f.width = 10; f.height = 10; f.data = new Array<number>(100).fill(0); }, 'LAYER_SIZE_MISMATCH'],
    ['BAD_URL (template on an area that is not dynamic)', (m) => { zones(m).objects.push(area('evil', { properties: [{ name: 'openWebsite', type: 'string', value: 'javascript:alert(1)//{{{x}}}' }] })); }, 'BAD_URL'],
  ])('%s', async (_name, mutate, code) => {
    expect((await validateVariant(mutate)).errors).toContain(code);
  });

  test.each<[string, (map: TiledMap) => void, string]>([
    ['START_LAYER_NESTED', (m) => {
      const start = m.layers.shift()!;
      m.layers.unshift({ id: 950, layers: [start], name: 'spawns', opacity: 1, type: 'group', visible: true, x: 0, y: 0 });
    }, 'START_LAYER_NESTED'],
    ['ISOLATED_WALL', (m) => { setCell(m, 'walls', 14, 13, gidOf(m, 'WA_Room_Builder', 104)); setCell(m, 'collisions', 14, 13, gidOf(m, 'WA_Special_Zones', 2)); }, 'ISOLATED_WALL'],
    ['ORPHAN_ZONE', (m) => { zones(m).objects.push(area('empty', { properties: [] })); }, 'ORPHAN_ZONE'],
    ['SCRIPT_EXTERNAL', (m) => { setProperty(m, 'script', 'string', 'https://example.org/s.js'); }, 'SCRIPT_EXTERNAL'],
    ['MISSING_COPYRIGHT', (m) => { m.properties = (m.properties ?? []).filter((p) => p.name !== 'mapCopyright'); }, 'MISSING_COPYRIGHT'],
    ['START_LAYER_EMPTY', (m) => { const start = resolveRole(m, 'start').layer; start.data = new Array<number>(m.width * m.height).fill(0); }, 'START_LAYER_EMPTY'],
    ['SCRIPT_NOT_FOUND', (m) => { setProperty(m, 'script', 'string', 'scripts/missing.js'); }, 'SCRIPT_NOT_FOUND'],
    ['START_TILE_BLOCKED', (m) => {
      // Move the spawn onto the wall corner at (0,0).
      const start = resolveRole(m, 'start').layer;
      const data = readTileData(start);
      const tile = data.find((v) => v !== 0)!;
      data.fill(0);
      data[0] = tile;
      writeTileData(start, data);
    }, 'START_TILE_BLOCKED'],
    ['SCRIPT_WHITESPACE', (m) => { setProperty(m, 'script', 'string', ' https://example.org/s.js'); }, 'SCRIPT_WHITESPACE'],
  ])('%s (warning)', async (_name, mutate, code) => {
    expect((await validateVariant(mutate)).warnings).toContain(code);
  });
});

describe('exit doors', () => {
  test('an exit door needs an exitUrl area over it', async () => {
    await scaffoldMap({ projectDir: project.dir, mapPath: 'exit.tmj', width: 12, height: 10, assetSet: 'wa-starter-office', spawn: { x: 4, y: 5 } });
    await buildRooms({
      projectDir: project.dir,
      mapPath: 'exit.tmj',
      dsl: { mapWidth: 12, mapHeight: 10, assetSet: 'wa-starter-office', rooms: [{ id: 'hall', bounds: { x: 0, y: 0, width: 10, height: 8 }, doors: [{ wall: 'north', offset: 4, width: 2, exit: true }] }] },
    });
    const before = await validateMap({ projectDir: project.dir, mapPath: 'exit.tmj' });
    expect(before.errors.map((e) => e.code)).toEqual(['EXIT_WITHOUT_EXIT_ZONE']);
    const { configureZone } = await import('../../src/core/zones.js');
    await configureZone({ projectDir: project.dir, mapPath: 'exit.tmj', name: 'to-office', x: 4, y: 0, width: 2, height: 2, properties: { exitUrl: 'office.tmj#from-conference' } });
    expect((await validateMap({ projectDir: project.dir, mapPath: 'exit.tmj' })).errors).toEqual([]);
  });
});

describe("WA's own maps", () => {
  // The starter kit ships the script both maps load.
  beforeEach(async () => {
    await mkdir(join(project.dir, 'src'), { recursive: true });
    await writeFile(join(project.dir, 'src', 'main.ts'), '');
  });

  test('office.tmj has no errors, only missing-copyright warnings, and its lintels need no collision', async () => {
    const report = await validateMap({ projectDir: project.dir, mapPath: 'office.tmj' });
    expect(report.errors).toEqual([]);
    expect([...new Set(report.warnings.map((w) => w.code))]).toEqual(['MISSING_COPYRIGHT']);
  });

  test('conference.tmj has exactly one documented error, the face without collision at (17,1)', async () => {
    const report = await validateMap({ projectDir: project.dir, mapPath: 'conference.tmj' });
    expect(report.errors.map((e) => [e.code, e.x, e.y])).toEqual([['WALL_WITHOUT_COLLISION', 17, 1]]);
  });
});

test('a map broken everywhere gets a bounded report that says how much it left out', async () => {
  const map = structuredClone(clean);
  // Six layers of tile ids no tileset has: 1920 bad cells, 50 listed per layer at most.
  for (let i = 1; i <= 6; i++) {
    map.layers.push({ type: 'tilelayer', id: 900 + i, name: `bad${i}`, x: 0, y: 0, width: 20, height: 16, opacity: 1, visible: true, data: new Array(320).fill(99999) } as TiledMap['layers'][number]);
  }
  await writeFile(join(project.dir, 'variant.tmj'), serializeMap(map));
  const report = await validateMap({ projectDir: project.dir, mapPath: 'variant.tmj' });
  expect(report.ok).toBe(false);
  expect(report.errors).toHaveLength(MAX_REPORTED_ERRORS);
  expect(report.errors.every((e) => e.code === 'INVALID_GID')).toBe(true);
  expect(report.omitted).toEqual({ errors: 6 * 320 - MAX_REPORTED_ERRORS, warnings: 0 });
  expect(JSON.stringify(report).length).toBeLessThan(64 * 1024);
  // A clean report has no omitted field.
  expect((await validateMap({ projectDir: project.dir, mapPath: 'venue.tmj' })).omitted).toBeUndefined();
});

test('an asset set missing wall pieces is reported when a map is validated with it', async () => {
  const { writeDemoSet } = await import('../helpers/demo-set.js');
  await writeDemoSet(project.dir);
  const report = await validateMap({ projectDir: project.dir, mapPath: 'venue.tmj', assetSet: 'demo' });
  expect(report.warnings.map((w) => w.code)).toContain('ASSET_SET_INCOMPLETE');
  // The built-in set covers every piece.
  expect((await validateMap({ projectDir: project.dir, mapPath: 'venue.tmj' })).warnings).toEqual([]);
});
