import type { ErrorBody } from '../core/errors.js';
import type { TiledMap, TiledTilesetFile } from './tiled.schema.js';
import type { Rect } from './dsl.schema.js';

// Types for Tiled automapping (Tiled 1.12 semantics). A RuleSet is loaded once from a rules
// file and can be applied to any number of working maps.

// One special tile kind, from a rule-map tile's `MatchType` property.
export type MatchKind = 'Empty' | 'NonEmpty' | 'Other' | 'Negate' | 'Ignore';

// What one rule-map cell holds: nothing, a special tile, or a literal tile of a rule-map tileset.
export type RuleCell =
  | { kind: 'none' }
  | { kind: 'special'; match: MatchKind }
  | { kind: 'tile'; tileset: number; localId: number; flags: number };

// Options a rule takes from the map properties, then from `rule_options` rectangles.
export interface RuleOptions {
  skipChance: number;
  modX: number;
  modY: number;
  offsetX: number;
  offsetY: number;
  noOverlappingOutput: boolean;
  disabled: boolean;
  ignoreLock: boolean;
}

export interface RuleMapOptions {
  deleteTiles: boolean;
  matchOutsideMap: boolean;
  overflowBorder: boolean;
  wrapBorder: boolean;
  matchInOrder: boolean;
  automappingRadius: number;
}

// A rule-map tile layer, decoded into rule cells (row-major, rule-map size).
export interface RuleLayerGrid {
  layerName: string;
  cells: RuleCell[];
}

export interface InputLayerDef {
  grid: RuleLayerGrid;
  strictEmpty: boolean;
  flagsMask: number;
}

// The conditions one input index puts on one target layer.
export interface InputConditionsDef {
  layerName: string;
  listYes: InputLayerDef[];
  listNo: InputLayerDef[];
}

export interface InputSetDef {
  name: string;
  layers: InputConditionsDef[];
}

export interface OutputLayerDef {
  grid: RuleLayerGrid;
  target: string;
  // Properties copied to the target layer whenever this output is applied.
  properties: { name: string; type: string; value: unknown }[];
}

export interface OutputSetDef {
  name: string;
  layers: OutputLayerDef[];
  probability: number;
}

// The output layers of one output set that have content inside a rule's output region.
export interface RuleOutput {
  layers: OutputLayerDef[];
}

export interface RuleBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface RuleDef {
  // Cells as [x, y] in rule-map coordinates, row-major.
  inputCells: [number, number][];
  outputCells: [number, number][];
  inputBox: RuleBox;
  // Output cells in the order Tiled copies them: per banded rectangle, column by column.
  outputOrder: [number, number][];
  options: RuleOptions;
  // The unnamed output set (always applied) and the named ones (one picked per match).
  outputSet: RuleOutput | undefined;
  outputSets: { output: RuleOutput; probability: number }[];
}

// A tileset of a rule map. `identity` decides which working-map tileset is the same tileset.
export interface RuleTileset {
  name: string;
  firstgid: number;
  tilecount: number;
  identity: string | undefined;
  // The tileset as it would be embedded into a working map, with the image path absolute.
  embed: TiledTilesetFile | undefined;
  // Why the tileset cannot be used for literal tiles, when it cannot.
  unusable: string | undefined;
}

export interface RuleMap {
  path: string;
  relPath: string;
  // SHA-256 of the rule map's content (as parsed, so line endings and spacing do not count),
  // for noticing that rules changed.
  hash: string;
  width: number;
  height: number;
  options: RuleMapOptions;
  inputSets: InputSetDef[];
  outputSets: OutputSetDef[];
  inputLayerNames: string[];
  outputTileLayerNames: string[];
  rules: RuleDef[];
  tilesets: RuleTileset[];
  warnings: ErrorBody[];
}

export interface RuleMapReference {
  // Anchored, case-insensitive file-name filter from a `[pattern]` line; undefined matches all.
  filter: RegExp | undefined;
  ruleMap: RuleMap;
}

export interface RuleSet {
  // The project's real path: working maps must lie inside it.
  projectDir: string;
  rulesPath: string;
  rulesAbs: string;
  references: RuleMapReference[];
  warnings: ErrorBody[];
  // SHA-256 over every rules file and rule map read, in order: it changes when the rules do.
  hash: string;
}

// A working-map tileset stored in an external file, resolved by the caller (the core is sync);
// resolveExternalTilesets() builds these. `sourceAbs` must be the real path returned by the
// project guard, or its tiles never match; `tilecount` is the highest tile id + 1.
export interface ExternalTilesetInfo {
  sourceAbs: string;
  tilecount: number;
}

export interface AutomapOptions {
  seed?: number;
  // Where to automap, like a selection in Tiled: one rectangle or several. Default: the map.
  region?: Rect | readonly Rect[];
  // The working map's file name, for `[filter]` lines.
  mapFileName: string;
  // The working map's real absolute path (from the project guard), inside the rule set's
  // project: tileset images are resolved against it.
  mapAbs: string;
  // External tilesets of the working map, keyed by their `source` as written in the map.
  externalTilesets?: Record<string, ExternalTilesetInfo>;
}

export interface AutomapReport {
  rulesPath: string;
  ruleMaps: string[];
  rules: number;
  matches: number;
  changedCells: number;
  layersWritten: string[];
  warnings: ErrorBody[];
}

export type { TiledMap };
