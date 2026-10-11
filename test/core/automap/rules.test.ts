import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { automap, loadRules, wildcardToRegExp } from '../../../src/core/automap/index.js';
import { readMap } from '../../../src/core/map-io.js';
import { forEachTileLayer, readTileData } from '../../../src/core/layers.js';
import type { WaEngineError } from '../../../src/core/errors.js';
import { makeProject, type TempProject } from '../../helpers/project.js';
import { FIXTURES } from '../../helpers/automap.js';

// Rule maps here use the fixture tilesets: colours (gids 1-8) and automap-rules (9 Empty,
// 10 NonEmpty, 11 Other, 12 Ignore, 13 Negate).

interface LayerSpec {
  name: string;
  data?: number[];
  type?: 'tilelayer' | 'objectgroup' | 'group';
  width?: number;
  height?: number;
  visible?: boolean;
  properties?: { name: string; type: string; value: unknown }[];
  objects?: Record<string, unknown>[];
  layers?: LayerSpec[];
}

function layer(spec: LayerSpec, id: number, w: number, h: number): Record<string, unknown> {
  if (spec.type === 'objectgroup') return { id, name: spec.name, type: 'objectgroup', objects: spec.objects ?? [], visible: true, opacity: 1, x: 0, y: 0 };
  if (spec.type === 'group') return { id, name: spec.name, type: 'group', layers: (spec.layers ?? []).map((l, i) => layer(l, id * 10 + i, w, h)), visible: true, opacity: 1, x: 0, y: 0 };
  const lw = spec.width ?? w;
  const lh = spec.height ?? h;
  return {
    id, name: spec.name, type: 'tilelayer', width: lw, height: lh, x: 0, y: 0, opacity: 1, visible: spec.visible ?? true,
    data: spec.data ?? new Array(lw * lh).fill(0),
    ...(spec.properties !== undefined ? { properties: spec.properties } : {}),
  };
}

const COLOURS = { firstgid: 1, name: 'colours', image: '../tilesets/colours.png', imagewidth: 256, imageheight: 32, tilewidth: 32, tileheight: 32, tilecount: 8, columns: 8 };
const RULES = {
  firstgid: 9, name: 'automap-rules', image: '../tilesets/rules.png', imagewidth: 160, imageheight: 32, tilewidth: 32, tileheight: 32, tilecount: 5, columns: 5,
  tiles: ['Empty', 'NonEmpty', 'Other', 'Ignore', 'Negate'].map((value, id) => ({ id, properties: [{ name: 'MatchType', type: 'string', value }] })),
};

function ruleMapJson(layers: LayerSpec[], opts: { width?: number; height?: number; orientation?: string; infinite?: boolean; properties?: unknown[]; tilesets?: unknown[] } = {}): string {
  const w = opts.width ?? 1;
  const h = opts.height ?? 1;
  return JSON.stringify({
    type: 'map', version: '1.11', orientation: opts.orientation ?? 'orthogonal', renderorder: 'right-down', width: w, height: h, tilewidth: 32, tileheight: 32,
    infinite: opts.infinite ?? false, nextlayerid: 99, nextobjectid: 99, layers: layers.map((l, i) => layer(l, i + 1, w, h)),
    tilesets: opts.tilesets ?? [COLOURS, RULES], ...(opts.properties !== undefined ? { properties: opts.properties } : {}),
  });
}

let project: TempProject;
let rulesDir: string;
beforeEach(async () => {
  project = await makeProject();
  await copyFile(join(FIXTURES, 'tilesets', 'colours.png'), join(project.dir, 'tilesets', 'colours.png'));
  await copyFile(join(FIXTURES, 'tilesets', 'rules.png'), join(project.dir, 'tilesets', 'rules.png'));
  rulesDir = join(project.dir, 'rules');
  await mkdir(rulesDir);
});
afterEach(() => project.cleanup());

async function writeRuleMap(file: string, layers: LayerSpec[], opts: Parameters<typeof ruleMapJson>[1] = {}): Promise<void> {
  await writeFile(join(rulesDir, file), ruleMapJson(layers, opts));
  await writeFile(join(rulesDir, 'rules.txt'), `${file}\n`);
}

