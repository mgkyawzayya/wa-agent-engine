import * as z from 'zod';
import {
  TiledMapTilesetSchema,
  TiledPropertySchema,
  type TiledMapTileset,
  type TiledProperty,
} from './tiled.schema.js';

// Prefab .tmj files: small finite Tiled maps whose layers name the furniture and foreground
// sub-layers they stamp into, plus a `collisions` layer (any non-zero cell collides).

export const PREFAB_LAYER_NAMES = [
  'furniture1',
  'furniture2',
  'furniture3',
  'foreground1',
  'foreground2',
  'collisions',
] as const;
export type PrefabLayerName = (typeof PREFAB_LAYER_NAMES)[number];

export const PREFAB_CATEGORIES = ['talks', 'work', 'social', 'logistics', 'fun', 'phone'] as const;
export type PrefabCategory = (typeof PREFAB_CATEGORIES)[number];

export const PREFAB_PLACEMENTS = ['free', 'north-wall'] as const;
export type PrefabPlacement = (typeof PREFAB_PLACEMENTS)[number];

// Which wall-face row a north-wall prefab's top row sits on: the upper row directly under the
// wall top, the lower one, or either.
export const PREFAB_FACE_ROWS = ['upper', 'lower', 'either'] as const;
export type PrefabFaceRow = (typeof PREFAB_FACE_ROWS)[number];

export interface PrefabLayer {
  type: 'tilelayer';
  name: PrefabLayerName;
  width: number;
  height: number;
  data: number[];
  [key: string]: unknown;
}

export interface PrefabMap {
  orientation: 'orthogonal';
  infinite?: false;
  width: number;
  height: number;
  tilewidth: 32;
  tileheight: 32;
  layers: PrefabLayer[];
  tilesets: TiledMapTileset[];
  properties?: TiledProperty[];
  [key: string]: unknown;
}

const int = z.number().int();

const PrefabLayerSchema: z.ZodType<PrefabLayer> = z.looseObject({
  type: z.literal('tilelayer'),
  name: z.enum(PREFAB_LAYER_NAMES),
  width: int.min(1),
  height: int.min(1),
  data: z.array(int.min(0)),
});

export const PrefabMapSchema: z.ZodType<PrefabMap> = z
  .looseObject({
    orientation: z.literal('orthogonal'),
    infinite: z.literal(false).exactOptional(),
    width: int.min(1),
    height: int.min(1),
    tilewidth: z.literal(32),
    tileheight: z.literal(32),
    layers: z.array(PrefabLayerSchema).min(1),
    tilesets: z.array(TiledMapTilesetSchema),
    properties: z.array(TiledPropertySchema).exactOptional(),
  })
  .superRefine((prefab, ctx) => {
    const names = new Set<string>();
    prefab.layers.forEach((layer, i) => {
      if (names.has(layer.name)) {
        ctx.addIssue({ code: 'custom', path: ['layers', i, 'name'], message: `duplicate layer "${layer.name}"` });
      }
      names.add(layer.name);
      if (layer.width !== prefab.width || layer.height !== prefab.height) {
        ctx.addIssue({ code: 'custom', path: ['layers', i], message: 'layer size must equal the prefab size' });
      }
      if (layer.data.length !== layer.width * layer.height) {
        ctx.addIssue({ code: 'custom', path: ['layers', i, 'data'], message: 'data length must be width*height' });
      }
    });
  });

// The prefab's own map properties.
export const PrefabMetaSchema = z
  .strictObject({
    category: z.enum(PREFAB_CATEGORIES),
    placement: z.enum(PREFAB_PLACEMENTS),
    use: z.string().min(1),
    credit: z.string().min(1).exactOptional(),
    license: z.string().min(1).exactOptional(),
    faceRow: z.enum(PREFAB_FACE_ROWS).exactOptional(),
  })
  .refine((meta) => (meta.placement === 'north-wall') === (meta.faceRow !== undefined), {
    message: 'faceRow is required for north-wall prefabs and only for them',
    path: ['faceRow'],
  });
export type PrefabMeta = z.infer<typeof PrefabMetaSchema>;
