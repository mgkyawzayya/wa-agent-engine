import { createHash } from 'node:crypto';
import { stat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
  InputConditionsDef,
  InputLayerDef,
  InputSetDef,
  MatchKind,
  OutputLayerDef,
  OutputSetDef,
  RuleBox,
  RuleCell,
  RuleDef,
  RuleLayerGrid,
  RuleMap,
  RuleMapOptions,
  RuleOptions,
  RuleOutput,
  RuleTileset,
} from '../../schemas/automap.schema.js';
import {
  isExternalTileset,
  TiledTilesetFileSchema,
  type TiledLayer,
  type TiledMap,
  type TiledObject,
  type TiledProperty,
  type TiledTileLayer,
  type TiledTilesetFile,
  type TiledTilesetFields,
} from '../../schemas/tiled.schema.js';
import { WaEngineError, type ErrorBody } from '../errors.js';
import { readTileData } from '../layers.js';
import { MAX_MAP_DIMENSION } from '../limits.js';
import { readMap } from '../map-io.js';
import { resolveMapRelative } from '../project-paths.js';
import { FILE_ONLY_KEYS } from '../tileset-embed.js';
import { FLAG_D, FLAG_H, FLAG_HEX, FLAG_V, GID_MASK, tilesetIdentity, VISUAL_FLAGS } from './cells.js';
import { coherentRegions, Region, type RegionRect } from './region.js';

// Rule maps larger than this are refused, like the DSL's map limit.
export const MAX_RULE_MAP_TILES = 500;

const MATCH_KINDS: readonly MatchKind[] = ['Empty', 'NonEmpty', 'Other', 'Negate', 'Ignore'];
const NONE: RuleCell = { kind: 'none' };

function invalid(ruleMap: string, message: string, details: Record<string, unknown> = {}): WaEngineError {
  return new WaEngineError('AUTOMAP_RULES_INVALID', `${ruleMap}: ${message}`, { ruleMap, ...details });
}

function unsupported(ruleMap: string, feature: string, message: string): WaEngineError {
  return new WaEngineError('AUTOMAP_UNSUPPORTED', `${ruleMap}: ${message}`, { ruleMap, feature });
}

// ---- property values, converted the way Qt's QVariant converts them ----

type Converted<T> = { ok: true; value: T } | { ok: false };

// Colours, files, object references and class values do not convert to bools or numbers.
const convertible = (p: TiledProperty): boolean => p.type === undefined || ['bool', 'int', 'float', 'string'].includes(p.type);

function toBool(p: TiledProperty): Converted<boolean> {
  const value = p.value;
  if (!convertible(p)) return { ok: false };
  if (typeof value === 'boolean') return { ok: true, value };
  if (typeof value === 'number') return { ok: true, value: value !== 0 };
  if (typeof value === 'string') {
    const s = value.toLowerCase();
    return { ok: true, value: !(s === '' || s === '0' || s === 'false') };
  }
  return { ok: false };
}

// `lenient`: a string that is not a number reads as 0, as QVariant::value<qreal>() gives it;
// otherwise it does not convert (QVariant::toReal(&ok)).
function toReal(p: TiledProperty, lenient: boolean): Converted<number> {
  const value = p.value;
  if (!convertible(p)) return { ok: false };
  if (typeof value === 'number') return { ok: true, value };
  if (typeof value === 'boolean') return { ok: true, value: value ? 1 : 0 };
  if (typeof value === 'string') {
    const n = Number(value.trim());
    if (value.trim() !== '' && Number.isFinite(n)) return { ok: true, value: n };
    return lenient ? { ok: true, value: 0 } : { ok: false };
  }
  return { ok: false };
}

function toInt(p: TiledProperty): Converted<number> {
  const value = p.value;
  if (!convertible(p)) return { ok: false };
  if (typeof value === 'number') return { ok: true, value: Math.round(value) | 0 };
  if (typeof value === 'boolean') return { ok: true, value: value ? 1 : 0 };
  if (typeof value === 'string') return { ok: true, value: /^\s*[+-]?\d+\s*$/.test(value) ? Number.parseInt(value, 10) | 0 : 0 };
  return { ok: false };
}

