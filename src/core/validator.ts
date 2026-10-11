import { access } from 'node:fs/promises';
import {
  getProperty,
  isExternalTileset,
  type TiledLayer,
  type TiledMap,
  type TiledObject,
  type TiledTileLayer,
} from '../schemas/tiled.schema.js';
import { WA_ZONE_PROPERTY_NAMES } from '../schemas/wa.schema.js';
import { checkCoverage, loadAssetSet, type LoadedAssetSet } from './asset-set-registry.js';
import { collectDoorSpans, faceStyleOf } from './autotiler.js';
import { alignState, readState, type EngineState } from './engine-state.js';
import { WaEngineError } from './errors.js';
import { decodeGid, tilesetForGid } from './gid.js';
import { CellSet } from './grid.js';
import { forEachObjectGroup, readTileData, tryResolveRole, type LayerRole } from './layers.js';
import { readMap } from './map-io.js';
import { resolveMap } from './map-session.js';
import { resolveMapRelative } from './project-paths.js';
import { doorProblems, solidCells } from './walkability.js';
import { checkZoneProperties, DEFAULT_ASSET_SET, isArea } from './zones.js';

// Checks a map against WorkAdventure's rules (as its own map validator and runtime apply them)
// and against the engine's own invariants. Read-only.

// Every code a validation issue can carry: a closed list agents can branch on.
export const VALIDATION_CODES = [
  // map basics and layers
  'NOT_ORTHOGONAL',
  'TILE_SIZE_NOT_32',
  'INFINITE_MAP',
  'MISSING_FLOOR_LAYER',
  'MISSING_START_LAYER',
  'START_LAYER_NESTED',
  'START_LAYER_EMPTY',
  'START_TILE_BLOCKED',
  'OVERLAY_ABOVE_FLOOR',
  'LAYER_DATA_UNSUPPORTED',
  'LAYER_SIZE_MISMATCH',
  // tilesets and tiles
  'NON_EMBEDDED_TILESET',
  'TILESET_IMAGE_MISSING',
  'COLLIDES_NOT_BOOL',
  'MISSING_COPYRIGHT',
  'INVALID_GID',
  'ASSET_SET_NOT_FOUND',
  'ASSET_SET_INCOMPLETE',
  // walls and doors
  'WALL_WITHOUT_COLLISION',
  'ISOLATED_WALL',
  'DOOR_UNREACHABLE',
  'EXIT_WITHOUT_EXIT_ZONE',
  // objects and zones
  'NEGATIVE_COORDS',
  'OUT_OF_BOUNDS_OBJECT',
  'AREA_WITHOUT_SIZE',
  'DUPLICATE_AREA_NAME',
  'ORPHAN_ZONE',
  'INVALID_ZONE_PROPERTY',
  'BAD_URL',
  // map script
  'SCRIPT_EXTERNAL',
  'SCRIPT_NOT_FOUND',
  'SCRIPT_WHITESPACE',
  // engine record
  'ENGINE_STATE_INVALID',
] as const;
export type ValidationCode = (typeof VALIDATION_CODES)[number];

// Codes that come from shared core checks (door and zone checks) are validation codes too.
function validationCode(code: string): ValidationCode {
  if (!(VALIDATION_CODES as readonly string[]).includes(code)) throw new WaEngineError('INTERNAL', `unlisted validation code ${code}`);
  return code as ValidationCode;
}

export interface ValidationIssue {
  code: ValidationCode;
  message: string;
  layer?: string;
  x?: number;
  y?: number;
  objectName?: string;
}

export interface ValidationReport {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  // How many issues the caps left out; only present when some were.
  omitted?: { errors: number; warnings: number };
}

export interface ValidateOptions {
  projectDir: string;
  mapPath: string;
  assetSet?: string;
}

