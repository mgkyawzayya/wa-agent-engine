import { resolve } from 'node:path';
import type { TiledTilesetFields } from '../../schemas/tiled.schema.js';

// Cell flag bits as Tiled keeps them. Cell::VisualFlags (all four) is the default flag mask
// of an input layer; the Ignore*Flip properties remove bits from it.
export const FLAG_H = 0x80000000;
export const FLAG_V = 0x40000000;
export const FLAG_D = 0x20000000;
export const FLAG_HEX = 0x10000000;
export const VISUAL_FLAGS = (FLAG_H | FLAG_V | FLAG_D | FLAG_HEX) >>> 0;
export const GID_MASK = 0x0fffffff;

export const isEmptyCell = (raw: number): boolean => (raw & GID_MASK) === 0;

// Which working-map tileset a rule-map tileset is: the same image (or image collection), tile
// size, tile count, margin, spacing and tile offset. Names are not compared, as in Tiled.
export function tilesetIdentity(fields: TiledTilesetFields, baseDir: string): string | undefined {
  const offset = fields.tileoffset as { x?: number; y?: number } | undefined;
  const geometry = `${fields.tilewidth}x${fields.tileheight}:${fields.tilecount}:${fields.margin ?? 0}:${fields.spacing ?? 0}:${offset?.x ?? 0},${offset?.y ?? 0}`;
  const abs = (p: string): string => resolve(baseDir, p.replaceAll('\\', '/'));
  if (fields.image !== undefined) return `image:${abs(fields.image)}|${geometry}`;
  const images = (fields.tiles ?? []).filter((t) => t.image !== undefined).map((t) => `${t.id}=${abs(t.image!)}`).sort();
  return images.length === 0 ? undefined : `collection:${images.join(',')}|${geometry}`;
}
