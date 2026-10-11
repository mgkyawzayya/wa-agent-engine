import { access, readFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod';
import { AssetSetIdSchema, AssetSetSchema, type AssetSet } from '../schemas/asset-set.schema.js';
import { TiledTilesetFileSchema, type TiledTilesetFile } from '../schemas/tiled.schema.js';
import { WaEngineError } from './errors.js';
import { assertProjectDir, resolveInProject } from './project-paths.js';

// Asset sets ship definitions only (tilesets, terrain, prefabs); their images come from the
// user's own starter-kit project. A set in <project>/.wa-asset-sets/<id>/ wins over a
// built-in set with the same id.

export const BUILTIN_SETS_DIR = fileURLToPath(new URL('../../assets/sets/', import.meta.url));
export const PROJECT_SETS_DIR = '.wa-asset-sets';

// Wall neighbour values in N, E, S, W order: 0 none, 1 wall, 2 door.
export type WallNeighbour = 0 | 1 | 2;

export interface WallLookup {
  // Wall-top tile for a neighbour pattern, or undefined when the set has no such piece.
  // A door cell's own lintel is tileFor(0, 2, 0, 2) (horizontal) or tileFor(2, 0, 2, 0)
  // (vertical); looking up a door cell by its actual wall neighbours gives a wall piece.
  tileFor(n: WallNeighbour, e: WallNeighbour, s: WallNeighbour, w: WallNeighbour): number | undefined;
  isolated: number;
  // Every wall-top tile of the terrain, variants included (lintels excluded), for
  // recognising walls already in a map.
  wallTops: ReadonlySet<number>;
  lintels: ReadonlySet<number>;
}

export interface LoadedTileset {
  name: string;
  tsj: TiledTilesetFile;
  // Absolute path of the .tsj file.
  tsjPath: string;
  // Image path relative to the user's project root.
  image: string;
  tilesetCopyright: string;
}

export interface LoadedAssetSet {
  id: string;
  source: 'project' | 'builtin';
  set: AssetSet;
  tilesets: ReadonlyMap<string, LoadedTileset>;
  walls: WallLookup;
  // Resolves a path relative to set.json (a prefab or .tsj), through the project guard
  // for project-local sets.
  resolveFile(rel: string, ext: string | readonly string[]): Promise<string>;
}

const errnoOf = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;

async function exists(abs: string): Promise<boolean> {
  try {
    await access(abs);
    return true;
  } catch {
    return false;
  }
}

function invalid(id: string, message: string, details?: unknown): WaEngineError {
  return new WaEngineError('ASSET_SET_INVALID', `asset set "${id}": ${message}`, details);
}

async function readJson(abs: string, id: string, what: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(abs, 'utf8'));
  } catch (err) {
    throw invalid(id, `${what} is missing or not valid JSON (${errnoOf(err) ?? 'parse error'})`);
  }
}

const neighbourKey = (n: number, e: number, s: number, w: number): string => `${n},${e},${s},${w}`;

function buildWallLookup(id: string, set: AssetSet, tilesets: ReadonlyMap<string, LoadedTileset>): WallLookup {
  const terrain = set.wallTerrain;
  const wangset = tilesets.get(terrain.tileset)?.tsj.wangsets?.find((w) => w.name === terrain.wangset);
  if (wangset === undefined) throw invalid(id, `tileset ${terrain.tileset} has no wangset "${terrain.wangset}"`);
  if (wangset.type !== 'edge') throw invalid(id, `wangset "${terrain.wangset}" must be an edge set`);
  const valueOf = (color: number): WallNeighbour | undefined =>
    color === 0 ? 0 : color === terrain.wallColor ? 1 : color === terrain.doorColor ? 2 : undefined;
  const byKey = new Map<string, number>();
  const lintels = new Set(set.doorLintelTiles);
  const wallTops = new Set<number>([terrain.isolatedWallTile]);
  for (const { tileid, wangid } of wangset.wangtiles) {
    const sides = [wangid[0], wangid[2], wangid[4], wangid[6]].map((c) => valueOf(c ?? 0));
    if (sides.some((v) => v === undefined)) continue;
    if (!lintels.has(tileid)) wallTops.add(tileid);
    const key = neighbourKey(sides[0]!, sides[1]!, sides[2]!, sides[3]!);
    // Tiled picks randomly among equal wangids; the engine keeps the first for determinism.
    if (!byKey.has(key)) byKey.set(key, tileid);
  }
  return {
    tileFor: (n, e, s, w) => (n | e | s | w) === 0 ? terrain.isolatedWallTile : byKey.get(neighbourKey(n, e, s, w)),
    isolated: terrain.isolatedWallTile,
    wallTops,
    lintels,
  };
}

