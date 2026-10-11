// Writes the automapping test fixtures under test/fixtures/automap/: one folder per feature
// with a working map (map.tmj), its rule maps, a rules.txt and fixture.json. The expected
// outputs (expected.tmj) come from Tiled itself: see scripts/tiled-automap-capture.ts.
//
//   npx tsx scripts/gen-automap-fixtures.ts
//
// Cells are written one character each ('.' empty, 'A'-'H' tiles 0-7 of the colour tileset,
// 'e' Empty, 'n' NonEmpty, 'o' Other, 'i' Ignore, 'g' Negate), or as space-separated tokens
// when a tile is flipped: a tile letter followed by 'h', 'v' and/or 'd' (a one-token row ends
// in a space).

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../src/core/png.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'automap');

const COLOURS: [number, number, number][] = [
  [220, 60, 60], [60, 160, 70], [60, 90, 210], [230, 190, 40],
  [150, 70, 190], [40, 180, 190], [240, 130, 40], [120, 120, 120],
];
const SPECIALS = ['Empty', 'NonEmpty', 'Other', 'Ignore', 'Negate'] as const;
const SPECIAL_CHARS: Record<string, number> = { e: 0, n: 1, o: 2, i: 3, g: 4 };
const COLOUR_FIRSTGID = 1;
const RULES_FIRSTGID = COLOUR_FIRSTGID + COLOURS.length;

interface Prop {
  name: string;
  type: 'bool' | 'int' | 'float' | 'string';
  value: unknown;
}

interface LayerDef {
  name: string;
  rows: string[];
  properties?: Prop[];
  locked?: boolean;
}

interface RuleOptionsRect {
  x: number;
  y: number;
  width: number;
  height: number;
  properties: Prop[];
}

interface RuleMapDef {
  file: string;
  layers: LayerDef[];
  properties?: Prop[];
  ruleOptions?: RuleOptionsRect[];
}

interface FixtureDef {
  name: string;
  description: string;
  map: LayerDef[];
  ruleMaps: RuleMapDef[];
  // rules.txt content; by default it lists every rule map.
  rules?: string;
  extraFiles?: Record<string, string>;
  // Random output: Tiled's generator cannot be seeded, so these are checked by the engine only.
  random?: boolean;
  mapFile?: string;
  // A partial run over this rectangle of tiles.
  region?: { x: number; y: number; width: number; height: number };
  // The colour tileset is an external file (tilesets/colours.tsj) in the map and rule maps.
  external?: boolean;
  // Map layers placed inside a locked group layer.
  lockedGroup?: string[];
}

const flags = (suffix: string): number =>
  ((suffix.includes('h') ? 0x80000000 : 0) | (suffix.includes('v') ? 0x40000000 : 0) | (suffix.includes('d') ? 0x20000000 : 0)) >>> 0;

function token(t: string): number {
  if (t === '.') return 0;
  const special = SPECIAL_CHARS[t];
  if (special !== undefined) return RULES_FIRSTGID + special;
  const base = t.charCodeAt(0) - 'A'.charCodeAt(0);
  if (base < 0 || base >= COLOURS.length) throw new Error(`bad cell "${t}"`);
  return (COLOUR_FIRSTGID + base + flags(t.slice(1))) >>> 0;
}

function parseRows(rows: string[]): number[][] {
  return rows.map((row) => (row.includes(' ') ? row.trim().split(/\s+/) : [...row]).map(token));
}

function size(layers: LayerDef[]): { width: number; height: number } {
  const grids = layers.map((l) => parseRows(l.rows));
  const width = Math.max(...grids.map((g) => Math.max(...g.map((r) => r.length))));
  const height = Math.max(...grids.map((g) => g.length));
  return { width, height };
}

