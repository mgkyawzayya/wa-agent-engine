import * as z from 'zod';
import { DslRoomSchema, MAX_FURNITURE_PER_ROOM, MAX_ROOMS, parseDsl } from '../schemas/dsl.schema.js';
import { getProperty, isExternalTileset, setProperty, type TiledMap } from '../schemas/tiled.schema.js';
import { WaEngineError } from './errors.js';
import { decodeGid, encodeGid } from './gid.js';
import type { Cell } from './grid.js';
import { TILE_ROLES, type TileRole } from './layers.js';
import { MAX_MAP_DIMENSION } from './limits.js';

// What the engine owns in a map, kept in the map property `wa-agent-engine:build` (a JSON
// string): the last applied rooms, every cell a build or prefab wrote together with the tile
// it replaced (so it can be restored), and the zones and variables the engine created.
// Cells and objects outside this record are never touched.

export const ENGINE_STATE_PROPERTY = 'wa-agent-engine:build';
export const MODAL_ORIGINS_PROPERTY = 'wa-agent-engine:modalOrigins';

function damaged(detail: string): WaEngineError {
  return new WaEngineError(
    'ENGINE_STATE_INVALID',
    `the ${ENGINE_STATE_PROPERTY} map property is damaged (${detail}); restore it from version control or remove it to treat every tile as hand-drawn`,
  );
}

// Cells as row runs, "y:x0-x1,x2;y:..." — room builds write whole rows, so this stays small.
export function encodeCells(cells: Iterable<Cell>): string {
  return encodeRuns([...cells].map((c) => ({ ...c, value: 0 })), false);
}

// Cells with a value as row runs of equal values, "y:x0-x1=v,x2=w;...".
function encodeRuns(cells: readonly (Cell & { value: number })[], withValues: boolean): string {
  const rows = new Map<number, (Cell & { value: number })[]>();
  for (const c of cells) {
    const row = rows.get(c.y);
    if (row === undefined) rows.set(c.y, [c]);
    else row.push(c);
  }
  return [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([y, row]) => {
      const sorted = [...new Map(row.map((c) => [c.x, c])).values()].sort((a, b) => a.x - b.x);
      const runs: string[] = [];
      for (let i = 0; i < sorted.length; ) {
        let j = i;
        while (
          j + 1 < sorted.length &&
          sorted[j + 1]!.x === sorted[j]!.x + 1 &&
          (!withValues || sorted[j + 1]!.value === sorted[i]!.value)
        ) {
          j++;
        }
        const span = i === j ? `${sorted[i]!.x}` : `${sorted[i]!.x}-${sorted[j]!.x}`;
        runs.push(withValues ? `${span}=${sorted[i]!.value}` : span);
        i = j + 1;
      }
      return `${y}:${runs.join(',')}`;
    })
    .join(';');
}

const ROW = /^(\d+):(.+)$/;
const RUN = /^(\d+)(?:-(\d+))?(?:=(\d+))?$/;

// Refuses anything malformed, outside the map, or past `limit` cells (by default one entry
// can never record more cells than the map has), so a damaged record cannot exhaust memory.
function decodeRuns(text: string, size: { width: number; height: number }, limit = size.width * size.height): (Cell & { value: number })[] {
  if (text === '') return [];
  const out: (Cell & { value: number })[] = [];
  for (const row of text.split(';')) {
    const rowMatch = ROW.exec(row);
    const y = Number(rowMatch?.[1]);
    if (rowMatch === null || y >= size.height) throw damaged('a cell row is malformed or outside the map');
    for (const run of rowMatch[2]!.split(',')) {
      const m = RUN.exec(run);
      const a = Number(m?.[1]);
      const b = m?.[2] === undefined ? a : Number(m[2]);
      const value = m?.[3] === undefined ? 0 : Number(m[3]);
      if (m === null || b < a || b >= size.width || value > 0xffffffff) throw damaged('a cell run is malformed, outside the map, or not a tile id');
      if (out.length + (b - a + 1) > limit) throw damaged('it records more cells than the map has');
      for (let x = a; x <= b; x++) out.push({ x, y, value });
    }
  }
  return out;
}

export function decodeCells(text: string, size: { width: number; height: number }): Cell[] {
  return decodeRuns(text, size).map(({ x, y }) => ({ x, y }));
}

