// Writes the proving asset set test/fixtures/asset-sets/office-automap/: the built-in set's
// walls, wall faces, lintels, collisions and four floor styles, drawn by Tiled automapping
// rules instead of its wall terrain and face rules. Building the room fixtures with it gives
// the same pictures as building them with wa-starter-office (test/core/automap-asset-set.test.ts).
//
//   npx tsx scripts/gen-office-automap.ts            write the set
//   npx tsx scripts/gen-office-automap.ts --check    exit 1 when the files on disk are stale
//
// The rules read the sketch the engine paints (wa_sketch: wall, door and floor markers;
// wa_style: each room's wall-style marker over its inside) and copy the built-in set's choices:
// - walls.tmj: a wall top for every neighbour pattern the wall terrain has (straight from its
//   lookup), lintels over doors, and the clean-up the engine's own drawing does (old wall tiles
//   and collisions under doors, an old lintel where a wall now closes a door);
// - faces.tmj: the 2-row wall faces under every wall whose south side is open, in the four
//   variants (open to the west, the east, both, or neither) of the room's wall style, or of the
//   outside style; a later rule overwrites an earlier one, so room styles follow the outside;
// - floors.tmj: each floor style inside rooms, and on doors the floor of their inner room (the
//   south or east one overwrites the north or west one).
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BUILTIN_SETS_DIR, loadAssetSet, wangSet, type LoadedWangSet, type WallNeighbour } from '../src/core/asset-set-registry.js';
import { MARKER_IMAGE, MARKER_PALETTE, MARKER_TILESET } from '../src/core/markers.js';
import { DEFAULT_ASSET_SET } from '../src/core/zones.js';
import type { FaceRow } from '../src/schemas/asset-set.schema.js';
import type { TiledEmbeddedTileset, TiledMap, TiledTileLayer, TiledTilesetFile } from '../src/schemas/tiled.schema.js';

export const OFFICE_AUTOMAP_DIR = fileURLToPath(new URL('../test/fixtures/asset-sets/office-automap/', import.meta.url));
const SET_ID = 'office-automap';
// The floor styles the room fixtures use.
const FLOORS = ['wood-light', 'carpet-red', 'carpet-navy', 'slate-blue'];
const MARKERS = {
  wall: 0,
  door: 1,
  floor: { 'wood-light': 2, 'carpet-red': 3, 'carpet-navy': 4, 'slate-blue': 5 } as Record<string, number>,
  wallStyle: { white: 6, yellow: 7 } as Record<string, number>,
};
// From the rule maps (.wa-asset-sets/office-automap/automap/) to the project root.
const TO_PROJECT = '../../../';
const SPECIALS = ['Empty', 'Ignore', 'NonEmpty', 'Other'] as const;

// ---- rule tiles: markers 1-16, the special tiles, then the two art tilesets ----

const MARKER_FIRST = 1;
const SPECIAL_FIRST = MARKER_FIRST + MARKER_PALETTE.length;
const ROOM_BUILDER = 'WA_Room_Builder';
const ZONES = 'WA_Special_Zones';

interface Cond {
  layer: string;
  x: number;
  y: number;
  any?: number[];
  none?: number[];
}

interface Out {
  layer: string;
  x: number;
  y: number;
  gid: number;
}

interface Rule {
  // Alternatives: the rule matches where all conditions of one of them hold.
  indices: Cond[][];
  outputs: Out[];
}

const marker = (id: number): number => MARKER_FIRST + id;
const special = (name: (typeof SPECIALS)[number]): number => SPECIAL_FIRST + SPECIALS.indexOf(name);
const EMPTY = special('Empty');
const NON_EMPTY = special('NonEmpty');
const W = marker(MARKERS.wall);
const D = marker(MARKERS.door);

const sketch = (x: number, y: number, cond: Pick<Cond, 'any' | 'none'>): Cond => ({ layer: 'wa_sketch', x, y, ...cond });
const wall = (x: number, y: number): Cond => sketch(x, y, { any: [W] });
const door = (x: number, y: number): Cond => sketch(x, y, { any: [D] });
const wallOrDoor = (x: number, y: number): Cond => sketch(x, y, { any: [W, D] });
// Neither a wall nor a door: inside or outside a room.
const open = (x: number, y: number): Cond => sketch(x, y, { none: [W, D] });
const notWall = (x: number, y: number): Cond => sketch(x, y, { none: [W] });

