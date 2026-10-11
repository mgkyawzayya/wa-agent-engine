import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, sep } from 'node:path';
import { getProperty, isExternalTileset, type TiledEmbeddedTileset, type TiledMap, type TiledObject, type TiledTileLayer } from '../schemas/tiled.schema.js';
import { WaEngineError } from './errors.js';
import { GLYPH_ADVANCE, GLYPH_HEIGHT, GLYPH_WIDTH, glyph, wrapText } from './bitmap-font.js';
import { TEXT_EM_WIDTH, TEXT_LINE_HEIGHT } from './labels.js';
import { decodeGid, tilesetForGid } from './gid.js';
import { forEachObjectGroup, forEachTileLayer, readTileData, SKETCH_ROLES, tryResolveRole } from './layers.js';
import { readFileBounded, readMap, sha256Hex } from './map-io.js';
import { resolveMap } from './map-session.js';
import { decodePng, encodePng, readPngInfo, type Rgba8 } from './png.js';
import { resolveInProject, resolveMapRelative } from './project-paths.js';
import { isArea } from './zones.js';

// Renders a map to a PNG from the tileset images already in the user's project, so an agent
// can look at what it drew. It composites existing tiles; it never generates an image.

export const RENDER_SCALES = [0.25, 0.5, 1, 2] as const;
export type RenderScale = (typeof RENDER_SCALES)[number];
export const MAX_PREVIEW_SIDE = 4096;
export const MAX_IMAGE_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 8192;
export const MAX_DECODED_BYTES = 512 * 1024 * 1024;
// Tiles larger than this many map cells a side are refused: each one is drawn whole.
export const MAX_TILE_TO_GRID = 8;
// Drawing every visible tile may touch at most this many times the preview's pixels.
export const MAX_DRAW_FACTOR = 24;
export const PREVIEW_DIR = '.wa-preview';
// Preview names are cut to this many UTF-8 bytes (plus a hash), well under file-name limits.
const MAX_NAME_BYTES = 150;

export interface RenderOptions {
  projectDir: string;
  mapPath: string;
  // One of RENDER_SCALES; anything else is INVALID_INPUT.
  scale?: number;
  overlays?: readonly 'zones'[];
}

export interface RenderResult {
  pngPath: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  // The PNG itself, so a caller can attach it without reading the file back.
  png: Uint8Array;
}

// Decoded tileset images, by the tileset object in the map (names need not be unique).
export type Sheets = ReadonlyMap<TiledEmbeddedTileset, Rgba8>;

type Flags = { h: boolean; v: boolean; d: boolean };

// ---- tile drawing ----

// Pixel of a flipped tile: Tiled applies the diagonal flip first, then H and V, so sampling
// undoes V and H, then swaps x and y.
export function flippedSource(x: number, y: number, size: number, flags: Flags): [number, number] {
  const uy = flags.v ? size - 1 - y : y;
  const ux = flags.h ? size - 1 - x : x;
  return flags.d ? [uy, ux] : [ux, uy];
}

// Integer source-over of one RGBA pixel into the canvas, with a layer opacity in 0..255.
function blend(out: Uint8ClampedArray, o: number, r: number, g: number, b: number, a: number, opacity: number): void {
  const sa = Math.floor((a * opacity + 127) / 255);
  if (sa === 0) return;
  const da = out[o + 3]!;
  if (sa === 255 || da === 0) {
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = sa;
    return;
  }
  const keep = Math.floor((da * (255 - sa) + 127) / 255);
  const oa = sa + keep;
  out[o] = Math.floor((r * sa + out[o]! * keep + (oa >> 1)) / oa);
  out[o + 1] = Math.floor((g * sa + out[o + 1]! * keep + (oa >> 1)) / oa);
  out[o + 2] = Math.floor((b * sa + out[o + 2]! * keep + (oa >> 1)) / oa);
  out[o + 3] = oa;
}

// Where a tileset's tiles lie in its image. The column and row counts come from the image as
// it really is, the way Tiled computes them, so a tile id past the image draws nothing.
interface TileGrid {
  tileset: TiledEmbeddedTileset;
  image: Rgba8;
  columns: number;
  count: number;
}

