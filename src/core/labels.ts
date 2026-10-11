import { doorCells, interiorOf, type DslRoom, type Rect } from '../schemas/dsl.schema.js';
import type { TiledMap, TiledObject } from '../schemas/tiled.schema.js';
import { wrapText } from './bitmap-font.js';
import type { EngineState } from './engine-state.js';
import { allocObjectId, readTileData, removeOwnedObjects, resolveRole, tryResolveRole, type TileRole } from './layers.js';

// Room labels: Tiled text objects on the wall face at the top of each named room. The face is
// white or yellow in every wall style, so dark text reads on any floor. WorkAdventure draws an
// object's text at its top-left corner (halign only aligns lines against each other), so labels
// are left-aligned, like a sign on the wall.
export const LABEL_TYPE = 'label';
// Name sizes from largest to smallest: a label takes the first that fits its wall.
export const LABEL_NAME_SIZES = [16, 13, 11] as const;
export const LABEL_DETAILS_PX = 11;
const LABEL_COLOUR = '#1e1e1e';
const LABEL_FONT = 'Arial';
// WorkAdventure uses a "font-family" property as is, so the fallbacks apply where Arial is missing.
const LABEL_FONT_STACK = 'Arial, Helvetica, sans-serif';
const PADDING = 4;

// The tile layers whose tiles stand in front of a wall face: a label there would be covered.
export const FURNITURE_ROLES: readonly TileRole[] = ['furniture1', 'furniture2', 'furniture3', 'foreground1', 'foreground2'];

// How tall a text needs to be once wrapped to a width: an estimate (glyphs about 0.6 em wide,
// which allows for capitals, lines 1.25 em apart, wrapped at spaces) that the validator and the
// preview share.
export const TEXT_EM_WIDTH = 0.6;
export const TEXT_LINE_HEIGHT = 1.25;

export function estimateTextHeight(text: string, pixelsize: number, width: number): number {
  const perLine = Math.max(1, Math.floor(width / (pixelsize * TEXT_EM_WIDTH)));
  return wrapText(text, perLine).length * pixelsize * TEXT_LINE_HEIGHT;
}

function labelObject(map: TiledMap, name: string, text: string, pixelsize: number, box: { x: number; y: number; width: number; height: number }): TiledObject {
  return {
    id: allocObjectId(map),
    name,
    type: LABEL_TYPE,
    ...box,
    rotation: 0,
    visible: true,
    properties: [{ name: 'font-family', type: 'string', value: LABEL_FONT_STACK }],
    text: { text, pixelsize, fontfamily: LABEL_FONT, color: LABEL_COLOUR, wrap: true },
  };
}

// Picks the largest name size whose text, and the details under it, fit the wall; the smallest
// size when nothing fits. The name box never takes more than the wall: whatever does not fit
// is left to the validator's LABEL_TOO_LONG.
function layoutLabel(name: string, details: string, width: number, available: number): { size: number; nameHeight: number } {
  const detailsHeight = details === '' ? 0 : estimateTextHeight(details, LABEL_DETAILS_PX, width);
  for (const size of LABEL_NAME_SIZES) {
    const nameHeight = Math.ceil(estimateTextHeight(name, size, width));
    if (nameHeight + detailsHeight <= available) return { size, nameHeight: details === '' ? available : nameHeight };
  }
  const size = LABEL_NAME_SIZES[LABEL_NAME_SIZES.length - 1]!;
  return { size, nameHeight: details === '' ? available : Math.min(available, Math.ceil(estimateTextHeight(name, size, width))) };
}

// The widest run of columns from `start` (inclusive) to `end` (exclusive) that `blocked` lets
// through. Ties go to the leftmost run.
function widestRun(start: number, end: number, blocked: (col: number) => boolean): { x: number; width: number } {
  let best = { x: start, width: 0 };
  let runStart = -1;
  for (let col = start; col <= end; col++) {
    const stop = col === end || blocked(col);
    if (!stop && runStart < 0) runStart = col;
    if (stop && runStart >= 0) {
      if (col - runStart > best.width) best = { x: runStart, width: col - runStart };
      runStart = -1;
    }
  }
  return best;
}

