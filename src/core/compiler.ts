import { access } from 'node:fs/promises';
import { interiorOf, MAX_MAP_TILES, parseDsl, type Dsl } from '../schemas/dsl.schema.js';
import { isExternalTileset, setProperty, type TiledMap, type TiledObject } from '../schemas/tiled.schema.js';
import { NPC_WRITABLE_BY, type WaVariable } from '../schemas/wa.schema.js';
import { loadAssetSet, type LoadedAssetSet } from './asset-set-registry.js';
import { autotile, faceStyleOf } from './autotiler.js';
import {
  decodeCells,
  eachWrite,
  emptyState,
  encodeCells,
  MODAL_ORIGINS_PROPERTY,
  writeState,
  WriteRecorder,
  type EngineState,
  type PrefabRecord,
  type Writes,
} from './engine-state.js';
import { assertWhole, WaEngineError, isWaEngineError, type ErrorCode } from './errors.js';
import { decodeGid, tilesetForGid } from './gid.js';
import { CellSet } from './grid.js';
import { allocObjectId, ensureStandardLayers, forEachObjectGroup, removeOwnedObjects, resolveRole, type TileRole } from './layers.js';
import { writeLabels } from './labels.js';
import { createEmptyMap, readMap, withMapLock, writeMap } from './map-io.js';
import { editMap, resolveMap } from './map-session.js';
import { loadPrefab, type LoadedPrefab } from './prefab-registry.js';
import { resolveMapRelative } from './project-paths.js';
import { embedSetTilesets, TileWriter } from './tile-writer.js';
import { collidingGids, doorProblems, newDoorProblems, solidCells } from './walkability.js';
import { checkZoneProperties, DEFAULT_ASSET_SET, upsertArea } from './zones.js';

const TILE = 32;

function firstError(errors: readonly WaEngineError[]): never {
  const [first] = errors;
  throw new WaEngineError(first!.code, first!.message, errors.length === 1 ? first!.details : { errors: errors.map((e) => e.toJSON()) });
}

// ---- scaffold ----

export interface ScaffoldOptions {
  projectDir: string;
  mapPath: string;
  width: number;
  height: number;
  assetSet: string;
  spawn: { x: number; y: number };
  mapName?: string;
  mapDescription?: string;
  script?: string;
  overwrite?: boolean;
}

export interface ScaffoldResult {
  mapPath: string;
  layers: string[];
  tilesets: string[];
  warnings: WaEngineError[];
}

async function checkScript(projectDir: string, mapAbs: string, script: string): Promise<WaEngineError[]> {
  if (/^https:\/\//i.test(script)) {
    return [new WaEngineError('SCRIPT_EXTERNAL', `the map script is loaded from outside the project: ${script}`)];
  }
  const bad = new WaEngineError('BAD_URL', `script must be an https URL or a file inside the project, relative to the map: ${script}`);
  if (/^[a-z][a-z0-9+.-]*:/i.test(script)) throw bad;
  try {
    await access(await resolveMapRelative(projectDir, mapAbs, script));
  } catch {
    throw bad;
  }
  return [];
}