interface Art {
  set: LoadedWangSet;
  gid(tileset: string, tile: number): number;
  collision: number;
}

// ---- walls.tmj ----

function wallRules(art: Art): Rule[] {
  const { walls } = art.set;
  const rules: Rule[] = [];
  const side = (value: WallNeighbour, x: number, y: number): Cond => (value === 1 ? wall(x, y) : value === 2 ? door(x, y) : open(x, y));
  const values: WallNeighbour[] = [0, 1, 2];
  for (const n of values) for (const e of values) for (const s of values) for (const w of values) {
    const tile = walls.tileFor(n, e, s, w);
    if (tile === undefined) continue;
    rules.push({
      indices: [[wall(0, 0), side(n, 0, -1), side(e, 1, 0), side(s, 0, 1), side(w, -1, 0)]],
      outputs: [
        { layer: 'walls', x: 0, y: 0, gid: art.gid(art.set.wang.wallTerrain.tileset, tile) },
        { layer: 'collisions', x: 0, y: 0, gid: art.collision },
      ],
    });
  }
  const horizontal = [door(0, 0), wallOrDoor(-1, 0), wallOrDoor(1, 0)];
  const vertical = [door(0, 0), wallOrDoor(0, -1), wallOrDoor(0, 1)];
  const clear = (x: number, y: number): Out[] => [{ layer: 'walls', x, y, gid: EMPTY }, { layer: 'collisions', x, y, gid: EMPTY }];
  const lintels: [Cond[], number | undefined][] = [[horizontal, walls.tileFor(0, 2, 0, 2)], [vertical, walls.tileFor(2, 0, 2, 0)]];
  for (const [conds, lintel] of lintels) {
    rules.push({ indices: [[...conds]], outputs: [{ layer: 'foreground1', x: 0, y: 0, gid: art.gid(art.set.wang.wallTerrain.tileset, lintel!) }, ...clear(0, 0)] });
  }
  // Old wall faces and their collisions under a horizontal door go, down to a wall or a door.
  const occupied = (x: number, y: number): Cond => ({ layer: 'walls', x, y, any: [NON_EMPTY] });
  rules.push({ indices: [[...horizontal, open(0, 1), occupied(0, 1)]], outputs: clear(0, 1) });
  rules.push({ indices: [[...horizontal, open(0, 1), open(0, 2), occupied(0, 2)]], outputs: clear(0, 2) });
  // A wall that now closes a door loses the door's lintel.
  const lintelTiles = art.set.wang.doorLintelTiles.map((t) => art.gid(art.set.wang.wallTerrain.tileset, t));
  rules.push({ indices: [[wall(0, 0), { layer: 'foreground1', x: 0, y: 0, any: lintelTiles }]], outputs: [{ layer: 'foreground1', x: 0, y: 0, gid: EMPTY }] });
  return rules;
}

// ---- faces.tmj ----

// The cell at column dx is solid when it is a wall or a wall face (a wall 1 or 2 cells above
// with nothing but open cells between), and open otherwise.
const solidAt = (dx: number): Cond[][] => [[wall(dx, 0)], [open(dx, 0), wall(dx, -1)], [open(dx, 0), open(dx, -1), wall(dx, -2)]];
const openAt = (dx: number): Cond[][] => [[door(dx, 0)], [open(dx, 0), door(dx, -1)], [open(dx, 0), open(dx, -1), notWall(dx, -2)]];

