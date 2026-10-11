import type { Drawing } from '../schemas/asset-set.schema.js';
import { FACE_ROWS } from '../schemas/dsl.schema.js';
import type { TiledMap } from '../schemas/tiled.schema.js';
import { faceCellsFor } from './autotiler.js';
import { CellSet, inBounds } from './grid.js';
import { tryResolveRole } from './layers.js';
import type { TileWriter } from './tile-writer.js';

// Walls, doors and wall faces of a map drawn with automapping rules, read from the markers on
// its sketch layer rather than from tiles: the rules may draw walls with any art.

export interface SketchReader {
  isWall(x: number, y: number): boolean;
  isDoor(x: number, y: number): boolean;
  // A cell under a wall whose south neighbour is not a wall or a door, up to FACE_ROWS deep,
  // as the wall-face rule of the autotiler has it.
  isFace(x: number, y: number): boolean;
}

export function sketchReader(map: TiledMap, writer: TileWriter, drawing: Drawing): SketchReader {
  const present = tryResolveRole(map, 'sketch') !== undefined;
  const marker = (x: number, y: number): number | undefined => {
    if (!present || !inBounds(x, y, map.width, map.height)) return undefined;
    const t = writer.local('sketch', x, y);
    return t?.tileset === drawing.markerTileset ? t.tile : undefined;
  };
  const isWall = (x: number, y: number): boolean => marker(x, y) === drawing.markers.wall;
  const isDoor = (x: number, y: number): boolean => marker(x, y) === drawing.markers.door;
  const blocks = (x: number, y: number): boolean => isWall(x, y) || isDoor(x, y);
  return {
    isWall,
    isDoor,
    isFace: (x, y) => {
      if (!inBounds(x, y, map.width, map.height) || blocks(x, y)) return false;
      for (let row = 1; row <= FACE_ROWS; row++) {
        if (isWall(x, y - row)) return true;
        if (blocks(x, y - row)) return false;
      }
      return false;
    },
  };
}

export interface SketchCells {
  walls: CellSet;
  doors: CellSet;
  faces: CellSet;
}

// Every wall, door and face cell of the sketch.
export function sketchCells(map: TiledMap, writer: TileWriter, drawing: Drawing): SketchCells {
  const reader = sketchReader(map, writer, drawing);
  const walls = new CellSet();
  const doors = new CellSet();
  if (tryResolveRole(map, 'sketch') !== undefined) {
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (reader.isWall(x, y)) walls.add(x, y);
        else if (reader.isDoor(x, y)) doors.add(x, y);
      }
    }
  }
  return { walls, doors, faces: new CellSet(faceCellsFor(walls, walls, doors, map.width, map.height, FACE_ROWS)) };
}
