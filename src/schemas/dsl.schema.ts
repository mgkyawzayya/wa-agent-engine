import * as z from 'zod';
import { WaEngineError } from '../core/errors.js';
import { AssetSetIdSchema } from './asset-set.schema.js';
import { NPC_WRITABLE_BY, WaVariableSchema } from './wa.schema.js';

// The room DSL in two layers. `DslShape` checks structure only and is the MCP inputSchema,
// so the SDK's pre-handler validation never swallows a coded geometry error. `parseDsl`
// adds the geometry rules and maps each failure to a coded WaEngineError.

export const MAX_MAP_TILES = 500;
// 2 face rows under the north wall plus at least 1 walkable row.
export const MIN_INTERIOR_ROWS = 3;
export const MIN_INTERIOR_COLS = 1;
export const FACE_ROWS = 2;
// Input caps: keep a single tool call bounded in time and memory.
export const MAX_ROOMS = 200;
export const MAX_DOORS_PER_ROOM = 16;
export const MAX_FURNITURE_PER_ROOM = 100;
export const MAX_VARIABLES = 100;
// Room labels: the name and the details shown on the wall at the top of a room.
export const MAX_ROOM_NAME = 60;
export const MAX_ROOM_DETAILS = 120;
// The cell between two doors on one wall line must hold a straight wall piece (63 or 65)
// for each door, so distinct doors need at least 2 wall cells between them.
export const MIN_DOOR_GAP = 2;

const int = z.number().int();

export const RectSchema = z.strictObject({
  x: int.describe('Left tile column'),
  y: int.describe('Top tile row'),
  width: int.min(1).describe('Width in tiles'),
  height: int.min(1).describe('Height in tiles'),
});
export type Rect = z.infer<typeof RectSchema>;

export const DoorSchema = z.strictObject({
  wall: z.enum(['north', 'south', 'east', 'west']).describe('The wall the door is in'),
  offset: int.describe('Cells from the wall start: the west corner for north/south walls, the north corner for east/west walls'),
  width: int.min(1).default(1).describe('Door width in cells'),
  exit: z
    .boolean()
    .exactOptional()
    .describe('An exit door may open off the map edge; pair it with an exitUrl zone. Other doors must lead somewhere walkable'),
});
export type Door = z.infer<typeof DoorSchema>;

export const FurnitureSchema = z.strictObject({
  prefabId: z.string().min(1).describe('Prefab id; the id ends in its size, width x height (place_prefab lists them)'),
  x: int.min(0).describe('Map tile column of the prefab top-left cell'),
  y: int.min(0).describe('Map tile row of the prefab top-left cell'),
});

export const DslRoomSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'room ids are 1-64 letters, digits, "_" or "-"')
    .describe('Unique room id; also the name of the room area'),
  name: z
    .string()
    .max(MAX_ROOM_NAME)
    .exactOptional()
    .describe('Room name shown on the wall at the top of the room, 2-4 words, for example "Main Hall"; a room without a name gets no label'),
  details: z
    .string()
    .max(MAX_ROOM_DETAILS)
    .exactOptional()
    .describe('One or two short lines under the name: what happens there, for example "Talks 10:00-17:00, Q&A after each talk"'),
  bounds: RectSchema.describe('Room rectangle in tiles, including its walls; at least 3 wide and 5 tall'),
  wallStyle: z.string().exactOptional().describe('Wall style of the asset set, for example "white" or "yellow"'),
  floorStyle: z.string().exactOptional().describe('Floor style of the asset set, for example "wood-dark"'),
  doors: z.array(DoorSchema).max(MAX_DOORS_PER_ROOM).default([]).describe('Doors in the room walls'),
  furniture: z.array(FurnitureSchema).max(MAX_FURNITURE_PER_ROOM).default([]).describe('Prefabs inside the room'),
  waProperties: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .exactOptional()
    .describe('WorkAdventure properties for the room area, the same keys as configure_wa_zone, for example {"jitsiRoom": "Talks"}'),
});
export type DslRoom = z.infer<typeof DslRoomSchema>;

// Room variables default to the NPC-only sentinel (user decision): players cannot write them.
export const DslVariableSchema = WaVariableSchema.extend({
  name: WaVariableSchema.shape.name.describe('Variable name: letters, digits and "_"'),
  default: WaVariableSchema.shape.default.describe('Starting value; arrays and objects are stored as JSON text'),
  persist: WaVariableSchema.shape.persist.describe('Keep the value after everyone leaves'),
  writableBy: z.string().min(1).default(NPC_WRITABLE_BY).describe('Player tag allowed to write it; by default only the NPC service can'),
});

