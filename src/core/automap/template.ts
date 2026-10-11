import type { TiledEmbeddedTileset, TiledMap, TiledObject, TiledObjectGroup, TiledTileLayer } from '../../schemas/tiled.schema.js';
import { createEmptyMap } from '../map-io.js';
import { RULE_TILES } from '../markers.js';

// The rule map automap_template writes: one rule for every piece a room build can need, whose
// input is already painted with the markers a build paints (wa_sketch: walls, doors and
// floors; wa_style: each room's wall style over its inside) and whose output the user paints
// with their own tiles in Tiled. Painted with the starter kit's tiles it draws exactly what the
// proving set draws (scripts/gen-office-automap.ts, test/tools/automap-template.test.ts).
//
// Rules are laid out in rows, one empty cell apart, so they run in this order: clean-ups
// first, then wall tops, lintels, faces (outside rooms first, so room styles overwrite them),
// floors, and the floors of doors (the north or west room first, so the south or east one
// wins). Each rule has a rectangle on "rule_options" named after its piece, with the names
// validate_wa_map uses for pieces the rules miss.

export interface TemplateMarkers {
  wall: number;
  door: number;
  floor: Record<string, number>;
  wallStyle: Record<string, number>;
}

export interface TemplateSpec {
  // Tile ids of the markers in the marker tileset.
  markers: TemplateMarkers;
  wallStyles: readonly string[];
  floorStyles: readonly string[];
  // The marker tileset, the special tiles' tileset (RULE_TILES in order, with MatchType) and
  // the art tilesets, with their firstgids, as the rule map embeds them.
  markerFirstgid: number;
  ruleTilesFirstgid: number;
  tilesets: TiledEmbeddedTileset[];
}

// A rule as the user sees it: the cell to paint (the rule's anchor, in rule-map tiles) and the
// layers to paint there; empty for rules that come complete.
export interface TemplateRuleInfo {
  name: string;
  x: number;
  y: number;
  paint: string[];
}

export interface Template {
  map: TiledMap;
  rules: TemplateRuleInfo[];
}

interface Cond {
  layer: string;
  x: number;
  y: number;
  any?: number[];
  none?: number[];
}

interface Fill {
  layer: string;
  x: number;
  y: number;
  gid: number;
}

interface Rule {
  name: string;
  // Alternatives: the rule matches where all conditions of one of them hold.
  indices: Cond[][];
  // Outputs that come complete: the Empty tiles of the clean-ups.
  fills: Fill[];
  // What the user paints at the anchor (0, 0): output layers, or an input layer of the first
  // index (over the tile already there).
  paint: { layer: string; input?: true }[];
}

type Side = 'open' | 'wall' | 'door';

// The wall patterns rooms can give a wall cell (north, east, south, west): the 16 of walls and
// open cells, a wall beside a door in each direction, and a wall between two doors.
const WALL_PATTERNS: readonly { name: string; sides: readonly [Side, Side, Side, Side] }[] = [
  ...Array.from({ length: 16 }, (_, mask) => {
    const bits = [(mask >> 3) & 1, (mask >> 2) & 1, (mask >> 1) & 1, mask & 1] as const;
    const side = (b: number): Side => (b === 1 ? 'wall' : 'open');
    return { name: `wall N${bits[0]} E${bits[1]} S${bits[2]} W${bits[3]}`, sides: [side(bits[0]), side(bits[1]), side(bits[2]), side(bits[3])] as const };
  }),
  { name: 'wall west of a door', sides: ['open', 'door', 'open', 'wall'] },
  { name: 'wall east of a door', sides: ['open', 'wall', 'open', 'door'] },
  { name: 'wall above a door', sides: ['wall', 'open', 'door', 'open'] },
  { name: 'wall below a door', sides: ['door', 'open', 'wall', 'open'] },
  { name: 'wall between two doors, horizontal', sides: ['open', 'door', 'open', 'door'] },
  { name: 'wall between two doors, vertical', sides: ['door', 'open', 'door', 'open'] },
];