interface Context {
  map: TiledMap;
  projectDir: string;
  mapAbs: string;
  state: EngineState | undefined;
  set: LoadedAssetSet | undefined;
  errors: IssueList;
  warnings: IssueList;
  // Every tile layer in draw order (groups depth-first), with its path.
  layers: { layer: TiledTileLayer; path: string; data: Uint32Array | undefined }[];
}

// Caps that keep a report small enough for an agent to read and for one MCP message: one
// broken layer cannot flood it, and neither can many.
const MAX_PER_RULE = 50;
export const MAX_REPORTED_ERRORS = 200;
export const MAX_REPORTED_WARNINGS = 100;

class IssueList {
  readonly items: ValidationIssue[] = [];
  omitted = 0;
  private readonly perRule = new Map<string, number>();
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  add(issue: ValidationIssue): void {
    const rule = `${issue.code}\0${issue.layer ?? ''}`;
    const count = this.perRule.get(rule) ?? 0;
    if (count >= MAX_PER_RULE || this.items.length >= this.max) {
      this.omitted += 1;
      return;
    }
    this.perRule.set(rule, count + 1);
    this.items.push(issue);
  }
}

function flatten(layers: readonly TiledLayer[], prefix = ''): { layer: TiledLayer; path: string }[] {
  return layers.flatMap((l) => {
    const path = `${prefix}${l.name}`;
    return l.type === 'group' ? [{ layer: l, path }, ...flatten(l.layers, `${path}/`)] : [{ layer: l, path }];
  });
}

function add(list: IssueList, issue: ValidationIssue): void {
  list.add(issue);
}

function checkBasics(ctx: Context): void {
  const { map } = ctx;
  if (map.orientation !== 'orthogonal') add(ctx.errors, { code: 'NOT_ORTHOGONAL', message: `WorkAdventure needs an orthogonal map, not ${map.orientation}` });
  if (map.tilewidth !== 32 || map.tileheight !== 32) {
    add(ctx.errors, { code: 'TILE_SIZE_NOT_32', message: `tiles must be 32x32, not ${map.tilewidth}x${map.tileheight}` });
  }
  if (map.infinite === true) add(ctx.errors, { code: 'INFINITE_MAP', message: 'WorkAdventure rejects infinite maps; use a fixed map size' });
}

function checkLayers(ctx: Context): void {
  const { map } = ctx;
  const all = flatten(map.layers);
  const floorLayer = map.layers.find((l) => l.name === 'floorLayer');
  if (floorLayer?.type !== 'objectgroup') {
    const nested = all.some((e) => e.layer.name === 'floorLayer' && e.path.includes('/'));
    add(ctx.errors, {
      code: 'MISSING_FLOOR_LAYER',
      message: nested ? 'floorLayer is inside a group; WorkAdventure needs it as a top-level object layer' : 'there is no top-level object layer named floorLayer',
    });
  }
  const startLayers = all.filter(
    (e) =>
      e.layer.type === 'tilelayer' &&
      (e.layer.name === 'start' || getProperty(e.layer, 'start')?.value === true || getProperty(e.layer, 'startLayer')?.value === true),
  );
  let startArea = false;
  forEachObjectGroup(map.layers, (layer) => {
    if (layer.objects.some((o) => isArea(o) && o.name === 'start')) startArea = true;
  });
  if (startLayers.length === 0 && !startArea) {
    add(ctx.errors, { code: 'MISSING_START_LAYER', message: 'there is no start layer, startLayer property, or area named start, so players spawn at the map centre' });
  } else if (startLayers.length > 0 && startLayers.every((e) => e.path.includes('/')) && !startArea) {
    add(ctx.warnings, { code: 'START_LAYER_NESTED', message: 'the start layer is inside a group; WorkAdventure warns about this', layer: startLayers[0]!.path });
  }
  if (startLayers.length > 0 && !startArea) {
    const tiles = startLayers.some((e) => {
      const entry = ctx.layers.find((l) => l.layer === e.layer);
      return entry?.data?.some((raw) => raw !== 0) ?? false;
    });
    if (!tiles) add(ctx.warnings, { code: 'START_LAYER_EMPTY', message: 'the start layer has no tiles, so players spawn at the map centre' });
  }
  // The start and collision overlays must sit under the floor, which hides their tiles.
  const index = (role: LayerRole): number => {
    const found = tryResolveRole(map, role);
    return found === undefined ? -1 : all.findIndex((e) => e.layer === found.layer);
  };
  const floor = index('floor');
  for (const role of ['start', 'collisions'] as const) {
    const at = index(role);
    if (floor !== -1 && at > floor) {
      add(ctx.errors, { code: 'OVERLAY_ABOVE_FLOOR', message: `the ${role} layer draws above the floor, so its overlay tiles show`, layer: all[at]!.path });
    }
  }
}