// ---- the world around the rooms ----

export const MAX_PATHS = 100;
export const MAX_WATER = 50;
export const MAX_SCATTER = 50;
export const MAX_SCATTER_COUNT = 500;
// The sum of `count` over all scatter areas; every placed prefab is a record in the build.
export const MAX_SCATTER_TOTAL = 5_000;
const MAX_POINTS = 64;

// Each coordinate is checked against the actual map size by parseDsl.
const coordinate = int.min(0).max(MAX_MAP_TILES - 1);
const extent = int.min(1).max(MAX_MAP_TILES);

// [x, y] as a two-number array: some tool-calling clients cannot read tuple schemas.
const PointSchema = z.array(coordinate).length(2).describe('[x, y], a map tile');
export type Point = z.infer<typeof PointSchema>;
export const pointXY = (p: Point): [number, number] => [p[0]!, p[1]!];

const AreaSchema = z.strictObject({ x: coordinate, y: coordinate, width: extent, height: extent });
export type Area = z.infer<typeof AreaSchema>;

// A strip along a line of points (each step straight across or straight down), or a rectangle.
const StripShape = {
  points: z
    .array(PointSchema)
    .min(2)
    .max(MAX_POINTS)
    .exactOptional()
    .describe('Centre line as map tiles inside the map; each pair of neighbours must share x or y (straight segments, corners allowed)'),
  width: int.min(1).max(12).default(2).describe('Width in tiles of a line strip'),
  rect: AreaSchema.exactOptional().describe('A rectangle inside the map instead of a line, for example a plaza or a lake'),
};
const oneShape = (v: { points?: unknown; rect?: unknown }): boolean => (v.points === undefined) !== (v.rect === undefined);

export const PathSchema = z
  .strictObject({
    ...StripShape,
    style: z.string().min(1).describe('Floor style of the path, for example "cobble"; see the catalog'),
  })
  .refine(oneShape, { message: 'give either points or rect' })
  .describe('A walkable path, road or plaza on the ground; where it crosses water it becomes a bridge');

export const WaterSchema = z
  .strictObject(StripShape)
  .refine(oneShape, { message: 'give either points or rect' })
  .describe('A river or pond; it blocks walking except where a path crosses it');

export const ScatterSchema = z.strictObject({
  area: AreaSchema.describe('Where to scatter: a rectangle of map tiles inside the map'),
  prefabs: z.array(z.string().min(1)).min(1).max(20).describe('Prefab ids to pick from, for example trees and bushes'),
  count: int
    .min(1)
    .max(MAX_SCATTER_COUNT)
    .describe(`How many to place; fewer if the area has no room. All areas together place at most ${MAX_SCATTER_TOTAL}`),
  seed: int.min(0).default(1).describe('Change it for another arrangement; the same seed gives the same one'),
});

export type DslPath = z.infer<typeof PathSchema>;
export type DslWater = z.infer<typeof WaterSchema>;
export type DslScatter = z.infer<typeof ScatterSchema>;

export const DslShape = z.strictObject({
  mapWidth: int.min(1).describe('Must equal the map width from scaffold_map'),
  mapHeight: int.min(1).describe('Must equal the map height from scaffold_map'),
  tileSize: z.literal(32).default(32).describe('Always 32'),
  assetSet: AssetSetIdSchema.describe('The map asset set, for example "wa-starter-office"'),
  rooms: z.array(DslRoomSchema).max(MAX_ROOMS).describe('Every room of the map; rooms left out are removed'),
  modalOrigins: z.array(z.string()).max(20).exactOptional().describe('Bare https origins the NPC map script may open in a pop-up; leave it out unless the map runs the NPC'),
  variables: z.array(DslVariableSchema).max(MAX_VARIABLES).default([]).describe('Shared map variables'),
  ground: z
    .string()
    .min(1)
    .exactOptional()
    .describe(
      'Floor style for every tile no room covers, for example "grass": the map becomes a world with buildings in a landscape. Floors drawn by hand stay',
    ),
  paths: z.array(PathSchema).max(MAX_PATHS).default([]).describe('Paths, roads and plazas on the ground'),
  water: z.array(WaterSchema).max(MAX_WATER).default([]).describe('Rivers and ponds on the ground'),
  scatter: z.array(ScatterSchema).max(MAX_SCATTER).default([]).describe('Areas filled at random with prefabs such as trees and flowers'),
});
export type Dsl = z.infer<typeof DslShape>;
// What callers may pass in: the fields with defaults are optional here.
export type DslInput = z.input<typeof DslShape>;

