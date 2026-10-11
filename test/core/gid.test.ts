import { describe, expect, test } from 'vitest';
import { decodeGid, encodeGid, FLIP_D, FLIP_H, FLIP_V, ROTATE_HEX, tilesetForGid } from '../../src/core/gid.js';
import type { TiledMapTileset } from '../../src/schemas/tiled.schema.js';

describe('gid flags', () => {
  test('all 8 flip combinations round-trip', () => {
    for (const h of [false, true]) {
      for (const v of [false, true]) {
        for (const d of [false, true]) {
          const raw = encodeGid({ gid: 375, h, v, d });
          expect(raw).toBeGreaterThanOrEqual(0);
          expect(decodeGid(raw)).toEqual({ gid: 375, h, v, d });
        }
      }
    }
  });

  test('matches Tiled bit values and clears the hex-rotation bit', () => {
    expect(encodeGid({ gid: 1, h: true, v: false, d: false })).toBe(0x80000001);
    expect(decodeGid((FLIP_V | FLIP_D | 7) >>> 0)).toEqual({ gid: 7, h: false, v: true, d: true });
    const withHex = (ROTATE_HEX | FLIP_H | 42) >>> 0;
    expect(decodeGid(withHex)).toEqual({ gid: 42, h: true, v: false, d: false });
    expect(encodeGid(decodeGid(withHex)) & ROTATE_HEX).toBe(0);
  });

  test('accepts negative int32 values as unsigned', () => {
    expect(decodeGid(0x80000005 | 0).gid).toBe(5);
  });
});

describe('tilesetForGid', () => {
  const tilesets: TiledMapTileset[] = [
    { firstgid: 1, name: 'A', tilewidth: 32, tileheight: 32, tilecount: 12, columns: 6, image: 'a.png' },
    { firstgid: 13, name: 'B', tilewidth: 32, tileheight: 32, tilecount: 96, columns: 12, image: 'b.png' },
  ];

  test('finds the owner with the largest firstgid <= gid', () => {
    expect(tilesetForGid(tilesets, 3)).toMatchObject({ localId: 2, tileset: { name: 'A' } });
    expect(tilesetForGid(tilesets, 13)).toMatchObject({ localId: 0, tileset: { name: 'B' } });
  });

  test('rejects empty cells and gids past the last tile', () => {
    expect(tilesetForGid(tilesets, 0)).toBeUndefined();
    expect(tilesetForGid(tilesets, 13 + 96)).toBeUndefined();
  });
});
