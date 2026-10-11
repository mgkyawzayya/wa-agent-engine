import { randomBytes } from 'node:crypto';
import { access, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import * as z from 'zod';
import { PREFAB_ID_PATTERN, type ExtendingAssetSet, type PrefabEntry } from '../schemas/asset-set.schema.js';
import { PREFAB_CATEGORIES, type PrefabCategory } from '../schemas/prefab.schema.js';
import { MAX_PROPS, PropHintsSchema, type PropHint } from '../schemas/prop-hints.schema.js';
import { BUILTIN_SETS_DIR, loadAssetSet, PROJECT_SETS_DIR } from './asset-set-registry.js';
import { WaEngineError } from './errors.js';
import { sha256Hex } from './map-io.js';
import { decodePng, encodePng, readPngHeader, type Rgba8 } from './png.js';
import { loadPrefab } from './prefab-registry.js';
import { assertProjectDir, resolveInProject } from './project-paths.js';

// Imports single-image props (PNG images in 32 px tile multiples, described by a hints file)
// as a project asset set that extends a base set. The images are copied, pixel for pixel, into
// one atlas image in the project's tilesets/ folder; each prop becomes a prefab whose rows go on
// furniture1, or on foreground1 for its foreground rows, with collisions from its grid.

const TILE = 32;
const ATLAS_COLUMNS = 16;
// Some GPUs cap textures at 4096 px.
const ATLAS_MAX_SIDE = 4096;
const MAX_PROP_FILE_BYTES = 16 * 1024 * 1024;
const LOCK_STALE_MS = 10 * 60 * 1000;
export const MAX_SOURCES = 20;
export const DEFAULT_BASE_SET = 'wa-starter-office';

export interface ImportPropSetOptions {
  projectDir: string;
  setId: string;
  // Hints JSON files, relative to the project; each one's images are relative to it.
  source: string | readonly string[];
  extends?: string;
  overwrite?: boolean;
}

export interface ImportedProp {
  id: string;
  width: number;
  height: number;
  category: PrefabCategory;
  use: string;
}

export interface ImportPropSetResult {
  setId: string;
  extends: string;
  image: string;
  prefabs: ImportedProp[];
}

// Engine categories from words in a prop's id and tags (plurals count), first match wins;
// anything else is social. A hint category that is already an engine category is kept.
const CATEGORY_WORDS: readonly (readonly [PrefabCategory, readonly string[]])[] = [
  ['outdoor', ['outdoor', 'street', 'park', 'garden', 'picnic', 'tent', 'kiosk', 'bunting', 'bike', 'tree', 'bush', 'hedge', 'fence']],
  ['talks', ['stage', 'podium', 'projector', 'mic', 'audience', 'screen', 'lectern', 'speaker']],
  ['logistics', ['registration', 'help', 'desk', 'tea', 'water', 'vending', 'food', 'coffee', 'cooler', 'dispenser', 'snack']],
  ['fun', ['game', 'arcade', 'pool', 'pingpong', 'foosball', 'chess', 'prize', 'raffle', 'trophy', 'gift', 'balloon', 'treasure', 'teleport']],
  ['work', ['board', 'sign', 'signpost', 'whiteboard', 'table', 'chair', 'notice', 'schedule', 'topic']],
];

export function propCategory(prop: Pick<PropHint, 'id' | 'category' | 'tags'>): PrefabCategory {
  if (prop.category !== undefined && (PREFAB_CATEGORIES as readonly string[]).includes(prop.category)) return prop.category as PrefabCategory;
  const words = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const tokens = [words(prop.id), (prop.tags ?? []).flatMap(words)];
  for (const group of tokens) {
    const set = new Set(group);
    for (const [category, keys] of CATEGORY_WORDS) {
      if (keys.some((k) => set.has(k) || set.has(`${k}s`) || set.has(`${k}es`))) return category;
    }
  }
  return 'social';
}

export const prefabIdOf = (propId: string): string => propId.toLowerCase().replaceAll('_', '-');

async function exists(abs: string): Promise<boolean> {
  try {
    await access(abs);
    return true;
  } catch {
    return false;
  }
}

interface Placed {
  prop: PropHint;
  id: string;
  image: Rgba8;
  width: number;
  height: number;
  x: number;
  y: number;
}

// Shelf packing, tallest first, ties in file order: deterministic for the same hints.
function pack(items: Omit<Placed, 'x' | 'y'>[]): { placed: Placed[]; columns: number; rows: number } {
  const columns = Math.max(ATLAS_COLUMNS, ...items.map((i) => i.width));
  const order = items.map((item, index) => ({ item, index })).sort((a, b) => b.item.height - a.item.height || a.index - b.index);
  const placed: Placed[] = [];
  let x = 0;
  let y = 0;
  let shelf = 0;
  for (const { item } of order) {
    if (x + item.width > columns) {
      y += shelf;
      x = 0;
      shelf = 0;
    }
    placed.push({ ...item, x, y });
    x += item.width;
    shelf = Math.max(shelf, item.height);
  }
  return { placed, columns, rows: y + shelf };
}

function blitInto(atlas: Rgba8, image: Rgba8, left: number, top: number): void {
  for (let y = 0; y < image.height; y++) {
    const from = y * image.width * 4;
    atlas.data.set(image.data.subarray(from, from + image.width * 4), ((top + y) * atlas.width + left) * 4);
  }
}

function tileIsEmpty(image: Rgba8, tx: number, ty: number): boolean {
  for (let y = ty * TILE; y < (ty + 1) * TILE; y++) {
    for (let x = tx * TILE; x < (tx + 1) * TILE; x++) if (image.data[(y * image.width + x) * 4 + 3] !== 0) return false;
  }
  return true;
}

function prefabMap(p: Placed, setId: string, columns: number, entry: PrefabEntry, credit: string | undefined): object {
  const foreground = new Set(p.prop.foregroundRows ?? []);
  const furniture1: number[] = [];
  const foreground1: number[] = [];
  const collisions: number[] = [];
  for (let ty = 0; ty < p.height; ty++) {
    for (let tx = 0; tx < p.width; tx++) {
      const gid = tileIsEmpty(p.image, tx, ty) ? 0 : 1 + (p.y + ty) * columns + (p.x + tx);
      furniture1.push(foreground.has(ty) ? 0 : gid);
      foreground1.push(foreground.has(ty) ? gid : 0);
      const cell = p.prop.collisionGrid?.[ty]?.[tx];
      // Collision cells are never decoded, only tested for non-zero.
      collisions.push(cell === 1 || cell === true ? 1 : 0);
    }
  }
  const layer = (name: string, data: number[], id: number) => ({ id, name, type: 'tilelayer', width: p.width, height: p.height, x: 0, y: 0, opacity: 1, visible: true, data });
  const layers = [layer('furniture1', furniture1, 1), layer('foreground1', foreground1, 2), layer('collisions', collisions, 3)].filter((l) =>
    l.data.some((v) => v !== 0),
  );
  const properties = [
    { name: 'category', type: 'string', value: entry.category },
    { name: 'placement', type: 'string', value: entry.placement },
    ...(entry.faceRow === undefined ? [] : [{ name: 'faceRow', type: 'string', value: entry.faceRow }]),
    { name: 'use', type: 'string', value: entry.use },
    ...(entry.license === undefined ? [] : [{ name: 'license', type: 'string', value: entry.license }]),
    ...(credit === undefined ? [] : [{ name: 'credit', type: 'string', value: credit }]),
  ];
  return {
    type: 'map',
    version: '1.10',
    orientation: 'orthogonal',
    renderorder: 'right-down',
    infinite: false,
    width: p.width,
    height: p.height,
    tilewidth: TILE,
    tileheight: TILE,
    nextlayerid: 4,
    nextobjectid: 1,
    tilesets: [{ firstgid: 1, source: `../tilesets/${setId}.tsj` }],
    layers,
    properties,
  };
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const errnoOf = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? 'error';

// One import of a set at a time. A lock older than ten minutes is from a run that died.
async function acquireLock(dir: string, setId: string): Promise<void> {
  await mkdir(dirname(dir), { recursive: true });
  try {
    await mkdir(dir);
  } catch (err) {
    if (errnoOf(err) !== 'EEXIST') throw err;
    if (Date.now() - (await stat(dir)).mtimeMs < LOCK_STALE_MS) {
      throw new WaEngineError('ASSET_SET_LOCKED', `another import of asset set "${setId}" is running; try again when it has finished`);
    }
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir);
  }
}

async function refuseLink(abs: string, shown: string): Promise<void> {
  const info = await lstat(abs).catch(() => undefined);
  if (info?.isSymbolicLink() === true) throw new WaEngineError('INVALID_INPUT', `${shown} is a symbolic link; remove it first`);
}

export async function importPropSet(options: ImportPropSetOptions): Promise<ImportPropSetResult> {
  const projectDir = await assertProjectDir(options.projectDir);
  const setId = options.setId;
  const baseId = options.extends ?? DEFAULT_BASE_SET;
  if (!PREFAB_ID_PATTERN.test(setId)) throw new WaEngineError('INVALID_INPUT', 'setId must be 1-64 lowercase letters, digits and "-"');
  if (await exists(join(BUILTIN_SETS_DIR, setId))) throw new WaEngineError('INVALID_INPUT', `"${setId}" is a built-in set; choose another setId`);
  const base = await loadAssetSet(baseId, projectDir);
  if (base.extends !== undefined) throw new WaEngineError('INVALID_INPUT', `"${baseId}" extends another set; extend a full set such as ${DEFAULT_BASE_SET}`);

  // 1. The hints, and every image's size from its PNG header, before decoding anything.
  const sources = typeof options.source === 'string' ? [options.source] : [...options.source];
  if (sources.length === 0 || sources.length > MAX_SOURCES) throw new WaEngineError('INVALID_INPUT', `source must name 1 to ${MAX_SOURCES} hints files`);
  const listed: { prop: PropHint; source: string }[] = [];
  for (const source of sources) {
    const sourceAbs = await resolveInProject(projectDir, source, { ext: '.json' });
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(sourceAbs, 'utf8'));
    } catch {
      throw new WaEngineError('INVALID_INPUT', `${source} is missing or not valid JSON`);
    }
    const hints = PropHintsSchema.safeParse(raw);
    if (!hints.success) throw new WaEngineError('INVALID_INPUT', `${source} is not a props hints file:\n${z.prettifyError(hints.error)}`);
    for (const prop of hints.data) listed.push({ prop, source });
  }
  if (listed.length > MAX_PROPS) throw new WaEngineError('INVALID_INPUT', `${listed.length} props; one set holds at most ${MAX_PROPS}`);
  const problems: string[] = [];
  const ids = new Set<string>();
  const baseIds = new Set(base.set.prefabs.map((p) => p.id));
  const sized: (Omit<Placed, 'x' | 'y' | 'image'> & { abs: string })[] = [];
  for (const { prop, source } of listed) {
    const id = prefabIdOf(prop.id);
    if (ids.has(id)) problems.push(`${prop.id}: two props become prefab "${id}"`);
    if (baseIds.has(id)) problems.push(`${prop.id}: "${id}" is already a prefab of ${baseId}`);
    ids.add(id);
    const [width, height] = prop.sizeTiles;
    try {
      const abs = await resolveInProject(projectDir, posix.join(posix.dirname(source), prop.image), { ext: '.png' });
      if ((await stat(abs)).size > MAX_PROP_FILE_BYTES) throw new WaEngineError('IMAGE_TOO_LARGE', `is larger than ${MAX_PROP_FILE_BYTES} bytes`);
      const header = readPngHeader(new Uint8Array(await readFile(abs)));
      if (header.width !== width * TILE || header.height !== height * TILE) {
        problems.push(`${prop.id}: ${prop.image} is ${header.width}x${header.height} px, but sizeTiles ${width}x${height} needs ${width * TILE}x${height * TILE}`);
        continue;
      }
      sized.push({ prop, id, width, height, abs });
    } catch (err) {
      problems.push(`${prop.id}: ${prop.image} ${err instanceof WaEngineError ? err.message : 'cannot be read'}`);
    }
  }
  if (problems.length > 0) {
    throw new WaEngineError('INVALID_INPUT', `${problems.length} prop(s) cannot be imported: ${problems.slice(0, 10).join('; ')}`, { problems });
  }

  // 2. The atlas: planned from the sizes, then every prop's pixels copied in unchanged.
  const { placed: planned, columns, rows } = pack(sized.map((s) => ({ ...s, image: undefined as unknown as Rgba8 })));
  if (rows * TILE > ATLAS_MAX_SIDE) throw new WaEngineError('IMAGE_TOO_LARGE', `the props need an atlas ${rows * TILE} px tall (at most ${ATLAS_MAX_SIDE}); split them into several sets`);
  const atlas: Rgba8 = { width: columns * TILE, height: rows * TILE, data: new Uint8ClampedArray(columns * TILE * rows * TILE * 4) };
  const placed: Placed[] = [];
  for (const p of planned) {
    const abs = sized.find((s) => s.id === p.id)!.abs;
    const image = await decodePng(new Uint8Array(await readFile(abs)));
    let opaque = false;
    for (let i = 3; i < image.data.length && !opaque; i += 4) opaque = image.data[i] !== 0;
    if (!opaque) {
      problems.push(`${p.prop.id}: ${p.prop.image} is fully transparent`);
      continue;
    }
    blitInto(atlas, image, p.x * TILE, p.y * TILE);
    placed.push({ ...p, image });
  }
  if (problems.length > 0) {
    throw new WaEngineError('INVALID_INPUT', `${problems.length} prop(s) cannot be imported: ${problems.join('; ')}`, { problems });
  }
  const png = encodePng(atlas);
  // Named after its content: a re-import that changes the props gets a new atlas, and maps built
  // with the old one keep its image and tile numbers.
  const tilesetName = `${setId}-${sha256Hex(png).slice(0, 8)}`;
  const imageRel = `tilesets/${tilesetName}.png`;

  const licenses = [...new Set(listed.map(({ prop }) => prop.license).filter((l): l is string => l !== undefined))];
  const entries: PrefabEntry[] = [];
  const files: [string, string][] = [];
  const order = new Map(sized.map((s, i) => [s.id, i]));
  for (const p of [...placed].sort((a, b) => order.get(a.id)! - order.get(b.id)!)) {
    const entry: PrefabEntry = {
      id: p.id,
      path: `prefabs/${p.id}.tmj`,
      width: p.width,
      height: p.height,
      category: propCategory(p.prop),
      placement: p.prop.placement ?? 'free',
      use: p.prop.use ?? p.prop.name ?? p.prop.id,
    };
    if (p.prop.faceRow !== undefined) entry.faceRow = p.prop.faceRow;
    if (p.prop.license !== undefined) entry.license = p.prop.license;
    const credit = p.prop.name === undefined ? undefined : `${p.prop.name}${p.prop.provenanceRun === undefined ? '' : ` (${p.prop.provenanceRun})`}`;
    entries.push(entry);
    files.push([entry.path, json(prefabMap(p, setId, columns, entry, credit))]);
  }
  const setJson: ExtendingAssetSet = {
    id: setId,
    title: `${setId}: props imported from ${sources.join(', ')}`,
    extends: baseId,
    tilesets: [
      {
        name: tilesetName,
        tsj: `tilesets/${setId}.tsj`,
        image: imageRel,
        tilesetCopyright: licenses.length > 0 ? licenses.join('; ') : `Imported props (${sources.join(', ')})`,
      },
    ],
    prefabs: entries,
  };
  const tsj = {
    type: 'tileset',
    version: '1.10',
    name: tilesetName,
    tilewidth: TILE,
    tileheight: TILE,
    tilecount: columns * rows,
    columns,
    margin: 0,
    spacing: 0,
    image: `../../../${imageRel}`,
    imagewidth: atlas.width,
    imageheight: atlas.height,
  };
  files.push([`tilesets/${setId}.tsj`, json(tsj)], ['set.json', json(setJson)]);

  // 3. Write under a lock into fresh names, swap them in, check, and put everything back on failure.
  const lockDir = await resolveInProject(projectDir, posix.join(PROJECT_SETS_DIR, `.lock-${setId}`));
  await acquireLock(lockDir, setId);
  const tag = randomBytes(6).toString('hex');
  const tmpDir = await resolveInProject(projectDir, posix.join(PROJECT_SETS_DIR, `.tmp-${setId}-${tag}`));
  const oldDir = await resolveInProject(projectDir, posix.join(PROJECT_SETS_DIR, `.old-${setId}-${tag}`));
  const tmpPng = await resolveInProject(projectDir, `tilesets/.${tilesetName}-${tag}.png`, { ext: '.png' });
  try {
    const finalDir = await resolveInProject(projectDir, posix.join(PROJECT_SETS_DIR, setId));
    const pngAbs = await resolveInProject(projectDir, imageRel, { ext: '.png' });
    await refuseLink(finalDir, `${PROJECT_SETS_DIR}/${setId}`);
    await refuseLink(pngAbs, imageRel);
    const hadSet = await exists(finalDir);
    if (hadSet && options.overwrite !== true) {
      throw new WaEngineError('ASSET_SET_EXISTS', `asset set "${setId}" already exists; pass overwrite: true to replace it`, { setId });
    }
    // The same props give the same atlas, which may already be there.
    const newPng = !(await exists(pngAbs));
    for (const [rel, text] of files) {
      await mkdir(join(tmpDir, posix.dirname(rel)), { recursive: true });
      await writeFile(join(tmpDir, rel), text);
    }
    if (newPng) {
      await mkdir(dirname(pngAbs), { recursive: true });
      await writeFile(tmpPng, png);
    }
    let movedOld = false;
    let placedSet = false;
    let placedPng = false;
    try {
      if (hadSet) {
        await rename(finalDir, oldDir);
        movedOld = true;
      }
      await rename(tmpDir, finalDir);
      placedSet = true;
      if (newPng) {
        await rename(tmpPng, pngAbs);
        placedPng = true;
      }
      const loaded = await loadAssetSet(setId, projectDir);
      for (const entry of entries) await loadPrefab(loaded, entry.id);
    } catch (err) {
      if (placedSet) await rm(finalDir, { recursive: true, force: true });
      if (placedPng) await rm(pngAbs, { force: true });
      if (movedOld) await rename(oldDir, finalDir);
      throw err;
    }
    await rm(oldDir, { recursive: true, force: true });
  } catch (err) {
    if (err instanceof WaEngineError) throw err;
    throw new WaEngineError('INTERNAL', `could not write asset set "${setId}" (${errnoOf(err)})`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
    await rm(tmpPng, { force: true });
    await rm(lockDir, { recursive: true, force: true });
  }

  return {
    setId,
    extends: baseId,
    image: imageRel,
    prefabs: entries.map((e) => ({ id: e.id, width: e.width, height: e.height, category: e.category, use: e.use })),
  };
}