async function loadError(rules = join(rulesDir, 'rules.txt')): Promise<WaEngineError> {
  try {
    await loadRules(project.dir, rules);
  } catch (err) {
    return err as WaEngineError;
  }
  throw new Error('expected loadRules to fail');
}

const replaceAtoB: LayerSpec[] = [
  { name: 'input_ground', data: [1] },
  { name: 'output_ground', data: [2] },
];

describe('rules files', () => {
  test('the hash of a rule set changes with its rules, not with line endings or spacing', async () => {
    await writeRuleMap('walls.tmj', replaceAtoB);
    const hash = async (): Promise<string> => (await loadRules(project.dir, join(rulesDir, 'rules.txt'))).hash;
    const first = await hash();
    await writeFile(join(rulesDir, 'rules.txt'), 'walls.tmj\r\n');
    await writeFile(join(rulesDir, 'walls.tmj'), JSON.stringify(JSON.parse(ruleMapJson(replaceAtoB)), null, 2));
    expect(await hash()).toBe(first);
    await writeFile(join(rulesDir, 'walls.tmj'), ruleMapJson([{ name: 'input_ground', data: [1] }, { name: 'output_ground', data: [3] }]));
    expect(await hash()).not.toBe(first);
    await writeFile(join(rulesDir, 'walls.tmj'), ruleMapJson(replaceAtoB));
    await writeFile(join(rulesDir, 'rules.txt'), 'walls.tmj\nwalls.tmj\n');
    expect(await hash()).not.toBe(first);
  });

  test('a missing rules file is AUTOMAP_RULES_NOT_FOUND', async () => {
    expect((await loadError(join(rulesDir, 'none.txt'))).code).toBe('AUTOMAP_RULES_NOT_FOUND');
  });

  test('a missing rule map is AUTOMAP_RULES_NOT_FOUND', async () => {
    await writeFile(join(rulesDir, 'rules.txt'), 'gone.tmj\n');
    expect((await loadError()).code).toBe('AUTOMAP_RULES_NOT_FOUND');
  });

  test('a rule map that is not .tmj or .json is PATH_BAD_EXTENSION', async () => {
    await writeFile(join(rulesDir, 'rules.txt'), 'walls.tmx\n');
    expect((await loadError()).code).toBe('PATH_BAD_EXTENSION');
  });

  test('a rule map outside the project is PATH_OUTSIDE_PROJECT', async () => {
    await writeFile(join(rulesDir, 'rules.txt'), '../../elsewhere.tmj\n');
    expect((await loadError()).code).toBe('PATH_OUTSIDE_PROJECT');
  });

  test('rules files that include each other are AUTOMAP_RULES_INVALID', async () => {
    await writeFile(join(rulesDir, 'rules.txt'), 'a.txt\n');
    await writeFile(join(rulesDir, 'a.txt'), 'b.TXT\n');
    await writeFile(join(rulesDir, 'b.TXT'), 'a.txt\n');
    const err = await loadError();
    expect(err.code).toBe('AUTOMAP_RULES_INVALID');
    expect(err.details).toMatchObject({ cycle: ['rules/rules.txt', 'rules/a.txt', 'rules/b.TXT', 'rules/a.txt'] });
  });

  test('comments, blank lines and trimmed lines; the same rule map may be listed twice', async () => {
    await writeRuleMap('ab.tmj', replaceAtoB);
    await writeFile(join(rulesDir, 'rules.txt'), '# comment\n\n   // another\n  ab.tmj  \nab.tmj\n');
    const rules = await loadRules(project.dir, join(rulesDir, 'rules.txt'));
    expect(rules.references.map((r) => r.ruleMap.relPath)).toEqual(['rules/ab.tmj', 'rules/ab.tmj']);
    expect(rules.references[0]!.ruleMap).toBe(rules.references[1]!.ruleMap);
  });

  test('a rules path may name a single rule map', async () => {
    await writeRuleMap('ab.tmj', replaceAtoB);
    const rules = await loadRules(project.dir, join(rulesDir, 'ab.tmj'));
    expect(rules.rulesPath).toBe('rules/ab.tmj');
    expect(rules.references).toHaveLength(1);
  });

  test('filters follow Qt wildcards, anchored and case-insensitive', () => {
    expect(wildcardToRegExp('map*.tmj').test('Map-1.TMJ')).toBe(true);
    expect(wildcardToRegExp('map?.tmj').test('map12.tmj')).toBe(false);
    expect(wildcardToRegExp('[ab]*.tmj').test('b.tmj')).toBe(true);
    expect(wildcardToRegExp('[!ab]*.tmj').test('b.tmj')).toBe(false);
    expect(wildcardToRegExp('x[.tmj').test('x[.tmj')).toBe(true);
    expect(wildcardToRegExp('*.tmj').test('dir/a.tmj')).toBe(false);
  });
});

