import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { loadAssetSet, wangSet, type LoadedWangSet } from '../../src/core/asset-set-registry.js';
import { autotile, collectDoorSpans, doorSideProblems, faceCellsFor, faceStyleOf, wallPieceFor, type AutotileResult } from '../../src/core/autotiler.js';
import { decodeGid, tilesetForGid } from '../../src/core/gid.js';
import { CellSet } from '../../src/core/grid.js';
import { readTileData, resolveRole, type TileRole } from '../../src/core/layers.js';
import { readMap } from '../../src/core/map-io.js';
import { parseDsl } from '../../src/schemas/dsl.schema.js';
import type { TiledMap } from '../../src/schemas/tiled.schema.js';
import { cachedMapPath, makeProject, type TempProject } from '../helpers/project.js';

interface Fixture {
  description: string;
  mapWidth: number;
  mapHeight: number;
  rooms: unknown[];
  existingWalls?: string[];
  expect?: Partial<Record<TileRole, string[]>>;
  expectCells?: Partial<Record<TileRole, Record<string, number>>>;
  expectEmpty?: Partial<Record<TileRole, string[]>>;
  expectHalo?: string[];
  expectError?: string;
}

const ROOMS_DIR = fileURLToPath(new URL('../fixtures/rooms/', import.meta.url));
const WINDOWS = fileURLToPath(new URL('../fixtures/crosscheck/windows.json', import.meta.url));

let project: TempProject;
let set: LoadedWangSet;
beforeAll(async () => {
  project = await makeProject();
  set = wangSet(await loadAssetSet('wa-starter-office', project.dir));
});
afterAll(() => project.cleanup());

// "x,y", "x0-x1,y" or "x,y0-y1".
function cells(specs: readonly string[] = []): CellSet {
  const out = new CellSet();
  for (const spec of specs) {
    const [xs, ys] = spec.split(',') as [string, string];
    const [x0, x1 = x0] = xs.split('-').map(Number) as [number, number?];
    const [y0, y1 = y0] = ys.split('-').map(Number) as [number, number?];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.add(x, y);
  }
  return out;
}

function run(fixture: Pick<Fixture, 'mapWidth' | 'mapHeight' | 'rooms' | 'existingWalls'>): AutotileResult {
  const dsl = parseDsl({ mapWidth: fixture.mapWidth, mapHeight: fixture.mapHeight, assetSet: 'wa-starter-office', rooms: fixture.rooms });
  return autotile({
    mapWidth: dsl.mapWidth,
    mapHeight: dsl.mapHeight,
    rooms: dsl.rooms,
    existingWalls: cells(fixture.existingWalls),
    set,
  });
}

function roleCells(result: AutotileResult, role: TileRole): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of result.placements.filter((q) => q.role === role)) {
    const key = `${p.x},${p.y}`;
    expect(out.has(key), `two ${role} placements at ${key}`).toBe(false);
    out.set(key, p.tile);
  }
  return out;
}

function grid(result: AutotileResult, role: TileRole, width: number, height: number): string[] {
  const byCell = roleCells(result, role);
  return Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => String(byCell.get(`${x},${y}`) ?? '.')).join(' '),
  );
}

const fixtures = (await readdir(ROOMS_DIR)).filter((f) => f.endsWith('.json')).sort();

describe.each(fixtures)('fixture %s', (file) => {
  let fixture: Fixture;
  beforeAll(async () => {
    fixture = JSON.parse(await readFile(`${ROOMS_DIR}${file}`, 'utf8')) as Fixture;
  });

  test('produces the expected tiles', () => {
    const result = run(fixture);
    if (fixture.expectError !== undefined) {
      expect(result.errors.map((e) => e.code)).toContain(fixture.expectError);
      return;
    }
    expect(result.errors.map((e) => e.toJSON())).toEqual([]);
    for (const [role, rows] of Object.entries(fixture.expect ?? {}) as [TileRole, string[]][]) {
      expect(grid(result, role, fixture.mapWidth, fixture.mapHeight), role).toEqual(rows);
    }
    for (const [role, expected] of Object.entries(fixture.expectCells ?? {}) as [TileRole, Record<string, number>][]) {
      const actual = roleCells(result, role);
      for (const [cell, tile] of Object.entries(expected)) expect(actual.get(cell), `${role} at ${cell}`).toBe(tile);
    }
    for (const [role, empty] of Object.entries(fixture.expectEmpty ?? {}) as [TileRole, string[]][]) {
      const actual = roleCells(result, role);
      for (const cell of empty) expect(actual.has(cell), `${role} at ${cell} should be empty`).toBe(false);
    }
    if (fixture.expectHalo !== undefined) {
      expect(result.halo.sorted().map((c) => `${c.x},${c.y}`)).toEqual(fixture.expectHalo);
    }
  });

  test('is deterministic', () => {
    expect(run(fixture)).toEqual(run(fixture));
  });
});