const FACE_VARIANTS: readonly { label: string; openWest: boolean; openEast: boolean }[] = [
  { label: 'middle', openWest: false, openEast: false },
  { label: 'open west', openWest: true, openEast: false },
  { label: 'open east', openWest: false, openEast: true },
  { label: 'open on both sides', openWest: true, openEast: true },
];

const RULES_PER_ROW = 8;

function templateRules(spec: TemplateSpec): Rule[][] {
  const marker = (id: number): number => spec.markerFirstgid + id;
  const special = (name: (typeof RULE_TILES)[number]): number => spec.ruleTilesFirstgid + RULE_TILES.indexOf(name);
  const W = marker(spec.markers.wall);
  const D = marker(spec.markers.door);
  const EMPTY = special('Empty');
  const sketch = (x: number, y: number, cond: Pick<Cond, 'any' | 'none'>): Cond => ({ layer: 'wa_sketch', x, y, ...cond });
  const wall = (x: number, y: number): Cond => sketch(x, y, { any: [W] });
  const door = (x: number, y: number): Cond => sketch(x, y, { any: [D] });
  const wallOrDoor = (x: number, y: number): Cond => sketch(x, y, { any: [W, D] });
  // Neither a wall nor a door: inside or outside a room.
  const open = (x: number, y: number): Cond => sketch(x, y, { none: [W, D] });
  const notWall = (x: number, y: number): Cond => sketch(x, y, { none: [W] });
  const floorAt = (x: number, y: number, style: string): Cond => sketch(x, y, { any: [marker(spec.markers.floor[style]!)] });
  const side = (s: Side, x: number, y: number): Cond => (s === 'wall' ? wall(x, y) : s === 'door' ? door(x, y) : open(x, y));
  const clear = (layers: readonly string[], x: number, y: number): Fill[] => layers.map((layer) => ({ layer, x, y, gid: EMPTY }));
  const horizontalDoor = [door(0, 0), wallOrDoor(-1, 0), wallOrDoor(1, 0)];
  const verticalDoor = [door(0, 0), wallOrDoor(0, -1), wallOrDoor(0, 1)];
  const wallArt = [{ layer: 'walls' }, { layer: 'collisions' }];

  // Clean-ups for walls a build did not draw itself: old wall faces under a new horizontal
  // door, down to the next wall or door, and the lintel of a door that a wall now closes. The
  // user paints that lintel over the Empty tile on foreground1; until then the rule only finds
  // empty cells, so it changes nothing.
  const occupied = (x: number, y: number): Cond => ({ layer: 'walls', x, y, any: [special('NonEmpty')] });
  const cleanUps: Rule[] = [
    { name: 'clear old faces under a new door, row 1', indices: [[...horizontalDoor, open(0, 1), occupied(0, 1)]], fills: clear(['walls', 'collisions'], 0, 1), paint: [] },
    { name: 'clear old faces under a new door, row 2', indices: [[...horizontalDoor, open(0, 1), open(0, 2), occupied(0, 2)]], fills: clear(['walls', 'collisions'], 0, 2), paint: [] },
    ...['horizontal', 'vertical'].map((kind): Rule => ({
      name: `clear an old ${kind} lintel where a wall closes a door`,
      indices: [[wall(0, 0), { layer: 'foreground1', x: 0, y: 0, any: [EMPTY] }]],
      fills: clear(['foreground1'], 0, 0),
      paint: [{ layer: 'foreground1', input: true }],
    })),
  ];

  const walls = WALL_PATTERNS.map(({ name, sides: [n, e, s, w] }): Rule => ({
    name,
    indices: [[wall(0, 0), side(n, 0, -1), side(e, 1, 0), side(s, 0, 1), side(w, -1, 0)]],
    fills: [],
    paint: wallArt,
  }));

  // A lintel over each door, which clears the wall and collision under it.
  const lintels = (['horizontal', 'vertical'] as const).map((kind): Rule => ({
    name: `${kind} lintel`,
    indices: [kind === 'horizontal' ? horizontalDoor : verticalDoor],
    fills: clear(['walls', 'collisions'], 0, 0),
    paint: [{ layer: 'foreground1' }],
  }));

  // The 2 rows of face under a wall whose south side is open. The cell at column dx is solid
  // when it is a wall or a wall face (a wall 1 or 2 cells above with only open cells between),
  // and open otherwise.
  const solidAt = (dx: number): Cond[][] => [[wall(dx, 0)], [open(dx, 0), wall(dx, -1)], [open(dx, 0), open(dx, -1), wall(dx, -2)]];
  const openAt = (dx: number): Cond[][] => [[door(dx, 0)], [open(dx, 0), door(dx, -1)], [open(dx, 0), open(dx, -1), notWall(dx, -2)]];
  const faceSections = [undefined, ...spec.wallStyles].map((style) => {
    const label = style === undefined ? 'outside rooms' : `of wall style ${style}`;
    const inside: Cond[] = style === undefined ? [] : [{ layer: 'wa_style', x: 0, y: 0, any: [marker(spec.markers.wallStyle[style]!)] }];
    return ([1, 2] as const).flatMap((row) => {
      const under = row === 1 ? [wall(0, -1), open(0, 0)] : [wall(0, -2), open(0, -1), open(0, 0)];
      return FACE_VARIANTS.map(({ label: variant, openWest, openEast }): Rule => {
        const west = openWest ? openAt(-1) : solidAt(-1);
        const east = openEast ? openAt(1) : solidAt(1);
        return {
          name: `face ${label}, row ${row}, ${variant}`,
          indices: west.flatMap((wc) => east.map((ec) => [...under, ...inside, ...wc, ...ec])),
          fills: [],
          paint: wallArt,
        };
      });
    });
  });

  const floors = spec.floorStyles.map((style): Rule => ({ name: `floor ${style}`, indices: [[floorAt(0, 0, style)]], fills: [], paint: [{ layer: 'floor' }] }));
  const doorFloors = ([['north', horizontalDoor, 0, -1], ['west', verticalDoor, -1, 0], ['south', horizontalDoor, 0, 1], ['east', verticalDoor, 1, 0]] as const).map(
    ([room, doorConds, dx, dy]) =>
      spec.floorStyles.map((style): Rule => ({
        name: `floor ${style} on a door, room to the ${room}`,
        indices: [[...doorConds, floorAt(dx, dy, style)]],
        fills: [],
        paint: [{ layer: 'floor' }],
      })),
  );
  return [cleanUps, walls, lintels, ...faceSections, floors, ...doorFloors];
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function boxOf(rule: Rule): Box {
  const cells: { x: number; y: number }[] = [...rule.indices.flat(), ...rule.fills, { x: 0, y: 0 }];
  return {
    minX: Math.min(...cells.map((c) => c.x)),
    minY: Math.min(...cells.map((c) => c.y)),
    maxX: Math.max(...cells.map((c) => c.x)),
    maxY: Math.max(...cells.map((c) => c.y)),
  };
}

export function buildTemplate(spec: TemplateSpec): Template {
  // Place the rules: each section on rows of its own, rules one empty cell apart, every rule
  // of a row with its top on the row's top, so Tiled's order (top, then left) is this order.
  const placed: { rule: Rule; box: Box; ox: number; oy: number }[] = [];
  let top = 1;
  let width = 0;
  for (const section of templateRules(spec)) {
    for (let start = 0; start < section.length; start += RULES_PER_ROW) {
      let left = 1;
      let rowHeight = 0;
      for (const rule of section.slice(start, start + RULES_PER_ROW)) {
        const box = boxOf(rule);
        placed.push({ rule, box, ox: left - box.minX, oy: top - box.minY });
        left += box.maxX - box.minX + 2;
        rowHeight = Math.max(rowHeight, box.maxY - box.minY + 1);
      }
      width = Math.max(width, left);
      top += rowHeight + 1;
    }
    // One more empty row between sections.
    top += 1;
  }
  const height = top - 1;

  const indices = Math.max(...placed.map((p) => p.rule.indices.length));
  const label = (i: number): string => (indices === 1 ? '' : String(i + 1));
  const inputName = (i: number, layer: string, not: boolean): string => `input${not ? 'not' : ''}${label(i)}_${layer}`;
  // How many same-name layers each kind of condition needs: one per tile of the longest list.
  const depth = new Map<string, number>();
  const need = (name: string, n: number): void => {
    depth.set(name, Math.max(depth.get(name) ?? 0, n));
  };
  const paintName = (p: Rule['paint'][number]): string => (p.input === true ? inputName(0, p.layer, false) : `output_${p.layer}`);
  for (const { rule } of placed) {
    rule.indices.forEach((conds, i) => {
      for (const c of conds) {
        if (c.any !== undefined) need(inputName(i, c.layer, false), c.any.length);
        if (c.none !== undefined) need(inputName(i, c.layer, true), c.none.length);
      }
    });
    for (const f of rule.fills) need(`output_${f.layer}`, 1);
    for (const p of rule.paint) need(paintName(p), 1);
  }
  const layers = new Map<string, number[][]>();
  for (const [name, n] of depth) layers.set(name, Array.from({ length: n }, () => new Array<number>(width * height).fill(0)));
  const put = (name: string, x: number, y: number, gids: readonly number[]): void => {
    gids.forEach((gid, k) => {
      layers.get(name)![k]![y * width + x] = gid;
    });
  };
  const rules: TemplateRuleInfo[] = [];
  const objects: TiledObject[] = [];
  for (const { rule, box, ox, oy } of placed) {
    rule.indices.forEach((conds, i) => {
      for (const c of conds) {
        if (c.any !== undefined) put(inputName(i, c.layer, false), c.x + ox, c.y + oy, c.any);
        if (c.none !== undefined) put(inputName(i, c.layer, true), c.x + ox, c.y + oy, c.none);
      }
    });
    for (const f of rule.fills) put(`output_${f.layer}`, f.x + ox, f.y + oy, [f.gid]);
    rules.push({ name: rule.name, x: ox, y: oy, paint: rule.paint.map(paintName) });
    objects.push({
      id: objects.length + 1,
      name: rule.name,
      type: '',
      x: (box.minX + ox) * 32,
      y: (box.minY + oy) * 32,
      width: (box.maxX - box.minX + 1) * 32,
      height: (box.maxY - box.minY + 1) * 32,
      rotation: 0,
      visible: true,
    });
  }

  // Inputs under outputs, each in a stable order, and the rule names on top.
  const names = [...layers.keys()].sort((a, b) => Number(a.startsWith('output')) - Number(b.startsWith('output')) || (a < b ? -1 : a > b ? 1 : 0));
  let id = 1;
  const tileLayers: TiledTileLayer[] = names.flatMap((name) =>
    layers.get(name)!.map((data) => ({ data, height, id: id++, name, opacity: 1, type: 'tilelayer' as const, visible: true, width, x: 0, y: 0 })),
  );
  const ruleOptions: TiledObjectGroup = { draworder: 'topdown', id: id++, name: 'rule_options', objects, opacity: 1, type: 'objectgroup', visible: true, x: 0, y: 0 };
  const map = createEmptyMap(width, height);
  map.layers = [...tileLayers, ruleOptions];
  map.nextlayerid = id;
  map.nextobjectid = objects.length + 1;
  // Walls on the map edge match too: cells outside the map count as empty.
  map.properties = [{ name: 'MatchOutsideMap', type: 'bool', value: true }];
  map.tilesets = spec.tilesets;
  return { map, rules };
}
