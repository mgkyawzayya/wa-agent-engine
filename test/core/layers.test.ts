import { deflateSync, gzipSync, zstdCompressSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import {
  ensureStandardLayers,
  readTileData,
  resolveRole,
  tryResolveRole,
  writeTileData,
  type LayerRole,
} from '../../src/core/layers.js';
import { createEmptyMap, readMap } from '../../src/core/map-io.js';
import { setProperty, type TiledLayer, type TiledMap, type TiledTileLayer } from '../../src/schemas/tiled.schema.js';
import { cachedMapPath } from '../helpers/project.js';

const officeMap = async (): Promise<TiledMap> => (await readMap(cachedMapPath('office.tmj'))).map;

const topNames = (map: TiledMap): string[] => map.layers.map((l) => l.name);
const tree = (layers: TiledLayer[]): unknown[] =>
  layers.map((l) => (l.type === 'group' ? { [l.name]: tree(l.layers) } : `${l.name}:${l.type}`));

describe('resolveRole on WA office.tmj', () => {
  test('every role resolves to a concrete layer', async () => {
    const map = await officeMap();
    const expected: Partial<Record<LayerRole, string>> = {
      start: 'start',
      collisions: 'collisions',
      floor: 'floor/floor1',
      walls: 'walls/walls1',
      furniture1: 'furniture/furniture1',
      furniture2: 'furniture/furniture2',
      furniture3: 'furniture/furniture3',
      foreground1: 'above/above1',
      foreground2: 'above/above2',
      floorLayer: 'floorLayer',
    };
    for (const [role, path] of Object.entries(expected)) {
      const found = resolveRole(map, role as LayerRole);
      expect(found.path).toBe(path);
      expect(found.layer.type).not.toBe('group');
    }
    expect(() => resolveRole(map, 'zones')).toThrow(expect.objectContaining({ code: 'LAYER_ROLE_UNRESOLVED' }));
  });

  test('an override pointing at a group is rejected', async () => {
    const map = await officeMap();
    setProperty(map, 'wa-agent-engine:layers', 'string', JSON.stringify({ floor: 'floor' }));
    expect(() => resolveRole(map, 'floor')).toThrow(expect.objectContaining({ code: 'LAYER_IS_GROUP' }));
  });

  test('an override can point a role at another layer', async () => {
    const map = await officeMap();
    setProperty(map, 'wa-agent-engine:layers', 'string', JSON.stringify({ floor: 'floor/floor2' }));
    expect(resolveRole(map, 'floor').path).toBe('floor/floor2');
  });
});

describe('ensureStandardLayers', () => {
  test('on office.tmj creates only wa_zones and no second foreground group', async () => {
    const map = await officeMap();
    const before = JSON.stringify(map.layers);
    const nextId = map.nextlayerid!;
    expect(ensureStandardLayers(map)).toEqual(['zones']);
    expect(topNames(map)).toEqual(['start', 'collisions', 'floor', 'walls', 'furniture', 'floorLayer', 'above', 'wa_zones']);
    expect(JSON.stringify(map.layers.slice(0, -1))).toBe(before);
    expect(map.layers.at(-1)).toMatchObject({ id: nextId, type: 'objectgroup', objects: [] });
    expect(map.nextlayerid).toBe(nextId + 1);
  });

  test('on an empty map creates the contract order', () => {
    const map = createEmptyMap(5, 4);
    ensureStandardLayers(map);
    expect(tree(map.layers)).toEqual([
      'start:tilelayer',
      'collisions:tilelayer',
      'floor:tilelayer',
      'walls:tilelayer',
      { furniture: ['furniture1:tilelayer', 'furniture2:tilelayer', 'furniture3:tilelayer'] },
      'floorLayer:objectgroup',
      { foreground: ['foreground1:tilelayer', 'foreground2:tilelayer'] },
      'wa_zones:objectgroup',
    ]);
    const ids = JSON.stringify(map.layers).match(/"id":\d+/g);
    expect(new Set(ids).size).toBe(ids?.length);
    expect((map.layers[0] as TiledTileLayer).data).toHaveLength(20);
    expect(ensureStandardLayers(map)).toEqual([]);
  });

  test('fills gaps in place without reordering', () => {
    const map = createEmptyMap(3, 3);
    ensureStandardLayers(map);
    map.layers = map.layers.filter((l) => l.name !== 'collisions' && l.name !== 'walls');
    const furniture = map.layers.find((l) => l.name === 'furniture');
    if (furniture?.type === 'group') furniture.layers.splice(1, 1);
    expect(ensureStandardLayers(map).sort()).toEqual(['collisions', 'furniture2', 'walls']);
    expect(tree(map.layers)).toEqual([
      'start:tilelayer',
      'collisions:tilelayer',
      'floor:tilelayer',
      'walls:tilelayer',
      { furniture: ['furniture1:tilelayer', 'furniture2:tilelayer', 'furniture3:tilelayer'] },
      'floorLayer:objectgroup',
      { foreground: ['foreground1:tilelayer', 'foreground2:tilelayer'] },
      'wa_zones:objectgroup',
    ]);
  });
});

describe('ensureStandardLayers on unusual maps', () => {
  const flatTile = (map: TiledMap, name: string): TiledTileLayer => ({
    data: new Array<number>(map.width * map.height).fill(0),
    height: map.height,
    id: map.nextlayerid!++,
    name,
    opacity: 1,
    type: 'tilelayer',
    visible: true,
    width: map.width,
    x: 0,
    y: 0,
  });

  test('a flat furniture and above layout gets flat sub-layers and stays idempotent', () => {
    const map = createEmptyMap(4, 4);
    map.layers = ['floor', 'walls', 'furniture'].map((n) => flatTile(map, n));
    map.layers.push({ draworder: 'topdown', id: map.nextlayerid!++, name: 'floorLayer', objects: [], opacity: 1, type: 'objectgroup', visible: true, x: 0, y: 0 });
    map.layers.push(flatTile(map, 'above'));
    ensureStandardLayers(map);
    expect(topNames(map)).toEqual([
      'start', 'collisions', 'floor', 'walls', 'furniture', 'furniture2', 'furniture3',
      'floorLayer', 'above', 'above2', 'wa_zones',
    ]);
    expect(resolveRole(map, 'furniture1').path).toBe('furniture');
    expect(resolveRole(map, 'foreground1').path).toBe('above');
    const snapshot = JSON.stringify(map);
    expect(ensureStandardLayers(map)).toEqual([]);
    expect(JSON.stringify(map)).toBe(snapshot);
  });

  test('an empty group gets its first sub-layer instead of a duplicate name', () => {
    const map = createEmptyMap(3, 3);
    map.layers = [{ id: map.nextlayerid!++, layers: [], name: 'floor', opacity: 1, type: 'group', visible: true, x: 0, y: 0 }];
    ensureStandardLayers(map);
    expect(resolveRole(map, 'floor').path).toBe('floor/floor1');
    expect(map.layers.filter((l) => l.name === 'floor')).toHaveLength(1);
    expect(topNames(map)).toEqual(['start', 'collisions', 'floor', 'walls', 'furniture', 'floorLayer', 'foreground', 'wa_zones']);
    expect(ensureStandardLayers(map)).toEqual([]);
  });

  test('a group with only higher sub-layers never lets two roles share one layer', () => {
    const map = createEmptyMap(3, 3);
    map.layers = [
      { id: map.nextlayerid!++, layers: [flatTile(map, 'furniture2'), flatTile(map, 'furniture3')], name: 'furniture', opacity: 1, type: 'group', visible: true, x: 0, y: 0 },
    ];
    expect(tryResolveRole(map, 'furniture1')).toBeUndefined();
    ensureStandardLayers(map);
    const paths = (['furniture1', 'furniture2', 'furniture3'] as const).map((r) => resolveRole(map, r).path);
    expect(paths).toEqual(['furniture/furniture1', 'furniture/furniture2', 'furniture/furniture3']);
  });

  test('flat sub-layers are inserted in numeric order', () => {
    const map = createEmptyMap(3, 3);
    map.layers = [flatTile(map, 'furniture2')];
    ensureStandardLayers(map);
    const names = topNames(map);
    expect(names.indexOf('furniture1')).toBeLessThan(names.indexOf('furniture2'));
    expect(names.indexOf('furniture2')).toBeLessThan(names.indexOf('furniture3'));
  });

  test('a layer with a role name but the wrong type is reported, not duplicated', () => {
    const map = createEmptyMap(3, 3);
    map.layers = [flatTile(map, 'wa_zones')];
    expect(() => ensureStandardLayers(map)).toThrow(expect.objectContaining({ code: 'LAYER_WRONG_TYPE' }));
    expect(map.layers.filter((l) => l.name === 'wa_zones')).toHaveLength(1);
  });

  test('a floorLayer inside a group is reported, since WA needs it top-level', () => {
    const map = createEmptyMap(3, 3);
    map.layers = [
      {
        id: map.nextlayerid!++,
        layers: [{ draworder: 'topdown', id: map.nextlayerid!++, name: 'floorLayer', objects: [], opacity: 1, type: 'objectgroup', visible: true, x: 0, y: 0 }],
        name: 'objects',
        opacity: 1,
        type: 'group',
        visible: true,
        x: 0,
        y: 0,
      },
    ];
    expect(() => ensureStandardLayers(map)).toThrow(expect.objectContaining({ code: 'LAYER_ROLE_UNRESOLVED' }));
  });
});

describe('tile data', () => {
  test.each(['zlib', 'gzip', 'zstd'] as const)('a %s payload that expands past the layer size is refused', (compression) => {
    const huge = Buffer.alloc(64 * 1024 * 1024);
    const packed = { zlib: deflateSync, gzip: gzipSync, zstd: zstdCompressSync }[compression](huge);
    const layer: TiledTileLayer = {
      id: 1, name: 'bomb', type: 'tilelayer', width: 2, height: 2, data: packed.toString('base64'), encoding: 'base64', compression,
    };
    expect(() => readTileData(layer)).toThrow(
      expect.objectContaining({ code: 'LAYER_DATA_UNSUPPORTED', message: expect.stringContaining('decompress') }),
    );
  });

  test('layer sizes over the cap are refused before allocating', () => {
    const layer: TiledTileLayer = { id: 1, name: 'wide', type: 'tilelayer', width: 100_000, height: 100_000, data: [] };
    expect(() => readTileData(layer)).toThrow(expect.objectContaining({ code: 'LAYER_DATA_UNSUPPORTED' }));
  });

  test.each([undefined, 'zlib', 'gzip', 'zstd'])('base64 data with compression %s round-trips', (compression) => {
    const layer: TiledTileLayer = {
      id: 1,
      name: 'l',
      type: 'tilelayer',
      width: 2,
      height: 2,
      data: '',
      encoding: 'base64',
      ...(compression === undefined ? {} : { compression }),
    };
    const gids = Uint32Array.from([0, 3, 0x80000001, 0xe0000007]);
    writeTileData(layer, gids);
    expect(typeof layer.data).toBe('string');
    expect(Array.from(readTileData(layer))).toEqual(Array.from(gids));
  });

  test('array data stays an array and keeps flip bits unsigned', () => {
    const layer: TiledTileLayer = { id: 1, name: 'l', type: 'tilelayer', width: 2, height: 1, data: [0, 0] };
    writeTileData(layer, Uint32Array.from([0x80000001, 5]));
    expect(layer.data).toEqual([2147483649, 5]);
  });
});
