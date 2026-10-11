import type { AssetSet, FaceRow, FaceStyle } from '../schemas/asset-set.schema.js';
import { doorCells, interiorOf, isVertical, type DslRoom } from '../schemas/dsl.schema.js';
import type { LoadedAssetSet, WallLookup, WallNeighbour } from './asset-set-registry.js';
import { WaEngineError } from './errors.js';
import { CellSet, DIRECTIONS4, inBounds, perimeterCells, rectCells, rectContains, type Cell } from './grid.js';
import { TILE_ROLES, type TileRole } from './layers.js';

// Turns DSL rooms into tile placements per layer role: wall tops (edge Wang lookup on the
// N/E/S/W neighbours), 2-row wall faces, floors, lintel doors, and collisions. Pure: no I/O.
//
// Contract with the compiler:
// - Write every placement and empty every clear. Nothing else in the map is touched, so
//   furniture and collisions placed inside rooms by other tools survive a rebuild.
// - Before writing, keep the original tile of every (role, cell) written or cleared, so the
//   cells can be restored when the room is removed or shrunk.
// - existingWalls / existingDoors are the wall-top and door cells in the map that the
//   engine's previous build did not draw (after its cells were restored). They may lie on
//   the new rooms' walls: such cells are taken over.

// A door must open onto at least this many connected walkable cells on its outside.
export const MIN_DOOR_SIDE_AREA = 4;

export interface Placement {
  role: TileRole;
  x: number;
  y: number;
  tileset: string;
  tile: number;
}

export interface AutotileInput {
  mapWidth: number;
  mapHeight: number;
  // Already validated by parseDsl.
  rooms: readonly DslRoom[];
  existingWalls: CellSet;
  existingDoors?: CellSet;
  // Face style of the wall face already at a cell (see faceStyleOf), so faces drawn into a
  // hand-drawn room keep its look.
  existingFaceStyle?: (x: number, y: number) => string | undefined;
  // Cells that hold any tile on the walls role. Faces under existing walls are only added
  // on free cells, old faces under new doors are cleared, and existing faces count as solid
  // when checking doors. Without it, no faces are added under existing walls, nothing under
  // doors is cleared, and every face the wall rule predicts counts as solid.
  occupied?: CellSet;
  // The previous build's footprint: existing walls next to it are re-tiled as well, since
  // their neighbours may have gone.
  previousFootprint?: CellSet;
  set: LoadedAssetSet;
}

export interface Clear {
  role: TileRole;
  x: number;
  y: number;
}

export interface AutotileResult {
  placements: Placement[];
  // Cells to empty: old wall tiles and collisions at door cells, old faces and collisions
  // under horizontal doors (cells `occupied` reports), and old lintels where a room's wall
  // now closes an existing door.
  clears: Clear[];
  // Cells this build owns: room rectangles, the faces it draws, and the cells under its
  // doors whose old faces it clears.
  footprint: CellSet;
  // Existing wall cells next to the build whose wall-top tile was recomputed.
  halo: CellSet;
  doors: CellSet;
  errors: WaEngineError[];
  warnings: WaEngineError[];
}

export interface FaceCell extends Cell {
  row: 1 | 2;
}

// ---- rules shared with the checks against WA's own maps ----

const valueAt = (walls: CellSet, doors: CellSet, x: number, y: number): WallNeighbour =>
  walls.has(x, y) ? 1 : doors.has(x, y) ? 2 : 0;

// Wall-top tile of a wall cell from its N/E/S/W neighbours (wall 1, door 2, nothing 0).
export function wallPieceFor(lookup: WallLookup, walls: CellSet, doors: CellSet, x: number, y: number): number | undefined {
  return lookup.tileFor(
    valueAt(walls, doors, x, y - 1),
    valueAt(walls, doors, x + 1, y),
    valueAt(walls, doors, x, y + 1),
    valueAt(walls, doors, x - 1, y),
  );
}

