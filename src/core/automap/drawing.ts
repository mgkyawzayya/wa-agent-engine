import { basename } from 'node:path';
import type { ExternalTilesetInfo, RuleSet } from '../../schemas/automap.schema.js';
import type { Rect } from '../../schemas/dsl.schema.js';
import { isExternalTileset, type TiledMap, type TiledTileLayer } from '../../schemas/tiled.schema.js';
import type { LoadedAutomapSet } from '../asset-set-registry.js';
import { WaEngineError, type ErrorBody } from '../errors.js';
import { decodeGid, tilesetForGid } from '../gid.js';
import { readTileData, TILE_ROLES, type TileRole } from '../layers.js';
import { createEmptyMap } from '../map-io.js';
import { embedSetTilesets } from '../tile-writer.js';
import { automap } from './engine.js';
import { loadRules } from './rules-file.js';

// Drawing rooms with an asset set's automapping rules. The rules run on a scratch map whose
// tile layers carry the role names an engine-built map uses (walls, floor, wa_sketch, ...), so
// they work on any layer layout, and every tile they change goes back through the caller,
// which records it like any other write of the build.

export const ROLE_LAYER_NAMES: Readonly<Record<TileRole, string>> = {
  start: 'start',
  collisions: 'collisions',
  sketch: 'wa_sketch',
  sketchStyle: 'wa_style',
  floor: 'floor',
  walls: 'walls',
  furniture1: 'furniture1',
  furniture2: 'furniture2',
  furniture3: 'furniture3',
  foreground1: 'foreground1',
  foreground2: 'foreground2',
};

// The roles rules may draw on: art and collisions, never the start tiles or the sketch.
export const DRAWING_OUTPUT_ROLES: readonly TileRole[] = ['collisions', 'floor', 'walls', 'furniture1', 'furniture2', 'furniture3', 'foreground1', 'foreground2'];

const roleNamed = (name: string): TileRole | undefined => TILE_ROLES.find((role) => ROLE_LAYER_NAMES[role] === name);

function invalid(set: LoadedAutomapSet, message: string, details?: unknown): WaEngineError {
  return new WaEngineError('ASSET_SET_INVALID', `asset set "${set.id}": ${message}`, details);
}

// Loads the set's rules and checks that they draw only on the roles they may.
export async function loadDrawingRules(set: LoadedAutomapSet, projectDir: string): Promise<RuleSet> {
  const rules = await loadRules(projectDir, await set.resolveFile(set.drawing.rules, ['.txt', '.tmj', '.json']));
  const allowed = DRAWING_OUTPUT_ROLES.map((role) => ROLE_LAYER_NAMES[role]);
  for (const { ruleMap } of rules.references) {
    const bad = ruleMap.outputTileLayerNames.filter((name) => !allowed.includes(name));
    if (bad.length > 0) {
      throw invalid(set, `rule map ${ruleMap.relPath} draws on ${bad.map((n) => `"${n}"`).join(', ')}; an asset set's rules may draw only on ${allowed.join(', ')}`, {
        ruleMap: ruleMap.relPath,
        layers: bad,
      });
    }
  }
  return rules;
}

export interface RoleChange {
  role: TileRole;
  x: number;
  y: number;
  raw: number;
}

export interface DrawingRun {
  changes: RoleChange[];
  matches: number;
  warnings: ErrorBody[];
}

export interface DrawingOptions {
  mapAbs: string;
  region?: readonly Rect[];
  externalTilesets?: Record<string, ExternalTilesetInfo>;
}

function scratchLayer(id: number, name: string, width: number, height: number, data: Uint32Array): TiledTileLayer {
  return { id, name, type: 'tilelayer', x: 0, y: 0, width, height, opacity: 1, visible: true, data: Array.from(data) };
}

