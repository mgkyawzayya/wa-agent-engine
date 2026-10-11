import { deflateSync, gunzipSync, gzipSync, inflateSync, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import {
  getProperty,
  type TiledGroupLayer,
  type TiledLayer,
  type TiledMap,
  type TiledObjectGroup,
  type TiledTileLayer,
} from '../schemas/tiled.schema.js';
import { WaEngineError } from './errors.js';
import { MAX_MAP_DIMENSION } from './limits.js';

// The engine writes to layer roles, never to layer names. Each role resolves to one
// concrete tile layer or object layer, so the engine works on its own maps and on WA's
// hand-made maps, whose layers live in groups (floor/floor1, above/above1, ...).

export const TILE_ROLES = [
  'start',
  'collisions',
  // The sketch layers of maps drawn with automapping rules: markers the rules read.
  'sketch',
  'sketchStyle',
  'floor',
  'walls',
  'furniture1',
  'furniture2',
  'furniture3',
  'foreground1',
  'foreground2',
] as const;
export const OBJECT_ROLES = ['floorLayer', 'zones'] as const;
export type TileRole = (typeof TILE_ROLES)[number];
export type ObjectRole = (typeof OBJECT_ROLES)[number];
export type LayerRole = TileRole | ObjectRole;

// Map property that overrides role resolution: a JSON object of role -> layer path.
export const LAYERS_OVERRIDE_PROPERTY = 'wa-agent-engine:layers';

interface RoleSpec {
  candidates: string[];
  kind: 'tilelayer' | 'objectgroup';
  topLevelOnly?: boolean;
  // Child index used when a candidate is a group (floor -> floor1).
  index: number;
}

const ROLE_SPECS: Record<LayerRole, RoleSpec> = {
  start: { candidates: ['start'], kind: 'tilelayer', topLevelOnly: true, index: 1 },
  collisions: { candidates: ['collisions'], kind: 'tilelayer', index: 1 },
  sketch: { candidates: ['wa_sketch'], kind: 'tilelayer', index: 1 },
  sketchStyle: { candidates: ['wa_style'], kind: 'tilelayer', index: 1 },
  floor: { candidates: ['floor', 'floor/floor1'], kind: 'tilelayer', index: 1 },
  walls: { candidates: ['walls', 'walls/walls1'], kind: 'tilelayer', index: 1 },
  // A flat `furniture` or `above` tile layer (older hand-made WA maps) serves as sub-layer 1.
  furniture1: { candidates: ['furniture/furniture1', 'furniture1', 'furniture'], kind: 'tilelayer', index: 1 },
  furniture2: { candidates: ['furniture/furniture2', 'furniture2'], kind: 'tilelayer', index: 2 },
  furniture3: { candidates: ['furniture/furniture3', 'furniture3'], kind: 'tilelayer', index: 3 },
  foreground1: {
    candidates: ['foreground/foreground1', 'above/above1', 'foreground1', 'above1', 'foreground', 'above'],
    kind: 'tilelayer',
    index: 1,
  },
  foreground2: {
    candidates: ['foreground/foreground2', 'above/above2', 'foreground2', 'above2'],
    kind: 'tilelayer',
    index: 2,
  },
  floorLayer: { candidates: ['floorLayer'], kind: 'objectgroup', topLevelOnly: true, index: 1 },
  zones: { candidates: ['wa_zones'], kind: 'objectgroup', index: 1 },
};

export interface ResolvedLayer<L extends TiledLayer = TiledLayer> {
  layer: L;
  path: string;
  parent: TiledLayer[];
  // Index of the containing top-level layer in map.layers.
  topIndex: number;
}

function findByPath(map: TiledMap, path: string): ResolvedLayer | undefined {
  const parts = path.split('/');
  let siblings: TiledLayer[] = map.layers;
  let topIndex = -1;
  for (let depth = 0; depth < parts.length; depth++) {
    const index = siblings.findIndex((l) => l.name === parts[depth]);
    if (index === -1) return undefined;
    if (depth === 0) topIndex = index;
    const layer = siblings[index]!;
    if (depth === parts.length - 1) return { layer, path, parent: siblings, topIndex };
    if (layer.type !== 'group') return undefined;
    siblings = layer.layers;
  }
  return undefined;
}

function readOverrides(map: TiledMap): Partial<Record<LayerRole, string>> {
  const prop = getProperty(map, LAYERS_OVERRIDE_PROPERTY);
  if (prop === undefined) return {};
  if (typeof prop.value !== 'string') {
    throw new WaEngineError('LAYER_ROLE_UNRESOLVED', `map property ${LAYERS_OVERRIDE_PROPERTY} must be a JSON string`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(prop.value);
  } catch {
    throw new WaEngineError('LAYER_ROLE_UNRESOLVED', `map property ${LAYERS_OVERRIDE_PROPERTY} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WaEngineError('LAYER_ROLE_UNRESOLVED', `map property ${LAYERS_OVERRIDE_PROPERTY} must map roles to layer paths`);
  }
  const out: Partial<Record<LayerRole, string>> = {};
  for (const [role, path] of Object.entries(parsed)) {
    if (Object.hasOwn(ROLE_SPECS, role) && typeof path === 'string') out[role as LayerRole] = path;
  }
  return out;
}

function checkKind(role: LayerRole, found: ResolvedLayer): void {
  const spec = ROLE_SPECS[role];
  if (found.layer.type === 'group') {
    throw new WaEngineError('LAYER_IS_GROUP', `layer "${found.path}" for role ${role} is a group; point the role at one of its layers`, {
      role,
      path: found.path,
    });
  }
  if (found.layer.type !== spec.kind) {
    throw new WaEngineError('LAYER_WRONG_TYPE', `layer "${found.path}" for role ${role} must be a ${spec.kind}`, {
      role,
      path: found.path,
      type: found.layer.type,
    });
  }
}

function findRole(map: TiledMap, role: LayerRole, overrides: Partial<Record<LayerRole, string>>): ResolvedLayer | undefined {
  const spec = ROLE_SPECS[role];
  const override = overrides[role];
  if (override !== undefined) {
    const found = findByPath(map, override);
    if (found === undefined) {
      throw new WaEngineError('LAYER_ROLE_UNRESOLVED', `layer override "${override}" for role ${role} does not exist`, {
        role,
        candidates: [override],
      });
    }
    checkKind(role, found);
    return found;
  }
  for (const candidate of spec.candidates) {
    if (spec.topLevelOnly === true && candidate.includes('/')) continue;
    let found = findByPath(map, candidate);
    if (found === undefined) continue;
    if (found.layer.type === 'group') {
      const group: TiledGroupLayer = found.layer;
      // The numbered child, or for sub-layer 1 the first unnumbered child of the right kind;
      // never another numbered sub-layer, so two roles cannot share one layer.
      const numbered = new RegExp(`^${group.name}\\d+$`);
      const child =
        group.layers.find((l) => l.name === `${group.name}${spec.index}`) ??
        (spec.index === 1 ? group.layers.find((l) => l.type === spec.kind && !numbered.test(l.name)) : undefined);
      if (child === undefined) continue;
      found = { layer: child, path: `${found.path}/${child.name}`, parent: group.layers, topIndex: found.topIndex };
    }
    if (found.layer.type !== spec.kind) continue;
    return found;
  }
  return undefined;
}

export function resolveRole(map: TiledMap, role: 'floorLayer' | 'zones'): ResolvedLayer<TiledObjectGroup>;
export function resolveRole(map: TiledMap, role: TileRole): ResolvedLayer<TiledTileLayer>;
export function resolveRole(map: TiledMap, role: LayerRole): ResolvedLayer;
export function resolveRole(map: TiledMap, role: LayerRole): ResolvedLayer {
  const found = findRole(map, role, readOverrides(map));
  if (found === undefined) {
    throw new WaEngineError(
      'LAYER_ROLE_UNRESOLVED',
      `no layer for role ${role}; tried ${ROLE_SPECS[role].candidates.join(', ')}. Set the ${LAYERS_OVERRIDE_PROPERTY} map property to point the role at a layer`,
      { role, candidates: ROLE_SPECS[role].candidates },
    );
  }
  return found;
}

export function tryResolveRole(map: TiledMap, role: LayerRole): ResolvedLayer | undefined {
  return findRole(map, role, readOverrides(map));
}

// ---- layer creation ----

export function allocLayerId(map: TiledMap): number {
  let max = 0;
  const walk = (layers: TiledLayer[]): void => {
    for (const l of layers) {
      max = Math.max(max, l.id);
      if (l.type === 'group') walk(l.layers);
    }
  };
  walk(map.layers);
  const id = Math.max(map.nextlayerid ?? 1, max + 1);
  map.nextlayerid = id + 1;
  return id;
}

export function allocObjectId(map: TiledMap): number {
  let max = 0;
  const walk = (layers: TiledLayer[]): void => {
    for (const l of layers) {
      if (l.type === 'objectgroup') for (const o of l.objects) max = Math.max(max, o.id);
      if (l.type === 'group') walk(l.layers);
    }
  };
  walk(map.layers);
  const id = Math.max(map.nextobjectid ?? 1, max + 1);
  map.nextobjectid = id + 1;
  return id;
}

// Removes engine-owned objects, checking each still carries the name and type recorded, so an
// object a user renamed or retyped is left alone.
export function removeOwnedObjects(map: TiledMap, owned: readonly { objectId: number; name: string }[], type: string): void {
  const match = new Map(owned.map((o) => [o.objectId, o.name]));
  forEachObjectGroup(map.layers, (layer) => {
    layer.objects = layer.objects.filter((o) => !(match.get(o.id) === o.name && (o.type ?? o.class) === type));
  });
}

function newTileLayer(map: TiledMap, name: string): TiledTileLayer {
  return {
    data: new Array<number>(map.width * map.height).fill(0),
    height: map.height,
    id: allocLayerId(map),
    name,
    opacity: 1,
    type: 'tilelayer',
    visible: true,
    width: map.width,
    x: 0,
    y: 0,
  };
}

function newObjectGroup(map: TiledMap, name: string): TiledObjectGroup {
  return { draworder: 'topdown', id: allocLayerId(map), name, objects: [], opacity: 1, type: 'objectgroup', visible: true, x: 0, y: 0 };
}

function newGroup(map: TiledMap, name: string, children: TiledLayer[]): TiledGroupLayer {
  return { id: allocLayerId(map), layers: children, name, opacity: 1, type: 'group', visible: true, x: 0, y: 0 };
}

// Contract order of the standard roles, bottom to top. start, collisions and the sketch layers
// sit under the floor so their overlay tiles stay hidden; layers above floorLayer draw over
// avatars.
const STANDARD_ORDER: readonly (LayerRole | 'furniture' | 'foreground')[] = [
  'start',
  'collisions',
  'sketch',
  'sketchStyle',
  'floor',
  'walls',
  'furniture',
  'floorLayer',
  'foreground',
  'zones',
];

const GROUP_ROLES = {
  furniture: { names: ['furniture'], roles: ['furniture1', 'furniture2', 'furniture3'] as TileRole[] },
  foreground: { names: ['foreground', 'above'], roles: ['foreground1', 'foreground2'] as TileRole[] },
} as const;

type Slot = (typeof STANDARD_ORDER)[number];

// Top-level indices occupied by a standard slot: its resolved roles plus any top-level layer
// carrying the slot's name (such as an empty `floor` group).
function slotIndices(map: TiledMap, slot: Slot): number[] {
  const roles: LayerRole[] = slot === 'furniture' || slot === 'foreground' ? GROUP_ROLES[slot].roles : [slot];
  const names: readonly string[] =
    slot === 'furniture' || slot === 'foreground'
      ? GROUP_ROLES[slot].names
      : ROLE_SPECS[slot].candidates.filter((c) => !c.includes('/'));
  const indices = roles.flatMap((role) => tryResolveRole(map, role)?.topIndex ?? []);
  map.layers.forEach((l, i) => {
    if (names.includes(l.name)) indices.push(i);
  });
  return indices;
}

// Inserts below the nearest following slot, else above the nearest preceding one.
function insertTopLevel(map: TiledMap, slot: Slot, layer: TiledLayer): void {
  const position = STANDARD_ORDER.indexOf(slot);
  for (let i = position + 1; i < STANDARD_ORDER.length; i++) {
    const indices = slotIndices(map, STANDARD_ORDER[i]!);
    if (indices.length > 0) {
      map.layers.splice(Math.min(...indices), 0, layer);
      return;
    }
  }
  for (let i = position - 1; i >= 0; i--) {
    const indices = slotIndices(map, STANDARD_ORDER[i]!);
    if (indices.length > 0) {
      map.layers.splice(Math.max(...indices) + 1, 0, layer);
      return;
    }
  }
  map.layers.push(layer);
}

function wrongType(role: LayerRole, path: string, type: string): WaEngineError {
  return new WaEngineError(
    'LAYER_WRONG_TYPE',
    `layer "${path}" exists but is a ${type}, so it cannot hold role ${role}; rename it or set the ${LAYERS_OVERRIDE_PROPERTY} map property`,
    { role, path, type },
  );
}

function findNested(layers: readonly TiledLayer[], name: string): boolean {
  return layers.some((l) => l.type === 'group' && l.layers.some((c) => c.name === name || findNested([c], name)));
}

// Adds a sub-layer to an existing group, after its numbered predecessor.
function addChild(map: TiledMap, group: TiledGroupLayer, role: LayerRole): void {
  const spec = ROLE_SPECS[role];
  const name = `${group.name}${spec.index}`;
  const clash = group.layers.find((l) => l.name === name);
  if (clash !== undefined) throw wrongType(role, `${group.name}/${name}`, clash.type);
  const child = spec.kind === 'objectgroup' ? newObjectGroup(map, name) : newTileLayer(map, name);
  const after = group.layers.findIndex((l) => l.name === `${group.name}${spec.index - 1}`);
  group.layers.splice(after === -1 ? group.layers.length : after + 1, 0, child);
}

export const SKETCH_ROLES: readonly TileRole[] = ['sketch', 'sketchStyle'];

// Creates only the missing standard roles. Never reorders, renames, or deletes a layer,
// never creates a second top-level layer with an existing name, and reuses WA's `above`
// group (or a flat `furniture`/`above` layer) for its slot. Safe to call repeatedly. The
// sketch layers are created only when asked for (maps drawn with automapping rules), hidden.
export function ensureStandardLayers(map: TiledMap, options: { sketch?: boolean } = {}): LayerRole[] {
  const created: LayerRole[] = [];
  const topLevel = (name: string): TiledLayer | undefined => map.layers.find((l) => l.name === name);
  for (const slot of STANDARD_ORDER) {
    if (SKETCH_ROLES.includes(slot as TileRole) && options.sketch !== true) continue;
    if (slot === 'furniture' || slot === 'foreground') {
      const { names, roles } = GROUP_ROLES[slot];
      const missing = roles.filter((role) => tryResolveRole(map, role) === undefined);
      if (missing.length === 0) continue;
      const group = map.layers.find(
        (l): l is TiledGroupLayer => l.type === 'group' && (names as readonly string[]).includes(l.name),
      );
      const present = roles.filter((role) => !missing.includes(role));
      if (group !== undefined) {
        for (const role of missing) addChild(map, group, role);
      } else if (present.length > 0) {
        // Flat layout: add the missing sub-layers as top-level layers in numeric order, named
        // after the existing ones (above -> above2).
        const prefix = resolveRole(map, present[0]!).path.replace(/\d+$/, '');
        for (const role of missing) {
          const n = ROLE_SPECS[role].index;
          const name = `${prefix}${n}`;
          const clash = topLevel(name);
          if (clash !== undefined) throw wrongType(role, name, clash.type);
          const placed = roles.filter((other) => other !== role && tryResolveRole(map, other) !== undefined);
          const below = placed.filter((other) => ROLE_SPECS[other].index < n).map((other) => resolveRole(map, other).topIndex);
          const above = placed.filter((other) => ROLE_SPECS[other].index > n).map((other) => resolveRole(map, other).topIndex);
          const at = below.length > 0 ? Math.max(...below) + 1 : Math.min(...above);
          map.layers.splice(at, 0, newTileLayer(map, name));
        }
      } else {
        const clash = names.map(topLevel).find((l) => l !== undefined);
        if (clash !== undefined) throw wrongType(missing[0]!, clash.name, clash.type);
        insertTopLevel(map, slot, newGroup(map, names[0], roles.map((role) => newTileLayer(map, role))));
      }
      created.push(...missing);
      continue;
    }
    if (tryResolveRole(map, slot) !== undefined) continue;
    const spec = ROLE_SPECS[slot];
    const name = spec.candidates[0]!;
    const clash = topLevel(name);
    if (clash?.type === 'group' && spec.topLevelOnly !== true) {
      addChild(map, clash, slot);
    } else if (clash !== undefined) {
      throw wrongType(slot, name, clash.type);
    } else {
      if (spec.topLevelOnly === true && findNested(map.layers, name)) {
        throw new WaEngineError(
          'LAYER_ROLE_UNRESOLVED',
          `layer "${name}" is inside a group; WorkAdventure needs it at the top level`,
          { role: slot },
        );
      }
      const layer = spec.kind === 'objectgroup' ? newObjectGroup(map, name) : newTileLayer(map, name);
      if (SKETCH_ROLES.includes(slot as TileRole)) layer.visible = false;
      insertTopLevel(map, slot, layer);
    }
    created.push(slot);
  }
  return created;
}

// ---- tile data ----

// Output is capped at the layer's expected size, so a small compressed payload cannot
// expand into gigabytes.
function decompress(bytes: Buffer, compression: string | undefined, maxOutputLength: number): Buffer {
  const options = { maxOutputLength: Math.max(1, maxOutputLength) };
  try {
    switch (compression ?? '') {
      case '':
        return bytes;
      case 'zlib':
        return inflateSync(bytes, options);
      case 'gzip':
        return gunzipSync(bytes, options);
      case 'zstd':
        return zstdDecompressSync(bytes, options);
    }
  } catch {
    throw new WaEngineError('LAYER_DATA_UNSUPPORTED', 'tile layer data does not decompress to the layer size');
  }
  throw new WaEngineError('LAYER_DATA_UNSUPPORTED', `unsupported tile layer compression "${compression}"`);
}

function compress(bytes: Buffer, compression: string | undefined): Buffer {
  switch (compression ?? '') {
    case '':
      return bytes;
    case 'zlib':
      return deflateSync(bytes);
    case 'gzip':
      return gzipSync(bytes);
    case 'zstd':
      return zstdCompressSync(bytes);
    default:
      throw new WaEngineError('LAYER_DATA_UNSUPPORTED', `unsupported tile layer compression "${compression}"`);
  }
}

// Raw GIDs of a finite tile layer, whether stored as a JSON array or base64.
export function readTileData(layer: TiledTileLayer): Uint32Array {
  if (
    !Number.isInteger(layer.width) ||
    !Number.isInteger(layer.height) ||
    layer.width < 0 ||
    layer.height < 0 ||
    layer.width > MAX_MAP_DIMENSION ||
    layer.height > MAX_MAP_DIMENSION
  ) {
    throw new WaEngineError('LAYER_DATA_UNSUPPORTED', `layer "${layer.name}" size is outside 0..${MAX_MAP_DIMENSION} tiles`);
  }
  const expected = layer.width * layer.height;
  let data: Uint32Array;
  if (Array.isArray(layer.data)) {
    const values = layer.data;
    data = new Uint32Array(values.length);
    for (let i = 0; i < values.length; i++) data[i] = values[i]! >>> 0;
  } else if (typeof layer.data === 'string' && layer.encoding === 'base64') {
    const bytes = decompress(Buffer.from(layer.data, 'base64'), layer.compression, expected * 4);
    if (bytes.length !== expected * 4) {
      throw new WaEngineError('LAYER_DATA_UNSUPPORTED', `layer "${layer.name}" data has the wrong length`);
    }
    data = new Uint32Array(expected);
    for (let i = 0; i < expected; i++) data[i] = bytes.readUInt32LE(i * 4);
  } else {
    throw new WaEngineError('LAYER_DATA_UNSUPPORTED', `layer "${layer.name}" has no finite tile data (infinite maps are not supported)`);
  }
  if (data.length !== expected) {
    throw new WaEngineError('LAYER_DATA_UNSUPPORTED', `layer "${layer.name}" data has the wrong length`);
  }
  return data;
}

// Writes GIDs back in the layer's existing encoding.
export function writeTileData(layer: TiledTileLayer, data: Uint32Array): void {
  if (data.length !== layer.width * layer.height) {
    throw new WaEngineError('LAYER_DATA_UNSUPPORTED', `layer "${layer.name}" needs ${layer.width * layer.height} cells`);
  }
  if (typeof layer.data === 'string' && layer.encoding === 'base64') {
    const bytes = Buffer.alloc(data.length * 4);
    data.forEach((v, i) => bytes.writeUInt32LE(v, i * 4));
    layer.data = compress(bytes, layer.compression).toString('base64');
    return;
  }
  layer.data = Array.from(data);
}

// Calls fn for every tile layer in draw order (groups depth-first), with its group chain.
export function forEachTileLayer(
  layers: readonly TiledLayer[],
  fn: (layer: TiledTileLayer, groups: readonly TiledGroupLayer[]) => void,
  groups: readonly TiledGroupLayer[] = [],
): void {
  for (const layer of layers) {
    if (layer.type === 'tilelayer') fn(layer, groups);
    else if (layer.type === 'group') forEachTileLayer(layer.layers, fn, [...groups, layer]);
  }
}

export function forEachObjectGroup(layers: readonly TiledLayer[], fn: (layer: TiledObjectGroup) => void): void {
  for (const layer of layers) {
    if (layer.type === 'objectgroup') fn(layer);
    else if (layer.type === 'group') forEachObjectGroup(layer.layers, fn);
  }
}