// The wall-face rule (art audit): a wall top whose south neighbour is neither a wall top nor
// a door gets faces in the cells below it, stopping at the map edge, a wall, or a door.
export function faceCellsFor(
  wallTops: Iterable<Cell>,
  walls: CellSet,
  doors: CellSet,
  width: number,
  height: number,
  faceHeight = 2,
): FaceCell[] {
  const faces: FaceCell[] = [];
  for (const { x, y } of wallTops) {
    if (walls.has(x, y + 1) || doors.has(x, y + 1)) continue;
    for (let row = 1; row <= faceHeight; row++) {
      const fy = y + row;
      if (!inBounds(x, fy, width, height) || walls.has(x, fy) || doors.has(x, fy)) break;
      faces.push({ x, y: fy, row: row as 1 | 2 });
    }
  }
  return faces;
}

// The face style a tile belongs to: the room wall styles first, then any other style.
export function faceStyleOf(set: AssetSet, tile: number): string | undefined {
  const names = [...set.wallStyles.names, ...Object.keys(set.faceRules.styles).filter((n) => !set.wallStyles.names.includes(n))];
  return names.find((name) => {
    const style = set.faceRules.styles[name];
    return style !== undefined && [style.row1, style.row2].some((row) => Object.values(row).includes(tile));
  });
}

function faceVariant(style: FaceStyle, row: 1 | 2, openW: boolean, openE: boolean): number {
  const r: FaceRow = row === 1 ? style.row1 : style.row2;
  return openW && openE ? r.openWE : openW ? r.openW : openE ? r.openE : r.mid;
}

// ---- the build, one function per step ----

export interface DoorSpan {
  cells: Cell[];
  vertical: boolean;
  exit: boolean;
}

// Door spans of all rooms; a door on a shared wall may be declared from both rooms.
export function collectDoorSpans(rooms: readonly DslRoom[]): DoorSpan[] {
  const spans = new Map<string, DoorSpan>();
  for (const room of rooms) {
    for (const door of room.doors) {
      const cells = doorCells(room.bounds, door);
      const key = cells.map((c) => `${c.x},${c.y}`).join(' ');
      const known = spans.get(key);
      if (known === undefined) spans.set(key, { cells, vertical: isVertical(door.wall), exit: door.exit === true });
      else known.exit ||= door.exit === true;
    }
  }
  return [...spans.values()];
}

interface Build {
  input: AutotileInput;
  width: number;
  height: number;
  set: AssetSet;
  lookup: WallLookup;
  perimeter: CellSet;
  footprint: CellSet;
  walls: CellSet;
  doors: CellSet;
  spans: DoorSpan[];
  wallStyleOf: Map<DslRoom, FaceStyle>;
  floorOf: Map<DslRoom, { tileset: string; tile: number }>;
  wallTops: Cell[];
  halo: CellSet;
  faces: FaceCell[];
  // Faces the wall rule predicts for every wall, existing ones included, that the map has.
  existingFaces: CellSet;
  // Cells under horizontal doors whose old faces and collisions are cleared.
  underDoor: CellSet;
  collisions: CellSet;
  placements: Placement[];
  clears: Clear[];
  errors: WaEngineError[];
  warnings: WaEngineError[];
}

function onPerimeter(room: DslRoom, x: number, y: number): boolean {
  const b = room.bounds;
  return rectContains(b, x, y) && (x === b.x || y === b.y || x === b.x + b.width - 1 || y === b.y + b.height - 1);
}

function interiorRoomAt(rooms: readonly DslRoom[], x: number, y: number): DslRoom | undefined {
  return rooms.find((r) => rectContains(interiorOf(r.bounds), x, y));
}

function place(b: Build, role: TileRole, x: number, y: number, tileset: string, tile: number): void {
  b.placements.push({ role, x, y, tileset, tile });
}

function resolveStyles(b: Build): void {
  for (const room of b.input.rooms) {
    const wallStyle = room.wallStyle ?? b.set.wallStyles.default;
    const floorStyle = room.floorStyle ?? b.set.floorStyles.default;
    const face = b.set.wallStyles.names.includes(wallStyle) ? b.set.faceRules.styles[wallStyle] : undefined;
    const floor = Object.hasOwn(b.set.floorStyles.styles, floorStyle) ? b.set.floorStyles.styles[floorStyle] : undefined;
    if (face === undefined) {
      b.errors.push(new WaEngineError('UNKNOWN_STYLE', `room "${room.id}": unknown wallStyle "${wallStyle}"`, {
        room: room.id,
        available: b.set.wallStyles.names,
      }));
    } else b.wallStyleOf.set(room, face);
    if (floor === undefined) {
      b.errors.push(new WaEngineError('UNKNOWN_STYLE', `room "${room.id}": unknown floorStyle "${floorStyle}"`, {
        room: room.id,
        available: Object.keys(b.set.floorStyles.styles),
      }));
    } else b.floorOf.set(room, floor);
  }
}