export function interiorOf(r: Rect): Rect {
  return { x: r.x + 1, y: r.y + 1, width: r.width - 2, height: r.height - 2 };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export function wallLength(r: Rect, wall: Door['wall']): number {
  return wall === 'north' || wall === 'south' ? r.width : r.height;
}

export function isVertical(wall: Door['wall']): boolean {
  return wall === 'east' || wall === 'west';
}

// Map cells of a door span.
export function doorCells(r: Rect, door: Door): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = [];
  for (let i = door.offset; i < door.offset + door.width; i++) {
    switch (door.wall) {
      case 'north': cells.push({ x: r.x + i, y: r.y }); break;
      case 'south': cells.push({ x: r.x + i, y: r.y + r.height - 1 }); break;
      case 'west': cells.push({ x: r.x, y: r.y + i }); break;
      case 'east': cells.push({ x: r.x + r.width - 1, y: r.y + i }); break;
    }
  }
  return cells;
}

function perimeter(r: Rect): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = [];
  for (let x = r.x; x < r.x + r.width; x++) {
    cells.push({ x, y: r.y }, { x, y: r.y + r.height - 1 });
  }
  for (let y = r.y + 1; y < r.y + r.height - 1; y++) {
    cells.push({ x: r.x, y }, { x: r.x + r.width - 1, y });
  }
  return cells;
}

function fail(code: ConstructorParameters<typeof WaEngineError>[0], message: string, details?: unknown): never {
  throw new WaEngineError(code, message, details);
}

function checkDoor(room: DslRoom, door: Door, index: number): void {
  const at = { room: room.id, door: index };
  const length = wallLength(room.bounds, door.wall);
  if (door.offset < 0 || door.offset + door.width > length) {
    fail('DOOR_OUT_OF_WALL', `door ${index} of room "${room.id}" runs past its ${door.wall} wall (length ${length})`, at);
  }
  // Door end pieces (63/65, 11/61) are straight wall pieces: corners and junctions have none.
  if (door.offset < 2 || door.offset + door.width > length - 2) {
    fail(
      'DOOR_AT_CORNER',
      `door ${index} of room "${room.id}" needs a straight wall cell between it and each corner (offset 2..${length - 2 - door.width})`,
      at,
    );
  }
  if (isVertical(door.wall) && door.offset < 1 + FACE_ROWS) {
    fail(
      'DOOR_BLOCKED_BY_FACE',
      `door ${index} of room "${room.id}" opens onto the wall-face rows under the north wall; use offset ${1 + FACE_ROWS} or more`,
      at,
    );
  }
}

// A vertical door must also stay clear of the face rows of the room on the other side.
function checkNeighbourFaces(rooms: DslRoom[]): void {
  for (const room of rooms) {
    room.doors.forEach((door, index) => {
      if (!isVertical(door.wall)) return;
      const cells = doorCells(room.bounds, door);
      const column = cells[0]?.x;
      for (const other of rooms) {
        if (other === room) continue;
        const b = other.bounds;
        if (b.x !== column && b.x + b.width - 1 !== column) continue;
        const faceTop = b.y + 1;
        const faceBottom = b.y + FACE_ROWS;
        const blocked = cells.filter((c) => c.y >= faceTop && c.y <= faceBottom && c.y < b.y + b.height - 1);
        if (blocked.length > 0) {
          fail(
            'DOOR_BLOCKED_BY_FACE',
            `door ${index} of room "${room.id}" opens onto the wall-face rows of room "${other.id}"`,
            { room: room.id, door: index, neighbour: other.id, cells: blocked },
          );
        }
      }
    });
  }
}

interface DoorSpan {
  start: number;
  end: number;
  room: string;
  door: number;
}

