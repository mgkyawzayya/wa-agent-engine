// Writes the inputs of the Tiled goldens for the proving set's rules, under
// test/fixtures/automap-office/: the sketch of every piece that validate_wa_map checks the rules
// with (all-pieces), and each room fixture as a build with office-automap paints it just before
// the rules run. Map properties (the engine's build record, the credits) are left out: the rules
// never read them, so engine changes there do not call for a new capture. Tiled's own output for
// them (expected.tmj) comes from scripts/tiled-automap-capture.ts, and
// test/core/automap/office-goldens.test.ts compares the engine with it.
//
//   npx tsx scripts/gen-office-goldens.ts            write the inputs
//   npx tsx scripts/gen-office-goldens.ts --check    exit 1 when they are stale
//
// Needs the starter-kit images (npm run fetch-assets): the rules draw with them.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { starterKitCacheDir } from '../src/config/starter-kit.js';
import { loadAssetSet, type LoadedAutomapSet } from '../src/core/asset-set-registry.js';
import { coverageSketch } from '../src/core/automap/drawing.js';
import { buildRooms, scaffoldMap } from '../src/core/compiler.js';
import { readTileData, resolveRole, writeTileData, type TileRole } from '../src/core/layers.js';
import { readMap } from '../src/core/map-io.js';
import { MARKER_IMAGE, markerPng } from '../src/core/markers.js';
import type { TiledMap } from '../src/schemas/tiled.schema.js';
import { OFFICE_AUTOMAP_DIR, SPECIAL_IMAGE, specialTilesPng, tiledJson } from './gen-office-automap.js';

export const OFFICE_GOLDENS_DIR = fileURLToPath(new URL('../test/fixtures/automap-office/', import.meta.url));
const ROOMS_DIR = fileURLToPath(new URL('../test/fixtures/rooms/', import.meta.url));
const SET_ID = 'office-automap';
// The rules file inside a project made by makeOfficeProject.
export const OFFICE_RULES = `.wa-asset-sets/${SET_ID}/automap/rules.txt`;
// The layers the proving set's rules draw on: empty before the rules run.
export const ART_ROLES: readonly TileRole[] = ['walls', 'floor', 'collisions', 'foreground1'];
// The starter-kit images the proving set draws with.
const IMAGES = ['WA_Room_Builder.png', 'WA_Special_Zones.png'];

export interface OfficeProject {
  dir: string;
  cleanup(): Promise<void>;
}

// A throwaway map project with the proving set, its images, the marker image and the image of
// its rules' special tiles.
export async function makeOfficeProject(): Promise<OfficeProject> {
  const cache = join(starterKitCacheDir(), 'tilesets');
  const missing = IMAGES.filter((image) => !existsSync(join(cache, image)));
  if (missing.length > 0) throw new Error(`the starter-kit images ${missing.join(', ')} are not in ${cache}; run npm run fetch-assets`);
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'wa-office-')));
  const cleanup = (): Promise<void> => rm(dir, { recursive: true, force: true });
  try {
    await mkdir(join(dir, 'tilesets'));
    for (const image of IMAGES) await copyFile(join(cache, image), join(dir, 'tilesets', image));
    await writeFile(join(dir, MARKER_IMAGE), markerPng());
    await writeFile(join(dir, SPECIAL_IMAGE), specialTilesPng());
    await cp(OFFICE_AUTOMAP_DIR, join(dir, '.wa-asset-sets', SET_ID), { recursive: true });
  } catch (err) {
    await cleanup();
    throw err;
  }
  return { dir, cleanup };
}

// The golden fixtures on disk: folders with a fixture.json.
export async function officeGoldenNames(): Promise<string[]> {
  const names = await readdir(OFFICE_GOLDENS_DIR).catch(() => [] as string[]);
  return names.filter((n) => existsSync(join(OFFICE_GOLDENS_DIR, n, 'fixture.json'))).sort();
}

export interface GoldenMeta {
  description: string;
  // "all-pieces", or the room fixture the map was built from.
  source: string;
  inputsHash: string;
  capturedInputsHash?: string;
}

interface RoomFixture {
  description: string;
  mapWidth: number;
  mapHeight: number;
  rooms: unknown[];
  existingWalls?: string[];
  expectError?: string;
}

// Room fixtures that build from an empty map: the others start from walls drawn before, or fail.
export async function goldenRooms(): Promise<{ name: string; fixture: RoomFixture }[]> {
  const out = [];
  for (const file of (await readdir(ROOMS_DIR)).filter((f) => f.endsWith('.json')).sort()) {
    const fixture = JSON.parse(await readFile(join(ROOMS_DIR, file), 'utf8')) as RoomFixture;
    if (fixture.existingWalls === undefined && fixture.expectError === undefined) out.push({ name: file.slice(0, -'.json'.length), fixture });
  }
  return out;
}