const toUnsigned = (p: TiledProperty): Converted<number> => {
  const n = toInt(p);
  return n.ok ? { ok: true, value: n.value >>> 0 } : n;
};

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export function defaultRuleOptions(): RuleOptions {
  return { skipChance: 0, modX: 1, modY: 1, offsetX: 0, offsetY: 0, noOverlappingOutput: false, disabled: false, ignoreLock: false };
}

type RuleOptionKey = keyof RuleOptions;

// Applies one rule option property; returns the option it set, or undefined when the name is
// not a rule option or its value does not convert.
function applyRuleOption(options: RuleOptions, p: TiledProperty): RuleOptionKey | undefined {
  if (same(p.name, 'Probability')) {
    const v = toReal(p, true);
    if (!v.ok) return undefined;
    options.skipChance = 1 - v.value;
    return 'skipChance';
  }
  for (const [key, field] of [['ModX', 'modX'], ['ModY', 'modY']] as const) {
    if (same(p.name, key)) {
      const v = toUnsigned(p);
      if (!v.ok) return undefined;
      options[field] = Math.max(1, v.value);
      return field;
    }
  }
  for (const [key, field] of [['OffsetX', 'offsetX'], ['OffsetY', 'offsetY']] as const) {
    if (same(p.name, key)) {
      const v = toInt(p);
      if (!v.ok) return undefined;
      options[field] = v.value;
      return field;
    }
  }
  for (const [key, field] of [['NoOverlappingOutput', 'noOverlappingOutput'], ['Disabled', 'disabled'], ['IgnoreLock', 'ignoreLock']] as const) {
    if (same(p.name, key)) {
      const v = toBool(p);
      if (!v.ok) return undefined;
      options[field] = v.value;
      return field;
    }
  }
  return undefined;
}

function mergeOptions(self: RuleOptions, other: RuleOptions, set: ReadonlySet<RuleOptionKey>): void {
  for (const key of set) Object.assign(self, { [key]: other[key] });
}

// ---- tilesets ----

// The tileset as a working map would embed it: image paths made absolute for now; the core
// rewrites them relative to the working map when it adds the tileset.
function embeddable(fields: TiledTilesetFields, baseDir: string): TiledTilesetFile {
  const copy = structuredClone(fields) as Record<string, unknown>;
  for (const key of ['firstgid', ...FILE_ONLY_KEYS]) delete copy[key];
  const abs = (p: string): string => resolve(baseDir, p.replaceAll('\\', '/'));
  if (typeof copy.image === 'string') copy.image = abs(copy.image);
  for (const tile of (copy.tiles as { image?: string }[] | undefined) ?? []) if (tile.image !== undefined) tile.image = abs(tile.image);
  return copy as TiledTilesetFile;
}

// Why a tileset's images cannot be given to a working map, if they cannot: outside the
// project, or missing.
async function imageProblem(projectDir: string, ownerAbs: string, fields: TiledTilesetFields): Promise<string | undefined> {
  const images = [fields.image, ...(fields.tiles ?? []).map((t) => t.image)].filter((i): i is string => i !== undefined);
  if (images.length === 0) return `tileset "${fields.name}" has no image`;
  for (const image of images) {
    let abs: string;
    try {
      abs = await resolveMapRelative(projectDir, ownerAbs, image);
    } catch {
      return `tileset "${fields.name}" uses an image outside the project: ${image}`;
    }
    try {
      if (!(await stat(abs)).isFile()) throw new Error('not a file');
    } catch {
      return `tileset "${fields.name}" uses an image that does not exist: ${image}`;
    }
  }
  return undefined;
}

