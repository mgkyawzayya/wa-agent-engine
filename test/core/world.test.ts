import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildRooms, placePrefab, scaffoldMap } from '../../src/core/compiler.js';
import { ENGINE_STATE_PROPERTY, MAX_STATE_PREFABS, readState, writeState } from '../../src/core/engine-state.js';
import { decodeGid, tilesetForGid } from '../../src/core/gid.js';
import { readTileData, resolveRole, type TileRole } from '../../src/core/layers.js';
import { readMap, writeMap } from '../../src/core/map-io.js';
import { TileWriter } from '../../src/core/tile-writer.js';
import { validateMap } from '../../src/core/validator.js';
import { seededRandom, stripCells } from '../../src/core/world.js';
import { getProperty, type TiledMap } from '../../src/schemas/tiled.schema.js';
import { makeFullProject, type TempProject } from '../helpers/project.js';

let project: TempProject;
beforeEach(async () => {
  project = await makeFullProject();
});
afterEach(() => project.cleanup());

const W = 30;
const H = 20;
const load = async (): Promise<TiledMap> => (await readMap(join(project.dir, 'world.tmj'))).map;
const scaffold = (spawn = { x: 4, y: 4 }) => scaffoldMap({ projectDir: project.dir, mapPath: 'world.tmj', width: W, height: H, assetSet: 'wa-starter-office', spawn });
const hall = { id: 'hall', name: 'Hall', bounds: { x: 2, y: 2, width: 10, height: 8 }, doors: [{ wall: 'south', offset: 4, width: 2 }] };
const build = (extra: Record<string, unknown> = {}, rooms: unknown[] = [hall]) =>
  buildRooms({ projectDir: project.dir, mapPath: 'world.tmj', dsl: { mapWidth: W, mapHeight: H, assetSet: 'wa-starter-office', rooms, ...extra } });

function tileAt(map: TiledMap, role: TileRole, x: number, y: number): string {
  const raw = readTileData(resolveRole(map, role).layer)[y * map.width + x] ?? 0;
  if (raw === 0) return '.';
  const hit = tilesetForGid(map.tilesets, decodeGid(raw).gid);
  return `${hit?.tileset.name}:${hit?.localId}`;
}

// Draws one tile by hand, as someone would in Tiled.
async function drawByHand(role: TileRole, x: number, y: number, tileset: string, tile: number): Promise<void> {
  const { map, sha256 } = await readMap(join(project.dir, 'world.tmj'));
  const writer = new TileWriter(map);
  writer.set(role, x, y, writer.gid(tileset, tile));
  writer.flush();
  await writeMap(join(project.dir, 'world.tmj'), map, { projectDir: project.dir, expectedSha256: sha256 });
}

const scatteredAt = async (): Promise<string[]> =>
  readState(await load())!.prefabs.filter((p) => p.instance.startsWith('s')).map((p) => `${p.x},${p.y}`);

