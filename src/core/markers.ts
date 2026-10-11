import { randomBytes } from 'node:crypto';
import { link, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKER_TILESET } from '../schemas/asset-set.schema.js';
import type { TiledTilesetFile } from '../schemas/tiled.schema.js';
import { WaEngineError } from './errors.js';
import { NO_HARD_LINKS } from './map-io.js';
import { encodePng } from './png.js';
import { resolveInProject } from './project-paths.js';

// The built-in marker tileset of asset sets drawn with automapping rules: 16 flat colour
// squares that a build paints on the sketch layers (walls, doors, floors, wall styles) for the
// rules to read. The package ships its .tsj only; the image is generated here, so the same
// palette always gives the same bytes.

export { MARKER_TILESET };
// Where a project keeps the marker image, relative to its root, like the starter-kit images.
export const MARKER_IMAGE = 'tilesets/wa-markers.png';
export const MARKER_TSJ = fileURLToPath(new URL('../../assets/markers/wa-markers.tsj', import.meta.url));
export const MARKER_COPYRIGHT = 'wa-agent-engine marker tiles (MIT): flat colours for automapping sketches';

const TILE = 32;
const COLUMNS = 4;

// Sixteen colours that stay distinct side by side, in tile id order.
export const MARKER_PALETTE: readonly { name: string; rgb: readonly [number, number, number] }[] = [
  { name: 'red', rgb: [0xe6, 0x19, 0x4b] },
  { name: 'green', rgb: [0x3c, 0xb4, 0x4b] },
  { name: 'yellow', rgb: [0xff, 0xe1, 0x19] },
  { name: 'blue', rgb: [0x43, 0x63, 0xd8] },
  { name: 'orange', rgb: [0xf5, 0x82, 0x31] },
  { name: 'purple', rgb: [0x91, 0x1e, 0xb4] },
  { name: 'cyan', rgb: [0x42, 0xd4, 0xf4] },
  { name: 'magenta', rgb: [0xf0, 0x32, 0xe6] },
  { name: 'lime', rgb: [0xbf, 0xef, 0x45] },
  { name: 'pink', rgb: [0xfa, 0xbe, 0xd4] },
  { name: 'teal', rgb: [0x46, 0x99, 0x90] },
  { name: 'lavender', rgb: [0xdc, 0xbe, 0xff] },
  { name: 'brown', rgb: [0x9a, 0x63, 0x24] },
  { name: 'beige', rgb: [0xff, 0xfa, 0xc8] },
  { name: 'maroon', rgb: [0x80, 0x00, 0x00] },
  { name: 'navy', rgb: [0x00, 0x00, 0x75] },
];

const ROWS = Math.ceil(MARKER_PALETTE.length / COLUMNS);

// The .tsj written to assets/markers/ by scripts/gen-markers.ts. Each tile is named after its
// colour (a string property), which Tiled shows when the tile is selected.
export function markerTsj(): TiledTilesetFile {
  return {
    columns: COLUMNS,
    image: 'wa-markers.png',
    imageheight: ROWS * TILE,
    imagewidth: COLUMNS * TILE,
    margin: 0,
    name: MARKER_TILESET,
    spacing: 0,
    tilecount: MARKER_PALETTE.length,
    tiledversion: '1.12.2',
    tileheight: TILE,
    tiles: MARKER_PALETTE.map((c, id) => ({ id, properties: [{ name: 'colour', type: 'string', value: c.name }] })),
    tilewidth: TILE,
    type: 'tileset',
    version: '1.11',
  };
}

export function markerPng(): Uint8Array {
  const width = COLUMNS * TILE;
  const height = ROWS * TILE;
  const data = new Uint8ClampedArray(width * height * 4);
  MARKER_PALETTE.forEach(({ rgb }, id) => {
    const left = (id % COLUMNS) * TILE;
    const top = Math.floor(id / COLUMNS) * TILE;
    for (let y = top; y < top + TILE; y++) {
      for (let x = left; x < left + TILE; x++) data.set([rgb[0], rgb[1], rgb[2], 255], (y * width + x) * 4);
    }
  });
  return encodePng({ width, height, data });
}

const errnoOf = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;

// Creates the file only if it does not exist yet: written beside it and linked into place, so
// a reader never sees half of it, or created in place where the filesystem has no hard links.
async function createIfAbsent(abs: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${abs}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, bytes, { flag: 'wx' });
  try {
    await link(tmp, abs);
  } catch (err) {
    if (errnoOf(err) === 'EEXIST') return;
    if (!NO_HARD_LINKS.has(errnoOf(err) ?? '')) throw err;
    try {
      await writeFile(abs, bytes, { flag: 'wx' });
    } catch (createErr) {
      if (errnoOf(createErr) !== 'EEXIST') throw createErr;
    }
  } finally {
    await rm(tmp, { force: true });
  }
}

// Writes the marker image into the project when it is not there yet. An existing file is left
// as it is: rules match the marker tileset by its image path, not by its colours.
export async function ensureMarkerImage(projectDir: string): Promise<void> {
  const abs = await resolveInProject(projectDir, MARKER_IMAGE, { ext: '.png' });
  const failed = (err: unknown): WaEngineError =>
    new WaEngineError('IO_ERROR', `cannot write the marker image ${MARKER_IMAGE} (${errnoOf(err) ?? 'error'})`, { errno: errnoOf(err) });
  try {
    await stat(abs);
    return;
  } catch (err) {
    if (errnoOf(err) !== 'ENOENT') throw failed(err);
  }
  try {
    await mkdir(dirname(abs), { recursive: true });
    await createIfAbsent(abs, markerPng());
  } catch (err) {
    throw failed(err);
  }
}
