import { readTileData } from '../../src/core/layers.js';
import type { TiledLayer, TiledMap, TiledProperty } from '../../src/schemas/tiled.schema.js';

// What a Tiled map means, independent of key order, tile-data encoding and formatting: two maps
// with equal meanings render and behave the same in WorkAdventure.

function flatten(layers: readonly TiledLayer[], prefix = ''): { path: string; layer: TiledLayer }[] {
  return layers.flatMap((l) => {
    const path = `${prefix}${l.name}`;
    return l.type === 'group' ? [{ path, layer: l }, ...flatten(l.layers, `${path}/`)] : [{ path, layer: l }];
  });
}

const props = (list: readonly TiledProperty[] | undefined): string =>
  JSON.stringify([...(list ?? [])].map((p) => [p.name, p.type ?? 'string', p.value]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));

export function mapMeaning(map: TiledMap): Map<string, string> {
  const out = new Map<string, string>();
  out.set('map', JSON.stringify([map.width, map.height, map.tilewidth, map.tileheight, map.orientation, map.infinite ?? false]));
  out.set('map properties', props(map.properties));
  map.tilesets.forEach((t, i) => {
    if ('source' in t && t.source !== undefined) {
      out.set(`tileset ${i}`, JSON.stringify([t.firstgid, t.source]));
      return;
    }
    out.set(`tileset ${i}`, JSON.stringify([t.firstgid, t.name, t.tilecount, t.image, t.tilewidth, t.tileheight]));
    out.set(`tileset ${i} properties`, props(t.properties as TiledProperty[] | undefined));
    // Per-tile properties, with their types: WA reads collisions from a bool "collides".
    const tiles = [...((t.tiles ?? []) as { id: number; properties?: TiledProperty[] }[])]
      .sort((a, b) => a.id - b.id)
      .map((tile) => [tile.id, props(tile.properties)]);
    out.set(`tileset ${i} tiles`, JSON.stringify(tiles));
  });
  for (const { path, layer } of flatten(map.layers)) {
    out.set(`layer ${path}`, JSON.stringify([layer.type, layer.visible ?? true, layer.opacity ?? 1]));
    out.set(`layer ${path} properties`, props(layer.properties));
    if (layer.type === 'tilelayer') out.set(`layer ${path} tiles`, Buffer.from(readTileData(layer).buffer).toString('base64'));
    if (layer.type === 'objectgroup') {
      for (const o of layer.objects) {
        out.set(`object ${path}#${o.id}`, JSON.stringify([o.name ?? '', o.type ?? o.class ?? '', o.x, o.y, o.width ?? 0, o.height ?? 0, o.point ?? false]));
        out.set(`object ${path}#${o.id} properties`, props(o.properties));
      }
    }
  }
  return out;
}

// The parts whose meaning differs between two maps.
export function meaningDifferences(a: TiledMap, b: TiledMap): string[] {
  const before = mapMeaning(a);
  const after = mapMeaning(b);
  return [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
}
