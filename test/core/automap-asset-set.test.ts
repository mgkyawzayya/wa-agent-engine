import { createHash } from 'node:crypto';
import { cp, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { automapMap } from '../../src/core/automap/automap-map.js';
import { buildRooms, scaffoldMap } from '../../src/core/compiler.js';
import { isWaEngineError } from '../../src/core/errors.js';
import { decodeGid, tilesetForGid } from '../../src/core/gid.js';
import { readTileData, resolveRole, writeTileData, type TileRole } from '../../src/core/layers.js';
import { readMap, writeMap } from '../../src/core/map-io.js';
import { encodePng } from '../../src/core/png.js';
import { composeMap, loadSheets } from '../../src/core/renderer.js';
import { isExternalTileset, type TiledMap } from '../../src/schemas/tiled.schema.js';
import { OFFICE_AUTOMAP_DIR, staleOfficeAutomapFiles } from '../../scripts/gen-office-automap.js';
import { makeFullProject, type TempProject } from '../helpers/project.js';

// The proof that asset sets drawn with automapping rules work: office-automap draws the
// built-in set's walls, faces, lintels, collisions and floors with Tiled rules, and building
// every room fixture with it gives the same picture as building it with wa-starter-office (or
// fails with the same error).

const ROOMS_DIR = fileURLToPath(new URL('../fixtures/rooms/', import.meta.url));
const WANG = 'wa-starter-office';
const AUTOMAP = 'office-automap';

interface Fixture {
  mapWidth: number;
  mapHeight: number;
  rooms: unknown[];
  existingWalls?: string[];
}

// "x,y", "x0-x1,y" or "x,y0-y1".
function cells(specs: readonly string[] = []): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const spec of specs) {
    const [xs, ys] = spec.split(',') as [string, string];
    const [x0, x1 = x0] = xs.split('-').map(Number) as [number, number?];
    const [y0, y1 = y0] = ys.split('-').map(Number) as [number, number?];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ x, y });
  }
  return out;
}

let project: TempProject;
beforeAll(async () => {
  project = await makeFullProject();
  await cp(OFFICE_AUTOMAP_DIR, join(project.dir, '.wa-asset-sets', AUTOMAP), { recursive: true });
});
afterAll(() => project.cleanup());

const gidOf = (map: TiledMap, tileset: string, tile: number): number => {
  const ts = map.tilesets.find((t) => !isExternalTileset(t) && t.name === tileset)!;
  return ts.firstgid + tile;
};

function paint(map: TiledMap, role: TileRole, at: readonly { x: number; y: number }[], raw: number): void {
  const { layer } = resolveRole(map, role);
  const data = readTileData(layer);
  for (const c of at) data[c.y * map.width + c.x] = raw;
  writeTileData(layer, data);
}

const ART_ROLES: readonly TileRole[] = ['walls', 'collisions', 'floor', 'foreground1'];
type Art = Map<TileRole, ({ tileset: string; tile: number } | undefined)[]>;

const scaffold = (mapPath: string, fixture: Fixture, assetSet: string) =>
  scaffoldMap({ projectDir: project.dir, mapPath, width: fixture.mapWidth, height: fixture.mapHeight, assetSet, spawn: { x: 0, y: fixture.mapHeight - 1 } });

// Walls already in the map, finished as a map would have them: sketched, then drawn by the
// rules over the whole map (as automap_map or Tiled would), which draws them exactly like the
// wall terrain. Both builds start from this art.
async function existingArt(name: string, fixture: Fixture): Promise<Art> {
  const mapPath = `${name}-existing.tmj`;
  await scaffold(mapPath, fixture, AUTOMAP);
  const abs = join(project.dir, mapPath);
  const { map, sha256 } = await readMap(abs);
  paint(map, 'sketch', cells(fixture.existingWalls), gidOf(map, 'wa-markers', 0));
  await writeMap(abs, map, { projectDir: project.dir, expectedSha256: sha256 });
  await automapMap({ projectDir: project.dir, mapPath, rules: `.wa-asset-sets/${AUTOMAP}/automap/rules.txt` });
  const drawn = (await readMap(abs)).map;
  return new Map(ART_ROLES.map((role) => [role, Array.from(readTileData(resolveRole(drawn, role).layer), (raw) => {
    const hit = raw === 0 ? undefined : tilesetForGid(drawn.tilesets, decodeGid(raw).gid);
    return hit === undefined || isExternalTileset(hit.tileset) ? undefined : { tileset: hit.tileset.name, tile: hit.localId };
  })]));
}

// Builds the fixture with one set and returns the picture's hash, or the error code.
async function build(name: string, fixture: Fixture, setId: string, art: Art | undefined): Promise<string> {
  const mapPath = `${name}-${setId}.tmj`;
  await scaffold(mapPath, fixture, setId);
  if (art !== undefined) {
    // The same art in both maps; the rules also find the walls on the sketch.
    const abs = join(project.dir, mapPath);
    const { map, sha256 } = await readMap(abs);
    for (const [role, tiles] of art) {
      tiles.forEach((t, i) => {
        if (t !== undefined) paint(map, role, [{ x: i % map.width, y: Math.floor(i / map.width) }], gidOf(map, t.tileset, t.tile));
      });
    }
    if (setId === AUTOMAP) paint(map, 'sketch', cells(fixture.existingWalls), gidOf(map, 'wa-markers', 0));
    await writeMap(abs, map, { projectDir: project.dir, expectedSha256: sha256 });
  }
  try {
    await buildRooms({ projectDir: project.dir, mapPath, dsl: { mapWidth: fixture.mapWidth, mapHeight: fixture.mapHeight, assetSet: setId, rooms: fixture.rooms } });
  } catch (err) {
    if (isWaEngineError(err)) return `error ${err.code}`;
    throw err;
  }
  const { map } = await readMap(join(project.dir, mapPath));
  const picture = composeMap(map, await loadSheets(project.dir, join(project.dir, mapPath), map));
  return createHash('sha256').update(encodePng(picture)).digest('hex');
}

describe('office-automap draws the room fixtures like wa-starter-office', async () => {
  const names = (await readdir(ROOMS_DIR)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)).sort();
  for (const name of names) {
    test(name, async () => {
      const fixture = JSON.parse(await readFile(join(ROOMS_DIR, `${name}.json`), 'utf8')) as Fixture;
      const art = fixture.existingWalls === undefined ? undefined : await existingArt(name, fixture);
      // Existing walls come with their faces.
      if (art !== undefined) expect(art.get('walls')!.filter(Boolean).length).toBeGreaterThan(cells(fixture.existingWalls).length);
      const wang = await build(name, fixture, WANG, art);
      const rules = await build(name, fixture, AUTOMAP, art);
      expect(rules).toBe(wang);
    });
  }
});

test('the proving set is what scripts/gen-office-automap.ts writes', async () => {
  expect(await staleOfficeAutomapFiles()).toEqual([]);
});