// Runs the rules over the map's role layers (`read` gives a role's tiles as they are now, or
// undefined when the map has no such layer) and returns the cells they changed. The map itself
// is not changed. The rules may only draw with the set's own tilesets.
export function drawWithRules(
  set: LoadedAutomapSet,
  map: TiledMap,
  read: (role: TileRole) => Uint32Array | undefined,
  rules: RuleSet,
  options: DrawingOptions,
): DrawingRun {
  const before = new Map<TileRole, Uint32Array>();
  const layers: TiledTileLayer[] = [];
  for (const role of TILE_ROLES) {
    const data = read(role);
    if (data === undefined) continue;
    before.set(role, data);
    layers.push(scratchLayer(layers.length + 1, ROLE_LAYER_NAMES[role], map.width, map.height, data));
  }
  const scratch: TiledMap = {
    orientation: map.orientation,
    width: map.width,
    height: map.height,
    tilewidth: map.tilewidth,
    tileheight: map.tileheight,
    nextlayerid: layers.length + 1,
    layers,
    tilesets: structuredClone(map.tilesets),
  };
  const report = automap(scratch, rules, {
    mapAbs: options.mapAbs,
    mapFileName: basename(options.mapAbs),
    seed: 0,
    ...(options.region === undefined ? {} : { region: options.region }),
    ...(options.externalTilesets === undefined ? {} : { externalTilesets: options.externalTilesets }),
  });
  if (scratch.tilesets.length > map.tilesets.length) {
    const added = scratch.tilesets.slice(map.tilesets.length).map((t) => (isExternalTileset(t) ? t.source : t.name));
    throw invalid(set, `its rules draw with ${added.map((n) => `tileset "${n}"`).join(', ')}, which the set does not list (or whose image or tile size differs from the set's); list it in set.json`, {
      tilesets: added,
    });
  }
  const warnings = [...report.warnings];
  const changes: RoleChange[] = [];
  const foreign = new Set<string>();
  for (const layer of scratch.layers) {
    const role = layer.type === 'tilelayer' ? roleNamed(layer.name) : undefined;
    if (role === undefined || layer.type !== 'tilelayer') continue;
    if ((layer.properties ?? []).length > 0) {
      warnings.push({ code: 'AUTOMAP_RULES_IGNORED', message: `the rules set properties on layer "${layer.name}"; a room build does not copy layer properties`, details: { layer: layer.name } });
    }
    const old = before.get(role);
    const now = readTileData(layer);
    for (let i = 0; i < now.length; i++) {
      const raw = now[i]!;
      if (raw === (old?.[i] ?? 0)) continue;
      changes.push({ role, x: i % map.width, y: Math.floor(i / map.width), raw });
      const hit = raw === 0 ? undefined : tilesetForGid(scratch.tilesets, decodeGid(raw).gid);
      const name = hit === undefined ? undefined : isExternalTileset(hit.tileset) ? hit.tileset.source : hit.tileset.name;
      if (name !== undefined && !set.tilesets.has(name)) foreign.add(name);
    }
  }
  // A tileset the map has but the set does not list would make the set draw differently on
  // another map.
  if (foreign.size > 0) {
    throw invalid(set, `its rules draw with ${[...foreign].map((n) => `tileset "${n}"`).join(', ')}, which the set does not list; list it in set.json`, {
      tilesets: [...foreign],
    });
  }
  return { changes, matches: report.matches, warnings };
}

// ---- coverage: what the rules draw for each piece rooms can need ----

type Mark = 'wall' | 'door';

interface Probe {
  name: string;
  role: TileRole;
  x: number;
  y: number;
}

interface Block {
  marks: [number, number, Mark | { floor: string }][];
  // Cells that get a wall style's marker on wa_style.
  styled?: { style: string; cells: [number, number][] };
  probes: Probe[];
}

// Each piece in its own 8x8 block, with room around it for the rules' input boxes and faces.
const BLOCK = 8;
const BLOCK_COLUMNS = 8;

