// One-off authoring helper: turns scripts/prefab-catalog.source.json into prefab .tmj files
// and the prefab list in set.json. After bootstrap the .tmj files are the source of truth
// and are edited in Tiled; rerun only to regenerate from the catalog on purpose.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { encodeGid } from '../src/core/gid.js';
import { NEW_MAP_TILED_VERSION, NEW_MAP_VERSION, serializeMap } from '../src/core/map-io.js';
import { AssetSetSchema } from '../src/schemas/asset-set.schema.js';
import {
  PREFAB_LAYER_NAMES,
  PrefabMapSchema,
  PrefabMetaSchema,
  type PrefabCategory,
  type PrefabFaceRow,
  type PrefabLayerName,
  type PrefabPlacement,
} from '../src/schemas/prefab.schema.js';
import { TiledTilesetFileSchema, type TiledMap } from '../src/schemas/tiled.schema.js';

const SET_DIR = fileURLToPath(new URL('../assets/sets/wa-starter-office/', import.meta.url));
const SOURCE = fileURLToPath(new URL('./prefab-catalog.source.json', import.meta.url));
const COLLISION = 'SZ:2';

interface SourceLayer {
  ts: string;
  rows: string[];
}

interface SourcePrefab {
  id: string;
  category: PrefabCategory;
  placement: PrefabPlacement;
  faceRow?: PrefabFaceRow;
  use: string;
  credit?: string;
  layers: Partial<Record<Exclude<PrefabLayerName, 'collisions'>, SourceLayer>>;
  collisions: string[];
}

interface Source {
  tilesetCodes: Record<string, string>;
  credits: Record<string, string>;
  // Licence of the adapted (credited) arrangements.
  license: string;
  prefabs: SourcePrefab[];
}

interface Cell {
  code: string;
  id: number;
  h: boolean;
}

function parseCell(raw: string, defaultCode: string, where: string): Cell | undefined {
  const text = raw.trim();
  if (text === '.') return undefined;
  const match = /^(?:([A-Z]{2}):)?(\d+)(h?)$/.exec(text);
  if (match === null) throw new Error(`${where}: bad cell "${raw}"`);
  return { code: match[1] ?? defaultCode, id: Number(match[2]), h: match[3] === 'h' };
}