async function checkTilesets(ctx: Context): Promise<void> {
  const { map } = ctx;
  for (const ts of map.tilesets) {
    if (isExternalTileset(ts)) {
      add(ctx.errors, { code: 'NON_EMBEDDED_TILESET', message: `tileset ${ts.source} is external; WorkAdventure needs embedded tilesets` });
      continue;
    }
    if (ts.image === undefined) {
      add(ctx.errors, { code: 'NON_EMBEDDED_TILESET', message: `tileset ${ts.name} is an image collection, which WorkAdventure does not support` });
    } else {
      let found = false;
      try {
        await access(await resolveMapRelative(ctx.projectDir, ctx.mapAbs, ts.image));
        found = true;
      } catch {
        found = false;
      }
      if (!found) add(ctx.errors, { code: 'TILESET_IMAGE_MISSING', message: `tileset ${ts.name}: image ${ts.image} is not in the project` });
    }
    for (const tile of ts.tiles ?? []) {
      const collides = getProperty(tile, 'collides');
      if (collides !== undefined && collides.type !== 'bool') {
        add(ctx.errors, { code: 'COLLIDES_NOT_BOOL', message: `tileset ${ts.name} tile ${tile.id}: collides must be a bool property` });
      }
    }
    if (getProperty(ts, 'tilesetCopyright') === undefined) {
      add(ctx.warnings, { code: 'MISSING_COPYRIGHT', message: `tileset ${ts.name} has no tilesetCopyright property` });
    }
  }
  if (getProperty(map, 'mapCopyright') === undefined) add(ctx.warnings, { code: 'MISSING_COPYRIGHT', message: 'the map has no mapCopyright property' });
}

// Players arriving on a start tile under a wall or furniture are stuck there.
function checkStartTiles(ctx: Context, solid: CellSet): void {
  const start = tryResolveRole(ctx.map, 'start');
  const entry = start === undefined ? undefined : ctx.layers.find((l) => l.layer === start.layer);
  entry?.data?.forEach((raw, i) => {
    const x = i % ctx.map.width;
    const y = Math.floor(i / ctx.map.width);
    if (raw !== 0 && solid.has(x, y)) {
      add(ctx.warnings, { code: 'START_TILE_BLOCKED', message: 'players spawn on a cell that a wall, wall face or furniture blocks', layer: entry.path, x, y });
    }
  });
}

function checkGids(ctx: Context): void {
  for (const { layer, data, path } of ctx.layers) {
    if (data === undefined) {
      if (ctx.map.infinite !== true) add(ctx.errors, { code: 'LAYER_DATA_UNSUPPORTED', message: 'this tile layer cannot be decoded', layer: path });
      continue;
    }
    if (ctx.map.infinite !== true && (layer.width !== ctx.map.width || layer.height !== ctx.map.height)) {
      add(ctx.errors, {
        code: 'LAYER_SIZE_MISMATCH',
        message: `this layer is ${layer.width}x${layer.height} but the map is ${ctx.map.width}x${ctx.map.height}`,
        layer: path,
      });
    }
    data.forEach((raw, i) => {
      if (raw === 0 || tilesetForGid(ctx.map.tilesets, decodeGid(raw).gid) !== undefined) return;
      add(ctx.errors, { code: 'INVALID_GID', message: `tile id ${decodeGid(raw).gid} belongs to no tileset`, layer: path, x: i % ctx.map.width, y: Math.floor(i / ctx.map.width) });
    });
  }
}