function coverageBlocks(set: LoadedAutomapSet): Block[] {
  const blocks: Block[] = [];
  for (let mask = 0; mask < 16; mask++) {
    const [n, e, s, w] = [(mask >> 3) & 1, (mask >> 2) & 1, (mask >> 1) & 1, mask & 1];
    const marks: Block['marks'] = [[3, 3, 'wall']];
    if (n === 1) marks.push([3, 2, 'wall']);
    if (e === 1) marks.push([4, 3, 'wall']);
    if (s === 1) marks.push([3, 4, 'wall']);
    if (w === 1) marks.push([2, 3, 'wall']);
    blocks.push({ marks, probes: [{ name: `wall N${n} E${e} S${s} W${w}`, role: 'walls', x: 3, y: 3 }] });
  }
  blocks.push({
    marks: [[1, 3, 'wall'], [2, 3, 'wall'], [3, 3, 'door'], [4, 3, 'wall'], [5, 3, 'wall']],
    probes: [
      { name: 'horizontal lintel', role: 'foreground1', x: 3, y: 3 },
      { name: 'wall west of a door', role: 'walls', x: 2, y: 3 },
      { name: 'wall east of a door', role: 'walls', x: 4, y: 3 },
    ],
  });
  blocks.push({
    marks: [[3, 1, 'wall'], [3, 2, 'wall'], [3, 3, 'door'], [3, 4, 'wall'], [3, 5, 'wall']],
    probes: [
      { name: 'vertical lintel', role: 'foreground1', x: 3, y: 3 },
      { name: 'wall above a door', role: 'walls', x: 3, y: 2 },
      { name: 'wall below a door', role: 'walls', x: 3, y: 4 },
    ],
  });
  // Faces under a 3-cell wall (open on the west, middle, open on the east) and under a single
  // wall cell (open on both sides), in both rows, for each wall style and outside rooms.
  const variants: [number, string][] = [[1, 'open west'], [2, 'middle'], [3, 'open east'], [6, 'open on both sides']];
  for (const style of [...set.set.wallStyles.names, undefined]) {
    const label = style === undefined ? 'outside rooms' : `of wall style ${style}`;
    const faces = variants.flatMap(([x]) => [[x, 3], [x, 4]] as [number, number][]);
    blocks.push({
      marks: variants.map(([x]): [number, number, Mark] => [x, 2, 'wall']),
      ...(style === undefined ? {} : { styled: { style, cells: faces } }),
      probes: variants.flatMap(([x, variant]) =>
        [1, 2].map((row): Probe => ({ name: `face ${label}, row ${row}, ${variant}`, role: 'walls', x, y: 2 + row })),
      ),
    });
  }
  for (const floor of Object.keys(set.drawing.markers.floor)) {
    blocks.push({ marks: [[3, 3, { floor }]], probes: [{ name: `floor ${floor}`, role: 'floor', x: 3, y: 3 }] });
  }
  return blocks;
}

// Runs the rules on a sketch of every wall pattern, door, face variant and floor style, and
// returns the pieces they draw no tile for. Read-only: the sketch lives in memory.
export async function drawingCoverage(set: LoadedAutomapSet, rules: RuleSet, projectDir: string, mapAbs: string): Promise<string[]> {
  const blocks = coverageBlocks(set);
  const width = BLOCK * Math.min(blocks.length, BLOCK_COLUMNS);
  const height = BLOCK * Math.ceil(blocks.length / BLOCK_COLUMNS);
  const scratch = createEmptyMap(width, height);
  await embedSetTilesets(projectDir, scratch, mapAbs, set);
  const markers = scratch.tilesets.find((t) => !isExternalTileset(t) && t.name === set.drawing.markerTileset)!;
  const { wall, door, floor, wallStyle } = set.drawing.markers;
  const sketch = new Uint32Array(width * height);
  const style = new Uint32Array(width * height);
  blocks.forEach((block, i) => {
    const left = (i % BLOCK_COLUMNS) * BLOCK;
    const top = Math.floor(i / BLOCK_COLUMNS) * BLOCK;
    for (const [x, y, mark] of block.marks) {
      sketch[(top + y) * width + left + x] = markers.firstgid + (mark === 'wall' ? wall : mark === 'door' ? door : floor[mark.floor]!);
    }
    for (const [x, y] of block.styled?.cells ?? []) style[(top + y) * width + left + x] = markers.firstgid + wallStyle[block.styled!.style]!;
  });
  const empty = new Uint32Array(width * height);
  const run = drawWithRules(set, scratch, (role) => (role === 'sketch' ? sketch : role === 'sketchStyle' ? style : empty), rules, { mapAbs });
  const drawn = new Set(run.changes.filter((c) => c.raw !== 0).map((c) => `${c.role}:${c.x}:${c.y}`));
  return blocks.flatMap((block, i) => {
    const left = (i % BLOCK_COLUMNS) * BLOCK;
    const top = Math.floor(i / BLOCK_COLUMNS) * BLOCK;
    return block.probes.filter((p) => !drawn.has(`${p.role}:${left + p.x}:${top + p.y}`)).map((p) => p.name);
  });
}
