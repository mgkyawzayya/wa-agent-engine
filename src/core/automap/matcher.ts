import type { InputLayerDef, InputSetDef, RuleCell, RuleDef, RuleMap } from '../../schemas/automap.schema.js';
import { GID_MASK, isEmptyCell, VISUAL_FLAGS } from './cells.js';
import type { Random } from './random.js';
import type { Region } from './region.js';

// Rule matching, following Tiled 1.12's AutoMapper::compileInputSet and matchRule.

export interface CellSource {
  width: number;
  height: number;
  data: Uint32Array;
}

export type GetCell = (x: number, y: number, layer: CellSource | undefined) => number;

const wrap = (value: number, bound: number): number => ((value % bound) + bound) % bound;

export const getPlainCell: GetCell = (x, y, l) =>
  l === undefined || x < 0 || y < 0 || x >= l.width || y >= l.height ? 0 : l.data[y * l.width + x]!;

export const getWrappedCell: GetCell = (x, y, l) =>
  l === undefined || l.width === 0 || l.height === 0 ? 0 : l.data[wrap(y, l.height) * l.width + wrap(x, l.width)]!;

export const getBoundCell: GetCell = (x, y, l) =>
  l === undefined || l.width === 0 || l.height === 0
    ? 0
    : l.data[Math.min(Math.max(y, 0), l.height - 1) * l.width + Math.min(Math.max(x, 0), l.width - 1)]!;

// One accepted or refused cell value. Equality includes the flag mask, as Tiled's MatchCell.
interface MatchCell {
  empty: boolean;
  raw: number;
  mask: number;
}

const EMPTY: MatchCell = { empty: true, raw: 0, mask: VISUAL_FLAGS };
const sameCell = (a: MatchCell, b: MatchCell): boolean => a.empty === b.empty && a.raw === b.raw && a.mask === b.mask;

function appendUnique(list: MatchCell[], cell: MatchCell): void {
  if (!list.some((c) => sameCell(c, cell))) list.push(cell);
}

interface CompiledPosition {
  x: number;
  y: number;
  any: MatchCell[];
  none: MatchCell[];
}

interface CompiledLayer {
  target: CellSource | undefined;
  positions: CompiledPosition[];
}

export interface CompiledIndex {
  layers: CompiledLayer[];
}

export interface MatchEnv {
  // The working layer an input layer name reads, or undefined when the map has none.
  resolveInput(name: string): CellSource | undefined;
  // The working-map raw value (gid and flags) of a literal rule tile.
  literal(ruleMap: RuleMap, cell: Extract<RuleCell, { kind: 'tile' }>): number;
}

// Every literal and Empty tile on the `input` layers of one index and target, inside the
// rule's input region: what an `Other` tile refuses.
function collectInputCells(ruleMap: RuleMap, rule: RuleDef, list: InputLayerDef[], env: MatchEnv): MatchCell[] {
  const cells: MatchCell[] = [];
  for (const layer of list) {
    for (const [x, y] of rule.inputCells) {
      const c = layer.grid.cells[y * ruleMap.width + x]!;
      if (c.kind === 'tile') appendUnique(cells, { empty: false, raw: env.literal(ruleMap, c), mask: layer.flagsMask });
      else if (c.kind === 'special' && c.match === 'Empty') appendUnique(cells, EMPTY);
    }
  }
  return cells;
}

// After this, at most one of the two lists is non-empty. Returns false when nothing can match.
function optimize(any: MatchCell[], none: MatchCell[]): boolean {
  const dedupedNone: MatchCell[] = [];
  for (const c of none) appendUnique(dedupedNone, c);
  none.splice(0, none.length, ...dedupedNone);
  if (any.length > 0) {
    const kept: MatchCell[] = [];
    for (const c of any) if (!none.some((n) => sameCell(n, c))) appendUnique(kept, c);
    any.splice(0, any.length, ...kept);
    none.length = 0;
    if (any.length === 0) return false;
  }
  return true;
}