function checkWalls(ctx: Context, solid: CellSet): void {
  const { set, map } = ctx;
  if (set === undefined) return;
  const terrain = set.set.wallTerrain.tileset;
  const faceTileset = set.set.faceRules.tileset;
  const horizontalLintel = set.walls.tileFor(0, 2, 0, 2);
  const local = (raw: number): { tileset: string; tile: number } | undefined => {
    const hit = raw === 0 ? undefined : tilesetForGid(map.tilesets, decodeGid(raw).gid);
    return hit === undefined || isExternalTileset(hit.tileset) ? undefined : { tileset: hit.tileset.name, tile: hit.localId };
  };
  const wallTops = new CellSet();
  const doors = new CellSet();
  const walkableUnderLintel = new CellSet();
  const wallLike: { x: number; y: number; layer: string }[] = [];
  for (const { data, path } of ctx.layers) {
    data?.forEach((raw, i) => {
      const t = local(raw);
      if (t === undefined) return;
      const x = i % map.width;
      const y = Math.floor(i / map.width);
      if (t.tileset === terrain && set.walls.lintels.has(t.tile)) {
        doors.add(x, y);
        if (t.tile === horizontalLintel) for (let r = 1; r <= set.set.faceRules.height; r++) if (y + r < map.height) walkableUnderLintel.add(x, y + r);
        return;
      }
      const isWallTop = t.tileset === terrain && set.walls.wallTops.has(t.tile);
      if (isWallTop) wallTops.add(x, y);
      if (isWallTop || (t.tileset === faceTileset && faceStyleOf(set.set, t.tile) !== undefined)) wallLike.push({ x, y, layer: path });
    });
  }
  for (const c of wallLike) {
    if (!solid.has(c.x, c.y) && !walkableUnderLintel.has(c.x, c.y)) {
      add(ctx.errors, { code: 'WALL_WITHOUT_COLLISION', message: 'a wall or wall-face tile has no collision, so players can walk through it', layer: c.layer, x: c.x, y: c.y });
    }
  }
  for (const c of wallTops) {
    const linked = [[0, -1], [1, 0], [0, 1], [-1, 0]].some(([dx, dy]) => wallTops.has(c.x + dx!, c.y + dy!) || doors.has(c.x + dx!, c.y + dy!));
    if (!linked) add(ctx.warnings, { code: 'ISOLATED_WALL', message: 'a wall cell has no wall neighbours', x: c.x, y: c.y });
  }
}

// Doors of engine-built rooms must stay walkable, furniture included, and every exit door
// needs an exitUrl area over it.
function checkDoors(ctx: Context, solid: CellSet): void {
  const rooms = ctx.state?.rooms ?? [];
  if (rooms.length === 0) return;
  const exitAreas: TiledObject[] = [];
  forEachObjectGroup(ctx.map.layers, (layer) => {
    for (const o of layer.objects) if (isArea(o) && typeof getProperty(o, 'exitUrl')?.value === 'string') exitAreas.push(o);
  });
  const covered = (x: number, y: number): boolean => {
    const cx = (x + 0.5) * ctx.map.tilewidth;
    const cy = (y + 0.5) * ctx.map.tileheight;
    return exitAreas.some((a) => cx >= a.x && cy >= a.y && cx <= a.x + (a.width ?? 0) && cy <= a.y + (a.height ?? 0));
  };
  for (const span of collectDoorSpans(rooms).filter((s) => s.exit)) {
    const open = span.cells.filter((c) => !covered(c.x, c.y));
    if (open.length > 0) {
      add(ctx.errors, { code: 'EXIT_WITHOUT_EXIT_ZONE', message: 'an exit door has no area with exitUrl over it, so it leads nowhere', x: open[0]!.x, y: open[0]!.y });
    }
  }
  for (const problem of doorProblems(ctx.map, rooms, solid)) {
    const door = (problem.details as { door?: { x: number; y: number } }).door;
    add(ctx.errors, { code: validationCode(problem.code), message: problem.message, ...(door === undefined ? {} : { x: door.x, y: door.y }) });
  }
}


