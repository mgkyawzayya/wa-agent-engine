import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forEachTileLayer, readTileData } from '../../src/core/layers.js';
import { isExternalTileset, type TiledMap } from '../../src/schemas/tiled.schema.js';

// Shared by the automapping tests: the fixture folder and a gid-independent view of a map.

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'automap');

// Each tile layer as cells "image#localId|flags" ('' when empty), so maps compare by tile
// identity rather than by gid numbering.
export function describeMap(map: TiledMap, mapAbs: string): { layers: string[]; cells: Record<string, string[]>; properties: Record<string, Record<string, unknown>> } {
  // Embedded tilesets are named by their image, external ones by their file.
  const tilesets = map.tilesets
    .map((t) => ({ firstgid: t.firstgid, image: resolve(dirname(mapAbs), isExternalTileset(t) ? t.source : (t as { image: string }).image) }))
    .sort((a, b) => a.firstgid - b.firstgid);
  const layers: string[] = [];
  const cells: Record<string, string[]> = {};
  const properties: Record<string, Record<string, unknown>> = {};
  forEachTileLayer(map.layers, (layer) => {
    layers.push(layer.name);
    cells[layer.name] = Array.from(readTileData(layer), (raw) => {
      const gid = raw & 0x0fffffff;
      if (gid === 0) return '';
      const owner = tilesets.filter((t) => t.firstgid <= gid).pop()!;
      return `${owner.image.split('/').pop()}#${gid - owner.firstgid}|${(raw >>> 28).toString(16)}`;
    });
    properties[layer.name] = Object.fromEntries((layer.properties ?? []).map((p) => [p.name, p.value]));
  });
  return { layers, cells, properties };
}
