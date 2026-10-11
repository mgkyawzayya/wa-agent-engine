import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import * as z from 'zod';
import {
  PrefabMapSchema,
  PrefabMetaSchema,
  type PrefabCategory,
  type PrefabFaceRow,
  type PrefabLayerName,
  type PrefabPlacement,
} from '../schemas/prefab.schema.js';
import { isExternalTileset } from '../schemas/tiled.schema.js';
import type { LoadedAssetSet } from './asset-set-registry.js';
import { WaEngineError } from './errors.js';
import { decodeGid } from './gid.js';

export type PrefabTileLayer = Exclude<PrefabLayerName, 'collisions'>;

export interface PrefabCell {
  x: number;
  y: number;
  tileset: string;
  tile: number;
  h: boolean;
  v: boolean;
  d: boolean;
}

export interface PrefabSummary {
  id: string;
  width: number;
  height: number;
  category: PrefabCategory;
  placement: PrefabPlacement;
  // Set for north-wall prefabs: the wall-face row their top row sits on.
  faceRow?: PrefabFaceRow;
  use: string;
  license?: string;
}

export interface LoadedPrefab extends PrefabSummary {
  credit?: string;
  // Cells per furniture/foreground sub-layer (only non-empty sub-layers are present).
  layers: Partial<Record<PrefabTileLayer, PrefabCell[]>>;
  collisions: { x: number; y: number }[];
}

export function listPrefabs(loaded: LoadedAssetSet, filter: { category?: PrefabCategory } = {}): PrefabSummary[] {
  return loaded.set.prefabs
    .filter((p) => filter.category === undefined || p.category === filter.category)
    .map(({ id, width, height, category, placement, faceRow, use, license }) => ({
      id,
      width,
      height,
      category,
      placement,
      ...(faceRow === undefined ? {} : { faceRow }),
      use,
      ...(license === undefined ? {} : { license }),
    }));
}

function invalid(id: string, message: string, details?: unknown): WaEngineError {
  return new WaEngineError('PREFAB_INVALID', `prefab "${id}": ${message}`, details);
}

export async function loadPrefab(loaded: LoadedAssetSet, id: string): Promise<LoadedPrefab> {
  const entry = loaded.set.prefabs.find((p) => p.id === id);
  if (entry === undefined) {
    throw new WaEngineError('PREFAB_NOT_FOUND', `asset set "${loaded.id}" has no prefab "${id}"`, {
      available: loaded.set.prefabs.map((p) => p.id),
    });
  }
  const abs = await loaded.resolveFile(entry.path, '.tmj');
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(abs, 'utf8'));
  } catch {
    throw invalid(id, `${entry.path} is missing or not valid JSON`);
  }
  const parsed = PrefabMapSchema.safeParse(raw);
  if (!parsed.success) throw invalid(id, `not a valid prefab map:\n${z.prettifyError(parsed.error)}`);
  const prefab = parsed.data;
  const meta = PrefabMetaSchema.safeParse(Object.fromEntries((prefab.properties ?? []).map((p) => [p.name, p.value])));
  if (!meta.success) throw invalid(id, `bad prefab properties:\n${z.prettifyError(meta.error)}`);
  if (prefab.width !== entry.width || prefab.height !== entry.height) {
    throw invalid(id, `is ${prefab.width}x${prefab.height}, but set.json says ${entry.width}x${entry.height}`);
  }
  if (
    meta.data.category !== entry.category ||
    meta.data.placement !== entry.placement ||
    meta.data.faceRow !== entry.faceRow ||
    meta.data.use !== entry.use ||
    meta.data.license !== entry.license
  ) {
    throw invalid(id, 'category, placement, faceRow, use, or license differs from set.json');
  }

  // Map each tileset reference of the prefab onto a tileset of the asset set.
  const ranges: { firstgid: number; name: string; count: number }[] = [];
  for (const ts of prefab.tilesets) {
    let name: string | undefined;
    if (isExternalTileset(ts)) {
      const target = resolve(dirname(abs), ts.source);
      name = [...loaded.tilesets.values()].find((t) => t.tsjPath === target)?.name;
    } else {
      name = ts.name;
    }
    const tileset = name === undefined ? undefined : loaded.tilesets.get(name);
    if (tileset === undefined) throw invalid(id, `uses a tileset outside asset set "${loaded.id}"`);
    ranges.push({ firstgid: ts.firstgid, name: tileset.name, count: tileset.tsj.tilecount });
  }
  ranges.sort((a, b) => a.firstgid - b.firstgid);

  const layers: LoadedPrefab['layers'] = {};
  const collisions: LoadedPrefab['collisions'] = [];
  for (const layer of prefab.layers) {
    const cells: PrefabCell[] = [];
    layer.data.forEach((raw, i) => {
      if (raw === 0) return;
      const x = i % prefab.width;
      const y = Math.floor(i / prefab.width);
      if (layer.name === 'collisions') {
        collisions.push({ x, y });
        return;
      }
      const { gid, h, v, d } = decodeGid(raw);
      const range = ranges.findLast((r) => r.firstgid <= gid);
      if (range === undefined || gid - range.firstgid >= range.count) {
        throw invalid(id, `layer ${layer.name} has an unknown tile at (${x},${y})`);
      }
      cells.push({ x, y, tileset: range.name, tile: gid - range.firstgid, h, v, d });
    });
    if (layer.name !== 'collisions' && cells.length > 0) layers[layer.name] = cells;
  }

  return {
    id,
    width: prefab.width,
    height: prefab.height,
    category: meta.data.category,
    placement: meta.data.placement,
    ...(meta.data.faceRow === undefined ? {} : { faceRow: meta.data.faceRow }),
    use: meta.data.use,
    ...(meta.data.credit === undefined ? {} : { credit: meta.data.credit }),
    ...(meta.data.license === undefined ? {} : { license: meta.data.license }),
    layers,
    collisions,
  };
}