const RoleWritesSchema = z.object({
  cells: z.string(),
  // Row runs of the tile each written cell had before (raw gid), for the non-empty ones.
  originals: z.string(),
});

const WritesSchema = z.partialRecord(z.enum(TILE_ROLES), RoleWritesSchema);
export type Writes = z.infer<typeof WritesSchema>;

export const PREFAB_ORIGINS = ['build', 'tool'] as const;

// Every DSL furniture item, plus room for tool-placed prefabs; a longer list is damage.
const MAX_STATE_PREFABS = MAX_ROOMS * MAX_FURNITURE_PER_ROOM + 10_000;

const EngineStateSchema = z.object({
  v: z.literal(2),
  assetSet: z.string(),
  // The map size and tileset first ids when the state was written: restoring needs both.
  size: z.object({ width: z.number().int().min(1).max(MAX_MAP_DIMENSION), height: z.number().int().min(1).max(MAX_MAP_DIMENSION) }),
  tilesets: z.array(z.tuple([z.string(), z.number().int().min(1)])),
  rooms: z.array(DslRoomSchema).max(MAX_ROOMS),
  footprint: z.string(),
  writes: WritesSchema,
  prefabs: z.array(
    z.object({
      instance: z.string(),
      prefabId: z.string(),
      x: z.number().int(),
      y: z.number().int(),
      origin: z.enum(PREFAB_ORIGINS),
      writes: WritesSchema,
    }),
  ).max(MAX_STATE_PREFABS),
  zones: z.array(
    z.object({
      name: z.string(),
      objectId: z.number().int(),
      origin: z.enum(PREFAB_ORIGINS),
      // Property keys the engine set, so a rebuild can drop the ones it no longer sets while
      // keeping keys a user added.
      keys: z.array(z.string()),
    }),
  ),
  variables: z.array(z.object({ name: z.string(), objectId: z.number().int() })),
  nextPrefab: z.number().int(),
});
export type EngineState = z.infer<typeof EngineStateSchema>;
export type PrefabRecord = EngineState['prefabs'][number];
export type ZoneRecord = EngineState['zones'][number];

function fingerprint(map: TiledMap): [string, number][] {
  return map.tilesets.filter((t) => !isExternalTileset(t)).map((t) => [String(t.name), t.firstgid]);
}

export function emptyState(assetSet: string, map: TiledMap): EngineState {
  return {
    v: 2,
    assetSet,
    size: { width: map.width, height: map.height },
    tilesets: fingerprint(map),
    rooms: [],
    footprint: '',
    writes: {},
    prefabs: [],
    zones: [],
    variables: [],
    nextPrefab: 1,
  };
}

export function readState(map: TiledMap): EngineState | undefined {
  const prop = getProperty(map, ENGINE_STATE_PROPERTY);
  if (prop === undefined) return undefined;
  let raw: unknown;
  try {
    raw = typeof prop.value === 'string' ? JSON.parse(prop.value) : undefined;
  } catch {
    raw = undefined;
  }
  const parsed = EngineStateSchema.safeParse(raw);
  if (!parsed.success) throw damaged('not a valid engine record');
  const state = parsed.data;
  const { size } = state;
  for (const { id, bounds: b } of state.rooms) {
    if (b.x < 0 || b.y < 0 || b.x + b.width > size.width || b.y + b.height > size.height) throw damaged(`room "${id}" lies outside the map`);
  }
  // The recorded rooms were a valid layout when they were built; checking them again keeps a
  // damaged door or room from reaching the door checks (a huge door width would exhaust memory).
  try {
    parseDsl({ mapWidth: size.width, mapHeight: size.height, assetSet: state.assetSet, rooms: state.rooms });
  } catch (err) {
    throw damaged(`its rooms are not a valid layout (${err instanceof WaEngineError ? err.code : 'invalid'})`);
  }
  // Every recorded cell must decode and lie inside the recorded map size. Each entry holds at
  // most one write per cell and role, and the build and the prefabs between them write a cell
  // and role at most a few times, so a real record stays well inside this budget.
  const mapCells = size.width * size.height;
  let budget = (2 * TILE_ROLES.length + 1) * mapCells;
  const check = (text: string): void => {
    budget -= decodeRuns(text, size, Math.min(mapCells, budget)).length;
  };
  check(state.footprint);
  for (const writes of [state.writes, ...state.prefabs.map((p) => p.writes)]) {
    for (const entry of Object.values(writes)) {
      check(entry.cells);
      check(entry.originals);
    }
  }
  return state;
}