// Every tile id the set refers to must exist in its tileset, the wall terrain colours must be
// distinct entries of the wangset, and the collision tile must really collide.
function checkReferences(id: string, set: AssetSet, tilesets: ReadonlyMap<string, LoadedTileset>): void {
  const problems: string[] = [];
  const check = (tileset: string, tile: number, what: string): void => {
    const count = tilesets.get(tileset)?.tsj.tilecount ?? 0;
    if (tile >= count) problems.push(`${what}: tile ${tile} is past the end of ${tileset} (${count} tiles)`);
  };
  const terrain = set.wallTerrain;
  for (const [name, ref] of Object.entries(set.floorStyles.styles)) check(ref.tileset, ref.tile, `floor style ${name}`);
  for (const [name, style] of Object.entries(set.faceRules.styles)) {
    for (const row of [style.row1, style.row2]) {
      for (const tile of Object.values(row)) check(set.faceRules.tileset, tile, `face style ${name}`);
    }
  }
  for (const tile of set.doorLintelTiles) check(terrain.tileset, tile, 'door lintel');
  check(terrain.tileset, terrain.isolatedWallTile, 'isolated wall tile');
  check(set.collisionTile.tileset, set.collisionTile.tile, 'collision tile');
  check(set.startTile.tileset, set.startTile.tile, 'start tile');
  const wangset = tilesets.get(terrain.tileset)?.tsj.wangsets?.find((w) => w.name === terrain.wangset);
  for (const { tileid } of wangset?.wangtiles ?? []) check(terrain.tileset, tileid, 'wall terrain');
  const colors = wangset?.colors?.length ?? 0;
  if (terrain.wallColor === terrain.doorColor || terrain.wallColor > colors || terrain.doorColor > colors) {
    problems.push(`wallColor and doorColor must be two different colours of wangset "${terrain.wangset}" (it has ${colors})`);
  }
  const collides = tilesets
    .get(set.collisionTile.tileset)
    ?.tsj.tiles?.find((t) => t.id === set.collisionTile.tile)
    ?.properties?.find((p) => p.name === 'collides');
  if (collides?.type !== 'bool' || collides.value !== true) {
    problems.push('the collision tile must carry the bool tile property collides = true');
  }
  if (problems.length > 0) throw invalid(id, problems.join('; '), { problems });
}