function tileGrid(tileset: TiledEmbeddedTileset, image: Rgba8): TileGrid {
  const margin = tileset.margin ?? 0;
  const spacing = tileset.spacing ?? 0;
  const fit = (size: number, tile: number): number => Math.max(0, Math.floor((size - margin + spacing) / (tile + spacing)));
  const columns = fit(image.width, tileset.tilewidth);
  return { tileset, image, columns, count: columns * fit(image.height, tileset.tileheight) };
}

// Draws one tile like Tiled: anchored at the bottom-left of its map cell (so tiles larger or
// smaller than the map grid line up the same way), shifted by the tileset's tileoffset, and
// clipped to the canvas. Scaling is nearest neighbour.
function drawTile(canvas: Rgba8, grid: TileGrid, localId: number, flags: Flags, left: number, bottom: number, scale: number, opacity: number): void {
  if (localId >= grid.count) return;
  const ts = grid.tileset;
  const size = ts.tilewidth;
  const margin = ts.margin ?? 0;
  const spacing = ts.spacing ?? 0;
  const sx0 = margin + (localId % grid.columns) * (size + spacing);
  const sy0 = margin + Math.floor(localId / grid.columns) * (size + spacing);
  const offset = (ts as { tileoffset?: { x?: number; y?: number } }).tileoffset;
  const drawn = Math.max(1, Math.round(size * scale));
  const x0 = left + Math.round((offset?.x ?? 0) * scale);
  const y0 = bottom - drawn + Math.round((offset?.y ?? 0) * scale);
  const src = grid.image.data;
  for (let dy = Math.max(0, -y0); dy < drawn && y0 + dy < canvas.height; dy++) {
    for (let dx = Math.max(0, -x0); dx < drawn && x0 + dx < canvas.width; dx++) {
      const [tx, ty] = flippedSource(Math.min(size - 1, Math.floor(dx / scale)), Math.min(size - 1, Math.floor(dy / scale)), size, flags);
      const si = ((sy0 + ty) * grid.image.width + (sx0 + tx)) * 4;
      const oi = ((y0 + dy) * canvas.width + (x0 + dx)) * 4;
      blend(canvas.data, oi, src[si]!, src[si + 1]!, src[si + 2]!, src[si + 3]!, opacity);
    }
  }
}

// ---- overlays ----

const ZONE_COLOURS: Record<string, [number, number, number]> = {
  meeting: [40, 110, 255],
  website: [30, 190, 80],
  audio: [170, 70, 230],
  silent: [230, 50, 50],
  exit: [255, 150, 20],
  other: [200, 200, 200],
};

function zoneKind(o: TiledObject): keyof typeof ZONE_COLOURS {
  if (getProperty(o, 'exitUrl') !== undefined) return 'exit';
  if (getProperty(o, 'jitsiRoom') !== undefined) return 'meeting';
  if (getProperty(o, 'openWebsite') !== undefined) return 'website';
  if (getProperty(o, 'playAudio') !== undefined) return 'audio';
  if (getProperty(o, 'silent')?.value === true) return 'silent';
  return 'other';
}

function outlineZones(canvas: Rgba8, map: TiledMap, scale: number): void {
  forEachObjectGroup(map.layers, (layer) => {
    for (const o of layer.objects) {
      if (!isArea(o)) continue;
      const [r, g, b] = ZONE_COLOURS[zoneKind(o)]!;
      const x0 = Math.max(0, Math.floor(o.x * scale));
      const y0 = Math.max(0, Math.floor(o.y * scale));
      const x1 = Math.min(canvas.width - 1, Math.floor((o.x + (o.width ?? 0)) * scale) - 1);
      const y1 = Math.min(canvas.height - 1, Math.floor((o.y + (o.height ?? 0)) * scale) - 1);
      if (x1 < x0 || y1 < y0) continue;
      const put = (x: number, y: number): void => {
        const i = (y * canvas.width + x) * 4;
        canvas.data[i] = r;
        canvas.data[i + 1] = g;
        canvas.data[i + 2] = b;
        canvas.data[i + 3] = 255;
      };
      for (let x = x0; x <= x1; x++) {
        put(x, y0);
        put(x, y1);
      }
      for (let y = y0; y <= y1; y++) {
        put(x0, y);
        put(x1, y);
      }
    }
  });
}

// ---- text objects ----

const MAX_TEXT_PIXELSIZE = 256;
const MAX_TEXT_CHARS = 2000;

