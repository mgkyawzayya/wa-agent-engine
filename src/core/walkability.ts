import type { DslRoom } from '../schemas/dsl.schema.js';
import { getProperty, isExternalTileset, type TiledMap } from '../schemas/tiled.schema.js';
import { collectDoorSpans, doorSideProblems } from './autotiler.js';
import { WaEngineError } from './errors.js';
import { decodeGid } from './gid.js';
import { CellSet } from './grid.js';
import { forEachTileLayer, readTileData } from './layers.js';

// Gids of tiles whose `collides` property is true.
export function collidingGids(map: TiledMap): Set<number> {
  const solid = new Set<number>();
  for (const ts of map.tilesets) {
    if (isExternalTileset(ts)) continue;
    for (const tile of ts.tiles ?? []) if (getProperty(tile, 'collides')?.value === true) solid.add(ts.firstgid + tile.id);
  }
  return solid;
}

// Cells WA treats as solid: any layer holding a colliding tile.
export function solidCells(map: TiledMap): CellSet {
  const solid = collidingGids(map);
  const mask = new CellSet();
  forEachTileLayer(map.layers, (layer) => {
    let data: Uint32Array;
    try {
      data = readTileData(layer);
    } catch {
      return;
    }
    data.forEach((raw, i) => {
      const x = i % layer.width;
      const y = Math.floor(i / layer.width);
      if (raw !== 0 && x < map.width && y < map.height && solid.has(decodeGid(raw).gid)) mask.add(x, y);
    });
  });
  return mask;
}

// Doors of engine-built rooms must stay walkable once furniture and everything else in the
// map is counted: no solid doorway, and walkable ground on both sides.
export function doorProblems(map: TiledMap, rooms: readonly DslRoom[], solid: CellSet): WaEngineError[] {
  if (rooms.length === 0) return [];
  const spans = collectDoorSpans(rooms);
  const problems: WaEngineError[] = [];
  for (const span of spans) {
    const blocked = span.cells.find((c) => solid.has(c.x, c.y));
    if (blocked !== undefined) {
      problems.push(new WaEngineError('DOOR_UNREACHABLE', `something solid stands in the doorway at (${blocked.x},${blocked.y})`, { door: blocked }));
    }
  }
  problems.push(...doorSideProblems(spans, rooms, (x, y) => solid.has(x, y), map.width, map.height));
  return problems;
}

const problemKey = (e: WaEngineError): string => {
  const d = e.details as { door?: unknown; side?: unknown } | undefined;
  return JSON.stringify([e.code, d?.door, d?.side]);
};

// The door problems in `after` that `before` did not have: what one change caused.
export function newDoorProblems(before: readonly WaEngineError[], after: readonly WaEngineError[]): WaEngineError[] {
  const known = new Set(before.map(problemKey));
  return after.filter((e) => !known.has(problemKey(e)));
}