// Cells of the furniture and foreground layers that hold a tile.
export function furnitureCells(map: TiledMap): Set<number> {
  const cells = new Set<number>();
  for (const role of FURNITURE_ROLES) {
    const resolved = tryResolveRole(map, role);
    if (resolved === undefined || resolved.layer.type !== 'tilelayer') continue;
    readTileData(resolved.layer).forEach((gid, i) => {
      if (gid !== 0) cells.add(i);
    });
  }
  return cells;
}

// The rooms of the build record with their details put back.
export function labelledRooms(state: EngineState): DslRoom[] {
  return state.rooms.map((room) => {
    const details = state.roomDetails[room.id];
    return details === undefined ? room : { ...room, details };
  });
}

// Replaces the previous labels with one name object, and one details object when the room has
// details, for every named room of the build record. A label takes the widest part of the wall
// face, at least two tiles, that neither doors in the wall above nor furniture standing on the
// face cover; failing that, the widest part furniture leaves free (text over a door gap still
// reads); failing that, the whole face. Furniture is read from the map, so prefabs placed later
// and furniture drawn in Tiled count too. Text objects made by hand are never touched. Run it
// after every change to the rooms or the furniture.
export function writeLabels(map: TiledMap, state: EngineState, faceRows: number, tile: number): void {
  removeOwnedObjects(map, state.labels, LABEL_TYPE);
  const records: EngineState['labels'] = [];
  const rooms = labelledRooms(state);
  const doors = new Set<number>();
  for (const room of rooms) for (const door of room.doors) for (const c of doorCells(room.bounds, door)) doors.add(c.y * map.width + c.x);
  const furniture = furnitureCells(map);
  const layer = resolveRole(map, 'zones').layer;
  for (const room of rooms) {
    const name = room.name?.trim() ?? '';
    if (name === '') continue;
    const details = room.details?.trim() ?? '';
    const inner = interiorOf(room.bounds);
    const wallRow = inner.y - 1;
    // A column of the face is covered by furniture on either face row, or open where a door
    // cuts the wall above it.
    const furnished = (col: number): boolean => {
      for (let row = inner.y; row < inner.y + faceRows; row++) if (furniture.has(row * map.width + col)) return true;
      return false;
    };
    const doorAbove = (col: number): boolean => doors.has(wallRow * map.width + col);
    const end = inner.x + inner.width;
    const clear = widestRun(inner.x, end, (col) => furnished(col) || doorAbove(col));
    const open = clear.width >= 2 ? clear : widestRun(inner.x, end, furnished);
    const run: Rect = open.width >= 2 ? { ...open, y: inner.y, height: faceRows } : { x: inner.x, width: inner.width, y: inner.y, height: faceRows };
    const x = run.x * tile + PADDING;
    const top = inner.y * tile + PADDING;
    const width = Math.max(tile - 2 * PADDING, run.width * tile - 2 * PADDING);
    const available = faceRows * tile - 2 * PADDING;
    const { size, nameHeight } = layoutLabel(name, details, width, available);
    const objects = [labelObject(map, `label:${room.id}`, name, size, { x, y: top, width, height: nameHeight })];
    if (details !== '') {
      // Kept inside the face even when nothing is left for it, so the validator can say so.
      const height = Math.max(1, available - nameHeight);
      objects.push(labelObject(map, `details:${room.id}`, details, LABEL_DETAILS_PX, { x, y: Math.min(top + nameHeight, top + available - 1), width, height }));
    }
    for (const object of objects) {
      layer.objects.push(object);
      records.push({ name: object.name!, objectId: object.id });
    }
  }
  state.labels = records;
}