// A Tiled colour, "#RRGGBB" or "#AARRGGBB"; black when missing or unreadable, as in WorkAdventure.
export function parseTextColour(value: string | undefined): [number, number, number, number] {
  const hex = (value ?? '').replace(/^#/, '');
  const byte = (i: number): number => Number.parseInt(hex.slice(i, i + 2), 16);
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return [byte(0), byte(2), byte(4), 255];
  if (/^[0-9a-fA-F]{8}$/.test(hex)) return [byte(2), byte(4), byte(6), byte(0)];
  return [0, 0, 0, 255];
}

function blendPixel(canvas: Rgba8, x: number, y: number, [r, g, b, a]: readonly number[]): void {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const i = (y * canvas.width + x) * 4;
  const k = a! / 255;
  canvas.data[i] = Math.round(r! * k + canvas.data[i]! * (1 - k));
  canvas.data[i + 1] = Math.round(g! * k + canvas.data[i + 1]! * (1 - k));
  canvas.data[i + 2] = Math.round(b! * k + canvas.data[i + 2]! * (1 - k));
  canvas.data[i + 3] = Math.max(canvas.data[i + 3]!, a!);
}

// Text objects as WorkAdventure places them: from the object's top-left corner, wrapped to its
// width when wrap is on, in its colour. The glyphs are a 5x7 dot-matrix font scaled to the size,
// so the preview shows where text is and roughly how much room it takes, not its typeface.
function drawTexts(canvas: Rgba8, map: TiledMap, scale: number): void {
  forEachObjectGroup(map.layers, (layer) => {
    if (layer.visible === false) return;
    for (const o of layer.objects) {
      if (o.text === undefined || o.visible === false || typeof o.text.text !== 'string') continue;
      // Bounded work whatever the map says: sizes up to 256 px, at most MAX_TEXT_CHARS characters.
      const size = Math.min(MAX_TEXT_PIXELSIZE, Math.max(1, o.text.pixelsize ?? 16));
      // Characters as wide as the validator's estimate (0.55 em), glyphs 0.7 em tall, lines 1.25
      // em apart, at the preview's scale: small text gets blurry but keeps its true extent, so
      // the preview never shows text spilling out of a box it fits in.
      const advance = Math.max(2, Math.round(TEXT_EM_WIDTH * size * scale));
      const glyphWidth = Math.max(1, advance - Math.max(1, Math.round(advance / GLYPH_ADVANCE)));
      const glyphHeight = Math.max(2, Math.round(0.7 * size * scale));
      const lineHeight = Math.max(glyphHeight + 1, Math.round(TEXT_LINE_HEIGHT * size * scale));
      // Like WorkAdventure, wrap only when wrap is on and the object has a width.
      const maxChars = o.text.wrap === true && (o.width ?? 0) > 0 ? Math.floor(o.width! / (TEXT_EM_WIDTH * size)) : Number.MAX_SAFE_INTEGER;
      const colour = parseTextColour(o.text.color);
      wrapText(o.text.text.slice(0, MAX_TEXT_CHARS), maxChars).forEach((line, row) => {
        let left = Math.round(o.x * scale);
        const top = Math.round(o.y * scale) + row * lineHeight + Math.floor((lineHeight - glyphHeight) / 2);
        if (top >= canvas.height || top + glyphHeight <= 0) return;
        for (const char of line) {
          if (left >= canvas.width) break;
          if (left + glyphWidth > 0) {
            const columns = glyph(char);
            const dy0 = Math.max(0, -top);
            const dy1 = Math.min(glyphHeight, canvas.height - top);
            const dx0 = Math.max(0, -left);
            const dx1 = Math.min(glyphWidth, canvas.width - left);
            for (let dy = dy0; dy < dy1; dy++) {
              const cy = Math.floor((dy * GLYPH_HEIGHT) / glyphHeight);
              for (let dx = dx0; dx < dx1; dx++) {
                const cx = Math.floor((dx * GLYPH_WIDTH) / glyphWidth);
                if (((columns[cx]! >> cy) & 1) === 1) blendPixel(canvas, left + dx, top + dy, colour);
              }
            }
          }
          left += advance;
        }
      });
    }
  });
}

// ---- composition ----

export function checkScale(scale: number): RenderScale {
  if (!(RENDER_SCALES as readonly number[]).includes(scale)) {
    throw new WaEngineError('INVALID_INPUT', `scale must be one of ${RENDER_SCALES.join(', ')}`);
  }
  return scale as RenderScale;
}

// The preview size in pixels. The map grid must land on whole pixels at this scale.
export function previewSize(map: TiledMap, scale: number): { width: number; height: number } {
  const cellWidth = map.tilewidth * scale;
  const cellHeight = map.tileheight * scale;
  if (!(map.width >= 1 && map.height >= 1 && Number.isInteger(cellWidth) && Number.isInteger(cellHeight) && cellWidth >= 1 && cellHeight >= 1)) {
    throw new WaEngineError('INVALID_INPUT', `a ${map.width}x${map.height} map of ${map.tilewidth}x${map.tileheight} px tiles has no whole-pixel preview at scale ${scale}`);
  }
  return { width: map.width * cellWidth, height: map.height * cellHeight };
}

// The sketch layers of maps drawn with automapping rules hold markers for the rules, never art:
// previews leave them out even when they are visible.
function sketchLayers(map: TiledMap): Set<TiledTileLayer> {
  const layers = new Set<TiledTileLayer>();
  for (const role of SKETCH_ROLES) {
    let layer;
    try {
      layer = tryResolveRole(map, role)?.layer;
    } catch (err) {
      // A layer that cannot hold the role is drawn like any other.
      if (!(err instanceof WaEngineError)) throw err;
      continue;
    }
    if (layer?.type === 'tilelayer') layers.add(layer);
  }
  return layers;
}

// Composes a map from already-decoded tileset images, then its text objects. Pure and
// deterministic. Like WA, only each tile layer's own visibility and opacity count; group
// attributes are ignored.
export function composeMap(map: TiledMap, sheets: Sheets, options: { scale?: number; overlays?: readonly 'zones'[] } = {}): Rgba8 {
  const scale = checkScale(options.scale ?? 1);
  const size = previewSize(map, scale);
  const cellWidth = map.tilewidth * scale;
  const cellHeight = map.tileheight * scale;
  const canvas: Rgba8 = { width: size.width, height: size.height, data: new Uint8ClampedArray(size.width * size.height * 4) };
  const grids = new Map<TiledEmbeddedTileset, TileGrid>();
  for (const [tileset, image] of sheets) grids.set(tileset, tileGrid(tileset, image));
  const sketch = sketchLayers(map);
  forEachTileLayer(map.layers, (layer) => {
    if (layer.visible === false || sketch.has(layer)) return;
    const opacity = Math.round(Math.max(0, Math.min(1, layer.opacity ?? 1)) * 255);
    if (opacity === 0) return;
    readTileData(layer).forEach((raw, i) => {
      if (raw === 0) return;
      const flags = decodeGid(raw);
      const hit = tilesetForGid(map.tilesets, flags.gid);
      if (hit === undefined || isExternalTileset(hit.tileset)) return;
      const grid = grids.get(hit.tileset);
      if (grid === undefined) return;
      const x = i % layer.width;
      const y = Math.floor(i / layer.width);
      drawTile(canvas, grid, hit.localId, flags, x * cellWidth, (y + 1) * cellHeight, scale, opacity);
    });
  });
  drawTexts(canvas, map, scale);
  if (options.overlays?.includes('zones') === true) outlineZones(canvas, map, scale);
  return canvas;
}

// Runs a step on one tileset's image, naming the tileset in any error it raises.
async function forTileset<T>(ts: TiledEmbeddedTileset, step: () => T | Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    if (err instanceof WaEngineError && err.details === undefined) {
      throw new WaEngineError(err.code, `tileset ${ts.name}: ${err.message}`, { tileset: ts.name });
    }
    throw err;
  }
}