export function writeState(map: TiledMap, state: EngineState): void {
  state.size = { width: map.width, height: map.height };
  state.tilesets = fingerprint(map);
  setProperty(map, ENGINE_STATE_PROPERTY, 'string', JSON.stringify(state));
}

const recordsCells = (state: EngineState): boolean =>
  state.rooms.length > 0 || state.footprint !== '' || [state.writes, ...state.prefabs.map((p) => p.writes)].some((w) => Object.keys(w).length > 0);

// Brings a state up to date with the map as it is now, before anything reads or saves it.
// Recorded cells are only valid at the size they were recorded at, so a resize is refused
// once there are any. Original tiles follow tileset first ids that Tiled renumbered (matched
// by tileset name), so the next save records ids that match the map.
export function alignState(state: EngineState, map: TiledMap): void {
  if (state.size.width !== map.width || state.size.height !== map.height) {
    if (recordsCells(state)) {
      throw new WaEngineError(
        'ENGINE_STATE_INVALID',
        `the map was resized from ${state.size.width}x${state.size.height} to ${map.width}x${map.height} since wa-agent-engine last wrote it; resize it back or remove the ${ENGINE_STATE_PROPERTY} property`,
      );
    }
    state.size = { width: map.width, height: map.height };
  }
  const now = new Map(fingerprint(map));
  const then = [...state.tilesets].sort((a, b) => b[1] - a[1]);
  if (then.some(([name, first]) => now.get(name) !== first)) {
    const remap = (raw: number): number => {
      const d = decodeGid(raw);
      const owner = then.find(([, first]) => first <= d.gid);
      const firstNow = owner === undefined ? undefined : now.get(owner[0]);
      if (owner === undefined || firstNow === undefined) {
        throw new WaEngineError('ENGINE_STATE_INVALID', `the tileset of a recorded tile is no longer in the map, so it cannot be restored; remove the ${ENGINE_STATE_PROPERTY} property`);
      }
      return encodeGid({ ...d, gid: d.gid - owner[1] + firstNow });
    };
    for (const writes of [state.writes, ...state.prefabs.map((p) => p.writes)]) {
      for (const entry of Object.values(writes)) {
        entry.originals = encodeRuns(decodeRuns(entry.originals, state.size).map((c) => ({ ...c, value: remap(c.value) })), true);
      }
    }
  }
  state.tilesets = fingerprint(map);
}

// Records writes while a build or prefab stamps tiles: the first time a (role, cell) is
// touched, the tile it had is kept.
export class WriteRecorder {
  readonly #touched = new Map<TileRole, Map<number, Cell & { value: number }>>();

  touch(role: TileRole, x: number, y: number, original: number): void {
    let cells = this.#touched.get(role);
    if (cells === undefined) {
      cells = new Map();
      this.#touched.set(role, cells);
    }
    const key = y * 65536 + x;
    if (!cells.has(key)) cells.set(key, { x, y, value: original });
  }

  cells(): Map<TileRole, Cell[]> {
    return new Map([...this.#touched].map(([role, cells]) => [role, [...cells.values()].map(({ x, y }) => ({ x, y }))]));
  }

  toWrites(): Writes {
    const writes: Writes = {};
    for (const role of TILE_ROLES) {
      const cells = this.#touched.get(role);
      if (cells === undefined || cells.size === 0) continue;
      const list = [...cells.values()];
      writes[role] = {
        cells: encodeRuns(list, false),
        originals: encodeRuns(list.filter((c) => c.value !== 0), true),
      };
    }
    return writes;
  }
}

// Every (role, cell, original gid) in a writes record.
export function* eachWrite(
  writes: Writes,
  size: { width: number; height: number },
): Generator<{ role: TileRole; x: number; y: number; original: number }> {
  for (const role of TILE_ROLES) {
    const entry = writes[role];
    if (entry === undefined) continue;
    const originals = new Map(decodeRuns(entry.originals, size).map((c) => [c.y * 65536 + c.x, c.value]));
    for (const { x, y } of decodeCells(entry.cells, size)) yield { role, x, y, original: originals.get(y * 65536 + x) ?? 0 };
  }
}