// 1. The wall mask: every room perimeter (shared lines merge) plus the walls already there.
function buildWallMask(b: Build): void {
  const { rooms } = b.input;
  // One error per room, with a capped list of the existing wall cells inside it.
  const crossing = new Map<DslRoom, Cell[]>();
  for (const c of b.input.existingWalls) {
    const room = interiorRoomAt(rooms, c.x, c.y);
    if (room !== undefined) crossing.set(room, [...(crossing.get(room) ?? []), c]);
  }
  for (const [room, cells] of crossing) {
    const sorted = cells.sort((p, q) => p.y - q.y || p.x - q.x);
    b.errors.push(new WaEngineError('ROOM_OVERLAP', `room "${room.id}" overlaps ${cells.length} wall cell(s) already in the map, first at (${sorted[0]!.x},${sorted[0]!.y})`, {
      room: room.id,
      cells: sorted.slice(0, 20),
    }));
  }
  // Walls 2 cells thick have no art; one error lists every 2x2 block.
  const thick = new CellSet();
  for (const { x, y } of b.perimeter) {
    for (const [ox, oy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]] as const) {
      const bx = x + ox;
      const by = y + oy;
      if (b.walls.has(bx, by) && b.walls.has(bx + 1, by) && b.walls.has(bx, by + 1) && b.walls.has(bx + 1, by + 1)) thick.add(bx, by);
    }
  }
  if (thick.size > 0) {
    const first = thick.sorted()[0]!;
    b.errors.push(new WaEngineError('THICK_WALL', `walls are 2 cells thick at (${first.x},${first.y}) next to a wall already in the map; rooms must share one wall line`, {
      cells: thick.sorted(),
    }));
  }
}

// 2. Doors: every span cell and both end cells must be straight walls, and vertical doors
// must not open onto wall-face rows (including faces of walls already in the map).
function cutDoors(b: Build): void {
  b.spans = collectDoorSpans(b.input.rooms);
  for (const span of b.spans) for (const c of span.cells) b.doors.add(c.x, c.y);

  const { walls, doors } = b;
  for (const span of b.spans) {
    const first = span.cells[0]!;
    const last = span.cells.at(-1)!;
    const along = span.vertical ? { dx: 0, dy: 1 } : { dx: 1, dy: 0 };
    const side = span.vertical ? { dx: 1, dy: 0 } : { dx: 0, dy: 1 };
    const straight = (x: number, y: number): boolean =>
      walls.has(x, y) && !walls.has(x + side.dx, y + side.dy) && !walls.has(x - side.dx, y - side.dy);
    const ends = [
      { x: first.x - along.dx, y: first.y - along.dy, far: { x: first.x - 2 * along.dx, y: first.y - 2 * along.dy } },
      { x: last.x + along.dx, y: last.y + along.dy, far: { x: last.x + 2 * along.dx, y: last.y + 2 * along.dy } },
    ];
    const bad = [
      ...span.cells.filter((c) => !straight(c.x, c.y)),
      ...ends.filter((e) => doors.has(e.x, e.y) || !straight(e.x, e.y) || !walls.has(e.far.x, e.far.y) || doors.has(e.far.x, e.far.y)),
    ];
    if (bad.length > 0) {
      b.errors.push(new WaEngineError('DOOR_AT_JUNCTION', `door at (${first.x},${first.y}) needs a straight wall on both ends and no crossing walls`, {
        door: first,
        cells: bad.map(({ x, y }) => ({ x, y })),
      }));
    }
  }
  for (const c of doors) walls.delete(c.x, c.y);
  // An existing door on a room's new wall is closed: its old lintel goes.
  for (const c of b.input.existingDoors ?? []) {
    if (b.perimeter.has(c.x, c.y) && !doors.has(c.x, c.y)) b.clears.push({ role: 'foreground1', x: c.x, y: c.y });
    else doors.add(c.x, c.y);
  }

  const allFaces = new CellSet(faceCellsFor(walls, walls, doors, b.width, b.height, b.set.faceRules.height));
  const occupied = b.input.occupied;
  b.existingFaces = occupied === undefined ? allFaces : new CellSet([...allFaces].filter((c) => occupied.has(c.x, c.y)));
  for (const span of b.spans.filter((s) => s.vertical)) {
    const blocked = span.cells.flatMap((c) => [{ x: c.x - 1, y: c.y }, { x: c.x + 1, y: c.y }]).filter((c) => allFaces.has(c.x, c.y));
    if (blocked.length > 0) {
      const first = span.cells[0]!;
      b.errors.push(new WaEngineError('DOOR_BLOCKED_BY_FACE', `door at (${first.x},${first.y}) opens onto wall-face rows`, {
        door: first,
        cells: blocked,
      }));
    }
  }
}

