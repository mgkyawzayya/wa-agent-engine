import * as z from 'zod';
import { PREFAB_CATEGORIES, PREFAB_FACE_ROWS, PREFAB_PLACEMENTS } from './prefab.schema.js';

// set.json: everything the compiler needs to draw with one bring-your-own asset set.
// Tile ids are local ids inside the named tileset; the set ships no images.

const int = z.number().int();
const tileId = int.min(0);
const relPath = z
  .string()
  .min(1)
  .refine((p) => !/^([\\/]|[A-Za-z]:)/.test(p) && !p.split(/[\\/]/).includes('..'), {
    message: 'must be a relative path without ".."',
  });

export const AssetSetIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'asset set ids are lowercase letters, digits and "-"');

export const TileRefSchema = z.strictObject({ tileset: z.string().min(1), tile: tileId });
export type TileRef = z.infer<typeof TileRefSchema>;

// Face tiles for one row: plain middle, open on the west, open on the east, open on both.
const FaceRowSchema = z.strictObject({ mid: tileId, openW: tileId, openE: tileId, openWE: tileId });
export type FaceRow = z.infer<typeof FaceRowSchema>;

export const FaceStyleSchema = z.strictObject({ row1: FaceRowSchema, row2: FaceRowSchema });
export type FaceStyle = z.infer<typeof FaceStyleSchema>;

const TilesetEntrySchema = z.strictObject({
  name: z.string().min(1),
  tsj: relPath.describe('Path of the .tsj file, relative to set.json'),
  image: relPath.describe('Path of the tileset image, relative to the user project root'),
  tilesetCopyright: z.string().min(1),
});

export const PREFAB_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const PrefabEntrySchema = z.strictObject({
  id: z.string().regex(PREFAB_ID_PATTERN),
  path: relPath.describe('Path of the prefab .tmj, relative to set.json'),
  width: int.min(1),
  height: int.min(1),
  category: z.enum(PREFAB_CATEGORIES),
  placement: z.enum(PREFAB_PLACEMENTS),
  faceRow: z.enum(PREFAB_FACE_ROWS).exactOptional(),
  use: z.string().min(1),
  license: z.string().min(1).exactOptional(),
});
export type PrefabEntry = z.infer<typeof PrefabEntrySchema>;

export const AssetSetSchema = z
  .strictObject({
    id: AssetSetIdSchema,
    title: z.string().min(1),
    starterKitSha: z.string().regex(/^[0-9a-f]{40}$/).exactOptional(),
    mapCopyright: z.string().min(1).exactOptional(),
    tilesets: z.array(TilesetEntrySchema).min(1),
    wallTerrain: z.strictObject({
      tileset: z.string().min(1),
      wangset: z.string().min(1),
      wallColor: int.min(1),
      doorColor: int.min(1),
      isolatedWallTile: tileId,
    }),
    // Lintel tiles drawn over door cells on foreground1. Order does not matter: the autotiler
    // picks the lintel through the wall lookup; this list marks them as walkable.
    doorLintelTiles: z.array(tileId).min(1),
    faceRules: z.strictObject({
      tileset: z.string().min(1),
      // Faces are exactly 2 rows tall (art audit), matching row1/row2 of each style.
      height: z.literal(2),
      exteriorStyle: z.string().min(1),
      styles: z.record(z.string(), FaceStyleSchema),
    }),
    wallStyles: z.strictObject({ default: z.string().min(1), names: z.array(z.string().min(1)).min(1) }),
    floorStyles: z.strictObject({ default: z.string().min(1), styles: z.record(z.string(), TileRefSchema) }),
    collisionTile: TileRefSchema,
    startTile: TileRefSchema,
    prefabs: z.array(PrefabEntrySchema),
  })
  .superRefine((set, ctx) => {
    const tilesets = new Set(set.tilesets.map((t) => t.name));
    const needTileset = (name: string, path: (string | number)[]): void => {
      if (!tilesets.has(name)) ctx.addIssue({ code: 'custom', path, message: `unknown tileset "${name}"` });
    };
    needTileset(set.wallTerrain.tileset, ['wallTerrain', 'tileset']);
    needTileset(set.faceRules.tileset, ['faceRules', 'tileset']);
    needTileset(set.collisionTile.tileset, ['collisionTile', 'tileset']);
    needTileset(set.startTile.tileset, ['startTile', 'tileset']);
    for (const [name, ref] of Object.entries(set.floorStyles.styles)) {
      needTileset(ref.tileset, ['floorStyles', 'styles', name, 'tileset']);
    }
    const faceStyles = Object.keys(set.faceRules.styles);
    for (const name of [...set.wallStyles.names, set.faceRules.exteriorStyle]) {
      if (!faceStyles.includes(name)) {
        ctx.addIssue({ code: 'custom', path: ['faceRules', 'styles'], message: `missing face style "${name}"` });
      }
    }
    if (!set.wallStyles.names.includes(set.wallStyles.default)) {
      ctx.addIssue({ code: 'custom', path: ['wallStyles', 'default'], message: 'default must be one of names' });
    }
    if (!Object.hasOwn(set.floorStyles.styles, set.floorStyles.default)) {
      ctx.addIssue({ code: 'custom', path: ['floorStyles', 'default'], message: 'default must be a defined style' });
    }
    const names = new Set<string>();
    set.tilesets.forEach((t, i) => {
      if (names.has(t.name)) ctx.addIssue({ code: 'custom', path: ['tilesets', i, 'name'], message: `duplicate tileset "${t.name}"` });
      names.add(t.name);
    });
    set.prefabs.forEach((p, i) => {
      if ((p.placement === 'north-wall') !== (p.faceRow !== undefined)) {
        ctx.addIssue({ code: 'custom', path: ['prefabs', i, 'faceRow'], message: 'faceRow is required for north-wall prefabs and only for them' });
      }
    });
    const ids = new Set<string>();
    set.prefabs.forEach((p, i) => {
      if (ids.has(p.id)) ctx.addIssue({ code: 'custom', path: ['prefabs', i, 'id'], message: `duplicate prefab "${p.id}"` });
      ids.add(p.id);
    });
  });

export type AssetSet = z.infer<typeof AssetSetSchema>;

// A set that extends another: it adds tilesets and prefabs (furniture, for example) to the base
// set and takes everything else from it: walls, faces, floors, collision and start tiles. The
// base must be a full set, not another extending one.
export const ExtendingAssetSetSchema = z
  .strictObject({
    id: AssetSetIdSchema,
    title: z.string().min(1),
    extends: AssetSetIdSchema.describe('The id of the set this one adds to, for example "wa-starter-office"'),
    mapCopyright: z.string().min(1).exactOptional(),
    tilesets: z.array(TilesetEntrySchema).min(1),
    prefabs: z.array(PrefabEntrySchema),
  })
  .superRefine((set, ctx) => {
    if (set.extends === set.id) ctx.addIssue({ code: 'custom', path: ['extends'], message: 'a set cannot extend itself' });
    set.prefabs.forEach((p, i) => {
      if (p.placement === 'north-wall' && p.faceRow === undefined) {
        ctx.addIssue({ code: 'custom', path: ['prefabs', i, 'faceRow'], message: 'faceRow is required for north-wall prefabs' });
      }
    });
  });
export type ExtendingAssetSet = z.infer<typeof ExtendingAssetSetSchema>;
