import * as z from 'zod';

// Loose schemas for Tiled 1.12 JSON. Every object keeps unknown keys, and the engine
// validates with these but mutates the original parsed JSON, so key order and any field
// Tiled writes survive a round-trip untouched.

export interface TiledProperty {
  name: string;
  type?: string;
  propertytype?: string;
  value?: unknown;
  [key: string]: unknown;
}

interface LayerBase {
  id: number;
  name: string;
  type: string;
  opacity?: number;
  visible?: boolean;
  properties?: TiledProperty[];
  [key: string]: unknown;
}

export interface TiledTileLayer extends LayerBase {
  type: 'tilelayer';
  width: number;
  height: number;
  data?: number[] | string;
  encoding?: string;
  compression?: string;
  chunks?: unknown[];
}

export interface TiledObject {
  id: number;
  name?: string;
  type?: string;
  class?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  gid?: number;
  properties?: TiledProperty[];
  [key: string]: unknown;
}

export interface TiledObjectGroup extends LayerBase {
  type: 'objectgroup';
  objects: TiledObject[];
}

export interface TiledImageLayer extends LayerBase {
  type: 'imagelayer';
}

export interface TiledGroupLayer extends LayerBase {
  type: 'group';
  layers: TiledLayer[];
}

export type TiledLayer = TiledTileLayer | TiledObjectGroup | TiledImageLayer | TiledGroupLayer;

export interface TiledWangSet {
  name: string;
  type: string;
  tile?: number;
  colors?: { name: string; color?: string; tile?: number; probability?: number; [key: string]: unknown }[];
  wangtiles: { tileid: number; wangid: number[]; [key: string]: unknown }[];
  [key: string]: unknown;
}

export interface TiledTile {
  id: number;
  properties?: TiledProperty[];
  image?: string;
  [key: string]: unknown;
}

// A tileset's own fields, shared by embedded tilesets and standalone .tsj files.
export interface TiledTilesetFields {
  name: string;
  tilewidth: number;
  tileheight: number;
  tilecount: number;
  columns: number;
  image?: string;
  imagewidth?: number;
  imageheight?: number;
  margin?: number;
  spacing?: number;
  tiles?: TiledTile[];
  wangsets?: TiledWangSet[];
  properties?: TiledProperty[];
  [key: string]: unknown;
}

export interface TiledEmbeddedTileset extends TiledTilesetFields {
  firstgid: number;
}

export interface TiledExternalTilesetRef {
  firstgid: number;
  source: string;
  [key: string]: unknown;
}

export type TiledMapTileset = TiledEmbeddedTileset | TiledExternalTilesetRef;

export interface TiledTilesetFile extends TiledTilesetFields {
  type?: string;
  version?: string | number;
  tiledversion?: string;
}

export interface TiledMap {
  type?: string;
  version?: string | number;
  tiledversion?: string;
  orientation: string;
  renderorder?: string;
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  infinite?: boolean;
  nextlayerid?: number;
  nextobjectid?: number;
  layers: TiledLayer[];
  tilesets: TiledMapTileset[];
  properties?: TiledProperty[];
  [key: string]: unknown;
}

const int = z.number().int();

export const TiledPropertySchema: z.ZodType<TiledProperty> = z.looseObject({
  name: z.string(),
  type: z.string().exactOptional(),
  propertytype: z.string().exactOptional(),
  value: z.unknown().exactOptional(),
});

const layerBase = {
  id: int,
  name: z.string(),
  opacity: z.number().exactOptional(),
  visible: z.boolean().exactOptional(),
  properties: z.array(TiledPropertySchema).exactOptional(),
};

export const TiledObjectSchema: z.ZodType<TiledObject> = z.looseObject({
  id: int,
  name: z.string().exactOptional(),
  type: z.string().exactOptional(),
  class: z.string().exactOptional(),
  x: z.number(),
  y: z.number(),
  width: z.number().exactOptional(),
  height: z.number().exactOptional(),
  gid: z.number().exactOptional(),
  properties: z.array(TiledPropertySchema).exactOptional(),
});

const TileLayerSchema: z.ZodType<TiledTileLayer> = z.looseObject({
  ...layerBase,
  type: z.literal('tilelayer'),
  width: int,
  height: int,
  data: z.union([z.array(z.number()), z.string()]).exactOptional(),
  encoding: z.string().exactOptional(),
  compression: z.string().exactOptional(),
  chunks: z.array(z.unknown()).exactOptional(),
});