describe('errors and warnings', () => {
  test('an unknown style is reported per room', () => {
    const result = run({ mapWidth: 8, mapHeight: 8, rooms: [{ id: 'a', bounds: { x: 0, y: 0, width: 5, height: 6 }, wallStyle: 'marble', floorStyle: 'lava' }] });
    expect(result.errors.map((e) => e.code)).toEqual(['UNKNOWN_STYLE', 'UNKNOWN_STYLE']);
  });

  test('a room over a wall already in the map is an overlap', () => {
    const result = run({ mapWidth: 10, mapHeight: 10, rooms: [{ id: 'a', bounds: { x: 0, y: 0, width: 8, height: 8 } }], existingWalls: ['4,2-5'] });
    expect(result.errors.map((e) => e.code)).toContain('ROOM_OVERLAP');
  });

  test('a room against an existing parallel wall is a thick wall', () => {
    const result = run({ mapWidth: 12, mapHeight: 10, rooms: [{ id: 'a', bounds: { x: 0, y: 0, width: 6, height: 6 } }], existingWalls: ['6,0-5'] });
    expect(result.errors.map((e) => e.code)).toEqual(['THICK_WALL']);
    expect((result.errors[0]?.details as { cells: unknown[] }).cells).toHaveLength(5);
  });

  test('an existing wall away from the build is left alone', () => {
    const result = run({ mapWidth: 10, mapHeight: 10, rooms: [{ id: 'a', bounds: { x: 0, y: 0, width: 5, height: 6 } }], existingWalls: ['7,2'] });
    expect(result.errors).toEqual([]);
    expect(result.halo.size).toBe(0);
    expect(result.placements.some((p) => p.x === 7)).toBe(false);
  });

  test('an existing single wall cell touching the build is drawn as a pillar with a warning', () => {
    const result = run({ mapWidth: 10, mapHeight: 10, rooms: [{ id: 'a', bounds: { x: 0, y: 0, width: 5, height: 6 } }], existingWalls: ['5,6'] });
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual(['ISOLATED_WALL']);
    expect(result.placements.find((p) => p.role === 'walls' && p.x === 5 && p.y === 6)?.tile).toBe(106);
  });

  test('a room over walls already in the map gets one overlap error with the cells listed', () => {
    const result = run({ mapWidth: 12, mapHeight: 12, rooms: [{ id: 'a', bounds: { x: 0, y: 0, width: 10, height: 10 } }], existingWalls: ['3,2-7', '6,2-7'] });
    const overlaps = result.errors.filter((e) => e.code === 'ROOM_OVERLAP');
    expect(overlaps).toHaveLength(1);
    expect((overlaps[0]!.details as { cells: unknown[] }).cells).toHaveLength(12);
  });
});

// ---- cross-checks against WA's own maps ----

interface LocalTile {
  tileset: string;
  tile: number;
  flipped: boolean;
}

function localTiles(map: TiledMap, path: TileRole): (LocalTile | undefined)[] {
  const layer = resolveRole(map, path).layer;
  return [...readTileData(layer)].map((raw) => {
    if (raw === 0) return undefined;
    const { gid, h, v, d } = decodeGid(raw);
    const hit = tilesetForGid(map.tilesets, gid);
    return hit === undefined ? undefined : { tileset: (hit.tileset as { name: string }).name, tile: hit.localId, flipped: h || v || d };
  });
}