async function loadTilesets(projectDir: string, abs: string, map: TiledMap): Promise<{ tilesets: RuleTileset[]; fields: (TiledTilesetFields | undefined)[] }> {
  const tilesets: RuleTileset[] = [];
  const fields: (TiledTilesetFields | undefined)[] = [];
  for (const ts of [...map.tilesets].sort((a, b) => a.firstgid - b.firstgid)) {
    if (!isExternalTileset(ts)) {
      tilesets.push({
        name: ts.name,
        firstgid: ts.firstgid,
        tilecount: ts.tilecount ?? 0,
        identity: tilesetIdentity(ts, dirname(abs)),
        embed: embeddable(ts, dirname(abs)),
        unusable: await imageProblem(projectDir, abs, ts),
      });
      fields.push(ts);
      continue;
    }
    // External tileset: only JSON files can be read. An XML .tsx cannot be read at all, so
    // its tiles (and their MatchType) are unknown and any tile from it is refused.
    let file: TiledTilesetFile | undefined;
    let sourceAbs: string | undefined;
    let unusable: string | undefined;
    try {
      sourceAbs = await resolveMapRelative(projectDir, abs, ts.source, { ext: ['.tsj', '.json'] });
      file = TiledTilesetFileSchema.parse(JSON.parse(await readFile(sourceAbs, 'utf8'))) as TiledTilesetFile;
    } catch (err) {
      unusable =
        err instanceof WaEngineError && err.code === 'PATH_BAD_EXTENSION'
          ? `external tileset "${ts.source}" is not a JSON tileset; embed it in the rule map or save it as .tsj`
          : `external tileset "${ts.source}" cannot be read`;
    }
    if (file === undefined || sourceAbs === undefined) {
      tilesets.push({ name: ts.source, firstgid: ts.firstgid, tilecount: 0, identity: undefined, embed: undefined, unusable });
      fields.push(undefined);
      continue;
    }
    tilesets.push({
      name: file.name,
      firstgid: ts.firstgid,
      tilecount: file.tilecount ?? 0,
      identity: `source:${sourceAbs}`,
      embed: embeddable(file, dirname(sourceAbs)),
      unusable: await imageProblem(projectDir, sourceAbs, file),
    });
    fields.push(file);
  }
  return { tilesets, fields };
}

function matchTypeOf(fields: TiledTilesetFields | undefined, localId: number): MatchKind | undefined {
  const prop = fields?.tiles?.find((t) => t.id === localId)?.properties?.find((p) => p.name === 'MatchType');
  if (prop === undefined || typeof prop.value !== 'string') return undefined;
  return (MATCH_KINDS as readonly string[]).includes(prop.value) ? (prop.value as MatchKind) : undefined;
}

// ---- layers ----

function allLayers(layers: readonly TiledLayer[], out: TiledLayer[] = []): TiledLayer[] {
  for (const layer of layers) {
    if (layer.type === 'group') allLayers(layer.layers, out);
    else out.push(layer);
  }
  return out;
}

function makeDecoder(relPath: string, tilesets: RuleTileset[], fields: (TiledTilesetFields | undefined)[]): (raw: number, layerName: string) => RuleCell {
  const cache = new Map<number, RuleCell>();
  return (raw, layerName) => {
    const gid = raw & GID_MASK;
    if (gid === 0) return NONE;
    const cached = cache.get(raw >>> 0);
    if (cached !== undefined) return cached;
    let index = -1;
    for (let i = 0; i < tilesets.length; i++) if (tilesets[i]!.firstgid <= gid) index = i;
    const ts = tilesets[index];
    const localId = ts === undefined ? -1 : gid - ts.firstgid;
    if (ts === undefined || (fields[index] !== undefined && localId >= ts.tilecount)) {
      throw invalid(relPath, `layer "${layerName}" uses tile id ${gid}, which no tileset of the rule map has`, { layer: layerName, gid });
    }
    const match = matchTypeOf(fields[index], localId);
    let cell: RuleCell;
    if (match !== undefined) cell = { kind: 'special', match };
    else if (ts.unusable !== undefined || ts.identity === undefined) {
      throw invalid(relPath, ts.unusable ?? `tileset "${ts.name}" cannot be compared with a working map`, { tileset: ts.name, layer: layerName });
    } else cell = { kind: 'tile', tileset: index, localId, flags: (raw & ~GID_MASK) >>> 0 };
    cache.set(raw >>> 0, cell);
    return cell;
  };
}