export async function scaffoldMap(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const { width, height, spawn } = options;
  assertWhole({ width, height, 'spawn.x': spawn.x, 'spawn.y': spawn.y });
  if (width < 1 || height < 1) throw new WaEngineError('INVALID_INPUT', 'width and height must be at least 1 tile');
  if (width > MAX_MAP_TILES || height > MAX_MAP_TILES) {
    throw new WaEngineError('MAP_TOO_LARGE', `maps are limited to ${MAX_MAP_TILES}x${MAX_MAP_TILES} tiles`);
  }
  if (spawn.x < 0 || spawn.y < 0 || spawn.x >= width || spawn.y >= height) {
    throw new WaEngineError('SPAWN_OUT_OF_BOUNDS', `spawn (${spawn.x},${spawn.y}) lies outside the ${width}x${height} map`);
  }
  const { projectDir, mapAbs } = await resolveMap(options.projectDir, options.mapPath);
  return withMapLock(mapAbs, async () => {
    let expectedSha256: string | null = null;
    try {
      const current = await readMap(mapAbs);
      if (options.overwrite !== true || current.map.type !== 'map') {
        throw new WaEngineError('MAP_EXISTS', `${options.mapPath} already exists; pass overwrite to replace a map`);
      }
      expectedSha256 = current.sha256;
    } catch (err) {
      if (isWaEngineError(err, 'MAP_EXISTS')) throw err;
      if (!isWaEngineError(err, 'MAP_NOT_FOUND')) {
        throw new WaEngineError('MAP_EXISTS', `${options.mapPath} exists and is not a Tiled map; refusing to overwrite it`);
      }
    }
    const set = await loadAssetSet(options.assetSet, projectDir);
    const warnings = options.script === undefined ? [] : await checkScript(projectDir, mapAbs, options.script);

    const map = createEmptyMap(width, height);
    ensureStandardLayers(map);
    await embedSetTilesets(projectDir, map, mapAbs, set);
    if (set.set.mapCopyright !== undefined) setProperty(map, 'mapCopyright', 'string', set.set.mapCopyright);
    if (options.mapDescription !== undefined) setProperty(map, 'mapDescription', 'string', options.mapDescription);
    if (options.mapName !== undefined) setProperty(map, 'mapName', 'string', options.mapName);
    if (options.script !== undefined) setProperty(map, 'script', 'string', options.script);

    const writer = new TileWriter(map);
    writer.set('start', spawn.x, spawn.y, writer.gid(set.set.startTile.tileset, set.set.startTile.tile));
    writer.flush();
    writeState(map, emptyState(set.id, map));
    await writeMap(mapAbs, map, { projectDir, expectedSha256 });
    return {
      mapPath: options.mapPath,
      layers: map.layers.map((l) => l.name),
      tilesets: map.tilesets.map((t) => String(t.name ?? t.source)),
      warnings,
    };
  });
}

// ---- what is already in the map ----

interface Existing {
  walls: CellSet;
  doors: CellSet;
  occupied: CellSet;
  faceStyle: (x: number, y: number) => string | undefined;
}

function readExisting(map: TiledMap, writer: TileWriter, set: LoadedAssetSet): Existing {
  const walls = new CellSet();
  const doors = new CellSet();
  const occupied = new CellSet();
  const faceTileset = set.set.faceRules.tileset;
  const wallTileset = set.set.wallTerrain.tileset;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const wall = writer.local('walls', x, y);
      if (writer.get('walls', x, y) !== 0) occupied.add(x, y);
      if (wall?.tileset === wallTileset && set.walls.wallTops.has(wall.tile)) walls.add(x, y);
      const top = writer.local('foreground1', x, y);
      if (top?.tileset === wallTileset && set.walls.lintels.has(top.tile)) doors.add(x, y);
    }
  }
  return {
    walls,
    doors,
    occupied,
    faceStyle: (x, y) => {
      const face = writer.local('walls', x, y);
      return face?.tileset === faceTileset ? faceStyleOf(set.set, face.tile) : undefined;
    },
  };
}

function restore(writer: TileWriter, writes: Writes, size: { width: number; height: number }): void {
  for (const w of eachWrite(writes, size)) writer.set(w.role, w.x, w.y, w.original);
}

// ---- prefabs ----

const PREFAB_ROLES: readonly TileRole[] = ['furniture1', 'furniture2', 'furniture3', 'foreground1', 'foreground2'];

interface Probe {
  isFace(x: number, y: number): boolean;
  isWallTop(x: number, y: number): boolean;
}

function probe(map: TiledMap, writer: TileWriter, set: LoadedAssetSet): Probe {
  const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < map.width && y < map.height;
  return {
    isFace: (x, y) => {
      if (!inside(x, y)) return false;
      const t = writer.local('walls', x, y);
      return t?.tileset === set.set.faceRules.tileset && faceStyleOf(set.set, t.tile) !== undefined;
    },
    isWallTop: (x, y) => {
      if (!inside(x, y)) return false;
      const t = writer.local('walls', x, y);
      return t?.tileset === set.set.wallTerrain.tileset && set.walls.wallTops.has(t.tile);
    },
  };
}