async function readTilesetImage(projectDir: string, mapAbs: string, ts: TiledEmbeddedTileset & { image: string }): Promise<Buffer> {
  const missing = (): WaEngineError =>
    new WaEngineError('TILESET_IMAGE_MISSING', `tileset ${ts.name}: image ${ts.image} is not in the project`, { tileset: ts.name });
  let abs: string;
  try {
    abs = await resolveMapRelative(projectDir, mapAbs, ts.image, { ext: '.png' });
  } catch (err) {
    if (err instanceof WaEngineError && err.code !== 'INVALID_INPUT') throw err;
    throw missing();
  }
  return readFileBounded(abs, MAX_IMAGE_FILE_BYTES, {
    open: missing,
    notFile: missing,
    tooLarge: () => new WaEngineError('IMAGE_TOO_LARGE', `tileset ${ts.name}: image ${ts.image} is larger than 32 MB`, { tileset: ts.name }),
  });
}

// What a preview can draw: one image of square tiles, no larger than MAX_TILE_TO_GRID map
// cells, drawn at their own size.
function checkTileset(ts: TiledEmbeddedTileset, map: TiledMap): void {
  const refuse = (message: string): never => {
    throw new WaEngineError('INVALID_INPUT', `tileset ${ts.name} ${message}`, { tileset: ts.name });
  };
  if (ts.image === undefined) refuse('is an image collection, which previews do not support');
  if (ts.tilewidth !== ts.tileheight || ts.tilewidth < 1) refuse(`has ${ts.tilewidth}x${ts.tileheight} px tiles; previews need square tiles`);
  if (ts.tilewidth > MAX_TILE_TO_GRID * map.tilewidth) refuse(`has ${ts.tilewidth} px tiles, more than ${MAX_TILE_TO_GRID} map cells wide`);
  if ((ts.margin ?? 0) < 0 || (ts.spacing ?? 0) < 0) refuse('has a negative margin or spacing');
  const renderSize = (ts as { tilerendersize?: unknown }).tilerendersize;
  if (renderSize !== undefined && renderSize !== 'tile') refuse('stretches its tiles to the map grid (tilerendersize "grid"), which previews do not support');
}

