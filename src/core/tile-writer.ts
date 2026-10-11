import { readFile } from 'node:fs/promises';
import { isExternalTileset, setProperty, TiledTilesetFileSchema, type TiledMap, type TiledTileLayer } from '../schemas/tiled.schema.js';
import { resolveImages, type LoadedAssetSet } from './asset-set-registry.js';
import type { WriteRecorder } from './engine-state.js';
import { WaEngineError } from './errors.js';
import { decodeGid, encodeGid, tilesetForGid } from './gid.js';
import { readTileData, resolveRole, writeTileData, type TileRole } from './layers.js';
import { embedTileset } from './tileset-embed.js';

// Reads and writes tiles by layer role, decoding each layer once and writing it back on
// flush. Every write can be recorded with the tile it replaced.

export class TileWriter {
  readonly #map: TiledMap;
  readonly #layers = new Map<TileRole, { layer: TiledTileLayer; data: Uint32Array; dirty: boolean }>();

  constructor(map: TiledMap) {
    this.#map = map;
  }

  #layer(role: TileRole): { layer: TiledTileLayer; data: Uint32Array; dirty: boolean } {
    let entry = this.#layers.get(role);
    if (entry === undefined) {
      const { layer } = resolveRole(this.#map, role);
      if (layer.width !== this.#map.width || layer.height !== this.#map.height) {
        throw new WaEngineError(
          'LAYER_DATA_UNSUPPORTED',
          `layer "${layer.name}" is ${layer.width}x${layer.height} but the map is ${this.#map.width}x${this.#map.height}; resize the layer to the map in Tiled`,
        );
      }
      entry = { layer, data: readTileData(layer), dirty: false };
      this.#layers.set(role, entry);
    }
    return entry;
  }

  #check(x: number, y: number): void {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= this.#map.width || y >= this.#map.height) {
      throw new WaEngineError('INVALID_INPUT', `cell (${x},${y}) is outside the ${this.#map.width}x${this.#map.height} map`);
    }
  }

  get(role: TileRole, x: number, y: number): number {
    this.#check(x, y);
    return this.#layer(role).data[y * this.#map.width + x] ?? 0;
  }

  set(role: TileRole, x: number, y: number, raw: number, recorder?: WriteRecorder): void {
    this.#check(x, y);
    const entry = this.#layer(role);
    const index = y * this.#map.width + x;
    recorder?.touch(role, x, y, entry.data[index] ?? 0);
    entry.data[index] = raw >>> 0;
    entry.dirty = true;
  }

  // The tileset name and local id at a cell, or undefined for an empty cell.
  local(role: TileRole, x: number, y: number): { tileset: string; tile: number } | undefined {
    const raw = this.get(role, x, y);
    if (raw === 0) return undefined;
    const hit = tilesetForGid(this.#map.tilesets, decodeGid(raw).gid);
    if (hit === undefined || isExternalTileset(hit.tileset)) return undefined;
    return { tileset: hit.tileset.name, tile: hit.localId };
  }

  gid(tileset: string, tile: number, flips: { h?: boolean; v?: boolean; d?: boolean } = {}): number {
    const ts = this.#map.tilesets.find((t) => !isExternalTileset(t) && t.name === tileset);
    if (ts === undefined) throw new WaEngineError('INTERNAL', `tileset ${tileset} is not embedded in the map`);
    return encodeGid({ gid: ts.firstgid + tile, h: flips.h ?? false, v: flips.v ?? false, d: flips.d ?? false });
  }

  flush(): void {
    for (const entry of this.#layers.values()) {
      if (entry.dirty) writeTileData(entry.layer, entry.data);
      entry.dirty = false;
    }
  }
}

// Embeds the named tilesets of an asset set (all of them when names is omitted), with their
// tilesetCopyright on the ones newly added. Images must exist in the project.
export async function embedSetTilesets(
  projectDir: string,
  map: TiledMap,
  mapAbs: string,
  set: LoadedAssetSet,
  names?: Iterable<string>,
): Promise<void> {
  const wanted = names === undefined ? [...set.tilesets.keys()] : [...new Set(names)];
  const images = await resolveImages(set, projectDir);
  for (const name of wanted) {
    const ts = set.tilesets.get(name);
    const image = images.get(name);
    if (ts === undefined || image === undefined) throw new WaEngineError('INTERNAL', `asset set has no tileset ${name}`);
    const tsj = TiledTilesetFileSchema.parse(JSON.parse(await readFile(ts.tsjPath, 'utf8')));
    const result = await embedTileset(projectDir, map, mapAbs, tsj, image);
    if (result.added) setProperty(result.tileset, 'tilesetCopyright', 'string', ts.tilesetCopyright);
  }
}