function faceRules(art: Art): Rule[] {
  const faces = art.set.wang.faceRules;
  const rules: Rule[] = [];
  const variants: [keyof FaceRow, boolean, boolean][] = [['mid', false, false], ['openW', true, false], ['openE', false, true], ['openWE', true, true]];
  // The outside style first: the rules for room styles overwrite it inside rooms.
  for (const style of [undefined, ...art.set.set.wallStyles.names]) {
    const tiles = faces.styles[style ?? faces.exteriorStyle]!;
    for (const row of [1, 2] as const) {
      const under = row === 1 ? [wall(0, -1), open(0, 0)] : [wall(0, -2), open(0, -1), open(0, 0)];
      const inside: Cond[] = style === undefined ? [] : [{ layer: 'wa_style', x: 0, y: 0, any: [marker(MARKERS.wallStyle[style]!)] }];
      for (const [variant, openWest, openEast] of variants) {
        const west = openWest ? openAt(-1) : solidAt(-1);
        const east = openEast ? openAt(1) : solidAt(1);
        rules.push({
          indices: west.flatMap((wc) => east.map((ec) => [...under, ...inside, ...wc, ...ec])),
          outputs: [
            { layer: 'walls', x: 0, y: 0, gid: art.gid(faces.tileset, (row === 1 ? tiles.row1 : tiles.row2)[variant]) },
            { layer: 'collisions', x: 0, y: 0, gid: art.collision },
          ],
        });
      }
    }
  }
  return rules;
}

// ---- floors.tmj ----

function floorRules(art: Art): Rule[] {
  const rules: Rule[] = [];
  const floor = (style: string): Out => {
    const ref = art.set.set.floorStyles.styles[style]!;
    return { layer: 'floor', x: 0, y: 0, gid: art.gid(ref.tileset!, ref.tile!) };
  };
  for (const style of FLOORS) rules.push({ indices: [[sketch(0, 0, { any: [marker(MARKERS.floor[style]!)] })]], outputs: [floor(style)] });
  const horizontal = [door(0, 0), wallOrDoor(-1, 0), wallOrDoor(1, 0)];
  const vertical = [door(0, 0), wallOrDoor(0, -1), wallOrDoor(0, 1)];
  // North and west rooms first, so the south or east room of a shared door wins.
  for (const [conds, dx, dy] of [[horizontal, 0, -1], [vertical, -1, 0], [horizontal, 0, 1], [vertical, 1, 0]] as const) {
    for (const style of FLOORS) {
      rules.push({ indices: [[...conds, sketch(dx, dy, { any: [marker(MARKERS.floor[style]!)] })]], outputs: [floor(style)] });
    }
  }
  return rules;
}

// ---- rule map files ----

function cellsOf(rule: Rule): { x: number; y: number }[] {
  return [...rule.indices.flat(), ...rule.outputs];
}