// Loads the images of the tilesets a map uses, through the path guard, within the limits.
// Every image's header is checked, and the decode budget summed, before any is decoded.
export async function loadSheets(projectDir: string, mapAbs: string, map: TiledMap): Promise<Map<TiledEmbeddedTileset, Rgba8>> {
  const used = new Set<TiledEmbeddedTileset>();
  const sketch = sketchLayers(map);
  forEachTileLayer(map.layers, (layer) => {
    if (layer.visible === false || sketch.has(layer)) return;
    for (const raw of readTileData(layer)) {
      if (raw === 0) continue;
      const hit = tilesetForGid(map.tilesets, decodeGid(raw).gid);
      if (hit === undefined) continue;
      if (isExternalTileset(hit.tileset)) {
        throw new WaEngineError('EXTERNAL_TILESET_UNRESOLVED', `tileset ${hit.tileset.source} is external; embed it to preview the map`, {
          tileset: hit.tileset.source,
        });
      }
      used.add(hit.tileset);
    }
  });
  const files: { ts: TiledEmbeddedTileset; bytes: Buffer }[] = [];
  let budget = MAX_DECODED_BYTES;
  for (const ts of map.tilesets) {
    if (isExternalTileset(ts) || !used.has(ts)) continue;
    const details = { tileset: ts.name };
    checkTileset(ts, map);
    const bytes = await forTileset(ts, () => readTilesetImage(projectDir, mapAbs, { ...ts, image: ts.image! }));
    const info = await forTileset(ts, () => readPngInfo(bytes));
    if (info.width > MAX_IMAGE_SIDE || info.height > MAX_IMAGE_SIDE) {
      throw new WaEngineError('IMAGE_TOO_LARGE', `tileset ${ts.name}: image ${ts.image} is ${info.width}x${info.height}, over ${MAX_IMAGE_SIDE} px`, details);
    }
    // Decoding holds the inflated data and the RGBA result at once; measured peaks run at
    // about twice that, so the budget is charged double.
    budget -= 2 * (info.inflatedBytes + info.width * info.height * 4);
    if (budget < 0) throw new WaEngineError('IMAGE_TOO_LARGE', 'the tileset images of this map are too large to decode together', details);
    files.push({ ts, bytes });
  }
  const sheets = new Map<TiledEmbeddedTileset, Rgba8>();
  for (const { ts, bytes } of files) sheets.set(ts, await forTileset(ts, () => decodePng(bytes)));
  return sheets;
}

function truncateBytes(text: string, max: number): string {
  let out = '';
  for (const ch of text) {
    if (Buffer.byteLength(out + ch) > max) break;
    out += ch;
  }
  return out;
}