// Callers pass the project folder as given; it is validated here like everywhere else.
export async function loadAssetSet(id: string, projectDirInput: string): Promise<LoadedAssetSet> {
  const projectDir = await assertProjectDir(projectDirInput);
  if (!AssetSetIdSchema.safeParse(id).success) {
    throw new WaEngineError('ASSET_SET_NOT_FOUND', `"${id}" is not a valid asset set id`);
  }
  const projectRel = posix.join(PROJECT_SETS_DIR, id);
  const projectSetJson = await resolveInProject(projectDir, posix.join(projectRel, 'set.json'), { ext: '.json' });
  const projectSetDir = await resolveInProject(projectDir, projectRel);
  if (!(await exists(projectSetJson)) && (await exists(projectSetDir))) {
    throw invalid(id, `${projectRel}/ exists but has no set.json; add one or remove the folder to use the built-in set`);
  }
  const source: LoadedAssetSet['source'] = (await exists(projectSetJson)) ? 'project' : 'builtin';
  const builtinDir = join(BUILTIN_SETS_DIR, id);
  if (source === 'builtin' && !(await exists(join(builtinDir, 'set.json')))) {
    throw new WaEngineError('ASSET_SET_NOT_FOUND', `no asset set "${id}" in ${PROJECT_SETS_DIR}/ or the built-in sets`, {
      id,
    });
  }
  const resolveFile = (rel: string, ext: string | readonly string[]): Promise<string> =>
    source === 'project'
      ? resolveInProject(projectDir, posix.join(projectRel, rel), { ext })
      : Promise.resolve(join(builtinDir, rel));

  const parsed = AssetSetSchema.safeParse(await readJson(await resolveFile('set.json', '.json'), id, 'set.json'));
  if (!parsed.success) {
    throw invalid(id, `set.json is invalid:\n${z.prettifyError(parsed.error)}`, {
      issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path, message: i.message })),
    });
  }
  const set = parsed.data;
  if (set.id !== id) throw invalid(id, `set.json declares id "${set.id}"`);

  const tilesets = new Map<string, LoadedTileset>();
  for (const entry of set.tilesets) {
    const tsjPath = await resolveFile(entry.tsj, ['.tsj', '.json']);
    const raw = await readJson(tsjPath, id, entry.tsj);
    const tsj = TiledTilesetFileSchema.safeParse(raw);
    if (!tsj.success) throw invalid(id, `${entry.tsj} is not a Tiled tileset:\n${z.prettifyError(tsj.error)}`);
    if (tsj.data.name !== entry.name) throw invalid(id, `${entry.tsj} is named "${tsj.data.name}", expected "${entry.name}"`);
    if (tsj.data.tilewidth !== 32 || tsj.data.tileheight !== 32) throw invalid(id, `${entry.tsj} must use 32x32 tiles`);
    tilesets.set(entry.name, {
      name: entry.name,
      tsj: tsj.data,
      tsjPath,
      image: entry.image,
      tilesetCopyright: entry.tilesetCopyright,
    });
  }
  checkReferences(id, set, tilesets);

  return { id, source, set, tilesets, walls: buildWallLookup(id, set, tilesets), resolveFile };
}

// Absolute paths of the set's tileset images inside the user's project.
async function isImageFile(abs: string): Promise<boolean> {
  try {
    const info = await stat(abs);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

export async function resolveImages(loaded: LoadedAssetSet, projectDir: string): Promise<Map<string, string>> {
  const images = new Map<string, string>();
  const missing: string[] = [];
  for (const ts of loaded.tilesets.values()) {
    const abs = await resolveInProject(projectDir, ts.image, { ext: '.png' });
    if (await isImageFile(abs)) images.set(ts.name, abs);
    else missing.push(ts.image);
  }
  if (missing.length > 0) {
    throw new WaEngineError(
      'ASSET_IMAGE_MISSING',
      `the project's tilesets/ folder lacks ${missing.length} image(s) that asset set "${loaded.id}" draws with: ${missing.join(', ')}. A WorkAdventure map-starter-kit project has them; point projectDir at one.`,
      { missing },
    );
  }
  return images;
}

export interface CoverageReport {
  ok: boolean;
  missing: string[];
}

const DOOR_PIECES: readonly { name: string; key: [WallNeighbour, WallNeighbour, WallNeighbour, WallNeighbour] }[] = [
  { name: 'wall west of a door', key: [0, 2, 0, 1] },
  { name: 'horizontal lintel', key: [0, 2, 0, 2] },
  { name: 'wall east of a door', key: [0, 1, 0, 2] },
  { name: 'wall above a door', key: [1, 0, 2, 0] },
  { name: 'vertical lintel', key: [2, 0, 2, 0] },
  { name: 'wall below a door', key: [2, 0, 1, 0] },
];

// Checks that the wall terrain covers all 16 wall neighbour patterns and every door piece.
export function checkCoverage(loaded: LoadedAssetSet): CoverageReport {
  const missing: string[] = [];
  const bit = (mask: number, b: number): WallNeighbour => ((mask >> b) & 1) as WallNeighbour;
  for (let mask = 0; mask < 16; mask++) {
    const [n, e, s, w] = [bit(mask, 3), bit(mask, 2), bit(mask, 1), bit(mask, 0)];
    if (loaded.walls.tileFor(n, e, s, w) === undefined) missing.push(`wall N${n} E${e} S${s} W${w}`);
  }
  for (const piece of DOOR_PIECES) {
    if (loaded.walls.tileFor(...piece.key) === undefined) missing.push(piece.name);
  }
  return { ok: missing.length === 0, missing };
}
