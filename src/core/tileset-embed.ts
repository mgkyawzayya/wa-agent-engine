import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import {
  isExternalTileset,
  TiledTilesetFileSchema,
  type TiledEmbeddedTileset,
  type TiledMap,
  type TiledMapTileset,
  type TiledTilesetFile,
} from '../schemas/tiled.schema.js';
import { WaEngineError } from './errors.js';
import { tileCountKnown } from './gid.js';
import { mapRelativePath, resolveMapRelative } from './project-paths.js';

// Fields of a .tsj that only belong to standalone tileset files (Tiled drops them on embed).
const FILE_ONLY_KEYS = new Set(['type', 'version', 'tiledversion', 'editorsettings', 'source']);

export interface EmbedResult {
  firstgid: number;
  tileset: TiledEmbeddedTileset;
  added: boolean;
}

async function externalTileCount(projectDir: string, mapAbs: string, source: string): Promise<number> {
  try {
    const abs = await resolveMapRelative(projectDir, mapAbs, source, { ext: ['.tsj', '.json'] });
    const parsed = TiledTilesetFileSchema.parse(JSON.parse(await readFile(abs, 'utf8')));
    const count = tileCountKnown({ ...parsed, firstgid: 1 });
    if (count === undefined) throw new Error('no tile count');
    return count;
  } catch (err) {
    throw new WaEngineError(
      'EXTERNAL_TILESET_UNRESOLVED',
      `cannot read external tileset "${source}" to find its tile count`,
      { source, reason: err instanceof WaEngineError ? err.code : 'unreadable' },
    );
  }
}

// The next safe firstgid: past the end of every tileset already in the map, including
// external ones, so new tile ids can never collide with existing ranges.
export async function nextFirstGid(projectDir: string, map: TiledMap, mapAbs: string): Promise<number> {
  let next = 1;
  for (const ts of map.tilesets) {
    const count = isExternalTileset(ts)
      ? await externalTileCount(projectDir, mapAbs, ts.source)
      : (tileCountKnown(ts) ?? 0);
    // An empty image collection still owns its firstgid.
    next = Math.max(next, ts.firstgid + Math.max(count, 1));
  }
  return next;
}

const normalizeImage = (p: string | undefined): string | undefined =>
  p === undefined ? undefined : posix.normalize(p.replaceAll('\\', '/'));

function sameTileset(a: TiledMapTileset, b: TiledEmbeddedTileset): boolean {
  return (
    !isExternalTileset(a) &&
    normalizeImage(a.image) === normalizeImage(b.image) &&
    a.tilecount === b.tilecount &&
    a.columns === b.columns
  );
}

// Embeds a .tsj into the map (WA requires embedded tilesets). The image path is rewritten
// relative to the map file, which is how Tiled, WA, and the preview renderer resolve it.
// Embedding the same tileset again is a no-op; a different tileset with the same name fails.
export async function embedTileset(
  projectDir: string,
  map: TiledMap,
  mapAbs: string,
  tsj: TiledTilesetFile,
  projectImageAbs: string,
): Promise<EmbedResult> {
  const entries = Object.entries(tsj).filter(([key]) => !FILE_ONLY_KEYS.has(key));
  const candidate: Record<string, unknown> = Object.fromEntries(entries);
  candidate.image = mapRelativePath(mapAbs, projectImageAbs);
  const sorted = Object.fromEntries(
    Object.entries({ ...candidate, firstgid: 0 }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ) as TiledEmbeddedTileset;

  const existing = map.tilesets.find((ts) => !isExternalTileset(ts) && ts.name === tsj.name);
  if (existing !== undefined && !isExternalTileset(existing)) {
    if (sameTileset(existing, sorted)) return { firstgid: existing.firstgid, tileset: existing, added: false };
    throw new WaEngineError(
      'TILESET_CONFLICT',
      `the map already has a different tileset named "${tsj.name}"`,
      {
        name: tsj.name,
        existing: { image: existing.image, tilecount: existing.tilecount, columns: existing.columns },
        incoming: { image: sorted.image, tilecount: sorted.tilecount, columns: sorted.columns },
      },
    );
  }

  sorted.firstgid = await nextFirstGid(projectDir, map, mapAbs);
  map.tilesets.push(sorted);
  return { firstgid: sorted.firstgid, tileset: sorted, added: true };
}