// A north-wall prefab hangs on the face rows under a wall top: its faceRow says which row its
// top row sits on.
function onNorthWall(p: Probe, prefab: { width: number; faceRow?: string | undefined }, x: number, y: number): boolean {
  const columns = Array.from({ length: prefab.width }, (_, i) => x + i);
  const upper = columns.every((cx) => p.isWallTop(cx, y - 1) && p.isFace(cx, y));
  const lower = columns.every((cx) => p.isWallTop(cx, y - 2) && p.isFace(cx, y - 1) && p.isFace(cx, y));
  return prefab.faceRow === 'upper' ? upper : prefab.faceRow === 'lower' ? lower : upper || lower;
}

function stampPrefab(
  map: TiledMap,
  writer: TileWriter,
  set: LoadedAssetSet,
  prefab: LoadedPrefab,
  x: number,
  y: number,
  recorder: WriteRecorder,
): void {
  assertWhole({ x, y });
  if (x < 0 || y < 0 || x + prefab.width > map.width || y + prefab.height > map.height) {
    throw new WaEngineError('PREFAB_OUT_OF_BOUNDS', `prefab ${prefab.id} (${prefab.width}x${prefab.height}) at (${x},${y}) does not fit in the map`, {
      prefab: prefab.id,
      x,
      y,
    });
  }
  const p = probe(map, writer, set);
  if (prefab.placement === 'north-wall' && !onNorthWall(p, prefab, x, y)) {
    throw new WaEngineError(
      'PREFAB_PLACEMENT',
      `prefab ${prefab.id} must hang on a north wall: its top row goes on the ${prefab.faceRow === 'either' ? 'upper or lower' : prefab.faceRow} wall-face row`,
      { prefab: prefab.id, x, y, faceRow: prefab.faceRow },
    );
  }

  const conflicts: { x: number; y: number; role: string }[] = [];
  for (let cy = y; cy < y + prefab.height; cy++) {
    for (let cx = x; cx < x + prefab.width; cx++) {
      // Wall faces are opaque: a wall-mounted prefab may cover them, and needs no floor there.
      const onFace = prefab.placement === 'north-wall' && p.isFace(cx, cy);
      for (const role of [...PREFAB_ROLES, 'walls', 'collisions'] as const) {
        if (onFace && (role === 'walls' || role === 'collisions')) continue;
        if (writer.get(role, cx, cy) !== 0) conflicts.push({ x: cx, y: cy, role });
      }
      if (!onFace && writer.get('floor', cx, cy) === 0) conflicts.push({ x: cx, y: cy, role: 'floor (missing)' });
    }
  }
  if (conflicts.length > 0) {
    throw new WaEngineError('PREFAB_BLOCKED', `prefab ${prefab.id} at (${x},${y}) overlaps ${conflicts.length} occupied or floorless cell(s)`, {
      prefab: prefab.id,
      conflicts: conflicts.slice(0, 50),
    });
  }

  for (const [role, cells] of Object.entries(prefab.layers) as [TileRole, LoadedPrefab['layers'][keyof LoadedPrefab['layers']]][]) {
    for (const c of cells ?? []) writer.set(role, x + c.x, y + c.y, writer.gid(c.tileset, c.tile, c), recorder);
  }
  // A cell that already collides (a wall face under a wall-mounted prefab) is left alone, so
  // removing the prefab never brings back a stale collision.
  const collision = writer.gid(set.set.collisionTile.tileset, set.set.collisionTile.tile);
  for (const c of prefab.collisions) {
    if (writer.get('collisions', x + c.x, y + c.y) === 0) writer.set('collisions', x + c.x, y + c.y, collision, recorder);
  }
}

function prefabTilesets(prefab: LoadedPrefab, set: LoadedAssetSet): string[] {
  const names = Object.values(prefab.layers).flatMap((cells) => (cells ?? []).map((c) => c.tileset));
  return [...names, set.set.collisionTile.tileset];
}

// The cells a stamp made solid that were not solid already.
function newlySolid(writer: TileWriter, writes: Writes, colliding: Set<number>, solid: CellSet, size: { width: number; height: number }): CellSet {
  const fresh = new CellSet();
  for (const w of eachWrite(writes, size)) {
    if (!solid.has(w.x, w.y) && colliding.has(decodeGid(writer.get(w.role, w.x, w.y)).gid)) fresh.add(w.x, w.y);
  }
  return fresh;
}