// The preview file for a map, named after its path in the project so that maps in different
// folders never share one ("maps/a/venue.tmj" -> "maps__a__venue@1x.png"). Letters of any
// script, with their marks, are kept. Joining the folders with "__" can only be undone when
// no part had to change, none is empty, starts or ends with "_" or holds "__", and the
// extension is exactly .tmj; every other name, and any name cut for length, gets a hash of the
// path, so two maps never share a preview.
export function previewName(projectDir: string, mapAbs: string, scale: RenderScale): string {
  const rel = relative(projectDir, mapAbs).split(sep).join('/');
  const parts = (rel.endsWith('.tmj') ? rel.slice(0, -4) : rel).split('/');
  const safe = parts.map((part) => part.replace(/[^\p{L}\p{M}\p{N}._-]/gu, '_'));
  const exact =
    rel.endsWith('.tmj') && safe.every((part, i) => part === parts[i] && part !== '' && !part.startsWith('_') && !part.endsWith('_') && !part.includes('__'));
  const name = safe.join('__');
  if (exact && Buffer.byteLength(name) <= MAX_NAME_BYTES) return `${name}@${scale}x.png`;
  return `${truncateBytes(name, MAX_NAME_BYTES)}-${createHash('sha256').update(rel).digest('hex').slice(0, 8)}@${scale}x.png`;
}

// The pixels drawing every visible tile would touch. A few huge tiles on many cells could keep
// the process busy for minutes, so the work is bounded like the preview size is.
function checkDrawWork(map: TiledMap, scale: number, size: { width: number; height: number }): void {
  let work = 0;
  const checked = new Set<TiledEmbeddedTileset>();
  const sketch = sketchLayers(map);
  forEachTileLayer(map.layers, (layer) => {
    if (layer.visible === false || (layer.opacity ?? 1) <= 0 || sketch.has(layer)) return;
    for (const raw of readTileData(layer)) {
      if (raw === 0) continue;
      const hit = tilesetForGid(map.tilesets, decodeGid(raw).gid);
      if (hit === undefined || isExternalTileset(hit.tileset)) continue;
      if (!checked.has(hit.tileset)) {
        checkTileset(hit.tileset, map);
        checked.add(hit.tileset);
      }
      const drawn = Math.max(1, Math.round(hit.tileset.tilewidth * scale));
      work += drawn * drawn;
    }
  });
  if (work > MAX_DRAW_FACTOR * size.width * size.height) {
    throw new WaEngineError(
      'PREVIEW_TOO_LARGE',
      `drawing this map's tiles would touch ${work} pixels, more than ${MAX_DRAW_FACTOR} times the preview; its tilesets have tiles far larger than the map grid`,
      { work, limit: MAX_DRAW_FACTOR * size.width * size.height },
    );
  }
}

async function renderOne(options: RenderOptions): Promise<RenderResult> {
  const scale = checkScale(options.scale ?? 1);
  const { projectDir, mapAbs } = await resolveMap(options.projectDir, options.mapPath);
  const { map } = await readMap(mapAbs);
  const size = previewSize(map, scale);
  if (size.width > MAX_PREVIEW_SIDE || size.height > MAX_PREVIEW_SIDE) {
    throw new WaEngineError(
      'PREVIEW_TOO_LARGE',
      `a ${size.width}x${size.height} px preview is over ${MAX_PREVIEW_SIDE} px; use a smaller scale`,
      { width: size.width, height: size.height },
    );
  }
  checkDrawWork(map, scale, size);
  const sheets = await loadSheets(projectDir, mapAbs, map);
  const png = encodePng(composeMap(map, sheets, { scale, overlays: options.overlays ?? [] }));

  const pngPath = await resolveInProject(projectDir, `${PREVIEW_DIR}/${previewName(projectDir, mapAbs, scale)}`, { ext: '.png' });
  const tmp = `${pngPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await mkdir(dirname(pngPath), { recursive: true });
    await writeFile(tmp, png, { flag: 'wx' });
    await rename(tmp, pngPath);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    // The errno only: a message from the file system would carry absolute paths.
    const errno = (err as { code?: unknown }).code;
    throw new WaEngineError('IO_ERROR', `cannot write the preview into ${PREVIEW_DIR}/ (${typeof errno === 'string' ? errno : 'error'})`, {
      errno: typeof errno === 'string' ? errno : undefined,
    });
  }
  return { pngPath, width: size.width, height: size.height, bytes: png.length, sha256: sha256Hex(png), png };
}

// Renders run one at a time in a process: each may hold up to the decode budget in memory.
let queue: Promise<unknown> = Promise.resolve();

export function renderMap(options: RenderOptions): Promise<RenderResult> {
  const next = queue.then(() => renderOne(options));
  queue = next.catch(() => undefined);
  return next;
}