describe('rule maps', () => {
  test.each([
    ['legacy regions', [{ name: 'regions', data: [1] }, ...replaceAtoB], 'AUTOMAP_UNSUPPORTED', 'legacy-regions'],
    ['regions_input', [{ name: 'Regions_Input', data: [1] }, ...replaceAtoB], 'AUTOMAP_UNSUPPORTED', 'legacy-regions'],
    ['object output', [{ name: 'input_ground', data: [1] }, { name: 'output_objects', type: 'objectgroup' }], 'AUTOMAP_UNSUPPORTED', 'object-layers'],
    ['object input', [{ name: 'input_ground', type: 'objectgroup' }, { name: 'output_ground', data: [2] }], 'AUTOMAP_UNSUPPORTED', 'object-layers'],
    ['other object layer', [...replaceAtoB, { name: 'notes', type: 'objectgroup' }], 'AUTOMAP_UNSUPPORTED', 'object-layers'],
  ] as const)('%s is refused', async (_label, layers, code, feature) => {
    await writeRuleMap('bad.tmj', [...layers] as LayerSpec[]);
    const err = await loadError();
    expect(err.code).toBe(code);
    expect(err.details).toMatchObject({ feature });
  });

  test.each([
    ['no underscore', [...replaceAtoB, { name: 'walls', data: [1] }]],
    ['rule_options as a tile layer', [...replaceAtoB, { name: 'rule_options', data: [0] }]],
    ['no input layer', [{ name: 'output_ground', data: [2] }]],
    ['no output layer', [{ name: 'input_ground', data: [1] }]],
    ['layer of the wrong size', [{ name: 'input_ground', data: [1, 1], width: 2 }, { name: 'output_ground', data: [2] }]],
    ['gid out of range', [{ name: 'input_ground', data: [40] }, { name: 'output_ground', data: [2] }]],
  ] as const)('%s is AUTOMAP_RULES_INVALID', async (_label, layers) => {
    await writeRuleMap('bad.tmj', [...layers] as LayerSpec[]);
    expect((await loadError()).code).toBe('AUTOMAP_RULES_INVALID');
  });

  test('size limits: 0x0 and 501x501 are AUTOMAP_RULES_INVALID', async () => {
    await writeRuleMap('zero.tmj', replaceAtoB, { width: 0, height: 0 });
    expect((await loadError()).code).toBe('AUTOMAP_RULES_INVALID');
    await writeRuleMap('huge.tmj', [{ name: 'input_ground' }, { name: 'output_ground' }], { width: 501, height: 501 });
    expect((await loadError()).code).toBe('AUTOMAP_RULES_INVALID');
  });

  test('isometric and infinite rule maps are AUTOMAP_UNSUPPORTED', async () => {
    await writeRuleMap('iso.tmj', replaceAtoB, { orientation: 'isometric' });
    expect((await loadError()).details).toMatchObject({ feature: 'orientation' });
    await writeRuleMap('inf.tmj', replaceAtoB, { infinite: true });
    expect((await loadError()).details).toMatchObject({ feature: 'infinite' });
  });

  test('a file that is not JSON is AUTOMAP_RULES_INVALID', async () => {
    await writeFile(join(rulesDir, 'rules.txt'), 'broken.tmj\n');
    await writeFile(join(rulesDir, 'broken.tmj'), '{ not json');
    expect((await loadError()).code).toBe('AUTOMAP_RULES_INVALID');
  });

  test('a literal tile from an XML tileset is AUTOMAP_RULES_INVALID naming the tileset', async () => {
    await writeRuleMap('xml.tmj', [{ name: 'input_ground', data: [1] }, { name: 'output_ground', data: [1] }], { tilesets: [{ firstgid: 1, source: 'tiles.tsx' }] });
    const err = await loadError();
    expect(err.code).toBe('AUTOMAP_RULES_INVALID');
    expect(err.details).toMatchObject({ tileset: 'tiles.tsx' });
  });

  test('ignored layers, properties and rule options give AUTOMAP_RULES_IGNORED warnings', async () => {
    await writeRuleMap('warn.tmj', [
      { name: 'input_ground', data: [1], properties: [{ name: 'Colour', type: 'string', value: 'x' }] },
      { name: 'output_ground', data: [2] },
      { name: 'regionsish', data: [0] },
      { name: 'misc_ground', data: [0] },
      { name: '//commented', data: [5] },
      {
        name: 'rule_options', type: 'objectgroup', objects: [
          { id: 1, x: 0, y: 0, width: 32, height: 32, ellipse: true },
          { id: 2, x: 0, y: 0, width: 32, height: 32, rotation: 45 },
          { id: 3, x: 0, y: 0, width: 32, height: 32, properties: [{ name: 'Speed', type: 'int', value: 2 }] },
        ],
      },
    ], { properties: [{ name: 'Mood', type: 'string', value: 'calm' }] });
    const rules = await loadRules(project.dir, join(rulesDir, 'rules.txt'));
    const warnings = rules.references[0]!.ruleMap.warnings;
    expect(warnings.every((w) => w.code === 'AUTOMAP_RULES_IGNORED')).toBe(true);
    expect(warnings.map((w) => w.message.replace(/^rules\/warn\.tmj: /, ''))).toEqual([
      'unknown map property "Mood" is ignored',
      'unknown property "Colour" on layer "input_ground" is ignored',
      'layer "regionsish" is not an automapping layer and is ignored',
      'layer "misc_ground" is not an automapping layer and is ignored',
      'only rectangles are used on "rule_options"; object 1 is ignored',
      'rotated rectangles are not supported on "rule_options"; object 2 is ignored',
      'unknown rule option "Speed" on object 3 is ignored',
    ]);
  });

  test('prefixes and property names ignore case; groups are searched; hidden layers are used', async () => {
    await writeRuleMap('case.tmj', [
      { name: 'stuff', type: 'group', layers: [{ name: 'INPUT_ground', data: [1], visible: false }] },
      { name: 'Output_ground', data: [2] },
    ], { properties: [{ name: 'matchinorder', type: 'bool', value: true }] });
    const rules = await loadRules(project.dir, join(rulesDir, 'rules.txt'));
    const rm = rules.references[0]!.ruleMap;
    expect(rm.options.matchInOrder).toBe(true);
    expect(rm.rules).toHaveLength(1);
    expect(rm.inputLayerNames).toEqual(['ground']);
  });

  test('NoOverlappingRules is read as NoOverlappingOutput, which wins when both are set', async () => {
    await writeRuleMap('old.tmj', replaceAtoB, { properties: [{ name: 'NoOverlappingRules', type: 'bool', value: true }] });
    expect((await loadRules(project.dir, join(rulesDir, 'rules.txt'))).references[0]!.ruleMap.rules[0]!.options.noOverlappingOutput).toBe(true);
    await writeRuleMap('both.tmj', replaceAtoB, { properties: [{ name: 'NoOverlappingRules', type: 'bool', value: true }, { name: 'NoOverlappingOutput', type: 'bool', value: false }] });
    expect((await loadRules(project.dir, join(rulesDir, 'rules.txt'))).references[0]!.ruleMap.rules[0]!.options.noOverlappingOutput).toBe(false);
  });

  test('ModX of 0 is clamped to 1; OverflowBorder and WrapBorder imply MatchOutsideMap', async () => {
    await writeRuleMap('opts.tmj', replaceAtoB, { properties: [{ name: 'ModX', type: 'int', value: 0 }, { name: 'WrapBorder', type: 'bool', value: true }] });
    const rm = (await loadRules(project.dir, join(rulesDir, 'rules.txt'))).references[0]!.ruleMap;
    expect(rm.rules[0]!.options.modX).toBe(1);
    expect(rm.options.matchOutsideMap).toBe(true);
  });

  test('an index whose cells all cancel out never matches', async () => {
    // input A and inputnot A at the same cell: nothing is allowed.
    await writeRuleMap('cancel.tmj', [{ name: 'input_ground', data: [1] }, { name: 'inputnot_ground', data: [1] }, { name: 'output_ground', data: [2] }]);
    const rules = await loadRules(project.dir, join(rulesDir, 'rules.txt'));
    await writeFile(join(rulesDir, 'map.tmj'), ruleMapJson([{ name: 'ground', data: [1] }], { tilesets: [COLOURS] }));
    const { map } = await readMap(join(rulesDir, 'map.tmj'));
    expect(automap(map, rules, { mapFileName: 'map.tmj', mapAbs: join(rulesDir, 'map.tmj') }).matches).toBe(0);
  });

  test('a missing input layer reads as empty: rules needing a tile there never match', async () => {
    await writeRuleMap('missing.tmj', [{ name: 'input_floor', data: [1] }, { name: 'output_ground', data: [2] }]);
    const rules = await loadRules(project.dir, join(rulesDir, 'rules.txt'));
    await writeFile(join(rulesDir, 'map.tmj'), ruleMapJson([{ name: 'ground', data: [1] }], { tilesets: [COLOURS] }));
    const { map } = await readMap(join(rulesDir, 'map.tmj'));
    const report = automap(map, rules, { mapFileName: 'map.tmj', mapAbs: join(rulesDir, 'map.tmj') });
    expect(report.matches).toBe(0);
    let data: number[] = [];
    forEachTileLayer(map.layers, (l) => (data = Array.from(readTileData(l))));
    expect(data).toEqual([1]);
  });
});

