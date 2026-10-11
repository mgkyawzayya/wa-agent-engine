import { describe, expect, test } from 'vitest';
import { readMap, serializeMap } from '../../src/core/map-io.js';
import { writeTileData } from '../../src/core/layers.js';
import type { TiledMap, TiledTileLayer } from '../../src/schemas/tiled.schema.js';
import { meaningDifferences } from '../../scripts/lib/tiled-meaning.js';
import { cachedMapPath } from '../helpers/project.js';

// The comparison the Tiled round-trip check relies on: formatting and encoding never count,
// anything WorkAdventure would see does.

const conference = async (): Promise<TiledMap> => (await readMap(cachedMapPath('conference.tmj'))).map;

// The same value with every object's keys in reverse order.
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)]));
}

describe('map meaning', () => {
  test('key order, formatting and tile-data encoding do not change the meaning', async () => {
    const map = await conference();
    const encoded = structuredClone(map);
    const layer = encoded.layers.find((l): l is TiledTileLayer => l.type === 'tilelayer')!;
    const data = Uint32Array.from(layer.data as number[]);
    Object.assign(layer, { encoding: 'base64', compression: 'zlib', data: '' });
    writeTileData(layer, data);
    expect(meaningDifferences(map, structuredClone(map))).toEqual([]);
    expect(meaningDifferences(map, encoded)).toEqual([]);
    expect(meaningDifferences(map, reversed(JSON.parse(serializeMap(map))) as TiledMap)).toEqual([]);
  });

  test('a moved tile or a collides of the wrong type each count', async () => {
    const map = await conference();
    const tile = structuredClone(map);
    const layer = tile.layers.find((l): l is TiledTileLayer => l.type === 'tilelayer' && Array.isArray(l.data) && l.data.some((v) => v !== 0))!;
    const data = layer.data as number[];
    const i = data.findIndex((v) => v !== 0);
    [data[i], data[i + 1]] = [data[i + 1]!, data[i]!];
    expect(meaningDifferences(map, tile)).toEqual([`layer ${layer.name} tiles`]);

    const collides = structuredClone(map);
    type Tiles = { tiles?: { properties?: { name: string; type?: string }[] }[] };
    const hasCollides = (t: Tiles): boolean => (t.tiles ?? []).some((x) => (x.properties ?? []).some((p) => p.name === 'collides'));
    const ts = (collides.tilesets as Tiles[]).find(hasCollides)! as { tiles: { properties: { name: string; type?: string }[] }[] };
    ts.tiles.find((x) => x.properties.some((p) => p.name === 'collides'))!.properties.find((p) => p.name === 'collides')!.type = 'string';
    expect(meaningDifferences(map, collides)).toHaveLength(1);
    expect(meaningDifferences(map, collides)[0]).toMatch(/^tileset \d+ tiles$/);
  });
});