// Lays the rules out left to right on one row, one empty column apart, so Tiled applies them
// in this order, and writes the input, inputnot and output layers they need.
function ruleMap(rules: Rule[], tilesets: TiledEmbeddedTileset[]): TiledMap {
  const placed = [];
  let left = 1;
  let height = 0;
  for (const rule of rules) {
    const cells = cellsOf(rule);
    const minX = Math.min(...cells.map((c) => c.x));
    const maxX = Math.max(...cells.map((c) => c.x));
    const minY = Math.min(...cells.map((c) => c.y));
    const maxY = Math.max(...cells.map((c) => c.y));
    placed.push({ rule, ox: left - minX, oy: 1 - minY });
    left += maxX - minX + 2;
    height = Math.max(height, maxY - minY + 1);
  }
  const width = left;
  const mapHeight = height + 2;
  const indices = Math.max(...rules.map((r) => r.indices.length));
  const label = (i: number): string => (indices === 1 ? '' : String(i + 1));
  // How many same-name layers each kind of condition needs: one per tile of the longest list.
  const depth = new Map<string, number>();
  const need = (name: string, n: number): void => {
    depth.set(name, Math.max(depth.get(name) ?? 0, n));
  };
  for (const rule of rules) {
    rule.indices.forEach((conds, i) => {
      for (const c of conds) {
        if (c.any !== undefined) need(`input${label(i)}_${c.layer}`, c.any.length);
        if (c.none !== undefined) need(`inputnot${label(i)}_${c.layer}`, c.none.length);
      }
    });
    for (const o of rule.outputs) need(`output_${o.layer}`, 1);
  }
  const layers = new Map<string, number[][]>();
  for (const [name, n] of depth) layers.set(name, Array.from({ length: n }, () => new Array<number>(width * mapHeight).fill(0)));
  const put = (name: string, x: number, y: number, gids: number[]): void => {
    gids.forEach((gid, k) => {
      layers.get(name)![k]![y * width + x] = gid;
    });
  };
  for (const { rule, ox, oy } of placed) {
    rule.indices.forEach((conds, i) => {
      for (const c of conds) {
        if (c.any !== undefined) put(`input${label(i)}_${c.layer}`, c.x + ox, c.y + oy, c.any);
        if (c.none !== undefined) put(`inputnot${label(i)}_${c.layer}`, c.x + ox, c.y + oy, c.none);
      }
    });
    for (const o of rule.outputs) put(`output_${o.layer}`, o.x + ox, o.y + oy, [o.gid]);
  }
  // Inputs before outputs, each in a stable order.
  const names = [...layers.keys()].sort((a, b) => Number(a.startsWith('output')) - Number(b.startsWith('output')) || (a < b ? -1 : a > b ? 1 : 0));
  let id = 1;
  const tileLayers: TiledTileLayer[] = names.flatMap((name) =>
    layers.get(name)!.map((data) => ({ data, height: mapHeight, id: id++, name, opacity: 1, type: 'tilelayer', visible: true, width, x: 0, y: 0 })),
  );
  return {
    compressionlevel: -1,
    height: mapHeight,
    infinite: false,
    layers: tileLayers,
    nextlayerid: id,
    nextobjectid: 1,
    orientation: 'orthogonal',
    // Walls on the map edge match too: cells outside the map count as empty.
    properties: [{ name: 'MatchOutsideMap', type: 'bool', value: true }],
    renderorder: 'right-down',
    tiledversion: '1.12.2',
    tileheight: 32,
    tilesets,
    tilewidth: 32,
    type: 'map',
    version: '1.11',
    width,
  };
}

