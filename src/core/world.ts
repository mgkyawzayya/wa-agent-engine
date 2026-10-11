import { doorCells, FACE_ROWS, pointXY, type Area, type Door, type Dsl, type DslRoom, type Point } from '../schemas/dsl.schema.js';
import type { LoadedAssetSet } from './asset-set-registry.js';
import type { WriteRecorder } from './engine-state.js';
import { WaEngineError } from './errors.js';
import { CellSet, inBounds } from './grid.js';
import type { TileWriter } from './tile-writer.js';

// The world around the rooms: ground on every empty floor tile no room covers, then water and
// paths on it. A path that crosses water becomes a bridge. Everything is written through the
// build's recorder, so the next build takes it back exactly like the rooms.

export interface StripCell {
  x: number;
  y: number;
  // Which way the strip runs here, for the bridge deck.
  horizontal: boolean;
}

interface Strip {
  points?: readonly Point[];
  width: number;
  rect?: Area;
}

// The offsets of a band `width` tiles wide around its centre line; the extra tile of an even
// width goes right or down.
function band(width: number): number[] {
  const from = -Math.floor((width - 1) / 2);
  return Array.from({ length: width }, (_, i) => from + i);
}

// The tiles a path or a river covers, inside the map: a band along each straight segment, a
// square at every turn, or a rectangle. parseDsl has checked that the points lie in the map
// and go straight from one to the next; the loops stay inside the map all the same.
export function stripCells(strip: Strip, mapWidth: number, mapHeight: number): StripCell[] {
  const cells = new Map<number, StripCell>();
  const add = (x: number, y: number, horizontal: boolean): void => {
    if (!inBounds(x, y, mapWidth, mapHeight)) return;
    const key = y * mapWidth + x;
    if (!cells.has(key)) cells.set(key, { x, y, horizontal });
  };
  if (strip.rect !== undefined) {
    const r = strip.rect;
    for (let y = Math.max(0, r.y); y < Math.min(mapHeight, r.y + r.height); y++) {
      for (let x = Math.max(0, r.x); x < Math.min(mapWidth, r.x + r.width); x++) add(x, y, r.width >= r.height);
    }
    return [...cells.values()];
  }
  const points = (strip.points ?? []).map(pointXY);
  const offsets = band(strip.width);
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, ay] = points[i]!;
    const [bx, by] = points[i + 1]!;
    const horizontal = ay === by;
    const lo = Math.max(0, horizontal ? Math.min(ax, bx) : Math.min(ay, by));
    const hi = Math.min(horizontal ? mapWidth - 1 : mapHeight - 1, horizontal ? Math.max(ax, bx) : Math.max(ay, by));
    for (let t = lo; t <= hi; t++) for (const o of offsets) (horizontal ? add(t, ay + o, true) : add(ax + o, t, false));
  }
  // The turns, filled whichever way the line bends.
  for (const [px, py] of points.slice(1, -1)) for (const ox of offsets) for (const oy of offsets) add(px + ox, py + oy, true);
  return [...cells.values()];
}

export interface WorldCells {
  // Tiles of the map that rooms, water or paths take: scattered prefabs keep off them.
  taken: CellSet;
  // Water tiles without a bridge: nobody can walk on them.
  water: CellSet;
}

function styleGid(set: LoadedAssetSet, writer: TileWriter, style: string, what: string): number {
  const ref = Object.hasOwn(set.set.floorStyles.styles, style) ? set.set.floorStyles.styles[style] : undefined;
  if (ref === undefined) {
    throw new WaEngineError('UNKNOWN_STYLE', `${what}: unknown floor style "${style}"`, { available: Object.keys(set.set.floorStyles.styles) });
  }
  return writer.gid(ref.tileset, ref.tile);
}

// `buildings` are the cells the rooms take: their rectangles and the wall faces the build
// draws outside them. Ground goes only on cells whose floor is empty, so floors drawn by hand
// stay; paths and water cover whatever floor is there.
export function drawWorld(dsl: Dsl, set: LoadedAssetSet, writer: TileWriter, recorder: WriteRecorder, collision: number, buildings: CellSet): WorldCells {
  const width = dsl.mapWidth;
  const height = dsl.mapHeight;
  const taken = new CellSet(buildings);
  const outside = (c: { x: number; y: number }): boolean => !buildings.has(c.x, c.y);

  if (dsl.ground !== undefined) {
    const gid = styleGid(set, writer, dsl.ground, 'ground');
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) if (!buildings.has(x, y) && writer.get('floor', x, y) === 0) writer.set('floor', x, y, gid, recorder);
    }
  }

  const water = new Map<number, StripCell>();
  if (dsl.water.length > 0) {
    if (set.set.water === undefined) throw new WaEngineError('INVALID_INPUT', `asset set "${set.id}" has no water tiles`);
    for (const strip of dsl.water) {
      for (const c of stripCells(strip, width, height)) if (outside(c)) water.set(c.y * width + c.x, c);
    }
  }
  const paths = new Map<number, { cell: StripCell; gid: number }>();
  dsl.paths.forEach((path, i) => {
    const gid = styleGid(set, writer, path.style, `path ${i + 1}`);
    for (const c of stripCells(path, width, height)) if (outside(c)) paths.set(c.y * width + c.x, { cell: c, gid });
  });

  const w = set.set.water;
  const blocking = new CellSet();
  for (const [key, c] of water) {
    const path = paths.get(key);
    if (path !== undefined && w !== undefined) {
      const deck = path.cell.horizontal ? w.bridge.horizontal : w.bridge.vertical;
      writer.set('floor', c.x, c.y, writer.gid(deck.tileset, deck.tile), recorder);
    } else if (w !== undefined) {
      writer.set('floor', c.x, c.y, writer.gid(w.tile.tileset, w.tile.tile), recorder);
      writer.set('collisions', c.x, c.y, collision, recorder);
      blocking.add(c.x, c.y);
    }
    taken.add(c.x, c.y);
  }
  for (const [key, { cell, gid }] of paths) {
    if (!water.has(key)) writer.set('floor', cell.x, cell.y, gid, recorder);
    taken.add(cell.x, cell.y);
  }
  return { taken, water: blocking };
}

const OUTWARD: Record<Door['wall'], { dx: number; dy: number }> = {
  north: { dx: 0, dy: -1 },
  south: { dx: 0, dy: 1 },
  west: { dx: -1, dy: 0 },
  east: { dx: 1, dy: 0 },
};

// The ground in front of every door, which scatter keeps free: a corridor running out from
// the door, one cell wider than the door on each side. Under a south door it starts with the
// gap in the wall-face rows, so it reaches 3 rows past the faces.
export function doorFronts(rooms: readonly DslRoom[], mapWidth: number, mapHeight: number): CellSet {
  const fronts = new CellSet();
  for (const room of rooms) {
    for (const door of room.doors) {
      const out = OUTWARD[door.wall];
      const depth = door.wall === 'south' ? FACE_ROWS + 3 : 3;
      for (const c of doorCells(room.bounds, door)) {
        for (let d = 1; d <= depth; d++) {
          for (let side = -1; side <= 1; side++) {
            const x = c.x + out.dx * d + (out.dx === 0 ? side : 0);
            const y = c.y + out.dy * d + (out.dy === 0 ? side : 0);
            if (inBounds(x, y, mapWidth, mapHeight)) fronts.add(x, y);
          }
        }
      }
    }
  }
  return fronts;
}

// A small seeded random generator (mulberry32): the same seed gives the same scatter.
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
