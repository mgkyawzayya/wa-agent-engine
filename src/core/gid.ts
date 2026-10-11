import { isExternalTileset, type TiledMapTileset } from '../schemas/tiled.schema.js';

// Tiled global tile ids carry flip flags in their top bits (Tiled docs, global-tile-ids).
export const FLIP_H = 0x80000000;
export const FLIP_V = 0x40000000;
export const FLIP_D = 0x20000000;
// Hexagonal 120° rotation. Meaningless on orthogonal maps but Tiled can leave it set, so it
// is always cleared.
export const ROTATE_HEX = 0x10000000;
const GID_MASK = 0x0fffffff;

export interface DecodedGid {
  gid: number;
  h: boolean;
  v: boolean;
  d: boolean;
}

export function decodeGid(raw: number): DecodedGid {
  const value = raw >>> 0;
  return {
    gid: value & GID_MASK,
    h: (value & FLIP_H) !== 0,
    v: (value & FLIP_V) !== 0,
    d: (value & FLIP_D) !== 0,
  };
}

export function encodeGid({ gid, h, v, d }: DecodedGid): number {
  // >>> 0 keeps the result unsigned: JS bitwise operators produce signed int32.
  return ((gid & GID_MASK) | (h ? FLIP_H : 0) | (v ? FLIP_V : 0) | (d ? FLIP_D : 0)) >>> 0;
}

export function tileCountKnown(ts: TiledMapTileset): number | undefined {
  if (isExternalTileset(ts)) return undefined;
  if (ts.image === undefined && ts.tiles !== undefined) {
    return ts.tiles.reduce((max, t) => Math.max(max, t.id + 1), 0);
  }
  return ts.tilecount;
}

export interface GidLookup {
  tileset: TiledMapTileset;
  localId: number;
}

// The owning tileset is the one with the largest firstgid <= gid. Returns undefined for an
// empty cell, or for a gid past the end of an embedded tileset.
export function tilesetForGid(tilesets: readonly TiledMapTileset[], gid: number): GidLookup | undefined {
  if (gid <= 0) return undefined;
  let owner: TiledMapTileset | undefined;
  for (const ts of tilesets) {
    if (ts.firstgid <= gid && (owner === undefined || ts.firstgid > owner.firstgid)) owner = ts;
  }
  if (owner === undefined) return undefined;
  const localId = gid - owner.firstgid;
  const count = tileCountKnown(owner);
  if (count !== undefined && localId >= count) return undefined;
  return { tileset: owner, localId };
}