// 3. Wall tops on the build's walls and on existing walls in a 1-cell halo around the new
// and the previous footprint.
function placeWallTops(b: Build): void {
  const around = new CellSet([...b.footprint, ...(b.input.previousFootprint ?? [])]);
  for (const c of b.input.existingWalls) {
    if (b.footprint.has(c.x, c.y) || !b.walls.has(c.x, c.y)) continue;
    let near = false;
    for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1 && !near; dx++) near = around.has(c.x + dx, c.y + dy);
    if (near) b.halo.add(c.x, c.y);
  }
  b.wallTops = [...b.perimeter].filter((c) => b.walls.has(c.x, c.y));
  for (const c of [...b.wallTops, ...b.halo]) {
    const tile = wallPieceFor(b.lookup, b.walls, b.doors, c.x, c.y);
    if (tile === undefined) {
      b.errors.push(new WaEngineError('WALL_PIECE_MISSING', `asset set "${b.input.set.id}" has no wall piece for the cell at (${c.x},${c.y})`, c));
      continue;
    }
    if (tile === b.lookup.isolated) {
      b.warnings.push(new WaEngineError('ISOLATED_WALL', `wall cell at (${c.x},${c.y}) has no wall neighbours`, c));
    }
    place(b, 'walls', c.x, c.y, b.set.wallTerrain.tileset, tile);
  }
}

// 4. Faces under the build's wall tops, and under halo walls on cells that are free. Style:
// the room's inside a DSL room, else the style already there, else the outside style.
function placeFaces(b: Build): void {
  const { rooms, occupied, existingFaceStyle } = b.input;
  const height = b.set.faceRules.height;
  // A door cell's old wall tile goes. Old faces and collisions under a horizontal door go too,
  // wherever the map has them (also inside a new room that took over a hand-drawn wall).
  for (const span of b.spans) {
    for (const c of span.cells) {
      b.clears.push({ role: 'walls', x: c.x, y: c.y }, { role: 'collisions', x: c.x, y: c.y });
      if (span.vertical || occupied === undefined) continue;
      for (let row = 1; row <= height && inBounds(c.x, c.y + row, b.width, b.height); row++) {
        const y = c.y + row;
        if (b.walls.has(c.x, y) || b.doors.has(c.x, y)) break;
        if (!occupied.has(c.x, y)) continue;
        b.clears.push({ role: 'walls', x: c.x, y }, { role: 'collisions', x: c.x, y });
        b.underDoor.add(c.x, y);
        b.footprint.add(c.x, y);
      }
    }
  }
  const own = faceCellsFor(b.wallTops, b.walls, b.doors, b.width, b.height, height);
  const fromHalo =
    occupied === undefined
      ? []
      : faceCellsFor(b.halo, b.walls, b.doors, b.width, b.height, height).filter(
          (f) => !b.footprint.has(f.x, f.y) && !occupied.has(f.x, f.y),
        );
  b.faces = [...own, ...fromHalo];
  const faceSet = new CellSet(b.faces);
  const exterior = b.set.faceRules.styles[b.set.faceRules.exteriorStyle]!;
  const solid = (x: number, y: number): boolean =>
    faceSet.has(x, y) || b.walls.has(x, y) || ((occupied?.has(x, y) ?? false) && !b.underDoor.has(x, y));
  for (const f of b.faces) {
    const room = interiorRoomAt(rooms, f.x, f.y);
    const kept = room === undefined ? existingFaceStyle?.(f.x, f.y) : undefined;
    const style =
      room !== undefined
        ? (b.wallStyleOf.get(room) ?? exterior)
        : kept !== undefined
          ? (b.set.faceRules.styles[kept] ?? exterior)
          : exterior;
    place(b, 'walls', f.x, f.y, b.set.faceRules.tileset, faceVariant(style, f.row, !solid(f.x - 1, f.y), !solid(f.x + 1, f.y)));
    b.footprint.add(f.x, f.y);
  }
}