function checkDoors(map: TiledMap, rooms: EngineState['rooms']): void {
  const problems = doorProblems(map, rooms, solidCells(map));
  if (problems.length > 0) firstError(problems);
}

export interface PlacePrefabOptions {
  projectDir: string;
  mapPath: string;
  prefabId: string;
  x: number;
  y: number;
  assetSet?: string;
}

export interface PlacePrefabResult {
  instance: string;
  cells: number;
  collisions: number;
}

// A map keeps the asset set it was built with, or moves to a set that extends that set (which
// has everything the map already uses, plus more prefabs). Any other set is a mismatch, even
// one that does not exist.
async function loadSetFor(current: string | undefined, requested: string, projectDir: string): Promise<LoadedAssetSet> {
  if (current === undefined || current === requested) return loadAssetSet(requested, projectDir);
  const mismatch = (): WaEngineError =>
    new WaEngineError('ASSET_SET_MISMATCH', `this map uses asset set "${current}", not "${requested}"; a map can only move to a set that extends the one it uses`);
  let set: LoadedAssetSet;
  try {
    set = await loadAssetSet(requested, projectDir);
  } catch (err) {
    if (isWaEngineError(err) && err.code === 'ASSET_SET_NOT_FOUND') throw mismatch();
    throw err;
  }
  if (set.extends !== current) throw mismatch();
  return set;
}

export async function placePrefab(options: PlacePrefabOptions): Promise<PlacePrefabResult> {
  assertWhole({ x: options.x, y: options.y });
  return editMap(options.projectDir, options.mapPath, async (session) => {
    const { map } = session;
    const state = session.state ?? emptyState(options.assetSet ?? DEFAULT_ASSET_SET, map);
    const set = await loadSetFor(session.state?.assetSet, options.assetSet ?? state.assetSet, session.projectDir);
    state.assetSet = set.id;
    const prefab = await loadPrefab(set, options.prefabId);
    ensureStandardLayers(map);
    await embedSetTilesets(session.projectDir, map, session.mapAbs, set, prefabTilesets(prefab, set));
    const writer = new TileWriter(map);
    const solid = solidCells(map);
    const before = doorProblems(map, state.rooms, solid);
    const recorder = new WriteRecorder();
    stampPrefab(map, writer, set, prefab, options.x, options.y, recorder);
    // A prefab must not turn an engine-built door into a dead end. A door something else
    // already blocks is reported by validate_map, not held against this prefab.
    for (const c of newlySolid(writer, recorder.toWrites(), collidingGids(map), solid, map)) solid.add(c.x, c.y);
    const caused = newDoorProblems(before, doorProblems(map, state.rooms, solid));
    if (caused.length > 0) firstError(caused);
    writer.flush();
    const instance = `p${state.nextPrefab}`;
    state.nextPrefab += 1;
    state.prefabs.push({ instance, prefabId: prefab.id, x: options.x, y: options.y, origin: 'tool', writes: recorder.toWrites() });
    // A prefab on a wall face may sit where a room's label was.
    writeLabels(map, state, set.set.faceRules.height, TILE);
    const cells = Object.values(prefab.layers).reduce((n, list) => n + (list?.length ?? 0), 0);
    return { result: { instance, cells, collisions: prefab.collisions.length }, write: { state } };
  });
}

// ---- build ----

export interface BuildRoomsOptions {
  projectDir: string;
  mapPath: string;
  dsl: unknown;
}

export interface BuildRoomsResult {
  placedCells: number;
  zones: string[];
  variables: string[];
  // Instances of the DSL's furniture, and of the tool-placed prefabs still in the map.
  prefabs: string[];
  toolPrefabs: string[];
  warnings: WaEngineError[];
}

function findVariables(map: TiledMap, name: string): TiledObject[] {
  const found: TiledObject[] = [];
  forEachObjectGroup(map.layers, (layer) => {
    for (const o of layer.objects) if ((o.type ?? o.class) === 'variable' && o.name === name) found.push(o);
  });
  return found;
}

function defaultProperty(value: WaVariable['default']): { type: string; value: unknown; asText: boolean } {
  if (typeof value === 'boolean') return { type: 'bool', value, asText: false };
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'int' : 'float', value, asText: false };
  if (typeof value === 'string') return { type: 'string', value, asText: false };
  // Tiled properties hold no arrays, objects or null: store JSON text for the map script to parse.
  return { type: 'string', value: JSON.stringify(value), asText: true };
}