function decodeLayer(relPath: string, layer: TiledTileLayer, map: TiledMap, decode: (raw: number, layerName: string) => RuleCell): RuleLayerGrid {
  if (layer.width !== map.width || layer.height !== map.height) {
    throw invalid(relPath, `layer "${layer.name}" is ${layer.width}x${layer.height}, not the map size ${map.width}x${map.height}`, { layer: layer.name });
  }
  let data: Uint32Array;
  try {
    data = readTileData(layer);
  } catch (err) {
    throw invalid(relPath, `layer "${layer.name}" has unreadable tile data`, { layer: layer.name, reason: err instanceof WaEngineError ? err.code : 'error' });
  }
  const cells = new Array<RuleCell>(data.length);
  for (let i = 0; i < data.length; i++) cells[i] = decode(data[i]!, layer.name);
  return { layerName: layer.name, cells };
}

function nonEmptyCells(grid: RuleLayerGrid, width: number): [number, number][] {
  const out: [number, number][] = [];
  grid.cells.forEach((c, i) => {
    if (c.kind !== 'none') out.push([i % width, Math.floor(i / width)]);
  });
  return out;
}

function ignoredWarning(relPath: string, message: string, details: Record<string, unknown> = {}): ErrorBody {
  return { code: 'AUTOMAP_RULES_IGNORED', message: `${relPath}: ${message}`, details: { ruleMap: relPath, ...details } };
}

// Tiled's objectTileRect: the object's pixel bounds converted to tiles and aligned outward.
function objectTileRect(o: TiledObject, map: TiledMap): RegionRect {
  return {
    left: Math.floor(o.x / map.tilewidth),
    top: Math.floor(o.y / map.tileheight),
    right: Math.ceil((o.x + (o.width ?? 0)) / map.tilewidth) - 1,
    bottom: Math.ceil((o.y + (o.height ?? 0)) / map.tileheight) - 1,
  };
}

const isPlainRectangle = (o: TiledObject): boolean =>
  o.gid === undefined && o.ellipse !== true && o.point !== true && o.polygon === undefined && o.polyline === undefined && o.text === undefined && o.capsule !== true;

// ---- the loader ----