async function checkObjects(ctx: Context): Promise<void> {
  const { map } = ctx;
  const widthPx = map.width * map.tilewidth;
  const heightPx = map.height * map.tileheight;
  const hasScript = getProperty(map, 'script') !== undefined;
  const names = new Map<string, number>();
  const areas: TiledObject[] = [];
  forEachObjectGroup(map.layers, (layer) => {
    for (const o of layer.objects) {
      const objectName = o.name ?? `#${o.id}`;
      if (o.x < 0 || o.y < 0) add(ctx.errors, { code: 'NEGATIVE_COORDS', message: 'object has negative coordinates', layer: layer.name, objectName });
      else if (o.x + (o.width ?? 0) > widthPx || o.y + (o.height ?? 0) > heightPx) {
        add(ctx.errors, { code: 'OUT_OF_BOUNDS_OBJECT', message: 'object extends past the map edge', layer: layer.name, objectName });
      }
      if (!isArea(o)) continue;
      areas.push(o);
      if (!((o.width ?? 0) > 0 && (o.height ?? 0) > 0)) {
        add(ctx.errors, { code: 'AREA_WITHOUT_SIZE', message: 'WorkAdventure skips areas without a width and height', layer: layer.name, objectName });
      }
      if (o.name !== undefined && o.name !== '') names.set(o.name, (names.get(o.name) ?? 0) + 1);
    }
  });
  for (const [name, count] of names) {
    if (count > 1) add(ctx.errors, { code: 'DUPLICATE_AREA_NAME', message: `${count} areas are named "${name}"; WorkAdventure renames duplicates, which breaks scripts`, objectName: name });
  }
  for (const area of areas) {
    const objectName = area.name ?? `#${area.id}`;
    const props = Object.fromEntries((area.properties ?? []).map((p) => [p.name, p.value]));
    // Without a map script, an area with no WA property does nothing.
    if (!hasScript && !Object.keys(props).some((k) => (WA_ZONE_PROPERTY_NAMES as string[]).includes(k))) {
      add(ctx.warnings, { code: 'ORPHAN_ZONE', message: 'this area has no WorkAdventure property and the map has no script', objectName });
    }
    const check = await checkZoneProperties(props, { projectDir: ctx.projectDir, mapAbs: ctx.mapAbs, zone: objectName }, 'lenient');
    for (const e of check.errors) add(ctx.errors, { code: validationCode(e.code), message: e.message, objectName });
    for (const w of check.warnings) add(ctx.warnings, { code: validationCode(w.code), message: w.message, objectName });
  }
}

