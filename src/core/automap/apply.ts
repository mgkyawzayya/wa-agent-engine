import type { OutputLayerDef, RuleCell, RuleDef, RuleMap, RuleOutput } from '../../schemas/automap.schema.js';
import type { TiledMap, TiledProperty, TiledTileLayer } from '../../schemas/tiled.schema.js';
import { forEachTileLayer, readTileData } from '../layers.js';
import { isEmptyCell } from './cells.js';
import { compileRule, getBoundCell, getPlainCell, getWrappedCell, matchRule, type CellSource, type GetCell, type MatchEnv } from './matcher.js';
import { RandomPicker, type AutomapRandom } from './random.js';
import { Region } from './region.js';
import type { TileTranslator } from './tiles.js';

// One automapping run over a working map, following Tiled 1.12's AutoMapper::autoMap and
// AutoMapperWrapper: output layers are worked on as copies, rule maps run one after another,
// and the copies are written back to the map at the end.

export interface WorkLayer extends CellSource {
  name: string;
  locked: boolean;
  original: TiledTileLayer | undefined;
  originalData: Uint32Array | undefined;
  // Properties the outputs set on this layer, by name.
  properties: Map<string, TiledProperty>;
}

const wrap = (value: number, bound: number): number => ((value % bound) + bound) % bound;

// Cells of a footprint or an applied region, packed into one number. Positions stay within
// a few thousand tiles of the map (maps, rule maps and AutomappingRadius are all bounded).
const PACK_OFFSET = 1 << 13;
const PACK_STRIDE = 1 << 15;
const pack = (x: number, y: number): number => (y + PACK_OFFSET) * PACK_STRIDE + (x + PACK_OFFSET);
const unpack = (key: number): [number, number] => [(key % PACK_STRIDE) - PACK_OFFSET, Math.floor(key / PACK_STRIDE) - PACK_OFFSET];

// The first tile layer with this name in draw order. Only the layer's own lock counts: Tiled
// does not check parent groups, so a locked group does not protect the layers in it (the
// locked-group fixture shows this).
function findTileLayer(map: TiledMap, name: string): TiledTileLayer | undefined {
  let found: TiledTileLayer | undefined;
  forEachTileLayer(map.layers, (layer) => {
    if (found === undefined && layer.name === name) found = layer;
  });
  return found;
}

export class AutomapRun implements MatchEnv {
  readonly outputs = new Map<string, WorkLayer>();
  private readonly originals = new Map<string, CellSource | undefined>();
  private readonly pickers = new Map<RuleDef, RandomPicker<RuleOutput>>();
  private readonly footprints = new WeakMap<OutputLayerDef, Map<RuleDef, [number, number][]>>();
  // While set, input layers are read from these copies (the map as it was when the rule map
  // started), so rules can be applied as soon as they are matched.
  private snapshot: Map<string, CellSource> | undefined;
  private readonly map: TiledMap;
  private readonly translator: TileTranslator;
  private readonly random: AutomapRandom;
  matches = 0;

  constructor(map: TiledMap, translator: TileTranslator, random: AutomapRandom) {
    this.map = map;
    this.translator = translator;
    this.random = random;
  }

  // Copies the existing output layers and creates the missing ones (prepareAutoMap).
  prepareOutputs(names: readonly string[]): void {
    for (const name of names) {
      if (this.outputs.has(name)) continue;
      const layer = findTileLayer(this.map, name);
      const data = layer === undefined ? undefined : readTileData(layer);
      this.outputs.set(name, {
        name,
        width: layer?.width ?? this.map.width,
        height: layer?.height ?? this.map.height,
        data: data?.slice() ?? new Uint32Array(this.map.width * this.map.height),
        locked: layer?.locked === true,
        original: layer,
        originalData: data,
        properties: new Map(),
      });
    }
  }

  // An input layer reads the output copy when one exists, so it sees earlier rule maps' changes.
  resolveInput(name: string): CellSource | undefined {
    const snapshot = this.snapshot?.get(name);
    if (snapshot !== undefined) return snapshot;
    const output = this.outputs.get(name);
    if (output !== undefined) return output;
    if (!this.originals.has(name)) {
      const layer = findTileLayer(this.map, name);
      this.originals.set(name, layer === undefined ? undefined : { width: layer.width, height: layer.height, data: readTileData(layer) });
    }
    return this.originals.get(name);
  }

  literal(ruleMap: RuleMap, cell: Extract<RuleCell, { kind: 'tile' }>): number {
    return (this.translator.gid(ruleMap.tilesets[cell.tileset]!, cell.localId) | cell.flags) >>> 0;
  }

  private picker(rule: RuleDef): RandomPicker<RuleOutput> {
    let picker = this.pickers.get(rule);
    if (picker === undefined) {
      picker = new RandomPicker<RuleOutput>();
      for (const s of rule.outputSets) picker.add(s.output, s.probability);
      this.pickers.set(rule, picker);
    }
    return picker;
  }

  // The cells one output layer writes for a rule (special tiles included), in rule-map
  // coordinates: the rule's footprint on that target for NoOverlappingOutput.
  private footprint(ruleMap: RuleMap, rule: RuleDef, layer: OutputLayerDef): [number, number][] {
    let byRule = this.footprints.get(layer);
    if (byRule === undefined) this.footprints.set(layer, (byRule = new Map()));
    let cells = byRule.get(rule);
    if (cells === undefined) {
      cells = rule.outputCells.filter(([x, y]) => layer.grid.cells[y * ruleMap.width + x]!.kind !== 'none');
      byRule.set(rule, cells);
    }
    return cells;
  }