function upsertVariables(map: TiledMap, state: EngineState, variables: Dsl['variables'], warnings: WaEngineError[]): string[] {
  const owned = new Map(state.variables.map((v) => [v.name, v.objectId]));
  const keep = new Set(variables.map((v) => v.name));
  removeOwnedObjects(map, state.variables.filter((v) => !keep.has(v.name)), 'variable');
  const records: EngineState['variables'] = [];
  for (const variable of variables) {
    const existing = findVariables(map, variable.name);
    const mine = existing.find((o) => o.id === owned.get(variable.name));
    if (existing.some((o) => o !== mine)) {
      throw new WaEngineError('VARIABLE_NAME_TAKEN', `a variable named "${variable.name}" already exists and was not created by wa-agent-engine`, {
        name: variable.name,
      });
    }
    const def = defaultProperty(variable.default);
    if (def.asText) {
      warnings.push(new WaEngineError('VARIABLE_DEFAULT_AS_TEXT', `variable "${variable.name}": its default is stored as JSON text; the map script must JSON.parse it`, {
        name: variable.name,
      }));
    }
    const properties = [
      { name: 'default', type: def.type, value: def.value },
      ...(variable.persist === undefined ? [] : [{ name: 'persist', type: 'bool', value: variable.persist }]),
      { name: 'writableBy', type: 'string', value: variable.writableBy ?? NPC_WRITABLE_BY },
    ];
    let object = mine;
    if (object === undefined) {
      object = { height: 0, id: allocObjectId(map), name: variable.name, point: true, properties, rotation: 0, type: 'variable', visible: true, width: 0, x: 0, y: 0 };
      resolveRole(map, 'zones').layer.objects.push(object);
    } else {
      object.properties = properties;
    }
    records.push({ name: variable.name, objectId: object.id });
  }
  state.variables = records;
  return records.map((r) => r.name);
}

function setModalOrigins(map: TiledMap, origins: readonly string[] | undefined): void {
  if (origins === undefined || origins.length === 0) {
    map.properties = (map.properties ?? []).filter((p) => p.name !== MODAL_ORIGINS_PROPERTY);
    return;
  }
  setProperty(map, MODAL_ORIGINS_PROPERTY, 'string', JSON.stringify(origins));
}

// Why a rebuild removed a tool prefab, or stopped tracking one; in the warning's details.reason
// so agents can branch on it.
const REMOVED_REASONS = {
  covered: 'the new rooms or their furniture cover it',
  'floor-gone': 'its floor is gone',
  'wall-gone': 'its wall is gone',
  'blocks-door': 'it would block a door of the new rooms',
  'out-of-bounds': 'it no longer fits in the map',
} as const;
const UNTRACKED_REASONS = {
  erased: 'was erased by hand, and its hidden collisions with it',
  edited: 'was edited by hand, so it was left as it is',
  'not-in-set': 'is not in the asset set any more, so it was left as it is',
} as const;
export type PrefabRemovedReason = keyof typeof REMOVED_REASONS;
export type PrefabUntrackedReason = keyof typeof UNTRACKED_REASONS;

function removedWarning(p: PrefabRecord, reason: PrefabRemovedReason): WaEngineError {
  return new WaEngineError('PREFAB_REMOVED', `prefab ${p.prefabId} (${p.instance}) at (${p.x},${p.y}) was removed: ${REMOVED_REASONS[reason]}; place it again elsewhere`, {
    reason,
    instance: p.instance,
    prefabId: p.prefabId,
    x: p.x,
    y: p.y,
  });
}

function untrackedWarning(p: PrefabRecord, reason: PrefabUntrackedReason): WaEngineError {
  return new WaEngineError('PREFAB_UNTRACKED', `prefab ${p.prefabId} (${p.instance}) at (${p.x},${p.y}) ${UNTRACKED_REASONS[reason]}; wa-agent-engine no longer tracks it`, {
    reason,
    instance: p.instance,
    prefabId: p.prefabId,
    x: p.x,
    y: p.y,
  });
}

const cellKey = (role: TileRole, x: number, y: number): string => `${role}:${x}:${y}`;