const ObjectGroupSchema: z.ZodType<TiledObjectGroup> = z.looseObject({
  ...layerBase,
  type: z.literal('objectgroup'),
  objects: z.array(TiledObjectSchema),
});

const ImageLayerSchema: z.ZodType<TiledImageLayer> = z.looseObject({
  ...layerBase,
  type: z.literal('imagelayer'),
});

const GroupLayerSchema: z.ZodType<TiledGroupLayer> = z.looseObject({
  ...layerBase,
  type: z.literal('group'),
  get layers(): z.ZodArray<z.ZodType<TiledLayer>> {
    return z.array(TiledLayerSchema);
  },
});

export const TiledLayerSchema: z.ZodType<TiledLayer> = z.union([
  TileLayerSchema,
  ObjectGroupSchema,
  ImageLayerSchema,
  GroupLayerSchema,
]);

const WangSetSchema: z.ZodType<TiledWangSet> = z.looseObject({
  name: z.string(),
  type: z.string(),
  tile: int.exactOptional(),
  colors: z
    .array(
      z.looseObject({
        name: z.string(),
        color: z.string().exactOptional(),
        tile: int.exactOptional(),
        probability: z.number().exactOptional(),
      }),
    )
    .exactOptional(),
  wangtiles: z.array(z.looseObject({ tileid: int, wangid: z.array(int).length(8) })),
});

const tilesetFields = {
  name: z.string(),
  tilewidth: int,
  tileheight: int,
  tilecount: int,
  columns: int,
  image: z.string().exactOptional(),
  imagewidth: int.exactOptional(),
  imageheight: int.exactOptional(),
  margin: int.exactOptional(),
  spacing: int.exactOptional(),
  tiles: z
    .array(
      z.looseObject({
        id: int,
        properties: z.array(TiledPropertySchema).exactOptional(),
        image: z.string().exactOptional(),
      }),
    )
    .exactOptional(),
  wangsets: z.array(WangSetSchema).exactOptional(),
  properties: z.array(TiledPropertySchema).exactOptional(),
};

export const TiledEmbeddedTilesetSchema: z.ZodType<TiledEmbeddedTileset> = z.looseObject({
  ...tilesetFields,
  firstgid: int.min(1),
});

export const TiledExternalTilesetRefSchema: z.ZodType<TiledExternalTilesetRef> = z.looseObject({
  firstgid: int.min(1),
  source: z.string(),
});

export const TiledMapTilesetSchema: z.ZodType<TiledMapTileset> = z.union([
  TiledExternalTilesetRefSchema,
  TiledEmbeddedTilesetSchema,
]);

export const TiledTilesetFileSchema: z.ZodType<TiledTilesetFile> = z.looseObject({
  ...tilesetFields,
  type: z.string().exactOptional(),
  version: z.union([z.string(), z.number()]).exactOptional(),
  tiledversion: z.string().exactOptional(),
});

export const TiledMapSchema: z.ZodType<TiledMap> = z.looseObject({
  type: z.string().exactOptional(),
  version: z.union([z.string(), z.number()]).exactOptional(),
  tiledversion: z.string().exactOptional(),
  orientation: z.string(),
  renderorder: z.string().exactOptional(),
  width: int.min(0),
  height: int.min(0),
  tilewidth: int.min(1),
  tileheight: int.min(1),
  infinite: z.boolean().exactOptional(),
  nextlayerid: int.exactOptional(),
  nextobjectid: int.exactOptional(),
  layers: z.array(TiledLayerSchema),
  tilesets: z.array(TiledMapTilesetSchema),
  properties: z.array(TiledPropertySchema).exactOptional(),
});

export function isExternalTileset(ts: TiledMapTileset): ts is TiledExternalTilesetRef {
  return typeof ts.source === 'string';
}

export function getProperty(owner: { properties?: TiledProperty[] }, name: string): TiledProperty | undefined {
  return owner.properties?.find((p) => p.name === name);
}

// Upserts a property, keeping Tiled's alphabetical order for new entries.
export function setProperty(
  owner: { properties?: TiledProperty[] },
  name: string,
  type: string,
  value: unknown,
): void {
  const props = (owner.properties ??= []);
  const existing = props.find((p) => p.name === name);
  if (existing !== undefined) {
    existing.type = type;
    existing.value = value;
    return;
  }
  const index = props.findIndex((p) => p.name > name);
  const prop: TiledProperty = { name, type, value };
  if (index === -1) props.push(prop);
  else props.splice(index, 0, prop);
}