describe('the world around the rooms', () => {
  test('ground covers every tile no room covers, and a rebuild without it takes it back', async () => {
    await scaffold();
    await build({ ground: 'wood-dark' });
    const map = await load();
    const ground = tileAt(map, 'floor', 0, 0);
    expect(ground).not.toBe('.');
    expect(tileAt(map, 'floor', W - 1, H - 1)).toBe(ground);
    expect(tileAt(map, 'floor', 20, 15)).toBe(ground);
    // Inside the room its own floor stays.
    expect(tileAt(map, 'floor', 5, 6)).not.toBe(ground);
    expect(await validateMap({ projectDir: project.dir, mapPath: 'world.tmj' })).toMatchObject({ ok: true, errors: [] });
    await build();
    expect(tileAt(await load(), 'floor', 0, 0)).toBe('.');
  });

  test('a path follows its points with its width, corners included, and a plaza fills its rectangle', async () => {
    await scaffold();
    await build({
      ground: 'wood-dark',
      paths: [
        { points: [[7, 12], [7, 16], [20, 16]], width: 2, style: 'carpet-navy' },
        { rect: { x: 22, y: 4, width: 5, height: 4 }, style: 'stripe-light' },
      ],
    });
    const map = await load();
    const path = tileAt(map, 'floor', 7, 12);
    expect(path).not.toBe(tileAt(map, 'floor', 0, 0));
    for (const [x, y] of [[8, 12], [7, 16], [8, 17], [14, 16], [20, 17]]) expect(tileAt(map, 'floor', x!, y!)).toBe(path);
    expect(tileAt(map, 'floor', 6, 12)).not.toBe(path);
    expect(tileAt(map, 'floor', 24, 6)).toBe(tileAt(map, 'floor', 22, 4));
    expect(tileAt(map, 'floor', 24, 6)).not.toBe(tileAt(map, 'floor', 0, 0));
  });

  test('water blocks walking, and a path across it becomes a walkable bridge', async () => {
    await scaffold();
    await build({
      ground: 'grass',
      water: [{ points: [[20, 0], [20, 19]], width: 3 }],
      paths: [{ points: [[10, 15], [28, 15]], width: 2, style: 'cobble' }],
    });
    const map = await load();
    const water = tileAt(map, 'floor', 20, 5);
    expect(water).toBe('WA_Exterior:676');
    expect(tileAt(map, 'collisions', 20, 5)).not.toBe('.');
    // Where the east-west path crosses: the deck, and no collision.
    expect(tileAt(map, 'floor', 20, 15)).toBe('WA_Exterior:651');
    expect(tileAt(map, 'collisions', 20, 15)).toBe('.');
    expect(tileAt(map, 'collisions', 19, 16)).toBe('.');
    expect(tileAt(map, 'floor', 25, 15)).toBe('WA_Exterior:650');
    expect(await validateMap({ projectDir: project.dir, mapPath: 'world.tmj' })).toMatchObject({ ok: true, errors: [] });
  });

  test('crooked points and unknown styles are refused', async () => {
    await scaffold();
    await expect(build({ paths: [{ points: [[1, 1], [5, 4]], style: 'carpet-navy' }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(build({ ground: 'lava' })).rejects.toMatchObject({ code: 'UNKNOWN_STYLE' });
  });

  test('scatter places prefabs on free ground, the same way for the same seed, clear of rooms, paths and doors', async () => {
    await scaffold();
    const world = (seed: number) => ({
      ground: 'wood-dark',
      paths: [{ points: [[0, 14], [29, 14]], width: 2, style: 'carpet-navy' }],
      scatter: [{ area: { x: 0, y: 0, width: W, height: H }, prefabs: ['plant-small-1x1', 'plant-tree-1x2'], count: 25, seed }],
    });
    const first = await build(world(7));
    const positions = async () => readState(await load())!.prefabs.filter((p) => p.instance.startsWith('s')).map((p) => [p.prefabId, p.x, p.y]);
    const a = await positions();
    expect(a).toHaveLength(25);
    expect(first.warnings).toEqual([]);
    await build(world(7));
    expect(await positions()).toEqual(a);
    await build(world(8));
    expect(await positions()).not.toEqual(a);
    for (const [id, x, y] of await positions()) {
      const height = id === 'plant-tree-1x2' ? 2 : 1;
      for (let row = y as number; row < (y as number) + height; row++) {
        const inRoom = (x as number) >= 2 && (x as number) < 12 && row >= 2 && row < 10;
        expect(inRoom).toBe(false);
        expect([14, 15].includes(row)).toBe(false);
      }
    }
    expect(await validateMap({ projectDir: project.dir, mapPath: 'world.tmj' })).toMatchObject({ ok: true, errors: [] });
  });

  test('a scatter area with too little room says how many it placed', async () => {
    await scaffold();
    const result = await build({ ground: 'wood-dark', scatter: [{ area: { x: 14, y: 2, width: 2, height: 2 }, prefabs: ['plant-small-1x1'], count: 10 }] });
    expect(result.warnings.map((w) => w.code)).toContain('SCATTER_INCOMPLETE');
  });
});

test('strips: a band around the line, the extra tile of an even width right or down, inside the map', () => {
  const cells = stripCells({ points: [[0, 0], [3, 0]], width: 2 }, 10, 10);
  expect(cells.map((c) => `${c.x},${c.y}`).sort()).toEqual(['0,0', '0,1', '1,0', '1,1', '2,0', '2,1', '3,0', '3,1']);
  expect(stripCells({ points: [[1, 1], [1, 3]], width: 3 }, 10, 10).every((c) => c.x >= 0 && c.x <= 2)).toBe(true);
});

test('the seeded generator repeats for a seed and differs between seeds', () => {
  const a = seededRandom(1);
  const b = seededRandom(1);
  const c = seededRandom(2);
  const first = [a(), a(), a()];
  expect([b(), b(), b()]).toEqual(first);
  expect([c(), c(), c()]).not.toEqual(first);
});

// The hall's south door is in row 9. The wall faces under the wall fill rows 10 and 11, apart
// from the gap under the door, so the ground in front of the door starts at row 12.
describe('south doors onto the world', () => {
  const hallWithDoor = (width: number) => ({ ...hall, doors: [{ wall: 'south', offset: 4, width }] });

  test.each([1, 2])('water just past the wall faces seals a %i-wide door, and the build says so', async (width) => {
    await scaffold();
    const before = await readFile(join(project.dir, 'world.tmj'));
    await expect(build({ ground: 'grass', water: [{ points: [[0, 13], [29, 13]], width: 3 }] }, [hallWithDoor(width)])).rejects.toMatchObject({
      code: 'DOOR_UNREACHABLE',
      details: { door: { x: 6, y: 9 }, side: { dx: 0, dy: 1 } },
    });
    expect(await readFile(join(project.dir, 'world.tmj'))).toEqual(before);
  });

  test.each([1, 2])('dense scatter just past the wall faces keeps the front of a %i-wide door free', async (width) => {
    await scaffold();
    const result = await build(
      { ground: 'grass', scatter: [{ area: { x: 0, y: 12, width: W, height: 2 }, prefabs: ['rocks-boulder-1x1'], count: 60, seed: 1 }] },
      [hallWithDoor(width)],
    );
    expect(result.warnings.map((w) => w.code)).toEqual(['SCATTER_INCOMPLETE']);
    const map = await load();
    for (let y = 12; y <= 14; y++) for (let x = 5; x <= 6 + width; x++) expect(tileAt(map, 'collisions', x, y)).toBe('.');
    // Outside the corridor the rows are full.
    expect(tileAt(map, 'collisions', 2, 12)).not.toBe('.');
    expect(await validateMap({ projectDir: project.dir, mapPath: 'world.tmj' })).toMatchObject({ ok: true, errors: [] });
  });

  test('a scattered prefab that would cut a door off is skipped', async () => {
    await scaffold();
    // Water fills rows 13-15, so the door's only way out is along row 12: the corridor gives it
    // 3 cells there, and the 4th must stay free on one side or the other.
    const result = await build(
      {
        ground: 'grass',
        water: [{ points: [[0, 14], [29, 14]], width: 3 }],
        scatter: [{ area: { x: 0, y: 12, width: W, height: 1 }, prefabs: ['rocks-boulder-1x1'], count: 30, seed: 1 }],
      },
      [hallWithDoor(1)],
    );
    expect(result.warnings.map((w) => w.code)).toEqual(['SCATTER_INCOMPLETE']);
    const map = await load();
    expect([tileAt(map, 'collisions', 4, 12), tileAt(map, 'collisions', 8, 12)]).toContain('.');
    expect(await validateMap({ projectDir: project.dir, mapPath: 'world.tmj' })).toMatchObject({ ok: true, errors: [] });
  });
});

describe('hand edits and the world', () => {
  test('ground leaves floors drawn by hand before alone', async () => {
    await scaffold();
    await build();
    await drawByHand('floor', 25, 15, 'WA_Room_Builder', 5);
    await build({ ground: 'grass' });
    expect(tileAt(await load(), 'floor', 25, 15)).toBe('WA_Room_Builder:5');
    expect(tileAt(await load(), 'floor', 24, 15)).toBe('WA_Exterior:628');
    await build();
    expect(tileAt(await load(), 'floor', 25, 15)).toBe('WA_Room_Builder:5');
    expect(tileAt(await load(), 'floor', 24, 15)).toBe('.');
  });

  test('ground the build drew belongs to it: the next build replaces a hand edit on it', async () => {
    await scaffold();
    await build({ ground: 'grass' });
    await drawByHand('floor', 25, 15, 'WA_Exterior', 650);
    await build({ ground: 'grass' });
    expect(tileAt(await load(), 'floor', 25, 15)).toBe('WA_Exterior:628');
    await build();
    expect(tileAt(await load(), 'floor', 25, 15)).toBe('.');
  });
});

describe('scatter and what is already in the map', () => {
  test('scatter keeps off prefabs placed with place_prefab', async () => {
    await scaffold();
    await build({ ground: 'grass' });
    const boulder = await placePrefab({ projectDir: project.dir, mapPath: 'world.tmj', prefabId: 'rocks-boulder-1x1', x: 20, y: 10 });
    const result = await build({ ground: 'grass', scatter: [{ area: { x: 19, y: 9, width: 3, height: 3 }, prefabs: ['flowers-yellow-1x1'], count: 9 }] });
    expect(result.toolPrefabs).toEqual([boulder.instance]);
    expect(result.warnings.map((w) => w.code)).toEqual(['SCATTER_INCOMPLETE']);
    expect(await scatteredAt()).toHaveLength(8);
    expect(await scatteredAt()).not.toContain('20,10');
  });

  test('scatter keeps off the spawn and the tiles around it', async () => {
    await scaffold({ x: 20, y: 16 });
    const result = await build({ ground: 'grass', scatter: [{ area: { x: 17, y: 13, width: 7, height: 7 }, prefabs: ['rocks-boulder-1x1'], count: 49 }] });
    expect(result.warnings.map((w) => w.code)).toEqual(['SCATTER_INCOMPLETE']);
    const map = await load();
    for (let y = 15; y <= 17; y++) for (let x = 19; x <= 21; x++) expect(tileAt(map, 'collisions', x, y)).toBe('.');
    expect(await scatteredAt()).toHaveLength(40);
    const report = await validateMap({ projectDir: project.dir, mapPath: 'world.tmj' });
    expect(report.warnings.map((w) => w.code)).not.toContain('START_TILE_BLOCKED');
  });

  test('water over the spawn is a build warning', async () => {
    await scaffold({ x: 20, y: 16 });
    const result = await build({ ground: 'grass', water: [{ rect: { x: 18, y: 14, width: 5, height: 5 } }] });
    expect(result.warnings).toMatchObject([{ code: 'START_TILE_BLOCKED', details: { x: 20, y: 16 } }]);
  });

  test('the build result lists the DSL furniture, not the scattered prefabs', async () => {
    await scaffold();
    const result = await build(
      { ground: 'grass', scatter: [{ area: { x: 14, y: 0, width: 16, height: 20 }, prefabs: ['rocks-small-1x1'], count: 5 }] },
      [{ ...hall, furniture: [{ prefabId: 'lectern-1x1', x: 5, y: 6 }] }],
    );
    expect(result.prefabs).toEqual(['b-hall-1']);
    expect(await scatteredAt()).toHaveLength(5);
  });

  test('a prefab larger than its scatter area is never picked', async () => {
    await scaffold();
    const result = await build({ ground: 'grass', scatter: [{ area: { x: 20, y: 12, width: 1, height: 1 }, prefabs: ['forest-oak-4x4'], count: 1 }] });
    expect(result.warnings).toMatchObject([{ code: 'SCATTER_INCOMPLETE', message: 'scatter 1: placed 0 of 1; none of its prefabs fits in the 1 x 1 area' }]);
    expect(await scatteredAt()).toEqual([]);
  });
});

describe('the build record limit', () => {
  test('a record with more prefabs than the engine reads back is never written', async () => {
    await scaffold();
    const map = await load();
    const state = readState(map)!;
    const property = JSON.stringify(getProperty(map, ENGINE_STATE_PROPERTY));
    state.prefabs = Array.from({ length: MAX_STATE_PREFABS + 1 }, (_, i) => ({ instance: `p${i}`, prefabId: 'rocks-small-1x1', x: 0, y: 0, origin: 'tool' as const, writes: {} }));
    expect(() => writeState(map, state)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(JSON.stringify(getProperty(map, ENGINE_STATE_PROPERTY))).toBe(property);
  });

  test('an edit that would go over the limit fails and leaves the map file unchanged', async () => {
    await scaffold();
    await build({ ground: 'grass' });
    const map = await load();
    const state = readState(map)!;
    state.prefabs = Array.from({ length: MAX_STATE_PREFABS }, (_, i) => ({ instance: `p${i}`, prefabId: 'rocks-small-1x1', x: 0, y: 0, origin: 'tool' as const, writes: {} }));
    state.nextPrefab = MAX_STATE_PREFABS + 1;
    writeState(map, state);
    await writeFile(join(project.dir, 'world.tmj'), JSON.stringify(map));
    const before = await readFile(join(project.dir, 'world.tmj'));
    await expect(placePrefab({ projectDir: project.dir, mapPath: 'world.tmj', prefabId: 'rocks-small-1x1', x: 20, y: 10 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(await readFile(join(project.dir, 'world.tmj'))).toEqual(before);
    expect(readState(await load())!.prefabs).toHaveLength(MAX_STATE_PREFABS);
  });
});

test('the world recipe example builds and validates clean', async () => {
  const recipe = await readFile(fileURLToPath(new URL('../../skills/wa-map-design/references/world-recipe.md', import.meta.url)), 'utf8');
  const dsl = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(recipe)![1]!) as { mapWidth: number; mapHeight: number };
  await scaffoldMap({ projectDir: project.dir, mapPath: 'recipe.tmj', width: dsl.mapWidth, height: dsl.mapHeight, assetSet: 'wa-starter-office', spawn: { x: 10, y: 24 } });
  const result = await buildRooms({ projectDir: project.dir, mapPath: 'recipe.tmj', dsl });
  expect(result.warnings).toEqual([]);
  expect(await validateMap({ projectDir: project.dir, mapPath: 'recipe.tmj' })).toMatchObject({ ok: true, errors: [], warnings: [] });
});