function compileInputSet(ruleMap: RuleMap, rule: RuleDef, set: InputSetDef, env: MatchEnv): CompiledIndex | undefined {
  const box = rule.inputBox;
  const compiled: CompiledIndex = { layers: [] };
  let hasIgnore = false;
  for (const conditions of set.layers) {
    let inputCells: MatchCell[] | undefined;
    let canMatch = true;
    const target = env.resolveInput(conditions.layerName);
    const positions: CompiledPosition[] = [];
    for (const [x, y] of rule.inputCells) {
      let any: MatchCell[] = [];
      let none: MatchCell[] = [];
      let negate = false;
      const index = y * ruleMap.width + x;
      const visit = (layer: InputLayerDef, yes: boolean): void => {
        const c = layer.grid.cells[index]!;
        const accept = yes ? any : none;
        const refuse = yes ? none : any;
        if (c.kind === 'none') {
          if (layer.strictEmpty) accept.push({ empty: true, raw: 0, mask: layer.flagsMask });
          return;
        }
        if (c.kind === 'tile') {
          accept.push({ empty: false, raw: env.literal(ruleMap, c), mask: layer.flagsMask });
          return;
        }
        switch (c.match) {
          case 'Empty':
            accept.push(EMPTY);
            break;
          case 'NonEmpty':
            refuse.push(EMPTY);
            break;
          case 'Other':
            inputCells ??= collectInputCells(ruleMap, rule, conditions.listYes, env);
            refuse.push(...inputCells);
            break;
          case 'Negate':
            negate = true;
            break;
          case 'Ignore':
            hasIgnore = true;
            break;
        }
      };
      for (const layer of conditions.listYes) visit(layer, true);
      for (const layer of conditions.listNo) visit(layer, false);
      if (negate) [any, none] = [none, any];
      if (!optimize(any, none)) {
        canMatch = false;
        continue;
      }
      // A missing input layer reads as empty everywhere.
      if (target === undefined) {
        const emptyAllowed = (any.length === 0 || any.some((c) => c.empty)) && !none.some((c) => c.empty);
        if (!emptyAllowed) canMatch = false;
      }
      if (any.length > 0 || none.length > 0) positions.push({ x: x - box.left, y: y - box.top, any, none });
    }
    if (!canMatch) return undefined;
    if (positions.length > 0) compiled.layers.push({ target, positions });
  }
  // Since Tiled 1.12, an index with no condition never matches unless it has an Ignore tile.
  return compiled.layers.length > 0 || hasIgnore ? compiled : undefined;
}

export function compileRule(ruleMap: RuleMap, rule: RuleDef, env: MatchEnv): CompiledIndex[] {
  const out: CompiledIndex[] = [];
  for (const set of ruleMap.inputSets) {
    const index = compileInputSet(ruleMap, rule, set, env);
    if (index !== undefined) out.push(index);
  }
  return out;
}

const cellMatches = (desired: MatchCell, cell: number): boolean =>
  (cell & GID_MASK) === (desired.raw & GID_MASK) && ((cell ^ desired.raw) & desired.mask) === 0;

function matchIndex(index: CompiledIndex, ox: number, oy: number, get: GetCell): boolean {
  for (const layer of index.layers) {
    for (const pos of layer.positions) {
      const cell = get(pos.x + ox, pos.y + oy, layer.target);
      if (pos.any.length > 0 && !pos.any.some((d) => (d.empty ? isEmptyCell(cell) : cellMatches(d, cell)))) return false;
      if (pos.none.some((d) => (d.empty ? isEmptyCell(cell) : cellMatches(d, cell)))) return false;
    }
  }
  return true;
}

export interface MatchRuleArgs {
  ruleMap: RuleMap;
  rule: RuleDef;
  compiled: CompiledIndex[];
  matchRegion: Region;
  get: GetCell;
  mapWidth: number;
  mapHeight: number;
  skip: Random;
  matched: (x: number, y: number) => void;
}

// Tries the rule at every candidate position, in Tiled's order and with its ModX/ModY start
// formula (including the unsigned modulo), and calls `matched` with the position of the
// top-left corner of the rule's input bounding box.
export function matchRule(args: MatchRuleArgs): void {
  const { ruleMap, rule, compiled, get, skip } = args;
  if (compiled.length === 0) return;
  const box = rule.inputBox;
  const ruleWidth = box.right - box.left;
  const ruleHeight = box.bottom - box.top;
  const region = args.matchRegion.adjusted(-ruleWidth, -ruleHeight, 0, 0);
  if (!ruleMap.options.matchOutsideMap) {
    region.intersectRect({ left: 0, top: 0, right: args.mapWidth - ruleWidth - 1, bottom: args.mapHeight - ruleHeight - 1 });
  }
  const { modX, modY, offsetX, offsetY, skipChance } = rule.options;
  for (const rect of region.rects()) {
    const startX = (rect.left + (((rect.left + offsetX) >>> 0) % modX)) | 0;
    const startY = (rect.top + (((rect.top + offsetY) >>> 0) % modY)) | 0;
    for (let y = startY; y <= rect.bottom; ) {
      for (let x = startX; x <= rect.right; ) {
        if (!(skipChance !== 0 && skip() < skipChance) && compiled.some((index) => matchIndex(index, x, y, get))) args.matched(x, y);
        const nextX = (x + modX) | 0;
        // A step of 2^31 or more wraps around in Tiled's int arithmetic and never ends; stop.
        if (nextX <= x) break;
        x = nextX;
      }
      const nextY = (y + modY) | 0;
      if (nextY <= y) break;
      y = nextY;
    }
  }
}