describe('rules-file and rule-map limits', () => {
  test('AutomappingRadius larger than any map is AUTOMAP_RULES_INVALID', async () => {
    await writeRuleMap('radius.tmj', replaceAtoB, { properties: [{ name: 'AutomappingRadius', type: 'int', value: 5_000_000 }] });
    expect((await loadError()).code).toBe('AUTOMAP_RULES_INVALID');
  });

  test('a literal tile from a tileset whose image is missing is AUTOMAP_RULES_INVALID naming the tileset', async () => {
    await writeRuleMap('missing.tmj', replaceAtoB, { tilesets: [{ ...COLOURS, image: '../tilesets/gone.png' }, RULES] });
    const err = await loadError();
    expect(err.code).toBe('AUTOMAP_RULES_INVALID');
    expect(err.details).toMatchObject({ tileset: 'colours' });
  });

  test('a filter that is not a valid pattern applies to every map, with a warning', async () => {
    await writeRuleMap('ab.tmj', replaceAtoB);
    await writeFile(join(rulesDir, 'rules.txt'), '[[z-a]]\nab.tmj\n');
    const rules = await loadRules(project.dir, join(rulesDir, 'rules.txt'));
    expect(rules.references[0]!.filter).toBeUndefined();
    expect(rules.warnings.map((w) => w.code)).toEqual(['AUTOMAP_RULES_IGNORED']);
  });

  test('a .tmx rule map is refused with a hint to save it as .tmj', async () => {
    await writeFile(join(rulesDir, 'rules.txt'), 'walls.tmx\n');
    const err = await loadError();
    expect(err.code).toBe('PATH_BAD_EXTENSION');
    expect(err.message).toContain('.tmj');
  });

  test('includes nested too deep and too many rule maps are AUTOMAP_RULES_INVALID', async () => {
    for (let i = 0; i < 20; i++) await writeFile(join(rulesDir, `r${i}.txt`), `r${i + 1}.txt\n`);
    await writeFile(join(rulesDir, 'rules.txt'), 'r0.txt\n');
    expect((await loadError()).code).toBe('AUTOMAP_RULES_INVALID');
    await writeRuleMap('ab.tmj', replaceAtoB);
    await writeFile(join(rulesDir, 'rules.txt'), 'ab.tmj\n'.repeat(1001));
    expect((await loadError()).code).toBe('AUTOMAP_RULES_INVALID');
  });
});
