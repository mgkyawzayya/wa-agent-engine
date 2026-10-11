import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { automapMap } from '../../src/core/automap/automap-map.js';
import { buildRooms, scaffoldMap } from '../../src/core/compiler.js';
import { isWaEngineError } from '../../src/core/errors.js';
import { decodeGid, tilesetForGid } from '../../src/core/gid.js';
import { readTileData, resolveRole, writeTileData, type TileRole } from '../../src/core/layers.js';
import { readMap, writeMap } from '../../src/core/map-io.js';
import { isExternalTileset, type TiledMap } from '../../src/schemas/tiled.schema.js';

// The room fixtures (test/fixtures/rooms/*.json) built with one asset set or another, for the
// tests that prove a set drawn with automapping rules draws them like another set.

const ROOMS_DIR = fileURLToPath(new URL('../fixtures/rooms/', import.meta.url));

export interface RoomFixture {
  mapWidth: number;
  mapHeight: number;
  rooms: unknown[];
  existingWalls?: string[];
}

export async function roomFixtureNames(): Promise<string[]> {
  return (await readdir(ROOMS_DIR)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)).sort();
}

export async function readRoomFixture(name: string): Promise<RoomFixture> {
  return JSON.parse(await readFile(join(ROOMS_DIR, `${name}.json`), 'utf8')) as RoomFixture;
}

// "x,y", "x0-x1,y" or "x,y0-y1".
export function cells(specs: readonly string[] = []): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const spec of specs) {
    const [xs, ys] = spec.split(',') as [string, string];
    const [x0, x1 = x0] = xs.split('-').map(Number) as [number, number?];
    const [y0, y1 = y0] = ys.split('-').map(Number) as [number, number?];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ x, y });
  }
  return out;
}

export const gidOf = (map: TiledMap, tileset: string, tile: number): number => {
  const ts = map.tilesets.find((t) => !isExternalTileset(t) && t.name === tileset)!;
  return ts.firstgid + tile;
};

export function paint(map: TiledMap, role: TileRole, at: readonly { x: number; y: number }[], raw: number): void {
  const { layer } = resolveRole(map, role);
  const data = readTileData(layer);
  for (const c of at) data[c.y * map.width + c.x] = raw;
  writeTileData(layer, data);
}

const ART_ROLES: readonly TileRole[] = ['walls', 'collisions', 'floor', 'foreground1'];
export type Art = Map<TileRole, ({ tileset: string; tile: number } | undefined)[]>;

const scaffold = (projectDir: string, mapPath: string, fixture: RoomFixture, assetSet: string) =>
  scaffoldMap({ projectDir, mapPath, width: fixture.mapWidth, height: fixture.mapHeight, assetSet, spawn: { x: 0, y: fixture.mapHeight - 1 } });

// Walls already in the map, finished as a map would have them: sketched, then drawn over the
// whole map by the rules of `automapSet` (as automap_map or Tiled would). Builds of the
// fixture start from this art.
export async function existingArt(projectDir: string, name: string, fixture: RoomFixture, automapSet: string): Promise<Art> {
  const mapPath = `${name}-existing.tmj`;
  await scaffold(projectDir, mapPath, fixture, automapSet);
  const abs = join(projectDir, mapPath);
  const { map, sha256 } = await readMap(abs);
  paint(map, 'sketch', cells(fixture.existingWalls), gidOf(map, 'wa-markers', 0));
  await writeMap(abs, map, { projectDir, expectedSha256: sha256 });
  await automapMap({ projectDir, mapPath, rules: `.wa-asset-sets/${automapSet}/automap/rules.txt` });
  const drawn = (await readMap(abs)).map;
  return new Map(ART_ROLES.map((role) => [role, Array.from(readTileData(resolveRole(drawn, role).layer), (raw) => {
    const hit = raw === 0 ? undefined : tilesetForGid(drawn.tilesets, decodeGid(raw).gid);
    return hit === undefined || isExternalTileset(hit.tileset) ? undefined : { tileset: hit.tileset.name, tile: hit.localId };
  })]));
}

// Builds the fixture with one set, starting from `art` (and, for a set drawn with rules, the
// existing walls on its sketch), and returns the built map, or the error code.
export async function buildFixture(
  projectDir: string,
  name: string,
  fixture: RoomFixture,
  setId: string,
  art: Art | undefined,
  options: { sketchExisting: boolean },
): Promise<{ map: TiledMap; mapAbs: string } | string> {
  const mapPath = `${name}-${setId}.tmj`;
  const mapAbs = join(projectDir, mapPath);
  await scaffold(projectDir, mapPath, fixture, setId);
  if (art !== undefined) {
    const { map, sha256 } = await readMap(mapAbs);
    for (const [role, tiles] of art) {
      tiles.forEach((t, i) => {
        if (t !== undefined) paint(map, role, [{ x: i % map.width, y: Math.floor(i / map.width) }], gidOf(map, t.tileset, t.tile));
      });
    }
    if (options.sketchExisting) paint(map, 'sketch', cells(fixture.existingWalls), gidOf(map, 'wa-markers', 0));
    await writeMap(mapAbs, map, { projectDir, expectedSha256: sha256 });
  }
  try {
    await buildRooms({ projectDir, mapPath, dsl: { mapWidth: fixture.mapWidth, mapHeight: fixture.mapHeight, assetSet: setId, rooms: fixture.rooms } });
  } catch (err) {
    if (isWaEngineError(err)) return `error ${err.code}`;
    throw err;
  }
  return { map: (await readMap(mapAbs)).map, mapAbs };
}