// Doors on one wall line, across all rooms: identical spans (a shared door declared from
// both sides) merge; overlapping, touching, or too-close spans are rejected.
function checkDoorSpacing(rooms: DslRoom[]): void {
  const lines = new Map<string, DoorSpan[]>();
  for (const room of rooms) {
    room.doors.forEach((door, index) => {
      const cells = doorCells(room.bounds, door);
      const first = cells[0]!;
      const vertical = isVertical(door.wall);
      const key = vertical ? `x=${first.x}` : `y=${first.y}`;
      const along = cells.map((c) => (vertical ? c.y : c.x));
      const spans = lines.get(key) ?? [];
      spans.push({ start: Math.min(...along), end: Math.max(...along), room: room.id, door: index });
      lines.set(key, spans);
    });
  }
  for (const [line, spans] of lines) {
    spans.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < spans.length; i++) {
      const a = spans[i - 1]!;
      const b = spans[i]!;
      if (a.start === b.start && a.end === b.end) continue;
      if (b.start - a.end - 1 < MIN_DOOR_GAP) {
        fail(
          'DOOR_TOO_CLOSE',
          `door ${a.door} of room "${a.room}" and door ${b.door} of room "${b.room}" on wall line ${line} need at least ${MIN_DOOR_GAP} wall cells between them`,
          { line, doors: [{ room: a.room, door: a.door }, { room: b.room, door: b.door }] },
        );
      }
    }
  }
}

function checkThickWalls(rooms: DslRoom[]): void {
  const walls = new Set<string>();
  for (const room of rooms) for (const c of perimeter(room.bounds)) walls.add(`${c.x},${c.y}`);
  const has = (x: number, y: number): boolean => walls.has(`${x},${y}`);
  for (const key of walls) {
    const [x, y] = key.split(',').map(Number) as [number, number];
    if (has(x + 1, y) && has(x, y + 1) && has(x + 1, y + 1)) {
      fail(
        'THICK_WALL',
        `walls are 2 cells thick at (${x},${y}); rooms that touch must share one wall line`,
        { x, y },
      );
    }
  }
}

function checkModalOrigins(origins: readonly string[]): void {
  for (const origin of origins) {
    let url: URL | undefined;
    try {
      url = new URL(origin);
    } catch {
      url = undefined;
    }
    if (url?.protocol !== 'https:' || url.origin !== origin) {
      fail('BAD_URL', `modalOrigins entries must be bare https origins such as https://example.org: ${origin}`, {
        origin,
      });
    }
  }
}

// Paths, water and scatter areas lie inside the map, so drawing them stays bounded by the map
// size; the points of a line go straight across or straight down from one to the next.
function checkWorld(dsl: Dsl): void {
  const map = `${dsl.mapWidth} x ${dsl.mapHeight} map`;
  const fits = (r: Area): boolean => r.x + r.width <= dsl.mapWidth && r.y + r.height <= dsl.mapHeight;
  const describe = (r: Area): string => `(${r.x}, ${r.y}) ${r.width} x ${r.height}`;
  const strips = [...dsl.paths.map((s, i) => ({ what: `path ${i + 1}`, strip: s })), ...dsl.water.map((s, i) => ({ what: `water ${i + 1}`, strip: s }))];
  for (const { what, strip } of strips) {
    if (strip.rect !== undefined && !fits(strip.rect)) {
      fail('INVALID_INPUT', `${what}: rect ${describe(strip.rect)} reaches past the ${map}`, { what });
    }
    const points = (strip.points ?? []).map(pointXY);
    for (const [x, y] of points) {
      if (x >= dsl.mapWidth || y >= dsl.mapHeight) fail('INVALID_INPUT', `${what}: point [${x}, ${y}] is outside the ${map}`, { what });
    }
    for (let i = 0; i + 1 < points.length; i++) {
      const [ax, ay] = points[i]!;
      const [bx, by] = points[i + 1]!;
      if (ax !== bx && ay !== by) {
        fail('INVALID_INPUT', `${what}: points [${ax}, ${ay}] and [${bx}, ${by}] are not on one row or one column`, { what });
      }
    }
  }
  dsl.scatter.forEach((s, i) => {
    if (!fits(s.area)) fail('INVALID_INPUT', `scatter ${i + 1}: area ${describe(s.area)} reaches past the ${map}`, { what: `scatter ${i + 1}` });
  });
  const total = dsl.scatter.reduce((sum, s) => sum + s.count, 0);
  if (total > MAX_SCATTER_TOTAL) {
    fail('INVALID_INPUT', `the scatter areas ask for ${total} prefabs in all; at most ${MAX_SCATTER_TOTAL} are allowed`, { total, max: MAX_SCATTER_TOTAL });
  }
}