// Whether a tool prefab is still exactly what it put down: every tile and collision it wrote
// is still there, and nothing else was drawn inside its rectangle since (cells another record
// wrote, such as a prefab in one of its empty cells, and the wall's own collisions on the
// faces a wall prefab hangs on aside). Otherwise it was erased (none of its
// visible tiles left; for a collision-only prefab, none of its collisions) or edited by hand,
// which also covers a prefab whose definition changed.
function prefabCondition(
  map: TiledMap,
  writer: TileWriter,
  faces: Probe,
  prefab: LoadedPrefab,
  record: PrefabRecord,
  collision: number,
  // Every cell any record wrote (this prefab's included), as cellKey strings.
  recorded: ReadonlySet<string>,
  // Tiles of an older atlas of the same prop set, which a re-import replaced: they count as
  // this prefab's own, so the rebuild puts it back with the new art.
  olderAtlas: (raw: number) => boolean,
): 'intact' | 'erased' | 'edited' {
  const expected = new Map<string, number>();
  for (const [role, cells] of Object.entries(prefab.layers) as [TileRole, LoadedPrefab['layers'][keyof LoadedPrefab['layers']]][]) {
    for (const c of cells ?? []) expected.set(cellKey(role, record.x + c.x, record.y + c.y), writer.gid(c.tileset, c.tile, c));
  }
  const tally = { visible: 0, visibleSame: 0, visibleGone: 0, hidden: 0, hiddenSame: 0, hiddenGone: 0 };
  for (const w of eachWrite(record.writes, map)) {
    const now = writer.get(w.role, w.x, w.y);
    if (w.role === 'collisions') {
      tally.hidden += 1;
      if (now === collision) tally.hiddenSame += 1;
      if (now === w.original) tally.hiddenGone += 1;
    } else {
      tally.visible += 1;
      if (now === expected.get(cellKey(w.role, w.x, w.y)) || (now !== 0 && olderAtlas(now))) tally.visibleSame += 1;
      if (now === w.original) tally.visibleGone += 1;
    }
  }
  let foreign = false;
  for (let y = Math.max(0, record.y); y < Math.min(map.height, record.y + prefab.height) && !foreign; y++) {
    for (let x = Math.max(0, record.x); x < Math.min(map.width, record.x + prefab.width) && !foreign; x++) {
      for (const role of [...PREFAB_ROLES, 'collisions'] as const) {
        if (recorded.has(cellKey(role, x, y))) continue;
        if (role === 'collisions' && prefab.placement === 'north-wall' && faces.isFace(x, y)) continue;
        if (writer.get(role, x, y) !== 0) foreign = true;
      }
    }
  }
  if (!foreign && tally.visibleSame === tally.visible && tally.hiddenSame === tally.hidden) return 'intact';
  const gone = tally.visible > 0 ? tally.visibleGone === tally.visible : tally.hiddenGone === tally.hidden;
  return !foreign && gone ? 'erased' : 'edited';
}

// Stamp failures that mean a tool prefab no longer fits where it was placed.
const NO_LONGER_FITS = new Set<ErrorCode>(['PREFAB_BLOCKED', 'PREFAB_PLACEMENT', 'PREFAB_OUT_OF_BOUNDS']);

function removedReason(err: WaEngineError): PrefabRemovedReason {
  if (err.code === 'PREFAB_PLACEMENT') return 'wall-gone';
  if (err.code === 'PREFAB_OUT_OF_BOUNDS') return 'out-of-bounds';
  const conflicts = (err.details as { conflicts?: { role: string }[] } | undefined)?.conflicts ?? [];
  return conflicts.length > 0 && conflicts.every((c) => c.role === 'floor (missing)') ? 'floor-gone' : 'covered';
}