export async function loadRuleMap(projectDir: string, abs: string, relPath: string): Promise<RuleMap> {
  let map: TiledMap;
  try {
    ({ map } = await readMap(abs));
  } catch (err) {
    if (err instanceof WaEngineError && err.code === 'MAP_NOT_FOUND') {
      throw new WaEngineError('AUTOMAP_RULES_NOT_FOUND', `rule map not found: ${relPath}`, { ruleMap: relPath });
    }
    throw invalid(relPath, 'not a readable Tiled JSON map', { reason: err instanceof WaEngineError ? err.code : 'error' });
  }
  if (map.orientation !== 'orthogonal') throw unsupported(relPath, 'orientation', `only orthogonal rule maps are supported, not "${map.orientation}"`);
  if (map.infinite === true) throw unsupported(relPath, 'infinite', 'infinite rule maps are not supported');
  if (!Number.isInteger(map.width) || !Number.isInteger(map.height) || map.width < 1 || map.height < 1 || map.width > MAX_RULE_MAP_TILES || map.height > MAX_RULE_MAP_TILES) {
    throw invalid(relPath, `rule maps must be 1x1 to ${MAX_RULE_MAP_TILES}x${MAX_RULE_MAP_TILES} tiles, not ${map.width}x${map.height}`);
  }

  const warnings: ErrorBody[] = [];
  const { tilesets, fields } = await loadTilesets(projectDir, abs, map);
  const decode = makeDecoder(relPath, tilesets, fields);

  // Map properties: options of the rule map and default rule options.
  const options: RuleMapOptions = { deleteTiles: false, matchOutsideMap: false, overflowBorder: false, wrapBorder: false, matchInOrder: false, automappingRadius: 0 };
  const ruleDefaults = defaultRuleOptions();
  const setDefaults = new Set<RuleOptionKey>();
  let noOverlappingRules = false;
  for (const p of map.properties ?? []) {
    const boolOption = (name: string, set: (v: boolean) => void): boolean => {
      if (!same(p.name, name)) return false;
      const v = toBool(p);
      if (v.ok) set(v.value);
      return v.ok;
    };
    if (boolOption('DeleteTiles', (v) => (options.deleteTiles = v))) continue;
    if (boolOption('MatchOutsideMap', (v) => (options.matchOutsideMap = v))) continue;
    if (boolOption('OverflowBorder', (v) => (options.overflowBorder = v))) continue;
    if (boolOption('WrapBorder', (v) => (options.wrapBorder = v))) continue;
    if (same(p.name, 'AutomappingRadius')) {
      const v = toInt(p);
      if (v.ok) {
        if (Math.abs(v.value) > MAX_MAP_DIMENSION) {
          throw invalid(relPath, `AutomappingRadius ${v.value} is larger than ${MAX_MAP_DIMENSION}, the largest map`, { property: p.name });
        }
        options.automappingRadius = v.value;
        continue;
      }
    }
    if (boolOption('NoOverlappingRules', (v) => (noOverlappingRules = v))) continue;
    if (boolOption('MatchInOrder', (v) => (options.matchInOrder = v))) continue;
    const set = applyRuleOption(ruleDefaults, p);
    if (set !== undefined) {
      setDefaults.add(set);
      continue;
    }
    warnings.push(ignoredWarning(relPath, `unknown map property "${p.name}" is ignored`, { property: p.name }));
  }
  if (options.overflowBorder || options.wrapBorder) options.matchOutsideMap = true;
  if (!setDefaults.has('noOverlappingOutput')) ruleDefaults.noOverlappingOutput = noOverlappingRules;

  // Layers.
  const inputSets: InputSetDef[] = [];
  const outputSets: OutputSetDef[] = [];
  const inputLayerNames: string[] = [];
  const outputTileLayerNames: string[] = [];
  const optionAreas: { area: RegionRect; options: RuleOptions; set: Set<RuleOptionKey> }[] = [];
  const errors: string[] = [];

  for (const layer of allLayers(map.layers)) {
    if (layer.type === 'imagelayer') continue;
    const name = layer.name;
    if (name.startsWith('//')) continue;
    const lower = name.toLowerCase();
    if (lower.startsWith('regions')) {
      if (lower === 'regions' || lower.endsWith('input') || lower.endsWith('output')) {
        throw unsupported(relPath, 'legacy-regions', `layer "${name}": legacy regions layers are not supported; remove them and let the input and output layers define the rules`);
      }
      warnings.push(ignoredWarning(relPath, `layer "${name}" is not an automapping layer and is ignored`, { layer: name }));
      continue;
    }
    if (lower === 'rule_options') {
      if (layer.type !== 'objectgroup') {
        errors.push(`"rule_options" must be an object layer`);
        continue;
      }
      for (const o of layer.objects) {
        if (!isPlainRectangle(o)) {
          warnings.push(ignoredWarning(relPath, `only rectangles are used on "rule_options"; object ${o.id} is ignored`, { object: o.id }));
          continue;
        }
        if (typeof o.rotation === 'number' && o.rotation !== 0) {
          warnings.push(ignoredWarning(relPath, `rotated rectangles are not supported on "rule_options"; object ${o.id} is ignored`, { object: o.id }));
          continue;
        }
        const area = { area: objectTileRect(o, map), options: defaultRuleOptions(), set: new Set<RuleOptionKey>() };
        for (const p of o.properties ?? []) {
          const set = applyRuleOption(area.options, p);
          if (set !== undefined) area.set.add(set);
          else warnings.push(ignoredWarning(relPath, `unknown rule option "${p.name}" on object ${o.id} is ignored`, { object: o.id, property: p.name }));
        }
        optionAreas.push(area);
      }
      continue;
    }
    const underscore = name.indexOf('_');
    if (underscore === -1) {
      if (layer.type === 'objectgroup') throw unsupported(relPath, 'object-layers', `object layer "${name}" is not supported in rule maps (only "rule_options")`);
      errors.push(`layer "${name}" has no "_" between its prefix and its target layer`);
      continue;
    }
    const target = name.slice(underscore + 1);
    let setName = name.slice(0, underscore);
    const lowerSet = setName.toLowerCase();
    if (lowerSet.startsWith('output')) setName = setName.slice(6);
    else if (lowerSet.startsWith('inputnot')) setName = setName.slice(8);
    else if (lowerSet.startsWith('input')) setName = setName.slice(5);

    if (lower.startsWith('input')) {
      if (layer.type !== 'tilelayer') {
        if (layer.type === 'objectgroup') throw unsupported(relPath, 'object-layers', `object layer "${name}": input layers must be tile layers`);
        errors.push(`"${name}": input layers must be tile layers`);
        continue;
      }
      if (!inputLayerNames.includes(target)) inputLayerNames.push(target);
      const inputLayer: InputLayerDef = { grid: decodeLayer(relPath, layer, map, decode), strictEmpty: false, flagsMask: VISUAL_FLAGS };
      for (const p of layer.properties ?? []) {
        const v = toBool(p);
        if ((same(p.name, 'StrictEmpty') || same(p.name, 'AutoEmpty')) && v.ok) {
          inputLayer.strictEmpty = v.value;
          continue;
        }
        const flag = same(p.name, 'IgnoreHorizontalFlip') ? FLAG_H
          : same(p.name, 'IgnoreVerticalFlip') ? FLAG_V
          : same(p.name, 'IgnoreDiagonalFlip') ? FLAG_D
          : same(p.name, 'IgnoreHexRotate120') ? FLAG_HEX
          : undefined;
        if (flag !== undefined && v.ok && v.value) {
          inputLayer.flagsMask = (inputLayer.flagsMask & ~flag) >>> 0;
          continue;
        }
        warnings.push(ignoredWarning(relPath, `unknown property "${p.name}" on layer "${name}" is ignored`, { layer: name, property: p.name }));
      }
      let set = inputSets.find((s) => s.name === setName);
      if (set === undefined) inputSets.push((set = { name: setName, layers: [] }));
      let conditions = set.layers.find((c) => c.layerName === target);
      if (conditions === undefined) set.layers.push((conditions = { layerName: target, listYes: [], listNo: [] } satisfies InputConditionsDef));
      if (lower.startsWith('inputnot')) conditions.listNo.push(inputLayer);
      else conditions.listYes.push(inputLayer);
      continue;
    }

    if (lower.startsWith('output')) {
      if (layer.type !== 'tilelayer') throw unsupported(relPath, 'object-layers', `object layer "${name}": object outputs are not supported`);
      if (!outputTileLayerNames.includes(target)) outputTileLayerNames.push(target);
      let set = outputSets.find((s) => s.name === setName);
      if (set === undefined) outputSets.push((set = { name: setName, layers: [], probability: 1 }));
      const outputLayer: OutputLayerDef = { grid: decodeLayer(relPath, layer, map, decode), target, properties: [] };
      set.layers.push(outputLayer);
      for (const p of layer.properties ?? []) {
        if (same(p.name, 'probability')) {
          const v = toReal(p, false);
          if (v.ok) {
            set.probability = v.value;
            continue;
          }
        }
        outputLayer.properties.push(structuredClone(p) as OutputLayerDef['properties'][number]);
      }
      continue;
    }

    if (layer.type === 'objectgroup') throw unsupported(relPath, 'object-layers', `object layer "${name}" is not supported in rule maps (only "rule_options")`);
    warnings.push(ignoredWarning(relPath, `layer "${name}" is not an automapping layer and is ignored`, { layer: name }));
  }

  if (inputSets.length === 0) errors.push('no input_<name> or inputnot_<name> layer');
  if (outputSets.length === 0) errors.push('no output_<name> layer');
  if (errors.length > 0) throw invalid(relPath, errors.join('; '), { problems: errors });

  // Input layers are always checked in name order (Tiled sorts them the same way).
  for (const set of inputSets) set.layers.sort((a, b) => (a.layerName < b.layerName ? -1 : a.layerName > b.layerName ? 1 : 0));

  const rules = buildRules(map.width, inputSets, outputSets, optionAreas, ruleDefaults);
  const hash = createHash('sha256').update(JSON.stringify(map)).digest('hex');
  return { path: abs, relPath, hash, width: map.width, height: map.height, options, inputSets, outputSets, inputLayerNames, outputTileLayerNames, rules, tilesets, warnings };
}