// Builds a room fixture with the proving set (in a project from makeOfficeProject).
export async function buildOfficeRooms(projectDir: string, mapPath: string, fixture: RoomFixture): Promise<void> {
  await scaffoldMap({ projectDir, mapPath, width: fixture.mapWidth, height: fixture.mapHeight, assetSet: SET_ID, spawn: { x: 0, y: fixture.mapHeight - 1 } });
  await buildRooms({ projectDir, mapPath, dsl: { mapWidth: fixture.mapWidth, mapHeight: fixture.mapHeight, assetSet: SET_ID, rooms: fixture.rooms } });
}

async function rulesHash(): Promise<ReturnType<typeof createHash>> {
  const hash = createHash('sha256');
  const dir = join(OFFICE_AUTOMAP_DIR, 'automap');
  for (const file of (await readdir(dir)).sort()) hash.update(file).update('\0').update(await readFile(join(dir, file))).update('\0');
  return hash;
}

// Every golden input, by fixture name: the map's text and its metadata (without capturedInputsHash).
export async function officeGoldenInputs(): Promise<Map<string, { map: string; meta: GoldenMeta }>> {
  const project = await makeOfficeProject();
  const out = new Map<string, { map: string; meta: GoldenMeta }>();
  const add = async (name: string, map: TiledMap, description: string, source: string): Promise<void> => {
    delete map.properties;
    const text = tiledJson(map);
    const hash = await rulesHash();
    out.set(name, { map: text, meta: { description, source, inputsHash: hash.update('map.tmj\0').update(text).digest('hex') } });
  };
  try {
    const set = (await loadAssetSet(SET_ID, project.dir)) as LoadedAutomapSet;
    const { map: pieces } = await coverageSketch(set, project.dir, join(project.dir, 'all-pieces.tmj'));
    await add('all-pieces', pieces, 'Every wall pattern, door, face variant and floor style, as validate_wa_map checks the rules', 'all-pieces');
    for (const { name, fixture } of await goldenRooms()) {
      const mapPath = `${name}.tmj`;
      await buildOfficeRooms(project.dir, mapPath, fixture);
      const { map } = await readMap(join(project.dir, mapPath));
      // The build painted the sketch and the rules drew the rest: take the rules' part away.
      for (const role of ART_ROLES) {
        const { layer } = resolveRole(map, role);
        writeTileData(layer, new Uint32Array(readTileData(layer).length));
      }
      await add(name, map, `The sketch of rooms/${name}.json before the rules run: ${fixture.description}`, `rooms/${name}.json`);
    }
  } finally {
    await project.cleanup();
  }
  return out;
}

async function readMeta(name: string): Promise<GoldenMeta | undefined> {
  try {
    return JSON.parse(await readFile(join(OFFICE_GOLDENS_DIR, name, 'fixture.json'), 'utf8')) as GoldenMeta;
  } catch {
    return undefined;
  }
}

// The fixtures whose inputs on disk differ from what this script writes, or that are missing or extra.
export async function staleOfficeGoldens(): Promise<string[]> {
  const inputs = await officeGoldenInputs();
  const stale: string[] = [];
  for (const [name, { map, meta }] of inputs) {
    const current = await readMeta(name);
    const onDisk = await readFile(join(OFFICE_GOLDENS_DIR, name, 'map.tmj'), 'utf8').catch(() => undefined);
    if (onDisk !== map || current?.inputsHash !== meta.inputsHash || current.source !== meta.source || current.description !== meta.description) stale.push(name);
  }
  for (const name of await officeGoldenNames()) if (!inputs.has(name)) stale.push(name);
  return stale;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { check: { type: 'boolean' } }, strict: true, allowPositionals: false });
  if (values.check === true) {
    const stale = await staleOfficeGoldens();
    if (stale.length > 0) {
      console.error(`${OFFICE_GOLDENS_DIR} is stale (${stale.join(', ')}); run: npx tsx scripts/gen-office-goldens.ts, then scripts/tiled-automap-capture.ts`);
      process.exitCode = 1;
    }
  } else {
    const inputs = await officeGoldenInputs();
    for (const name of await officeGoldenNames()) {
      if (!inputs.has(name)) await rm(join(OFFICE_GOLDENS_DIR, name), { recursive: true, force: true });
    }
    for (const [name, { map, meta }] of inputs) {
      const dir = join(OFFICE_GOLDENS_DIR, name);
      await mkdir(dir, { recursive: true });
      const captured = (await readMeta(name))?.capturedInputsHash;
      await writeFile(join(dir, 'map.tmj'), map);
      await writeFile(join(dir, 'fixture.json'), `${JSON.stringify({ ...meta, ...(captured !== undefined ? { capturedInputsHash: captured } : {}) }, null, 1)}\n`);
    }
    console.log(`wrote ${inputs.size} golden inputs to ${OFFICE_GOLDENS_DIR}`);
  }
}