  // Runs one rule map over `where` and returns the cells its matches' output regions cover
  // (used to widen a partial run for the following rule maps).
  runRuleMap(ruleMap: RuleMap, where: Region, trackApplied: boolean): Region | undefined {
    const radius = ruleMap.options.automappingRadius;
    const applyRegion = radius !== 0 ? where.adjusted(-radius, -radius, radius, radius) : where.clone();
    const applied = trackApplied ? new Set<number>() : undefined;

    if (ruleMap.options.deleteTiles) {
      const inputRegion = new Region();
      for (const name of ruleMap.inputLayerNames) {
        const layer = this.resolveInput(name);
        if (layer === undefined) continue;
        const cells: [number, number][] = [];
        for (let i = 0; i < layer.data.length; i++) if (!isEmptyCell(layer.data[i]!)) cells.push([i % layer.width, Math.floor(i / layer.width)]);
        inputRegion.unite(Region.fromCells(cells));
      }
      inputRegion.intersect(applyRegion);
      for (const name of ruleMap.outputTileLayerNames) {
        const layer = this.outputs.get(name)!;
        for (const [x, y] of inputRegion.cells()) if (x >= 0 && y >= 0 && x < layer.width && y < layer.height) layer.data[y * layer.width + x] = 0;
      }
    }

    // Without MatchInOrder every rule matches the map as it was when this rule map started.
    // Tiled finds all matches first and then applies them rule by rule; reading inputs from a
    // snapshot and applying each rule's matches at once gives the same result, and the two
    // random streams are used in the same order.
    if (!ruleMap.options.matchInOrder) {
      this.snapshot = new Map();
      for (const name of ruleMap.inputLayerNames) {
        const output = this.outputs.get(name);
        if (output !== undefined) this.snapshot.set(name, { width: output.width, height: output.height, data: output.data.slice() });
      }
    }
    try {
      const get: GetCell = ruleMap.options.wrapBorder ? getWrappedCell : ruleMap.options.overflowBorder ? getBoundCell : getPlainCell;
      for (const rule of ruleMap.rules) {
        if (rule.options.disabled) continue;
        if (rule.outputSet === undefined && this.picker(rule).size === 0) continue;
        const compiled = compileRule(ruleMap, rule, this);
        const written = new Map<WorkLayer, Set<number>>();
        matchRule({
          ruleMap, rule, compiled, matchRegion: applyRegion, get, mapWidth: this.map.width, mapHeight: this.map.height, skip: this.random.skip,
          matched: (x, y) => this.applyRule(ruleMap, rule, x, y, written, applied),
        });
      }
    } finally {
      this.snapshot = undefined;
    }
    return applied === undefined ? undefined : Region.fromCells([...applied].map(unpack));
  }

  private applyRule(ruleMap: RuleMap, rule: RuleDef, x: number, y: number, written: Map<WorkLayer, Set<number>>, applied: Set<number> | undefined): void {
    const ox = x - rule.inputBox.left;
    const oy = y - rule.inputBox.top;
    const picker = this.picker(rule);
    const picked = picker.size > 0 ? picker.pick(this.random.pick) : undefined;
    const outputs = [rule.outputSet, picked].filter((o): o is RuleOutput => o !== undefined);

    if (rule.options.noOverlappingOutput) {
      const footprints: [WorkLayer, number[]][] = [];
      for (const output of outputs) {
        for (const layer of output.layers) {
          footprints.push([this.outputs.get(layer.target)!, this.footprint(ruleMap, rule, layer).map(([cx, cy]) => pack(cx + ox, cy + oy))]);
        }
      }
      for (const [layer, keys] of footprints) {
        const done = written.get(layer);
        if (done !== undefined && keys.some((k) => done.has(k))) return;
      }
      for (const [layer, keys] of footprints) {
        let done = written.get(layer);
        if (done === undefined) written.set(layer, (done = new Set()));
        for (const k of keys) done.add(k);
      }
    }

    for (const output of outputs) this.copy(ruleMap, rule, ox, oy, output);
    if (applied !== undefined) for (const [cx, cy] of rule.outputCells) applied.add(pack(cx + ox, cy + oy));
    this.matches++;
  }

  private copy(ruleMap: RuleMap, rule: RuleDef, ox: number, oy: number, output: RuleOutput): void {
    const wrapBorder = ruleMap.options.wrapBorder;
    for (const layer of output.layers) {
      const target = this.outputs.get(layer.target)!;
      if (!rule.options.ignoreLock && target.locked) continue;
      for (const [x, y] of rule.outputOrder) {
        const cell = layer.grid.cells[y * ruleMap.width + x]!;
        if (cell.kind === 'none' || (cell.kind === 'special' && cell.match !== 'Empty')) continue;
        let dx = x + ox;
        let dy = y + oy;
        if (wrapBorder) {
          if (target.width === 0 || target.height === 0) continue;
          dx = wrap(dx, target.width);
          dy = wrap(dy, target.height);
        } else if (dx < 0 || dy < 0 || dx >= target.width || dy >= target.height) continue;
        target.data[dy * target.width + dx] = cell.kind === 'tile' ? this.literal(ruleMap, cell) : 0;
      }
      for (const p of layer.properties) target.properties.set(p.name, p);
    }
  }
}