const colourFields = (image: string) => ({
  columns: COLOURS.length, image, imageheight: 32, imagewidth: 32 * COLOURS.length,
  margin: 0, name: 'colours', spacing: 0, tilecount: COLOURS.length, tileheight: 32, tilewidth: 32,
});
const colourTileset = (external: boolean) =>
  external ? { firstgid: COLOUR_FIRSTGID, source: '../tilesets/colours.tsj' } : { firstgid: COLOUR_FIRSTGID, ...colourFields('../tilesets/colours.png') };

const rulesTileset = () => ({
  columns: SPECIALS.length, firstgid: RULES_FIRSTGID, image: '../tilesets/rules.png', imageheight: 32, imagewidth: 32 * SPECIALS.length,
  margin: 0, name: 'automap-rules', spacing: 0, tilecount: SPECIALS.length, tileheight: 32, tilewidth: 32,
  tiles: SPECIALS.map((match, id) => ({ id, properties: [{ name: 'MatchType', type: 'string', value: match }] })),
});

function tmj(layers: LayerDef[], withRules: boolean, extra: { properties?: Prop[] | undefined; ruleOptions?: RuleOptionsRect[] | undefined; external?: boolean; lockedGroup?: string[] | undefined } = {}): unknown {
  const { width, height } = size(layers);
  let id = 1;
  const out: unknown[] = layers.map((l) => {
    const grid = parseRows(l.rows);
    const data: number[] = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.push(grid[y]?.[x] ?? 0);
    return {
      data, height, id: id++, name: l.name, opacity: 1, type: 'tilelayer', visible: true, width, x: 0, y: 0,
      ...(l.locked === true ? { locked: true } : {}),
      ...(l.properties !== undefined ? { properties: l.properties } : {}),
    };
  });
  if (extra.lockedGroup !== undefined) {
    const inside = out.filter((l) => extra.lockedGroup!.includes((l as { name: string }).name));
    const at = out.indexOf(inside[0]!);
    const group = { id: id++, layers: inside, locked: true, name: 'locked', opacity: 1, type: 'group', visible: true, x: 0, y: 0 };
    out.splice(at, inside.length, group);
  }
  let objectId = 1;
  if (extra.ruleOptions !== undefined) {
    out.push({
      draworder: 'topdown', id: id++, name: 'rule_options', opacity: 1, type: 'objectgroup', visible: true, x: 0, y: 0,
      objects: extra.ruleOptions.map((r) => ({
        height: r.height * 32, id: objectId++, name: '', properties: r.properties, rotation: 0, type: '', visible: true,
        width: r.width * 32, x: r.x * 32, y: r.y * 32,
      })),
    });
  }
  return {
    compressionlevel: -1, height, infinite: false, layers: out, nextlayerid: id, nextobjectid: objectId, orientation: 'orthogonal',
    ...(extra.properties !== undefined ? { properties: extra.properties } : {}),
    renderorder: 'right-down', tiledversion: '1.12.2', tileheight: 32,
    tilesets: withRules ? [colourTileset(extra.external === true), rulesTileset()] : [colourTileset(extra.external === true)],
    tilewidth: 32, type: 'map', version: '1.11', width,
  };
}

const p = (name: string, type: Prop['type'], value: unknown): Prop => ({ name, type, value });
const AtoB = (file = 'replace.tmj'): RuleMapDef => ({ file, layers: [{ name: 'input_ground', rows: ['A'] }, { name: 'output_ground', rows: ['B'] }] });