async function checkScript(ctx: Context): Promise<void> {
  const value = getProperty(ctx.map, 'script')?.value;
  if (typeof value !== 'string') return;
  // WA resolves the script as a URL, which drops surrounding spaces.
  const script = value.trim();
  if (script !== value) add(ctx.warnings, { code: 'SCRIPT_WHITESPACE', message: 'the map script has leading or trailing spaces' });
  if (/^https?:\/\//i.test(script)) {
    add(ctx.warnings, { code: 'SCRIPT_EXTERNAL', message: `the map script is loaded from outside the project: ${script}` });
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(script)) {
    add(ctx.errors, { code: 'BAD_URL', message: `the map script must be an http(s) URL or a file in the project: ${script}` });
    return;
  }
  let abs: string;
  try {
    abs = await resolveMapRelative(ctx.projectDir, ctx.mapAbs, script.split(/[?#]/)[0]!);
  } catch (err) {
    if (err instanceof WaEngineError) add(ctx.warnings, { code: 'SCRIPT_EXTERNAL', message: `the map script path leaves the project: ${script}` });
    return;
  }
  try {
    await access(abs);
  } catch {
    add(ctx.warnings, { code: 'SCRIPT_NOT_FOUND', message: `the map script file is not in the project, so WorkAdventure will fail to load it: ${script}` });
  }
}

export async function validateLoadedMap(input: {
  map: TiledMap;
  projectDir: string;
  mapAbs: string;
  state: EngineState | undefined;
  assetSet?: string;
  // Issues found before the checks ran (an unreadable engine record), reported first.
  firstErrors?: readonly ValidationIssue[];
}): Promise<ValidationReport> {
  const ctx: Context = {
    map: input.map,
    projectDir: input.projectDir,
    mapAbs: input.mapAbs,
    state: input.state,
    set: undefined,
    errors: new IssueList(MAX_REPORTED_ERRORS),
    warnings: new IssueList(MAX_REPORTED_WARNINGS),
    layers: flatten(input.map.layers)
      .filter((e): e is { layer: TiledTileLayer; path: string } => e.layer.type === 'tilelayer')
      .map((e) => {
        let data: Uint32Array | undefined;
        try {
          data = readTileData(e.layer);
        } catch {
          data = undefined;
        }
        return { ...e, data };
      }),
  };
  for (const issue of input.firstErrors ?? []) add(ctx.errors, issue);
  const setId = input.assetSet ?? input.state?.assetSet ?? DEFAULT_ASSET_SET;
  try {
    ctx.set = await loadAssetSet(setId, input.projectDir);
  } catch (err) {
    add(ctx.warnings, { code: 'ASSET_SET_NOT_FOUND', message: `wall checks skipped: ${err instanceof Error ? err.message : String(err)}` });
  }
  if (ctx.set !== undefined) {
    // A set without every wall piece can fail a later build with WALL_PIECE_MISSING.
    const coverage = checkCoverage(ctx.set);
    if (!coverage.ok) {
      add(ctx.warnings, {
        code: 'ASSET_SET_INCOMPLETE',
        message: `asset set "${setId}" has no tile for: ${coverage.missing.join(', ')} (N, E, S, W: 1 means a wall on that side); rooms that need these pieces fail to build`,
      });
    }
  }
  checkBasics(ctx);
  checkLayers(ctx);
  await checkTilesets(ctx);
  checkGids(ctx);
  const solid = solidCells(ctx.map);
  checkStartTiles(ctx, solid);
  checkWalls(ctx, solid);
  checkDoors(ctx, solid);
  await checkObjects(ctx);
  await checkScript(ctx);
  const report: ValidationReport = { ok: ctx.errors.items.length === 0, errors: ctx.errors.items, warnings: ctx.warnings.items };
  if (ctx.errors.omitted + ctx.warnings.omitted > 0) report.omitted = { errors: ctx.errors.omitted, warnings: ctx.warnings.omitted };
  return report;
}

export async function validateMap(options: ValidateOptions): Promise<ValidationReport> {
  const target = await resolveMap(options.projectDir, options.mapPath);
  const { map } = await readMap(target.mapAbs);
  let state: EngineState | undefined;
  let stateIssue: ValidationIssue | undefined;
  try {
    state = readState(map);
    if (state !== undefined) alignState(state, map);
  } catch (err) {
    state = undefined;
    stateIssue = { code: 'ENGINE_STATE_INVALID', message: err instanceof Error ? err.message : String(err) };
  }
  return validateLoadedMap({
    ...target,
    map,
    state,
    ...(options.assetSet === undefined ? {} : { assetSet: options.assetSet }),
    ...(stateIssue === undefined ? {} : { firstErrors: [stateIssue] }),
  });
}