export async function buildRooms(options: BuildRoomsOptions): Promise<BuildRoomsResult> {
  const dsl = parseDsl(options.dsl);
  return editMap(options.projectDir, options.mapPath, async (session) => {
    const { map, projectDir, mapAbs } = session;
    if (dsl.mapWidth !== map.width || dsl.mapHeight !== map.height) {
      throw new WaEngineError('INVALID_INPUT', `the DSL is ${dsl.mapWidth}x${dsl.mapHeight} but the map is ${map.width}x${map.height}`);
    }
    const set = await loadSetFor(session.state?.assetSet, dsl.assetSet, projectDir);
    const previous = session.state ?? emptyState(dsl.assetSet, map);
    const size = previous.size;
    ensureStandardLayers(map);
    await embedSetTilesets(projectDir, map, mapAbs, set);
    const writer = new TileWriter(map);
    const warnings: WaEngineError[] = [];
    // Prefab definitions, read once per id however many records use them.
    const definitions = new Map<string, Promise<LoadedPrefab>>();
    const definition = (id: string): Promise<LoadedPrefab> => {
      let loaded = definitions.get(id);
      if (loaded === undefined) {
        loaded = loadPrefab(set, id);
        definitions.set(id, loaded);
      }
      return loaded;
    };

    // Tool prefabs erased or edited by hand since are left as they are and no longer tracked;
    // the others come off with the previous build and go back on after the new one.
    const collision = writer.gid(set.set.collisionTile.tileset, set.set.collisionTile.tile);
    const faces = probe(map, writer, set);
    const toolPrefabs: { record: PrefabRecord; prefab: LoadedPrefab }[] = [];
    // Atlases an import of this set wrote before (named <set>-<hash>) that the set no longer uses.
    const older = new Set(
      map.tilesets.filter((t) => !isExternalTileset(t) && String(t.name).startsWith(`${set.id}-`) && !set.tilesets.has(String(t.name))).map((t) => String(t.name)),
    );
    const olderAtlas = (raw: number): boolean => {
      const hit = tilesetForGid(map.tilesets, decodeGid(raw).gid);
      return hit !== undefined && older.has(String(hit.tileset.name));
    };
    // Every cell some record wrote: the build's and every prefab's.
    const recorded = new Set<string>();
    for (const writes of [previous.writes, ...previous.prefabs.map((p) => p.writes)]) {
      for (const w of eachWrite(writes, size)) recorded.add(cellKey(w.role, w.x, w.y));
    }
    for (const record of previous.prefabs.filter((p) => p.origin === 'tool')) {
      const prefab = await definition(record.prefabId).catch((err: unknown) => {
        // A prefab the set no longer has is left in place; a broken set fails the build.
        if (err instanceof WaEngineError && err.code === 'PREFAB_NOT_FOUND') return undefined;
        throw err;
      });
      if (prefab === undefined) {
        warnings.push(untrackedWarning(record, 'not-in-set'));
        continue;
      }
      const condition = prefabCondition(map, writer, faces, prefab, record, collision, recorded, olderAtlas);
      if (condition === 'intact') {
        toolPrefabs.push({ record, prefab });
        continue;
      }
      if (condition === 'erased') {
        // Its collisions are hidden under the floor and would otherwise outlive it.
        for (const w of eachWrite(record.writes, size)) {
          if (w.role === 'collisions' && writer.get('collisions', w.x, w.y) === collision) writer.set('collisions', w.x, w.y, w.original);
        }
      }
      warnings.push(untrackedWarning(record, condition));
    }

    // Undo in the reverse order things went on: tool prefabs, the build's furniture, the build.
    for (const { record } of [...toolPrefabs].reverse()) restore(writer, record.writes, size);
    for (const p of previous.prefabs.filter((q) => q.origin === 'build').reverse()) restore(writer, p.writes, size);
    restore(writer, previous.writes, size);

    const existing = readExisting(map, writer, set);
    const tiles = autotile({
      mapWidth: map.width,
      mapHeight: map.height,
      rooms: dsl.rooms,
      existingWalls: existing.walls,
      existingDoors: existing.doors,
      existingFaceStyle: existing.faceStyle,
      occupied: existing.occupied,
      previousFootprint: new CellSet(decodeCells(previous.footprint, size)),
      set,
    });
    if (tiles.errors.length > 0) firstError(tiles.errors);
    warnings.push(...tiles.warnings);

    const recorder = new WriteRecorder();
    for (const c of tiles.clears) writer.set(c.role, c.x, c.y, 0, recorder);
    for (const p of tiles.placements) writer.set(p.role, p.x, p.y, writer.gid(p.tileset, p.tile), recorder);

    const state: EngineState = {
      ...previous,
      assetSet: set.id,
      // Details are stored apart from the rooms, which 0.1.0 reads with a strict schema.
      rooms: dsl.rooms.map(({ details: _details, ...room }) => room),
      roomDetails: Object.fromEntries(dsl.rooms.flatMap((r) => (r.details === undefined ? [] : [[r.id, r.details]]))),
      footprint: encodeCells(tiles.footprint.sorted()),
      writes: recorder.toWrites(),
      prefabs: [],
    };

    // Zones: one area per room with WA properties, over its walkable interior.
    const faceRows = set.set.faceRules.height;
    const zoneNames: string[] = [];
    const zoneErrors: WaEngineError[] = [];
    for (const room of dsl.rooms) {
      if (room.waProperties === undefined || Object.keys(room.waProperties).length === 0) continue;
      const check = await checkZoneProperties(room.waProperties, { projectDir, mapAbs, zone: room.id }, 'strict');
      zoneErrors.push(...check.errors);
      warnings.push(...check.warnings);
      const inner = interiorOf(room.bounds);
      upsertArea(map, state, {
        name: room.id,
        rect: { x: inner.x * TILE, y: (inner.y + faceRows) * TILE, width: inner.width * TILE, height: (inner.height - faceRows) * TILE },
        values: check.values,
        origin: 'build',
      });
      zoneNames.push(room.id);
    }
    if (zoneErrors.length > 0) firstError(zoneErrors);
    const staleZones = state.zones.filter((z) => z.origin === 'build' && !zoneNames.includes(z.name));
    removeOwnedObjects(map, staleZones, 'area');
    state.zones = state.zones.filter((z) => !staleZones.includes(z));

    const variables = upsertVariables(map, state, dsl.variables, warnings);
    setModalOrigins(map, dsl.modalOrigins);

    // Furniture from the DSL, stamped like place_prefab and owned by the build.
    const buildPrefabs: PrefabRecord[] = [];
    for (const room of dsl.rooms) {
      for (const item of room.furniture) {
        const prefab = await definition(item.prefabId);
        const furniture = new WriteRecorder();
        stampPrefab(map, writer, set, prefab, item.x, item.y, furniture);
        buildPrefabs.push({ instance: `b-${room.id}-${buildPrefabs.length + 1}`, prefabId: prefab.id, x: item.x, y: item.y, origin: 'build', writes: furniture.toWrites() });
      }
    }

    // Tool prefabs go back on in the order they were placed, under the same rules as
    // place_prefab. One the new rooms or their furniture leave no room for, or that would
    // block a door of the new rooms, is removed.
    writer.flush();
    const solid = solidCells(map);
    const colliding = collidingGids(map);
    const baseline = doorProblems(map, dsl.rooms, solid);
    const replaced: PrefabRecord[] = [];
    for (const { record, prefab } of toolPrefabs) {
      const stamp = new WriteRecorder();
      try {
        stampPrefab(map, writer, set, prefab, record.x, record.y, stamp);
      } catch (err) {
        if (!isWaEngineError(err) || !NO_LONGER_FITS.has(err.code)) throw err;
        warnings.push(removedWarning(record, removedReason(err)));
        continue;
      }
      const writes = stamp.toWrites();
      const fresh = newlySolid(writer, writes, colliding, solid, size);
      for (const c of fresh) solid.add(c.x, c.y);
      if (newDoorProblems(baseline, doorProblems(map, dsl.rooms, solid)).length > 0) {
        for (const c of fresh) solid.delete(c.x, c.y);
        restore(writer, writes, size);
        warnings.push(removedWarning(record, 'blocks-door'));
        continue;
      }
      replaced.push({ ...record, writes });
    }
    state.prefabs = [...buildPrefabs, ...replaced];
    writer.flush();
    // Labels last, so they see every piece of furniture now on the walls.
    writeLabels(map, state, faceRows, TILE);
    // The whole map, furniture included, must leave every door walkable.
    checkDoors(map, dsl.rooms);
    return {
      result: {
        placedCells: tiles.placements.length,
        zones: zoneNames,
        variables,
        prefabs: buildPrefabs.map((b) => b.instance),
        toolPrefabs: replaced.map((r) => r.instance),
        warnings,
      },
      write: { state },
    };
  });
}