// A tileset as a rule map embeds it: the fields that make it the same tileset as the one a
// map embeds, with its image in the project's tilesets/.
function embedded(tsj: TiledTilesetFile, firstgid: number, image: string, tiles?: TiledEmbeddedTileset['tiles']): TiledEmbeddedTileset {
  const keep = ['columns', 'imageheight', 'imagewidth', 'margin', 'name', 'spacing', 'tilecount', 'tileheight', 'tileoffset', 'tilewidth'] as const;
  const fields = Object.fromEntries(keep.filter((k) => tsj[k] !== undefined).map((k) => [k, tsj[k]]));
  return { ...fields, firstgid, image: `${TO_PROJECT}${image}`, ...(tiles === undefined ? {} : { tiles }) } as TiledEmbeddedTileset;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 1)}\n`;
// Like Tiled: the tile ids of a layer on one line.
const ruleMapJson = (value: unknown): string => json(value).replace(/\[\n[\d,\n ]*\]/g, (list) => `[${list.slice(1, -1).replace(/\s+/g, '').replaceAll(',', ', ')}]`);

// Every file of the set, by path inside the set folder.
export async function officeAutomapFiles(): Promise<Map<string, string>> {
  const scratch = await mkdtemp(join(tmpdir(), 'wa-office-automap-'));
  let set: LoadedWangSet;
  try {
    await mkdir(join(scratch, 'tilesets'));
    set = wangSet(await loadAssetSet(DEFAULT_ASSET_SET, scratch));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const markersTsj = JSON.parse(await readFile(fileURLToPath(new URL('../assets/markers/wa-markers.tsj', import.meta.url)), 'utf8')) as TiledTilesetFile;
  const builder = set.tilesets.get(ROOM_BUILDER)!;
  const zones = set.tilesets.get(ZONES)!;
  const builderFirst = SPECIAL_FIRST + MARKER_PALETTE.length;
  const zonesFirst = builderFirst + builder.tsj.tilecount!;
  const tilesets = [
    embedded(markersTsj, MARKER_FIRST, MARKER_IMAGE),
    // The special tiles of the rules (MatchType), drawn with the marker image.
    embedded({ ...markersTsj, name: 'wa-automap-rules' }, SPECIAL_FIRST, MARKER_IMAGE, SPECIALS.map((m, id) => ({ id, properties: [{ name: 'MatchType', type: 'string', value: m }] }))),
    embedded(builder.tsj, builderFirst, builder.image),
    embedded(zones.tsj, zonesFirst, zones.image),
  ];
  const art: Art = {
    set,
    gid: (tileset, tile) => (tileset === ROOM_BUILDER ? builderFirst : tileset === ZONES ? zonesFirst : NaN) + tile,
    collision: zonesFirst + set.set.collisionTile.tile,
  };
  if (set.set.collisionTile.tileset !== ZONES || set.wang.wallTerrain.tileset !== ROOM_BUILDER || set.wang.faceRules.tileset !== ROOM_BUILDER) {
    throw new Error('the built-in set no longer draws walls from WA_Room_Builder and collisions from WA_Special_Zones');
  }

  const setJson = {
    id: SET_ID,
    title: 'Office walls drawn with automapping rules (wa-agent-engine proving set)',
    mapCopyright: set.set.mapCopyright,
    tilesets: set.set.tilesets.filter((t) => t.name === ZONES || t.name === ROOM_BUILDER),
    drawing: { mode: 'automap', rules: 'automap/rules.txt', markerTileset: MARKER_TILESET, markers: MARKERS },
    wallStyles: set.set.wallStyles,
    floorStyles: { default: set.set.floorStyles.default, styles: Object.fromEntries(FLOORS.map((f) => [f, {}])) },
    collisionTile: set.set.collisionTile,
    startTile: set.set.startTile,
    prefabs: [],
  };
  const files = new Map<string, string>();
  files.set('set.json', json(setJson));
  for (const t of setJson.tilesets) files.set(t.tsj, await readFile(join(BUILTIN_SETS_DIR, DEFAULT_ASSET_SET, t.tsj), 'utf8'));
  files.set('automap/rules.txt', '# Office walls, faces and floors, drawn from the sketch a room build paints.\nwalls.tmj\nfaces.tmj\nfloors.tmj\n');
  files.set('automap/walls.tmj', ruleMapJson(ruleMap(wallRules(art), tilesets)));
  files.set('automap/faces.tmj', ruleMapJson(ruleMap(faceRules(art), tilesets)));
  files.set('automap/floors.tmj', ruleMapJson(ruleMap(floorRules(art), tilesets)));
  return files;
}

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) out.push(...(await listFiles(join(dir, e.name), `${prefix}${e.name}/`)));
    else out.push(`${prefix}${e.name}`);
  }
  return out;
}

// The files on disk that differ from what the generator writes, or are missing or extra.
export async function staleOfficeAutomapFiles(dir = OFFICE_AUTOMAP_DIR): Promise<string[]> {
  const files = await officeAutomapFiles();
  const stale: string[] = [];
  for (const [rel, text] of files) if ((await readFile(join(dir, rel), 'utf8').catch(() => undefined)) !== text) stale.push(rel);
  for (const rel of await listFiles(dir)) if (!files.has(rel)) stale.push(rel);
  return stale;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { check: { type: 'boolean' } }, strict: true, allowPositionals: false });
  if (values.check === true) {
    const stale = await staleOfficeAutomapFiles();
    if (stale.length > 0) {
      console.error(`${OFFICE_AUTOMAP_DIR} is stale (${stale.join(', ')}); run: npx tsx scripts/gen-office-automap.ts`);
      process.exitCode = 1;
    }
  } else {
    const files = await officeAutomapFiles();
    await rm(OFFICE_AUTOMAP_DIR, { recursive: true, force: true });
    for (const [rel, text] of files) {
      await mkdir(join(OFFICE_AUTOMAP_DIR, rel, '..'), { recursive: true });
      await writeFile(join(OFFICE_AUTOMAP_DIR, rel), text);
    }
    console.log(`wrote ${files.size} files to ${OFFICE_AUTOMAP_DIR}`);
  }
}