// 5. Floors: every interior, face cells included; a door takes the floor of its inner room
// (the south room of a shared horizontal door, the east room of a shared vertical door).
function placeFloors(b: Build): void {
  for (const room of b.input.rooms) {
    const floor = b.floorOf.get(room);
    if (floor === undefined) continue;
    for (const c of rectCells(interiorOf(room.bounds))) place(b, 'floor', c.x, c.y, floor.tileset, floor.tile);
  }
  for (const span of b.spans) {
    for (const c of span.cells) {
      const owners = b.input.rooms.filter((r) => onPerimeter(r, c.x, c.y));
      const inner = owners.reduce<DslRoom | undefined>(
        (best, r) =>
          best === undefined ? r : span.vertical ? (r.bounds.x > best.bounds.x ? r : best) : r.bounds.y > best.bounds.y ? r : best,
        undefined,
      );
      const floor = inner === undefined ? undefined : b.floorOf.get(inner);
      if (floor !== undefined) place(b, 'floor', c.x, c.y, floor.tileset, floor.tile);
    }
  }
}

// 6. Collisions on every wall top and face; door cells and the cells under lintels stay free.
function placeCollisions(b: Build): void {
  b.collisions = new CellSet([...b.wallTops, ...b.halo, ...b.faces]);
  const { tileset, tile } = b.set.collisionTile;
  for (const c of b.collisions.sorted()) place(b, 'collisions', c.x, c.y, tileset, tile);
}

// 7. Lintels over every door cell.
function placeLintels(b: Build): void {
  for (const span of b.spans) {
    const lintel = span.vertical ? b.lookup.tileFor(2, 0, 2, 0) : b.lookup.tileFor(0, 2, 0, 2);
    if (lintel === undefined) {
      b.errors.push(new WaEngineError('WALL_PIECE_MISSING', `asset set "${b.input.set.id}" has no ${span.vertical ? 'vertical' : 'horizontal'} lintel`));
      continue;
    }
    for (const c of span.cells) place(b, 'foreground1', c.x, c.y, b.set.wallTerrain.tileset, lintel);
  }
}

// 8. Walkability: each side of every door must open onto walkable ground: the interior of
// a room it belongs to, or at least MIN_DOOR_SIDE_AREA connected walkable cells. An exit
// door may instead open off the map edge, where an exitUrl zone takes the player away.
// The size of the largest connected walkable area inside a room.
function largestArea(room: DslRoom, blocked: (x: number, y: number) => boolean): number {
  const inner = interiorOf(room.bounds);
  const open = new CellSet(rectCells(inner).filter((c) => !blocked(c.x, c.y)));
  let largest = 0;
  for (const start of open) {
    if (!open.has(start.x, start.y)) continue;
    open.delete(start.x, start.y);
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      for (const d of DIRECTIONS4) {
        const next = { x: queue[i]!.x + d.dx, y: queue[i]!.y + d.dy };
        if (open.delete(next.x, next.y)) queue.push(next);
      }
    }
    largest = Math.max(largest, queue.length);
  }
  return largest;
}