function safeParseShape(input: unknown): ReturnType<typeof DslShape.safeParse> {
  try {
    return DslShape.safeParse(input);
  } catch (err) {
    // A deeply nested variable default overflows zod's recursive JSON check.
    if (err instanceof RangeError) fail('INVALID_INPUT', 'DSL input is nested too deeply');
    throw err;
  }
}

export function parseDsl(input: unknown): Dsl {
  const parsed = safeParseShape(input);
  if (!parsed.success) {
    fail('INVALID_INPUT', `invalid DSL:\n${z.prettifyError(parsed.error)}`, { issues: parsed.error.issues });
  }
  const dsl = parsed.data;

  if (dsl.mapWidth > MAX_MAP_TILES || dsl.mapHeight > MAX_MAP_TILES) {
    fail('MAP_TOO_LARGE', `maps are limited to ${MAX_MAP_TILES}x${MAX_MAP_TILES} tiles`, {
      mapWidth: dsl.mapWidth,
      mapHeight: dsl.mapHeight,
    });
  }

  const seen = new Set<string>();
  for (const room of dsl.rooms) {
    if (seen.has(room.id)) fail('DUPLICATE_ROOM_ID', `room id "${room.id}" is used more than once`, { room: room.id });
    seen.add(room.id);
    const b = room.bounds;
    if (b.x < 0 || b.y < 0 || b.x + b.width > dsl.mapWidth || b.y + b.height > dsl.mapHeight) {
      fail('ROOM_OUT_OF_BOUNDS', `room "${room.id}" lies outside the ${dsl.mapWidth}x${dsl.mapHeight} map`, {
        room: room.id,
      });
    }
    const interior = interiorOf(b);
    if (interior.width < MIN_INTERIOR_COLS || interior.height < MIN_INTERIOR_ROWS) {
      fail(
        'ROOM_TOO_SMALL',
        `room "${room.id}" needs an interior of at least ${MIN_INTERIOR_COLS}x${MIN_INTERIOR_ROWS} tiles (2 wall-face rows plus 1 walkable row), so bounds of at least ${MIN_INTERIOR_COLS + 2}x${MIN_INTERIOR_ROWS + 2}`,
        { room: room.id },
      );
    }
    room.doors.forEach((door, index) => {
      checkDoor(room, door, index);
      if (door.exit === true) {
        const onEdge =
          (door.wall === 'north' && b.y === 0) ||
          (door.wall === 'south' && b.y + b.height === dsl.mapHeight) ||
          (door.wall === 'west' && b.x === 0) ||
          (door.wall === 'east' && b.x + b.width === dsl.mapWidth);
        if (!onEdge) {
          fail('EXIT_NOT_AT_MAP_EDGE', `door ${index} of room "${room.id}" is marked exit, but its ${door.wall} wall is not on the map edge`, {
            room: room.id,
            door: index,
          });
        }
      }
    });
    room.furniture.forEach((item, index) => {
      if (item.x >= dsl.mapWidth || item.y >= dsl.mapHeight) {
        fail('FURNITURE_OUT_OF_BOUNDS', `furniture ${index} of room "${room.id}" starts outside the map`, {
          room: room.id,
          furniture: index,
        });
      }
    });
  }

  const variables = new Set<string>();
  for (const variable of dsl.variables) {
    if (variables.has(variable.name)) {
      fail('DUPLICATE_VARIABLE', `variable "${variable.name}" is declared more than once`, { name: variable.name });
    }
    variables.add(variable.name);
  }

  for (let i = 0; i < dsl.rooms.length; i++) {
    for (let j = i + 1; j < dsl.rooms.length; j++) {
      const a = dsl.rooms[i]!;
      const b = dsl.rooms[j]!;
      if (rectsIntersect(interiorOf(a.bounds), b.bounds) || rectsIntersect(interiorOf(b.bounds), a.bounds)) {
        fail('ROOM_OVERLAP', `rooms "${a.id}" and "${b.id}" overlap; touching rooms share exactly one wall line`, {
          rooms: [a.id, b.id],
        });
      }
    }
  }

  checkThickWalls(dsl.rooms);
  checkNeighbourFaces(dsl.rooms);
  checkDoorSpacing(dsl.rooms);
  checkWorld(dsl);
  if (dsl.modalOrigins !== undefined) checkModalOrigins(dsl.modalOrigins);
  return dsl;
}
