import type { AutomapOptions, AutomapReport, RuleSet } from '../../schemas/automap.schema.js';
import { isExternalTileset, type TiledMap, type TiledProperty, type TiledTileLayer } from '../../schemas/tiled.schema.js';
import { assertWhole, WaEngineError, type ErrorBody } from '../errors.js';
import { allocLayerId, writeTileData } from '../layers.js';
import { isInside } from '../project-paths.js';
import { AutomapRun, type WorkLayer } from './apply.js';
import { GID_MASK, isEmptyCell } from './cells.js';
import { createAutomapRandom } from './random.js';
import { Region } from './region.js';
import { TileTranslator } from './tiles.js';


const sameProperty = (a: TiledProperty | undefined, b: TiledProperty): boolean =>
  a !== undefined && a.type === b.type && a.propertytype === b.propertytype && JSON.stringify(a.value) === JSON.stringify(b.value);

// Applies a rule set to a working map in memory, the way Tiled 1.12's AutoMap does, and
// reports what changed. Throws before changing the map when the run cannot complete.
export function automap(map: TiledMap, rules: RuleSet, options: AutomapOptions): AutomapReport {
  if (map.orientation !== 'orthogonal') {
    throw new WaEngineError('AUTOMAP_UNSUPPORTED', `only orthogonal maps can be automapped, not "${map.orientation}"`, { feature: 'orientation' });
  }
  if (map.infinite === true) throw new WaEngineError('AUTOMAP_UNSUPPORTED', 'infinite maps cannot be automapped', { feature: 'infinite' });
  if (!isInside(rules.projectDir, options.mapAbs)) {
    throw new WaEngineError('INVALID_INPUT', 'the map must be given by its real path inside the rules\' project');
  }
  const seed = options.seed ?? 0;
  if (!Number.isSafeInteger(seed) || seed < 0) throw new WaEngineError('INVALID_INPUT', 'seed must be a whole number of 0 or more');

  const references = rules.references.filter((r) => r.filter === undefined || r.filter.test(options.mapFileName));
  const warnings: ErrorBody[] = [...rules.warnings];
  const seenMaps = new Set<string>();
  for (const r of references) {
    if (seenMaps.has(r.ruleMap.path)) continue;
    seenMaps.add(r.ruleMap.path);
    warnings.push(...r.ruleMap.warnings);
  }
  const report: AutomapReport = {
    rulesPath: rules.rulesPath,
    ruleMaps: references.map((r) => r.ruleMap.relPath),
    rules: references.reduce((n, r) => n + r.ruleMap.rules.length, 0),
    matches: 0,
    changedCells: 0,
    layersWritten: [],
    warnings,
  };

  // The automapped region, clamped to the map before any region is built.
  let left = 0;
  let top = 0;
  let right = map.width - 1;
  let bottom = map.height - 1;
  if (options.region !== undefined) {
    const r = options.region;
    assertWhole({ 'region.x': r.x, 'region.y': r.y, 'region.width': r.width, 'region.height': r.height });
    left = Math.max(left, r.x);
    top = Math.max(top, r.y);
    right = Math.min(right, r.x + r.width - 1);
    bottom = Math.min(bottom, r.y + r.height - 1);
  }
  if (references.length === 0 || left > right || top > bottom) return report;
  for (const ts of map.tilesets) {
    if (isExternalTileset(ts) && options.externalTilesets?.[ts.source] === undefined) {
      report.warnings.push({
        code: 'EXTERNAL_TILESET_UNRESOLVED',
        message: `the map's external tileset "${ts.source}" could not be read, so rules never match its tiles; embed it in Tiled or save it as .tsj`,
        details: { source: ts.source },
      });
    }
  }

  const translator = new TileTranslator(map, options);
  for (const r of references) translator.register(r.ruleMap.tilesets);
  const run = new AutomapRun(map, translator, createAutomapRandom(seed));
  for (const r of references) run.prepareOutputs(r.ruleMap.outputTileLayerNames);

  // In a partial run, each rule map's output widens the region for the following ones.
  const mapRect = { left: 0, top: 0, right: map.width - 1, bottom: map.height - 1 };
  let region = Region.fromRect(left, top, right - left + 1, bottom - top + 1);
  let growing = true;
  for (const r of references) {
    if (growing && region.coversRect(mapRect)) growing = false;
    const applied = run.runRuleMap(r.ruleMap, region, growing);
    if (applied !== undefined) {
      region = region.clone();
      region.unite(applied);
      region.intersectRect(mapRect);
    }
  }
  report.matches = run.matches;
  commit(map, [...run.outputs.values()], translator, report);
  return report;
}

// Writes the working copies back. Everything that can fail is worked out first.
function commit(map: TiledMap, outputs: WorkLayer[], translator: TileTranslator, report: AutomapReport): void {
  const changedAt = (layer: WorkLayer, i: number): boolean => layer.data[i] !== (layer.originalData?.[i] ?? 0);
  const used = new Set<number>();
  for (const layer of outputs) {
    for (let i = 0; i < layer.data.length; i++) {
      const raw = layer.data[i]!;
      if (changedAt(layer, i) && !isEmptyCell(raw) && translator.isProvisional(raw & GID_MASK)) used.add(raw & GID_MASK);
    }
  }
  const plan = translator.planCommit(used);

  const writes: { layer: TiledTileLayer; data: Uint32Array; changed: number }[] = [];
  const propertyWrites: { layer: TiledTileLayer; props: TiledProperty[] }[] = [];
  const created: { layer: WorkLayer; data: Uint32Array; changed: number }[] = [];
  for (const layer of outputs) {
    let changed = 0;
    const data = layer.data.map((raw, i) => {
      if (!changedAt(layer, i)) return raw;
      changed++;
      return isEmptyCell(raw) ? raw : ((plan.remap(raw & GID_MASK) | (raw & ~GID_MASK)) >>> 0);
    });
    const props = [...layer.properties.values()];
    if (layer.original === undefined) {
      if (changed > 0) created.push({ layer, data, changed });
      continue;
    }
    if (changed > 0) writes.push({ layer: layer.original, data, changed });
    const original = layer.original;
    const changedProps = props.filter((p) => !sameProperty(original.properties?.find((q) => q.name === p.name), p));
    if (changedProps.length > 0) propertyWrites.push({ layer: original, props: changedProps });
  }

  for (const w of writes) {
    writeTileData(w.layer, w.data);
    report.changedCells += w.changed;
    report.layersWritten.push(w.layer.name);
  }
  for (const w of propertyWrites) {
    if (!report.layersWritten.includes(w.layer.name)) report.layersWritten.push(w.layer.name);
    const list = (w.layer.properties ??= []);
    for (const p of w.props) {
      const copy = structuredClone(p);
      const index = list.findIndex((q) => q.name === p.name);
      if (index >= 0) list[index] = copy;
      else {
        const at = list.findIndex((q) => q.name > p.name);
        if (at === -1) list.push(copy);
        else list.splice(at, 0, copy);
      }
    }
  }
  for (const c of created) {
    const props = [...c.layer.properties.values()].map((p) => structuredClone(p)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const layer: TiledTileLayer = {
      id: allocLayerId(map),
      name: c.layer.name,
      type: 'tilelayer',
      x: 0,
      y: 0,
      width: c.layer.width,
      height: c.layer.height,
      opacity: 1,
      visible: true,
      data: Array.from(c.data),
      ...(props.length > 0 ? { properties: props } : {}),
    };
    map.layers.push(layer);
    report.changedCells += c.changed;
    report.layersWritten.push(c.layer.name);
  }
  plan.apply();
}
