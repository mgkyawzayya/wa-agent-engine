import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
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

// Writes a one-rule rules file into a project with an engine map: the start tile on the
// "start" layer gets the same tile on a new "marks" layer. The rule map embeds the map's own
// WA_Special_Zones tileset, so its tiles match the map's.
export async function writeStartRule(projectDir: string, mapPath: string, rulesDir: string): Promise<void> {
  const mapAbs = join(projectDir, mapPath);
  const map = JSON.parse(await readFile(mapAbs, 'utf8')) as TiledMap;
  const zones = map.tilesets.find((t) => !isExternalTileset(t) && (t as { name: string }).name === 'WA_Special_Zones') as Record<string, unknown> & { image: string };
  const dir = join(projectDir, rulesDir);
  await mkdir(dir, { recursive: true });
  const image = relative(dir, resolve(dirname(mapAbs), zones.image)).split('\\').join('/');
  const startGid = 1 + 1; // WA_Special_Zones tile 1 is the start tile; firstgid 1 in the rule map
  const layer = (id: number, name: string) => ({ id, name, type: 'tilelayer', width: 1, height: 1, x: 0, y: 0, opacity: 1, visible: true, data: [startGid] });
  const rule = {
    type: 'map', version: '1.11', orientation: 'orthogonal', renderorder: 'right-down', width: 1, height: 1, tilewidth: 32, tileheight: 32,
    infinite: false, nextlayerid: 3, nextobjectid: 1, layers: [layer(1, 'input_start'), layer(2, 'output_marks')],
    tilesets: [{ ...zones, firstgid: 1, image }],
  };
  await writeFile(join(dir, 'start-marks.tmj'), JSON.stringify(rule));
  await writeFile(join(dir, 'rules.txt'), 'start-marks.tmj\n');
}