export function doorSideProblems(
  spans: readonly DoorSpan[],
  rooms: readonly DslRoom[],
  blockedCell: (x: number, y: number) => boolean,
  width: number,
  height: number,
): WaEngineError[] {
  const problems: WaEngineError[] = [];
  const blocked = (x: number, y: number): boolean => !inBounds(x, y, width, height) || blockedCell(x, y);
  const areas = new Map<DslRoom, number>();
  const largest = (room: DslRoom): number => {
    if (!areas.has(room)) areas.set(room, largestArea(room, blocked));
    return areas.get(room)!;
  };
  for (const span of spans) {
    const own = new CellSet(span.cells);
    const first = span.cells[0]!;
    const sides = span.vertical ? [DIRECTIONS4[3], DIRECTIONS4[1]] : [DIRECTIONS4[0], DIRECTIONS4[2]];
    for (const { dx, dy } of sides) {
      const offMap = span.cells.every((c) => !inBounds(c.x + dx, c.y + dy, width, height));
      if (span.exit && offMap) continue;
      const starts = span.cells.map((c) => ({ x: c.x + dx, y: c.y + dy })).filter((c) => !blocked(c.x, c.y) && !own.has(c.x, c.y));
      // Count connected walkable cells on this side, without going back through the door.
      const seen = new CellSet(starts);
      const queue = [...starts];
      for (let i = 0; i < queue.length && seen.size < MIN_DOOR_SIDE_AREA; i++) {
        const { x, y } = queue[i]!;
        for (const d of DIRECTIONS4) {
          const nx = x + d.dx;
          const ny = y + d.dy;
          if (!blocked(nx, ny) && !own.has(nx, ny) && !seen.has(nx, ny)) {
            seen.add(nx, ny);
            queue.push({ x: nx, y: ny });
          }
        }
      }
      if (seen.size >= MIN_DOOR_SIDE_AREA) continue;
      // Into a room the door belongs to, fewer cells are enough when the room's largest open
      // area is itself smaller; reaching less than that means a pocket.
      const room = starts
        .map((c) => interiorRoomAt(rooms, c.x, c.y))
        .find((r) => r !== undefined && span.cells.some((d) => onPerimeter(r, d.x, d.y)));
      if (room !== undefined && seen.size >= largest(room)) continue;
      problems.push(new WaEngineError(
        'DOOR_UNREACHABLE',
        room !== undefined
          ? `door at (${first.x},${first.y}) opens into a pocket of room "${room.id}" closed off by walls or furniture`
          : offMap
          ? `door at (${first.x},${first.y}) opens off the map edge; if it is an exit, mark it exit: true and add an exitUrl zone over it`
          : `door at (${first.x},${first.y}) leads nowhere on one side (a wall, wall faces, or fewer than ${MIN_DOOR_SIDE_AREA} walkable cells)`,
        { door: first, side: { dx, dy }, walkableCells: seen.size },
      ));
    }
  }
  return problems;
}

function checkDoorsWalkable(b: Build): void {
  const solid = (x: number, y: number): boolean =>
    b.collisions.has(x, y) || b.walls.has(x, y) || (b.existingFaces.has(x, y) && !b.underDoor.has(x, y));
  b.errors.push(...doorSideProblems(b.spans, b.input.rooms, solid, b.width, b.height));
}

export function autotile(input: AutotileInput): AutotileResult {
  const perimeter = new CellSet(input.rooms.flatMap((r) => perimeterCells(r.bounds)));
  const b: Build = {
    input,
    width: input.mapWidth,
    height: input.mapHeight,
    set: input.set.set,
    lookup: input.set.walls,
    perimeter,
    footprint: new CellSet(input.rooms.flatMap((r) => rectCells(r.bounds))),
    walls: new CellSet([...perimeter, ...input.existingWalls]),
    doors: new CellSet(),
    spans: [],
    wallStyleOf: new Map(),
    floorOf: new Map(),
    wallTops: [],
    halo: new CellSet(),
    faces: [],
    existingFaces: new CellSet(),
    underDoor: new CellSet(),
    collisions: new CellSet(),
    placements: [],
    clears: [],
    errors: [],
    warnings: [],
  };
  resolveStyles(b);
  buildWallMask(b);
  cutDoors(b);
  placeWallTops(b);
  placeFaces(b);
  placeFloors(b);
  placeCollisions(b);
  placeLintels(b);
  checkDoorsWalkable(b);
  // 9. Stable order: role, then row, then column.
  const roleOrder = (role: TileRole): number => TILE_ROLES.indexOf(role);
  b.placements.sort((p, q) => roleOrder(p.role) - roleOrder(q.role) || p.y - q.y || p.x - q.x);
  b.clears.sort((p, q) => roleOrder(p.role) - roleOrder(q.role) || p.y - q.y || p.x - q.x);
  return {
    placements: b.placements,
    clears: b.clears,
    footprint: b.footprint,
    halo: b.halo,
    doors: new CellSet(b.spans.flatMap((s) => s.cells)),
    errors: b.errors,
    warnings: b.warnings,
  };
}