const FIXTURES: FixtureDef[] = [
  { name: 'simple-replace', description: 'A one-cell rule turns every A into B', map: [{ name: 'ground', rows: ['A..A', '.A..', '...A'] }], ruleMaps: [AtoB()] },
  {
    name: 'multi-cell', description: 'A 2x1 rule; overlapping outputs are applied in scan order, the later one wins',
    map: [{ name: 'ground', rows: ['AA.AA', 'A.AAA'] }],
    ruleMaps: [{ file: 'pair.tmj', layers: [{ name: 'input_ground', rows: ['AA'] }, { name: 'output_ground', rows: ['CD'] }] }],
  },
  {
    name: 'inputnot', description: 'An A whose right neighbour is not B becomes C',
    map: [{ name: 'ground', rows: ['AB.A', 'AAAB'] }],
    ruleMaps: [{ file: 'not.tmj', layers: [{ name: 'input_ground', rows: ['A.'] }, { name: 'inputnot_ground', rows: ['.B'] }, { name: 'output_ground', rows: ['C.'] }] }],
  },
  {
    name: 'two-indices', description: 'Input indices 1 and 2 are alternatives: A or B becomes E',
    map: [{ name: 'ground', rows: ['ABCA'] }],
    ruleMaps: [{ file: 'indices.tmj', layers: [{ name: 'input1_ground', rows: ['A'] }, { name: 'input2_ground', rows: ['B'] }, { name: 'output_ground', rows: ['E'] }] }],
  },
  {
    name: 'same-name-alternatives', description: 'Two input layers with the same name accept either tile: A or C becomes F',
    map: [{ name: 'ground', rows: ['ABCA'] }],
    ruleMaps: [{ file: 'alternatives.tmj', layers: [{ name: 'input_ground', rows: ['A'] }, { name: 'input_ground', rows: ['C'] }, { name: 'output_ground', rows: ['F'] }] }],
  },
  {
    name: 'special-empty', description: 'Input Empty matches empty cells',
    map: [{ name: 'ground', rows: ['A.A', '.A.'] }],
    ruleMaps: [{ file: 'empty.tmj', layers: [{ name: 'input_ground', rows: ['e'] }, { name: 'output_ground', rows: ['B'] }] }],
  },
  {
    name: 'special-nonempty', description: 'Input NonEmpty matches any tile',
    map: [{ name: 'ground', rows: ['A.C'] }],
    ruleMaps: [{ file: 'nonempty.tmj', layers: [{ name: 'input_ground', rows: ['n'] }, { name: 'output_ground', rows: ['D'] }] }],
  },
  {
    name: 'special-other', description: 'Other refuses the tiles the rule uses on that input layer (A) and accepts empty',
    map: [{ name: 'ground', rows: ['AABA.'] }],
    ruleMaps: [{ file: 'other.tmj', layers: [{ name: 'input_ground', rows: ['Ao'] }, { name: 'output_ground', rows: ['E.'] }] }],
  },
  {
    name: 'special-ignore', description: 'Ignore tiles widen the rule, so it cannot match at the map edge',
    map: [{ name: 'ground', rows: ['AAAA'] }],
    ruleMaps: [{ file: 'ignore.tmj', layers: [{ name: 'input_ground', rows: ['iAi'] }, { name: 'output_ground', rows: ['.C.'] }] }],
  },
  {
    name: 'special-negate', description: 'Negate turns "A" into "anything but A", empty included',
    map: [{ name: 'ground', rows: ['AB.A'] }],
    ruleMaps: [{ file: 'negate.tmj', layers: [{ name: 'input_ground', rows: ['A'] }, { name: 'input_ground', rows: ['g'] }, { name: 'output_ground', rows: ['D'] }] }],
  },
  {
    name: 'auto-empty', description: 'AutoEmpty makes the empty cells of an input layer require empty',
    map: [{ name: 'ground', rows: ['AA.A.'] }],
    ruleMaps: [{
      file: 'autoempty.tmj',
      layers: [
        { name: 'input_ground', rows: ['A.'], properties: [p('AutoEmpty', 'bool', true)] },
        { name: 'input_deco', rows: ['.i'] },
        { name: 'output_ground', rows: ['B.'] },
      ],
    }],
  },
  {
    name: 'flips-exact', description: 'A flipped input tile matches only the same flip',
    map: [{ name: 'ground', rows: ['A Ah Av Ahv'] }],
    ruleMaps: [{ file: 'flip.tmj', layers: [{ name: 'input_ground', rows: ['Ah '] }, { name: 'output_ground', rows: ['C'] }] }],
  },
  {
    name: 'flips-ignored', description: 'IgnoreHorizontalFlip lets A match A and its horizontal mirror only',
    map: [{ name: 'ground', rows: ['A Ah Av Ahv'] }],
    ruleMaps: [{ file: 'flip.tmj', layers: [{ name: 'input_ground', rows: ['A'], properties: [p('IgnoreHorizontalFlip', 'bool', true)] }, { name: 'output_ground', rows: ['C'] }] }],
  },
  {
    name: 'output-probability', description: 'Output index 1 (weight 3) or 2 (weight 1) is drawn per match', random: true,
    map: [{ name: 'ground', rows: ['AAAAAAAA', 'AAAAAAAA', 'AAAAAAAA', 'AAAAAAAA', 'AAAAAAAA', 'AAAAAAAA', 'AAAAAAAA', 'AAAAAAAA'] }],
    ruleMaps: [{
      file: 'random.tmj',
      layers: [
        { name: 'input_ground', rows: ['A'] },
        { name: 'output1_ground', rows: ['B'], properties: [p('Probability', 'float', 3)] },
        { name: 'output2_ground', rows: ['C'], properties: [p('Probability', 'float', 1)] },
      ],
    }],
  },
  {
    name: 'rule-probability', description: 'A rule_options Probability of 0.25 skips about three positions in four', random: true,
    map: [{ name: 'ground', rows: ['AAAAAAAA', 'AAAAAAAA', 'AAAAAAAA', 'AAAAAAAA', 'AAAAAAAA', 'AAAAAAAA', 'AAAAAAAA', 'AAAAAAAA'] }],
    ruleMaps: [{ ...AtoB('sometimes.tmj'), ruleOptions: [{ x: 0, y: 0, width: 1, height: 1, properties: [p('Probability', 'float', 0.25)] }] }],
  },
  {
    name: 'unnamed-then-drawn', description: 'Unnamed outputs are written first, then the drawn index, which wins on shared cells',
    map: [{ name: 'ground', rows: ['A.A'] }],
    ruleMaps: [{ file: 'order.tmj', layers: [{ name: 'input_ground', rows: ['A'] }, { name: 'output_ground', rows: ['B'] }, { name: 'output1_ground', rows: ['C'] }] }],
  },
  {
    name: 'no-overlapping-output', description: 'NoOverlappingOutput skips matches whose output touches an earlier one of the same rule',
    map: [{ name: 'ground', rows: ['AAAAA', 'AAAAA', 'AAAAA', 'AAAAA', 'AAAAA'] }],
    ruleMaps: [{
      file: 'tiles.tmj', properties: [p('NoOverlappingOutput', 'bool', true)],
      layers: [{ name: 'input_ground', rows: ['AA', 'AA'] }, { name: 'output_ground', rows: ['BC', 'CB'] }],
    }],
  },
  {
    name: 'delete-tiles', description: 'DeleteTiles clears the output layers where an input layer has tiles, before matching',
    map: [{ name: 'ground', rows: ['A.A.'] }, { name: 'deco', rows: ['CCCC'] }],
    ruleMaps: [{ file: 'delete.tmj', properties: [p('DeleteTiles', 'bool', true)], layers: [{ name: 'input_ground', rows: ['A'] }, { name: 'output_deco', rows: ['B'] }] }],
  },
  {
    name: 'chain-simultaneous', description: 'By default every rule matches the map as it was before the rule map ran',
    map: [{ name: 'ground', rows: ['BAAA'] }],
    ruleMaps: [{ file: 'chain.tmj', layers: [{ name: 'input_ground', rows: ['BA'] }, { name: 'output_ground', rows: ['.B'] }] }],
  },
  {
    name: 'chain-in-order', description: 'MatchInOrder applies each match at once, so later positions see it',
    map: [{ name: 'ground', rows: ['BAAA'] }],
    ruleMaps: [{ file: 'chain.tmj', properties: [p('MatchInOrder', 'bool', true)], layers: [{ name: 'input_ground', rows: ['BA'] }, { name: 'output_ground', rows: ['.B'] }] }],
  },
  {
    name: 'sequential-rule-maps', description: 'Rule maps run one after another, each on the previous one\'s output',
    map: [{ name: 'ground', rows: ['AAA'] }],
    ruleMaps: [AtoB('first.tmj'), { file: 'second.tmj', layers: [{ name: 'input_ground', rows: ['B'] }, { name: 'output_ground', rows: ['C'] }] }],
  },
  {
    name: 'outside-default', description: 'By default the whole input box must lie inside the map',
    map: [{ name: 'ground', rows: ['AA.A'] }],
    ruleMaps: [{ file: 'edge.tmj', layers: [{ name: 'input_ground', rows: ['eA'] }, { name: 'output_ground', rows: ['.C'] }] }],
  },
  {
    name: 'outside-match', description: 'MatchOutsideMap reads cells outside the map as empty',
    map: [{ name: 'ground', rows: ['AA.A'] }],
    ruleMaps: [{ file: 'edge.tmj', properties: [p('MatchOutsideMap', 'bool', true)], layers: [{ name: 'input_ground', rows: ['eA'] }, { name: 'output_ground', rows: ['.C'] }] }],
  },
  {
    name: 'outside-clipped', description: 'Outputs past the map edge are dropped',
    map: [{ name: 'ground', rows: ['..A'] }],
    ruleMaps: [{ file: 'edge.tmj', properties: [p('MatchOutsideMap', 'bool', true)], layers: [{ name: 'input_ground', rows: ['Ae'] }, { name: 'output_ground', rows: ['.C'] }] }],
  },
  {
    name: 'border-overflow', description: 'OverflowBorder reads outside cells as the nearest edge cell',
    map: [{ name: 'ground', rows: ['A.'] }],
    ruleMaps: [{ file: 'edge.tmj', properties: [p('OverflowBorder', 'bool', true)], layers: [{ name: 'input_ground', rows: ['AA'] }, { name: 'output_ground', rows: ['.C'] }] }],
  },
  {
    name: 'border-wrap', description: 'WrapBorder wraps reads and writes around the map',
    map: [{ name: 'ground', rows: ['..A'] }],
    ruleMaps: [{ file: 'edge.tmj', properties: [p('WrapBorder', 'bool', true)], layers: [{ name: 'input_ground', rows: ['Ae'] }, { name: 'output_ground', rows: ['.C'] }] }],
  },
  {
    name: 'mod-offset', description: 'ModX 2, ModY 2, OffsetX 1 try only every other column and row',
    map: [{ name: 'ground', rows: ['AAAA', 'AAAA', 'AAAA', 'AAAA'] }],
    ruleMaps: [{ ...AtoB('mod.tmj'), properties: [p('ModX', 'int', 2), p('ModY', 'int', 2), p('OffsetX', 'int', 1)] }],
  },
  {
    name: 'mod-negative-offset', description: 'OffsetX -1 with ModX 3 hits Tiled\'s unsigned modulo: columns 0 and 3',
    map: [{ name: 'ground', rows: ['AAAAAA'] }],
    ruleMaps: [{ ...AtoB('mod.tmj'), ruleOptions: [{ x: 0, y: 0, width: 1, height: 1, properties: [p('ModX', 'int', 3), p('OffsetX', 'int', -1)] }] }],
  },
  {
    name: 'disabled-rule', description: 'A rule_options rectangle disables only the rule it fully contains',
    map: [{ name: 'ground', rows: ['AC'] }],
    ruleMaps: [{
      file: 'two.tmj',
      layers: [{ name: 'input_ground', rows: ['A.C'] }, { name: 'output_ground', rows: ['B.D'] }],
      ruleOptions: [{ x: 0, y: 0, width: 1, height: 1, properties: [p('Disabled', 'bool', true)] }],
    }],
  },
  {
    name: 'empty-index', description: 'Tiled 1.12: an index with no condition inside a rule never matches',
    map: [{ name: 'ground', rows: ['ACAA'] }],
    ruleMaps: [{ file: 'indices.tmj', layers: [{ name: 'input1_ground', rows: ['A..'] }, { name: 'input2_ground', rows: ['..C'] }, { name: 'output_ground', rows: ['B.D'] }] }],
  },
  {
    name: 'new-layer', description: 'A missing target layer is created at the top of the map',
    map: [{ name: 'ground', rows: ['A.A'] }],
    ruleMaps: [{ file: 'overlay.tmj', layers: [{ name: 'input_ground', rows: ['A'] }, { name: 'output_overlay', rows: ['B'] }] }],
  },
  {
    name: 'output-properties', description: 'Properties of an output layer are copied to its target layer',
    map: [{ name: 'ground', rows: ['A.'] }],
    ruleMaps: [{ file: 'props.tmj', layers: [{ name: 'input_ground', rows: ['A'] }, { name: 'output_ground', rows: ['B'], properties: [p('tint', 'string', 'warm')] }] }],
  },
  {
    name: 'locked-layer', description: 'A locked target layer is left alone',
    map: [{ name: 'ground', rows: ['A.A'], locked: true }],
    ruleMaps: [AtoB()],
  },
  {
    name: 'ignore-lock', description: 'IgnoreLock writes into a locked target layer',
    map: [{ name: 'ground', rows: ['A.A'], locked: true }],
    ruleMaps: [{ ...AtoB(), properties: [p('IgnoreLock', 'bool', true)] }],
  },
  {
    name: 'filters', description: 'Filter lines limit rule maps to matching map names; an include inherits the filter and restores it after',
    map: [{ name: 'ground', rows: ['AH'] }],
    ruleMaps: [
      AtoB('skipped.tmj'),
      { file: 'applied.tmj', layers: [{ name: 'input_ground', rows: ['A'] }, { name: 'output_ground', rows: ['C'] }] },
      { file: 'included.tmj', layers: [{ name: 'input_ground', rows: ['H'] }, { name: 'output_ground', rows: ['G'] }] },
    ],
    rules: '# rule maps for map.tmj only\n[other*.tmj]\nskipped.tmj\n[MA?.tmj]\napplied.tmj\nmore.txt\n',
    extraFiles: { 'more.txt': '// included: the [MA?.tmj] filter still applies\nincluded.tmj\n' },
  },
  {
    name: 'output-empty-clears', description: 'Empty on an output layer clears the cell; Ignore and NonEmpty outputs write nothing',
    map: [{ name: 'ground', rows: ['A.AB'] }],
    ruleMaps: [{ file: 'clear.tmj', layers: [{ name: 'input_ground', rows: ['A.B'] }, { name: 'output_ground', rows: ['e.i'] }, { name: 'output_ground', rows: ['..n'] }] }],
  },
  {
    name: 'clear-rule-first', description: 'The clear rule (input Ignore, output Empty) runs first, then the drawing rule',
    map: [{ name: 'ground', rows: ['A.A'] }, { name: 'deco', rows: ['CCC'] }],
    ruleMaps: [{ file: 'blueprint.tmj', layers: [{ name: 'input_ground', rows: ['i.A'] }, { name: 'output_deco', rows: ['e.B'] }] }],
  },
  {
    name: 'radius-partial', description: 'AutomappingRadius grows the automapped region of a partial run',
    map: [{ name: 'ground', rows: ['AAAA'] }], region: { x: 1, y: 0, width: 1, height: 1 },
    ruleMaps: [{ ...AtoB(), properties: [p('AutomappingRadius', 'int', 1)] }],
  },
  {
    name: 'partial-region', description: 'A partial run only matches inside its region',
    map: [{ name: 'ground', rows: ['A..A', '.A..', '...A'] }], region: { x: 0, y: 0, width: 2, height: 2 },
    ruleMaps: [AtoB()],
  },
  {
    name: 'partial-growth', description: 'In a partial run each rule map\'s output widens the region of the next one',
    map: [{ name: 'ground', rows: ['AAAA'] }], region: { x: 0, y: 0, width: 1, height: 1 },
    ruleMaps: [
      { file: 'first.tmj', layers: [{ name: 'input_ground', rows: ['A.'] }, { name: 'output_ground', rows: ['.B'] }] },
      { file: 'second.tmj', layers: [{ name: 'input_ground', rows: ['B'] }, { name: 'output_ground', rows: ['C'] }] },
    ],
  },
  {
    name: 'target-not-created', description: 'A missing target layer that receives nothing is not added',
    map: [{ name: 'ground', rows: ['CC'] }],
    ruleMaps: [{ file: 'overlay.tmj', layers: [{ name: 'input_ground', rows: ['A'] }, { name: 'output_overlay', rows: ['B'] }] }],
  },
  {
    name: 'property-overwrite', description: 'An output layer property replaces the same property on the target layer',
    map: [{ name: 'ground', rows: ['A.'], properties: [p('tint', 'string', 'cold'), p('zone', 'string', 'north')] }],
    ruleMaps: [{ file: 'props.tmj', layers: [{ name: 'input_ground', rows: ['A'] }, { name: 'output_ground', rows: ['B'], properties: [p('tint', 'string', 'warm')] }] }],
  },
  {
    name: 'other-scope', description: 'Other refuses only the tiles of its own index and target layer',
    map: [{ name: 'ground', rows: ['ACAA'] }],
    ruleMaps: [{ file: 'other.tmj', layers: [{ name: 'input1_ground', rows: ['Ao'] }, { name: 'input2_ground', rows: ['C.'] }, { name: 'output_ground', rows: ['E.'] }] }],
  },
  {
    name: 'negate-scope', description: 'Negate changes only its own index: "not A" or "A" matches everything',
    map: [{ name: 'ground', rows: ['ABC.'] }],
    ruleMaps: [{ file: 'negate.tmj', layers: [{ name: 'input1_ground', rows: ['A'] }, { name: 'input1_ground', rows: ['g'] }, { name: 'input2_ground', rows: ['A'] }, { name: 'output_ground', rows: ['D'] }] }],
  },
  {
    name: 'inputnot-specials', description: 'inputnot NonEmpty requires empty; inputnot Empty requires a tile',
    map: [{ name: 'ground', rows: ['A.A'] }, { name: 'deco', rows: ['...'] }],
    ruleMaps: [{ file: 'not.tmj', layers: [{ name: 'inputnot_ground', rows: ['n.e'] }, { name: 'output_deco', rows: ['B.C'] }] }],
  },
  {
    name: 'overflow-corner', description: 'OverflowBorder reads the corner cell for positions outside both edges',
    map: [{ name: 'ground', rows: ['A.', '..'] }],
    ruleMaps: [{ file: 'corner.tmj', properties: [p('OverflowBorder', 'bool', true)], layers: [{ name: 'input_ground', rows: ['AA', 'AA'] }, { name: 'output_ground', rows: ['..', '.B'] }] }],
  },
  {
    name: 'delete-tiles-same-layer', description: 'DeleteTiles erases an input layer that is also an output before matching, so nothing matches',
    map: [{ name: 'ground', rows: ['AC.'] }],
    ruleMaps: [{ ...AtoB('delete.tmj'), properties: [p('DeleteTiles', 'bool', true)] }],
  },
  {
    name: 'rule-order-tie', description: 'Two rules whose boxes start at the same corner keep Tiled\'s region order',
    map: [{ name: 'ground', rows: ['...', '...', 'A..'] }],
    ruleMaps: [{
      file: 'tie.tmj',
      layers: [
        { name: 'input_ground', rows: ['A.i', '..i', 'Aii'] },
        { name: 'output_ground', rows: ['B..', '...', 'C..'] },
      ],
    }],
  },
  {
    name: 'locked-group', description: 'A target layer inside a locked group is locked too',
    map: [{ name: 'ground', rows: ['A.A'] }, { name: 'deco', rows: ['...'] }], lockedGroup: ['deco'],
    ruleMaps: [{ file: 'two.tmj', layers: [{ name: 'input_ground', rows: ['A'] }, { name: 'output_ground', rows: ['B'] }, { name: 'output_deco', rows: ['C'] }] }],
  },
  {
    name: 'external-tileset', description: 'Tiles of the same external tileset file match across the map and the rule map', external: true,
    map: [{ name: 'ground', rows: ['A.A'] }],
    ruleMaps: [AtoB()],
  }
];