interface Window {
  name: string;
  map: string;
  mapWidth: number;
  mapHeight: number;
  rooms: unknown[];
  window: { x0: number; y0: number; x1: number; y1: number };
  roles: TileRole[];
  exclude: { role: TileRole; x: number; y: number; reason: string }[];
}
const { windows } = JSON.parse(await readFile(WINDOWS, 'utf8')) as { windows: Window[] };

describe('DSL rooms reproduce windows of WA maps tile for tile', () => {
  test.each(windows)('$name', async (w) => {
    const { map } = await readMap(cachedMapPath(w.map));
    const result = run(w);
    expect(result.errors.map((e) => e.toJSON())).toEqual([]);
    const mismatches: string[] = [];
    for (const role of w.roles) {
      // Only tiles of the autotiler's own tilesets count; decorations (trees, logos) on the
      // same WA layers are not drawn by it.
      const own = role === 'collisions' ? set.set.collisionTile.tileset : set.wang.wallTerrain.tileset;
      const theirs = localTiles(map, role).map((t) => (t?.tileset === own ? t : undefined));
      const ours = roleCells(result, role);
      for (let y = w.window.y0; y <= w.window.y1; y++) {
        for (let x = w.window.x0; x <= w.window.x1; x++) {
          if (w.exclude.some((e) => e.role === role && e.x === x && e.y === y)) continue;
          const t = theirs[y * map.width + x];
          const o = ours.get(`${x},${y}`);
          const want = t === undefined ? '.' : `${t.tile}${t.flipped ? '*' : ''}`;
          const got = o === undefined ? '.' : String(o);
          if (want !== got) mismatches.push(`${role} (${x},${y}): WA ${want}, engine ${got}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe('the wall and face rules hold on every cell of WA maps', () => {
  test.each(['office.tmj', 'conference.tmj'])('%s', async (name) => {
    const { map } = await readMap(cachedMapPath(name));
    const walls = localTiles(map, 'walls');
    const above = localTiles(map, 'foreground1');
    const collisions = localTiles(map, 'collisions');
    const wallMask = new CellSet();
    const doorMask = new CellSet();
    const observedFaces = new CellSet();
    walls.forEach((t, i) => {
      const x = i % map.width;
      const y = Math.floor(i / map.width);
      if (t?.tileset === 'WA_Room_Builder' && !t.flipped && set.walls.wallTops.has(t.tile)) wallMask.add(x, y);
      else if (t !== undefined) observedFaces.add(x, y);
    });
    above.forEach((t, i) => {
      if (t?.tileset === 'WA_Room_Builder' && set.walls.lintels.has(t.tile)) doorMask.add(i % map.width, Math.floor(i / map.width));
    });

    const wrongPieces = [...wallMask]
      .filter((c) => wallPieceFor(set.walls, wallMask, doorMask, c.x, c.y) !== walls[c.y * map.width + c.x]?.tile)
      .map((c) => `(${c.x},${c.y})`);
    expect(wrongPieces).toEqual([]);

    const predicted = new CellSet(faceCellsFor(wallMask, wallMask, doorMask, map.width, map.height));
    const key = (s: CellSet) => s.sorted().map((c) => `${c.x},${c.y}`);
    expect(key(predicted)).toEqual(key(observedFaces));

    // Wall tops and faces collide; the one documented exception is conference (17,1).
    const free = [...wallMask, ...observedFaces]
      .filter((c) => collisions[c.y * map.width + c.x] === undefined)
      .map((c) => `${c.x},${c.y}`);
    expect(free).toEqual(name === 'conference.tmj' ? ['17,1'] : []);
    expect(wallMask.size).toBe(name === 'office.tmj' ? 101 : 69);
    expect(observedFaces.size).toBe(name === 'office.tmj' ? 118 : 38);
  });
});

describe('building against what is already in the map', () => {
  const at = (result: AutotileResult, role: TileRole, x: number, y: number): number | undefined =>
    result.placements.find((p) => p.role === role && p.x === x && p.y === y)?.tile;

  test('a door cut through an existing wall is walkable and clears the old wall tile', () => {
    const result = run({
      mapWidth: 12,
      mapHeight: 12,
      rooms: [{ id: 'a', bounds: { x: 2, y: 3, width: 7, height: 6 }, doors: [{ wall: 'north', offset: 3 }] }],
      existingWalls: ['0-11,3'],
    });
    expect(result.errors.map((e) => e.toJSON())).toEqual([]);
    expect(at(result, 'foreground1', 5, 3)).toBe(64);
    expect([at(result, 'walls', 4, 3), at(result, 'walls', 6, 3)]).toEqual([63, 65]);
    expect(result.clears).toEqual(
      expect.arrayContaining([
        { role: 'walls', x: 5, y: 3 },
        { role: 'collisions', x: 5, y: 3 },
      ]),
    );
  });

  test('faces drawn into a hand-drawn room keep its style, and old faces under a new door are cleared', () => {
    const result = autotile({
      mapWidth: 12,
      mapHeight: 12,
      rooms: parseDsl({
        mapWidth: 12,
        mapHeight: 12,
        assetSet: 'wa-starter-office',
        rooms: [{ id: 'a', bounds: { x: 2, y: 0, width: 7, height: 6 }, doors: [{ wall: 'south', offset: 3 }] }],
      }).rooms,
      existingWalls: cells(['0-11,5']),
      existingFaceStyle: (_x, y) => (y === 6 || y === 7 ? 'yellow' : undefined),
      occupied: cells(['0-11,5-7']),
      set,
    });
    expect(result.errors.map((e) => e.toJSON())).toEqual([]);
    expect([at(result, 'walls', 3, 6), at(result, 'walls', 4, 6), at(result, 'walls', 6, 6)]).toEqual([200, 200, 200]);
    expect([at(result, 'walls', 3, 7), at(result, 'walls', 4, 7), at(result, 'walls', 6, 7)]).toEqual([225, 226, 225]);
    expect(result.clears).toEqual(
      expect.arrayContaining([
        { role: 'walls', x: 5, y: 6 },
        { role: 'collisions', x: 5, y: 6 },
        { role: 'walls', x: 5, y: 7 },
        { role: 'collisions', x: 5, y: 7 },
      ]),
    );
    expect(result.footprint.has(5, 7)).toBe(true);
  });

  test('a door through a hand-drawn wall clears its old faces inside the new room, and the faces beside it open', () => {
    const result = autotile({
      mapWidth: 12,
      mapHeight: 12,
      rooms: parseDsl({ mapWidth: 12, mapHeight: 12, assetSet: 'wa-starter-office', rooms: [{ id: 'a', bounds: { x: 2, y: 3, width: 7, height: 6 }, doors: [{ wall: 'north', offset: 3 }] }] }).rooms,
      existingWalls: cells(['0-11,3']),
      occupied: cells(['0-11,3-5']),
      set,
    });
    expect(result.errors.map((e) => e.toJSON())).toEqual([]);
    expect(result.clears).toEqual(
      expect.arrayContaining([
        { role: 'walls', x: 5, y: 4 },
        { role: 'collisions', x: 5, y: 4 },
        { role: 'walls', x: 5, y: 5 },
        { role: 'collisions', x: 5, y: 5 },
      ]),
    );
    expect([at(result, 'walls', 4, 4), at(result, 'walls', 6, 4), at(result, 'walls', 4, 5), at(result, 'walls', 6, 5)]).toEqual([206, 205, 231, 230]);
  });

  test("an existing door on a room's new wall is closed and its lintel cleared", () => {
    const result = autotile({
      mapWidth: 12,
      mapHeight: 10,
      rooms: parseDsl({ mapWidth: 12, mapHeight: 10, assetSet: 'wa-starter-office', rooms: [{ id: 'a', bounds: { x: 0, y: 0, width: 9, height: 6 } }] }).rooms,
      existingWalls: cells(['0-3,5', '5-11,5']),
      existingDoors: cells(['4,5']),
      set,
    });
    expect(result.errors).toEqual([]);
    expect(at(result, 'walls', 4, 5)).toBe(104);
    expect(result.clears).toContainEqual({ role: 'foreground1', x: 4, y: 5 });
  });

  test('an existing door next to the build keeps its end piece', () => {
    const result = autotile({
      mapWidth: 12,
      mapHeight: 12,
      rooms: parseDsl({ mapWidth: 12, mapHeight: 12, assetSet: 'wa-starter-office', rooms: [{ id: 'a', bounds: { x: 0, y: 4, width: 5, height: 6 } }] }).rooms,
      existingWalls: cells(['0-5,4', '7-10,4']),
      existingDoors: cells(['6,4']),
      set,
    });
    expect(result.errors).toEqual([]);
    expect(result.halo.has(5, 4)).toBe(true);
    expect(at(result, 'walls', 5, 4)).toBe(63);
  });

  test('a door next to a junction formed by an existing wall is rejected', () => {
    const result = run({
      mapWidth: 12,
      mapHeight: 12,
      rooms: [{ id: 'a', bounds: { x: 0, y: 0, width: 9, height: 6 }, doors: [{ wall: 'south', offset: 3 }] }],
      existingWalls: ['4,6-8'],
    });
    expect(result.errors.map((e) => e.code)).toContain('DOOR_AT_JUNCTION');
  });

  test('a shrunk room re-tiles the existing wall it used to touch', () => {
    const shrunk = { mapWidth: 12, mapHeight: 10, rooms: [{ id: 'a', bounds: { x: 0, y: 0, width: 4, height: 6 } }], existingWalls: ['5-7,3'] };
    const without = run(shrunk);
    expect(at(without, 'walls', 5, 3)).toBeUndefined();
    const dsl = parseDsl({ mapWidth: 12, mapHeight: 10, assetSet: 'wa-starter-office', rooms: shrunk.rooms });
    const withPrevious = autotile({
      mapWidth: 12,
      mapHeight: 10,
      rooms: dsl.rooms,
      existingWalls: cells(shrunk.existingWalls),
      previousFootprint: cells(['0-5,0-5']),
      set,
    });
    expect(at(withPrevious, 'walls', 5, 3)).toBe(58);
  });

  test('faces under an existing pillar go only on free cells, with open ends 280/305', () => {
    const result = autotile({
      mapWidth: 10,
      mapHeight: 10,
      rooms: parseDsl({ mapWidth: 10, mapHeight: 10, assetSet: 'wa-starter-office', rooms: [{ id: 'a', bounds: { x: 0, y: 0, width: 5, height: 6 } }] }).rooms,
      existingWalls: cells(['5,6']),
      existingFaceStyle: () => 'white',
      occupied: new CellSet(),
      set,
    });
    expect(result.warnings.map((w) => w.code)).toEqual(['ISOLATED_WALL']);
    expect(at(result, 'walls', 5, 7)).toBe(206);
    expect(at(result, 'walls', 5, 8)).toBe(305);
    const blocked = autotile({
      mapWidth: 10,
      mapHeight: 10,
      rooms: parseDsl({ mapWidth: 10, mapHeight: 10, assetSet: 'wa-starter-office', rooms: [{ id: 'a', bounds: { x: 0, y: 0, width: 5, height: 6 } }] }).rooms,
      existingWalls: cells(['5,6']),
      occupied: cells(['5,7-8']),
      set,
    });
    expect(at(blocked, 'walls', 5, 7)).toBeUndefined();
  });

  test('faceStyleOf maps face tiles back to their style', () => {
    expect([faceStyleOf(set.set, 203), faceStyleOf(set.set, 226), faceStyleOf(set.set, 310), faceStyleOf(set.set, 104)]).toEqual([
      'white',
      'yellow',
      'brick',
      undefined,
    ]);
  });
});

describe('doors must lead somewhere', () => {
  test('a door off the map edge is rejected unless it is marked as an exit', () => {
    const room = (exit: boolean) => ({ id: 'a', bounds: { x: 0, y: 4, width: 7, height: 6 }, doors: [{ wall: 'south', offset: 3, ...(exit ? { exit } : {}) }] });
    expect(run({ mapWidth: 8, mapHeight: 10, rooms: [room(false)] }).errors.map((e) => e.code)).toEqual(['DOOR_UNREACHABLE']);
    expect(run({ mapWidth: 8, mapHeight: 10, rooms: [room(true)] }).errors).toEqual([]);
  });

  test('a door opening onto another room’s wall faces is rejected', () => {
    const result = run({
      mapWidth: 8,
      mapHeight: 14,
      rooms: [
        { id: 'a', bounds: { x: 0, y: 0, width: 7, height: 6 } },
        { id: 'b', bounds: { x: 0, y: 7, width: 7, height: 6 }, doors: [{ wall: 'north', offset: 3 }] },
      ],
    });
    expect(result.errors.map((e) => e.code)).toEqual(['DOOR_UNREACHABLE']);
  });

  test('a door into a pocket of fewer than 4 walkable cells is rejected', () => {
    const result = run({
      mapWidth: 12,
      mapHeight: 12,
      rooms: [{ id: 'a', bounds: { x: 0, y: 0, width: 9, height: 6 }, doors: [{ wall: 'south', offset: 4 }] }],
      existingWalls: ['2,6-7', '6,6-7', '2-6,8'],
    });
    expect(result.errors.map((e) => e.code)).toEqual(['DOOR_UNREACHABLE']);
  });

  test('into a room that furniture splits up, a door needs only as many cells as its largest open area', () => {
    const { rooms } = parseDsl({ mapWidth: 8, mapHeight: 12, assetSet: 'wa-starter-office', rooms: [{ id: 'r', bounds: { x: 0, y: 0, width: 8, height: 9 }, doors: [{ wall: 'south', offset: 3 }] }] });
    const spans = collectDoorSpans(rooms);
    const door = new CellSet(spans.flatMap((sp) => sp.cells));
    // Inside the room only a 2-cell lane at the door and two single-cell gaps are open.
    const open = new CellSet([{ x: 3, y: 7 }, { x: 3, y: 6 }, { x: 1, y: 3 }, { x: 6, y: 3 }]);
    const blocked = (x: number, y: number): boolean => !door.has(x, y) && y < 9 && !open.has(x, y);
    expect(doorSideProblems(spans, rooms, blocked, 8, 12)).toEqual([]);
    // Once the room has a 3-cell area elsewhere, the 2-cell lane is a pocket again.
    open.add(1, 4).add(1, 5);
    expect(doorSideProblems(spans, rooms, blocked, 8, 12).map((e) => e.code)).toEqual(['DOOR_UNREACHABLE']);
  });

  test('a door off the map edge suggests marking it as an exit', () => {
    const result = run({ mapWidth: 8, mapHeight: 10, rooms: [{ id: 'a', bounds: { x: 0, y: 4, width: 7, height: 6 }, doors: [{ wall: 'south', offset: 3 }] }] });
    expect(result.errors[0]?.message).toContain('exit: true');
  });

  test('a door opening onto the faces of a wall already in the map is rejected', () => {
    const result = autotile({
      mapWidth: 12,
      mapHeight: 14,
      rooms: parseDsl({ mapWidth: 12, mapHeight: 14, assetSet: 'wa-starter-office', rooms: [{ id: 'a', bounds: { x: 0, y: 5, width: 9, height: 7 }, doors: [{ wall: 'north', offset: 4 }] }] }).rooms,
      existingWalls: cells(['0-11,2']),
      occupied: cells(['0-11,2-4']),
      set,
    });
    expect(result.errors.map((e) => e.code)).toEqual(['DOOR_UNREACHABLE']);
  });
});

test('a set without the wall pieces a layout needs reports them', async () => {
  const { writeDemoSet } = await import('../helpers/demo-set.js');
  await writeDemoSet(project.dir);
  const demo = await loadAssetSet('demo', project.dir);
  const result = autotile({
    mapWidth: 8,
    mapHeight: 8,
    rooms: parseDsl({ mapWidth: 8, mapHeight: 8, assetSet: 'demo', rooms: [{ id: 'a', bounds: { x: 0, y: 0, width: 5, height: 6 }, wallStyle: 'plain', floorStyle: 'f' }] }).rooms,
    existingWalls: new CellSet(),
    set: demo,
  });
  expect(result.errors.map((e) => e.code)).toContain('WALL_PIECE_MISSING');
});