async function main(): Promise<void> {
  const source = JSON.parse(await readFile(SOURCE, 'utf8')) as Source;
  const setPath = `${SET_DIR}set.json`;
  // The prefab list is regenerated below, so validate the rest of set.json without it.
  const set = AssetSetSchema.parse({ ...(JSON.parse(await readFile(setPath, 'utf8')) as object), prefabs: [] });
  const tileCounts = new Map<string, number>();
  for (const ts of set.tilesets) {
    const tsj = TiledTilesetFileSchema.parse(JSON.parse(await readFile(`${SET_DIR}${ts.tsj}`, 'utf8')));
    tileCounts.set(ts.name, tsj.tilecount);
  }
  const codeOrder = Object.keys(source.tilesetCodes);
  const entries: (typeof set.prefabs)[number][] = [];

  for (const prefab of source.prefabs) {
    const where = prefab.id;
    const layerCells = new Map<PrefabLayerName, (Cell | undefined)[][]>();
    let width = -1;
    let height = -1;
    for (const name of PREFAB_LAYER_NAMES) {
      if (name === 'collisions') continue;
      const layer = prefab.layers[name];
      if (layer === undefined) continue;
      const rows = layer.rows.map((row) => row.split(',').map((cell) => parseCell(cell, layer.ts, `${where}/${name}`)));
      height = height === -1 ? rows.length : height;
      width = width === -1 ? (rows[0]?.length ?? 0) : width;
      if (rows.length !== height || rows.some((r) => r.length !== width)) throw new Error(`${where}/${name}: ragged rows`);
      layerCells.set(name, rows);
    }
    if (`${prefab.id}`.match(/-(\d+)x(\d+)$/)?.slice(1).join('x') !== `${width}x${height}`) {
      throw new Error(`${where}: id suffix does not match the ${width}x${height} cells`);
    }
    if (prefab.collisions.length > 0) {
      const rows = Array.from({ length: height }, () => new Array<Cell | undefined>(width).fill(undefined));
      for (const at of prefab.collisions) {
        const [x, y] = at.split(',').map(Number) as [number, number];
        if (!(x >= 0 && x < width && y >= 0 && y < height)) throw new Error(`${where}: collision ${at} outside`);
        rows[y]![x] = parseCell(COLLISION, 'SZ', where);
      }
      layerCells.set('collisions', rows);
    }

    const usedCodes = new Set<string>();
    for (const rows of layerCells.values()) for (const row of rows) for (const cell of row) if (cell) usedCodes.add(cell.code);
    const firstGids = new Map<string, number>();
    const tilesets: { firstgid: number; source: string }[] = [];
    let next = 1;
    for (const code of codeOrder.filter((c) => usedCodes.has(c))) {
      const name = source.tilesetCodes[code]!;
      const count = tileCounts.get(name);
      if (count === undefined) throw new Error(`${where}: tileset ${name} is not in set.json`);
      firstGids.set(code, next);
      tilesets.push({ firstgid: next, source: `../tilesets/${name}.tsj` });
      next += count;
    }

    let layerId = 1;
    const order: PrefabLayerName[] = ['collisions', 'furniture1', 'furniture2', 'furniture3', 'foreground1', 'foreground2'];
    const layers = order
      .filter((name) => layerCells.has(name))
      .map((name) => ({
        data: layerCells.get(name)!.flat().map((cell) => {
          if (cell === undefined) return 0;
          const count = tileCounts.get(source.tilesetCodes[cell.code]!)!;
          if (cell.id >= count) throw new Error(`${where}/${name}: ${cell.code}:${cell.id} is past the tileset end`);
          return encodeGid({ gid: firstGids.get(cell.code)! + cell.id, h: cell.h, v: false, d: false });
        }),
        height,
        id: layerId++,
        name,
        opacity: 1,
        type: 'tilelayer',
        visible: true,
        width,
        x: 0,
        y: 0,
      }));

    const credit = prefab.credit === undefined ? undefined : source.credits[prefab.credit];
    if (prefab.credit !== undefined && credit === undefined) throw new Error(`${where}: unknown credit ${prefab.credit}`);
    const license = credit === undefined ? undefined : source.license;
    const properties = [
      { name: 'category', type: 'string', value: prefab.category },
      ...(credit === undefined ? [] : [{ name: 'credit', type: 'string', value: credit }]),
      ...(prefab.faceRow === undefined ? [] : [{ name: 'faceRow', type: 'string', value: prefab.faceRow }]),
      ...(license === undefined ? [] : [{ name: 'license', type: 'string', value: license }]),
      { name: 'placement', type: 'string', value: prefab.placement },
      { name: 'use', type: 'string', value: prefab.use },
    ];
    const map = {
      compressionlevel: -1,
      height,
      infinite: false,
      layers,
      nextlayerid: layerId,
      nextobjectid: 1,
      orientation: 'orthogonal',
      properties,
      renderorder: 'right-down',
      tiledversion: NEW_MAP_TILED_VERSION,
      tileheight: 32,
      tilesets,
      tilewidth: 32,
      type: 'map',
      version: NEW_MAP_VERSION,
      width,
    };
    PrefabMapSchema.parse(map);
    PrefabMetaSchema.parse(Object.fromEntries(properties.map((p) => [p.name, p.value])));
    await writeFile(`${SET_DIR}prefabs/${prefab.id}.tmj`, `${serializeMap(map as unknown as TiledMap)}\n`);
    entries.push({
      id: prefab.id,
      path: `prefabs/${prefab.id}.tmj`,
      width,
      height,
      category: prefab.category,
      placement: prefab.placement,
      ...(prefab.faceRow === undefined ? {} : { faceRow: prefab.faceRow }),
      use: prefab.use,
      ...(license === undefined ? {} : { license }),
    });
  }

  const updated = AssetSetSchema.parse({ ...set, prefabs: entries });
  await writeFile(setPath, `${JSON.stringify(updated, null, 2)}\n`);
  console.log(`wrote ${entries.length} prefabs and updated set.json`);
}

await main();