async function writePng(path: string, colours: [number, number, number][]): Promise<void> {
  const width = 32 * colours.length;
  const data = new Uint8ClampedArray(width * 32 * 4);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colours[Math.floor(x / 32)]!;
      const edge = x % 32 === 0 || y === 0;
      data.set(edge ? [0, 0, 0, 255] : [r, g, b, 255], (y * width + x) * 4);
    }
  }
  await writeFile(path, encodePng({ width, height: 32, data }));
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 1)}\n`;

// A hash of a fixture's inputs, so a captured expected.tmj can be tied to the inputs it came from.
async function inputsHash(dir: string): Promise<string> {
  const hash = createHash('sha256');
  for (const file of (await readdir(dir)).sort()) {
    if (file === 'fixture.json' || file.startsWith('expected')) continue;
    hash.update(file).update('\0').update(await readFile(join(dir, file))).update('\0');
  }
  return hash.digest('hex');
}

async function main(): Promise<void> {
  await mkdir(join(ROOT, 'tilesets'), { recursive: true });
  await writePng(join(ROOT, 'tilesets', 'colours.png'), COLOURS);
  await writePng(join(ROOT, 'tilesets', 'rules.png'), [[255, 255, 255], [40, 40, 40], [255, 0, 255], [200, 200, 200], [255, 140, 0]]);
  await writeFile(join(ROOT, 'tilesets', 'colours.tsj'), json({ ...colourFields('colours.png'), tiledversion: '1.12.2', type: 'tileset', version: '1.11' }));
  for (const f of FIXTURES) {
    const dir = join(ROOT, f.name);
    await mkdir(dir, { recursive: true });
    let captured: string | undefined;
    try {
      captured = (JSON.parse(await readFile(join(dir, 'fixture.json'), 'utf8')) as { capturedInputsHash?: string }).capturedInputsHash;
    } catch {
      captured = undefined;
    }
    // Tiled's captured output (expected.tmj) is kept; every input file is rewritten.
    for (const file of await readdir(dir)) if (file !== 'expected.tmj') await rm(join(dir, file), { force: true });
    const external = f.external === true;
    await writeFile(join(dir, f.mapFile ?? 'map.tmj'), json(tmj(f.map, false, { external, lockedGroup: f.lockedGroup })));
    for (const ruleMap of f.ruleMaps) {
      await writeFile(join(dir, ruleMap.file), json(tmj(ruleMap.layers, true, { properties: ruleMap.properties, ruleOptions: ruleMap.ruleOptions, external })));
    }
    await writeFile(join(dir, 'rules.txt'), f.rules ?? f.ruleMaps.map((r) => r.file).join('\n') + '\n');
    for (const [name, content] of Object.entries(f.extraFiles ?? {})) await writeFile(join(dir, name), content);
    const meta = {
      description: f.description,
      random: f.random === true,
      map: f.mapFile ?? 'map.tmj',
      ...(f.region !== undefined ? { region: f.region } : {}),
      inputsHash: await inputsHash(dir),
      ...(captured !== undefined ? { capturedInputsHash: captured } : {}),
    };
    await writeFile(join(dir, 'fixture.json'), json(meta));
  }
  console.log(`wrote ${FIXTURES.length} fixtures to ${ROOT}`);
}

await main();