function boxOf(cells: readonly (readonly [number, number])[]): RuleBox {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const [x, y] of cells) {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return { left, top, right, bottom };
}

// The order Tiled's copyTileRegion writes output cells: rectangle by rectangle, and within a
// rectangle column by column. It matters where wrapped outputs land on the same cell.
function copyOrder(cells: readonly [number, number][]): [number, number][] {
  const order: [number, number][] = [];
  for (const r of Region.fromCells(cells).rects()) {
    for (let x = r.left; x <= r.right; x++) for (let y = r.top; y <= r.bottom; y++) order.push([x, y]);
  }
  return order;
}

function buildRules(
  width: number,
  inputSets: InputSetDef[],
  outputSets: OutputSetDef[],
  optionAreas: { area: RegionRect; options: RuleOptions; set: Set<RuleOptionKey> }[],
  defaults: RuleOptions,
): RuleDef[] {
  const inputRegion = new Region();
  for (const set of inputSets) {
    for (const c of set.layers) for (const l of [...c.listYes, ...c.listNo]) inputRegion.unite(Region.fromCells(nonEmptyCells(l.grid, width)));
  }
  const outputRegion = new Region();
  for (const set of outputSets) for (const l of set.layers) outputRegion.unite(Region.fromCells(nonEmptyCells(l.grid, width)));
  const combined = new Region();
  combined.unite(inputRegion);
  combined.unite(outputRegion);

  const rules: RuleDef[] = [];
  for (const group of coherentRegions(combined)) {
    const cells = [...group.cells()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const ruleInput = cells.filter(([x, y]) => inputRegion.contains(x, y));
    const ruleOutput = cells.filter(([x, y]) => outputRegion.contains(x, y));
    if (ruleInput.length === 0 || ruleOutput.length === 0) continue;
    const options = { ...defaults };
    for (const area of optionAreas) {
      const inside = cells.every(([x, y]) => x >= area.area.left && x <= area.area.right && y >= area.area.top && y <= area.area.bottom);
      if (inside) mergeOptions(options, area.options, area.set);
    }
    const rule: RuleDef = {
      inputCells: ruleInput,
      outputCells: ruleOutput,
      inputBox: boxOf(ruleInput),
      outputOrder: copyOrder(ruleOutput),
      options,
      outputSet: undefined,
      outputSets: [],
    };
    for (const set of outputSets) {
      const layers: OutputLayerDef[] = set.layers.filter((l) => ruleOutput.some(([x, y]) => l.grid.cells[y * width + x]!.kind !== 'none'));
      if (layers.length === 0) continue;
      const output: RuleOutput = { layers };
      if (set.name === '') rule.outputSet = output;
      else rule.outputSets.push({ output, probability: set.probability });
    }
    rules.push(rule);
  }
  return rules;
}
