import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildRooms, placePrefab, scaffoldMap } from '../../src/core/compiler.js';
import { readState } from '../../src/core/engine-state.js';
import { estimateTextHeight, LABEL_DETAILS_PX, LABEL_TYPE } from '../../src/core/labels.js';
import { forEachObjectGroup, resolveRole } from '../../src/core/layers.js';
import { readMap, writeMap } from '../../src/core/map-io.js';
import { composeMap, parseTextColour } from '../../src/core/renderer.js';
import { validateMap } from '../../src/core/validator.js';
import type { TiledMap, TiledObject } from '../../src/schemas/tiled.schema.js';
import { makeFullProject, type TempProject } from '../helpers/project.js';

let project: TempProject;
beforeEach(async () => {
  project = await makeFullProject();
});
afterEach(() => project.cleanup());

const TILE = 32;
const load = async (): Promise<TiledMap> => (await readMap(join(project.dir, 'venue.tmj'))).map;
const scaffold = () => scaffoldMap({ projectDir: project.dir, mapPath: 'venue.tmj', width: 30, height: 20, assetSet: 'wa-starter-office', spawn: { x: 5, y: 17 } });
const dsl = (rooms: unknown[]) => ({ mapWidth: 30, mapHeight: 20, assetSet: 'wa-starter-office', rooms });
const build = (rooms: unknown[]) => buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: dsl(rooms) });

function labels(map: TiledMap): TiledObject[] {
  const found: TiledObject[] = [];
  forEachObjectGroup(map.layers, (layer) => {
    for (const o of layer.objects) if (o.type === LABEL_TYPE) found.push(o);
  });
  return found;
}
const byName = (map: TiledMap, name: string): TiledObject | undefined => labels(map).find((o) => o.name === name);

describe('room labels', () => {
  test('a named room gets its name, and its details under it, on the wall face below its north wall', async () => {
    await scaffold();
    await build([{ id: 'talks', name: 'Main Hall', details: 'Talks 10:00-17:00', bounds: { x: 0, y: 0, width: 12, height: 9 } }]);
    const map = await load();
    const name = byName(map, 'label:talks')!;
    const details = byName(map, 'details:talks')!;
    expect(name.text).toMatchObject({ text: 'Main Hall', pixelsize: 16, wrap: true });
    expect(details.text).toMatchObject({ text: 'Talks 10:00-17:00', pixelsize: LABEL_DETAILS_PX });
    // The face rows are the two rows under the north wall (row 0): rows 1 and 2.
    expect(name.y).toBeGreaterThanOrEqual(1 * TILE);
    expect(details.y + details.height!).toBeLessThanOrEqual(3 * TILE);
    expect(details.y).toBe(name.y + name.height!);
    // In the zones layer, so WorkAdventure draws it, and recorded so a rebuild can replace it.
    expect(resolveRole(map, 'zones').layer.objects).toContain(name);
    expect(readState(map)!.labels.map((l) => l.name)).toEqual(['label:talks', 'details:talks']);
    expect((await validateMap({ projectDir: project.dir, mapPath: 'venue.tmj' })).warnings).toEqual([]);
  });

  test('a rebuild replaces the labels, and a room without a name gets none', async () => {
    await scaffold();
    await build([
      { id: 'a', name: 'Lounge', bounds: { x: 0, y: 0, width: 10, height: 8 } },
      { id: 'b', name: 'Kitchen', bounds: { x: 9, y: 0, width: 10, height: 8 } },
    ]);
    await build([
      { id: 'a', name: 'Chill lounge', bounds: { x: 0, y: 0, width: 10, height: 8 } },
      { id: 'b', bounds: { x: 9, y: 0, width: 10, height: 8 } },
    ]);
    const map = await load();
    expect(labels(map).map((o) => [o.name, o.text?.text])).toEqual([['label:a', 'Chill lounge']]);
  });

  test('text objects made by hand survive a rebuild', async () => {
    await scaffold();
    await build([{ id: 'a', name: 'Lounge', bounds: { x: 0, y: 0, width: 10, height: 8 } }]);
    const { map, sha256 } = await readMap(join(project.dir, 'venue.tmj'));
    resolveRole(map, 'zones').layer.objects.push({ id: 900, name: 'welcome', x: 64, y: 160, width: 128, height: 20, text: { text: 'Welcome!' } });
    map.nextobjectid = 901;
    await writeMap(join(project.dir, 'venue.tmj'), map, { projectDir: project.dir, expectedSha256: sha256 });
    await build([{ id: 'a', name: 'Lounge', bounds: { x: 0, y: 0, width: 10, height: 8 } }]);
    const after = await load();
    expect(resolveRole(after, 'zones').layer.objects.some((o) => o.name === 'welcome' && o.text?.text === 'Welcome!')).toBe(true);
    expect(labels(after)).toHaveLength(1);
  });

  test('the label keeps clear of a screen on the wall and of a door in the wall above', async () => {
    await scaffold();
    await build([
      { id: 'hall', bounds: { x: 0, y: 0, width: 14, height: 5 } },
      {
        id: 'talks',
        name: 'Daisy talks',
        bounds: { x: 0, y: 4, width: 14, height: 9 },
        furniture: [{ prefabId: 'wall-screen-3x2', x: 1, y: 5 }],
        doors: [{ wall: 'north', offset: 8, width: 2 }],
      },
    ]);
    const label = byName(await load(), 'label:talks')!;
    // Free face columns: 4-7 (after the screen at 1-3, before the door at 8-9) and 10-12; the
    // widest run, 4-7, wins.
    expect(label.x).toBeGreaterThanOrEqual(4 * TILE);
    expect(label.x + label.width!).toBeLessThanOrEqual(8 * TILE);
  });

  test('a wall covered by furniture still gets its label, and validation warns LABEL_COVERED', async () => {
    await scaffold();
    await build([
      {
        id: 'talks',
        name: 'Talks',
        bounds: { x: 0, y: 0, width: 8, height: 9 },
        furniture: [
          { prefabId: 'wall-screen-3x2', x: 1, y: 1 },
          { prefabId: 'notice-board-3x1', x: 4, y: 1 },
        ],
      },
    ]);
    expect(byName(await load(), 'label:talks')).toBeDefined();
    const report = await validateMap({ projectDir: project.dir, mapPath: 'venue.tmj' });
    expect(report.warnings.map((w) => [w.code, w.objectName])).toContainEqual(['LABEL_COVERED', 'label:talks']);
  });

  test('a wall screen placed after the build moves the label off it', async () => {
    await scaffold();
    await build([{ id: 'hall', name: 'Main Hall', bounds: { x: 0, y: 0, width: 12, height: 9 } }]);
    expect(byName(await load(), 'label:hall')!.x).toBeLessThan(2 * TILE);
    await placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'wall-screen-3x2', x: 1, y: 1 });
    expect(byName(await load(), 'label:hall')!.x).toBeGreaterThanOrEqual(4 * TILE);
    expect((await validateMap({ projectDir: project.dir, mapPath: 'venue.tmj' })).warnings).toEqual([]);
  });

  test('labels of a narrow room stay on its wall face, even at the bottom of the map, and are reported as too long', async () => {
    await scaffoldMap({ projectDir: project.dir, mapPath: 'venue.tmj', width: 12, height: 6, assetSet: 'wa-starter-office', spawn: { x: 6, y: 4 } });
    await buildRooms({
      projectDir: project.dir,
      mapPath: 'venue.tmj',
      dsl: {
        mapWidth: 12,
        mapHeight: 6,
        assetSet: 'wa-starter-office',
        rooms: [
          { id: 'booth', name: 'The quiet phone booth for long calls', details: 'One person at a time, please knock', bounds: { x: 0, y: 1, width: 3, height: 5 } },
          { id: 'hall', bounds: { x: 2, y: 1, width: 10, height: 5 } },
        ],
      },
    });
    for (const o of labels(await load())) {
      expect(o.y).toBeGreaterThanOrEqual(2 * TILE);
      expect(o.y + o.height!).toBeLessThanOrEqual(4 * TILE);
    }
    const codes = (await validateMap({ projectDir: project.dir, mapPath: 'venue.tmj' })).warnings.map((w) => w.code);
    expect(codes).toContain('LABEL_TOO_LONG');
    expect(codes).not.toContain('LABEL_COVERED');
    expect(codes).not.toContain('OUT_OF_BOUNDS_OBJECT');
  });

  test('details are stored apart from the rooms, and a stored name longer than the input limit still reads', async () => {
    await scaffold();
    await build([{ id: 'a', name: 'Lounge', details: 'Coffee and chats', bounds: { x: 0, y: 0, width: 10, height: 8 } }]);
    const { map, sha256 } = await readMap(join(project.dir, 'venue.tmj'));
    const state = readState(map)!;
    expect(state.rooms[0]).not.toHaveProperty('details');
    expect(state.roomDetails).toEqual({ a: 'Coffee and chats' });
    // A 0.1.0 build record could hold any name length.
    const prop = map.properties!.find((p) => p.name === 'wa-agent-engine:build')!;
    const raw = JSON.parse(String(prop.value)) as { rooms: { name?: string }[] };
    raw.rooms[0]!.name = 'N'.repeat(61);
    prop.value = JSON.stringify(raw);
    await writeMap(join(project.dir, 'venue.tmj'), map, { projectDir: project.dir, expectedSha256: sha256 });
    expect(readState(await load())!.rooms[0]!.name).toHaveLength(61);
    expect((await validateMap({ projectDir: project.dir, mapPath: 'venue.tmj' })).errors).toEqual([]);
  });

  test('a narrow room gets a smaller name that fits, so the map validates clean', async () => {
    await scaffold();
    await build([{ id: 'booth', name: 'Phone booth A', bounds: { x: 0, y: 0, width: 4, height: 6 } }]);
    const label = byName(await load(), 'label:booth')!;
    expect(label.text!.pixelsize).toBeLessThan(16);
    expect(estimateTextHeight(label.text!.text, label.text!.pixelsize!, label.width!)).toBeLessThanOrEqual(label.height!);
    expect((await validateMap({ projectDir: project.dir, mapPath: 'venue.tmj' })).warnings).toEqual([]);
  });

  test('details too long for the wall raise LABEL_TOO_LONG', async () => {
    await scaffold();
    const details = 'Lightning talks, demos, open mic and the closing ceremony with prizes for the best session of the day';
    await build([{ id: 'booth', name: 'Stage', details, bounds: { x: 0, y: 0, width: 5, height: 6 } }]);
    const report = await validateMap({ projectDir: project.dir, mapPath: 'venue.tmj' });
    expect(report.warnings.map((w) => [w.code, w.objectName])).toContainEqual(['LABEL_TOO_LONG', 'details:booth']);
  });

  test('a build state written before labels existed still reads, with no labels', async () => {
    await scaffold();
    await build([{ id: 'a', bounds: { x: 0, y: 0, width: 10, height: 8 } }]);
    const { map, sha256 } = await readMap(join(project.dir, 'venue.tmj'));
    const prop = map.properties!.find((p) => p.name === 'wa-agent-engine:build')!;
    const state = JSON.parse(String(prop.value)) as Record<string, unknown>;
    delete state.labels;
    prop.value = JSON.stringify(state);
    await writeMap(join(project.dir, 'venue.tmj'), map, { projectDir: project.dir, expectedSha256: sha256 });
    expect(readState(await load())!.labels).toEqual([]);
    await build([{ id: 'a', name: 'Lounge', bounds: { x: 0, y: 0, width: 10, height: 8 } }]);
    expect(labels(await load())).toHaveLength(1);
  });
});

describe('text in the preview', () => {
  const blank = (objects: TiledObject[]): TiledMap =>
    ({
      type: 'map',
      orientation: 'orthogonal',
      width: 6,
      height: 2,
      tilewidth: TILE,
      tileheight: TILE,
      infinite: false,
      tilesets: [],
      layers: [{ type: 'objectgroup', id: 1, name: 'wa_zones', objects, visible: true, opacity: 1, x: 0, y: 0 }],
    }) as unknown as TiledMap;

  test('a text object is drawn in its colour where it stands, and nothing else changes', () => {
    const text = { id: 1, name: 't', x: 8, y: 8, width: 160, height: 20, text: { text: 'Hall', pixelsize: 16, color: '#ff0000', wrap: true } };
    const empty = composeMap(blank([]), new Map(), { scale: 1 });
    const drawn = composeMap(blank([text]), new Map(), { scale: 1 });
    const changed: [number, number][] = [];
    for (let i = 0; i < drawn.data.length; i += 4) {
      if (drawn.data[i] !== empty.data[i] || drawn.data[i + 3] !== empty.data[i + 3]) changed.push([(i / 4) % drawn.width, Math.floor(i / 4 / drawn.width)]);
    }
    expect(changed.length).toBeGreaterThan(20);
    for (const [x, y] of changed) {
      expect(x).toBeGreaterThanOrEqual(8);
      expect(x).toBeLessThan(8 + 160);
      expect(y).toBeGreaterThanOrEqual(8);
      expect(y).toBeLessThan(8 + 20);
    }
    const [x, y] = changed[0]!;
    expect(Array.from(drawn.data.slice((y * drawn.width + x) * 4, (y * drawn.width + x) * 4 + 4))).toEqual([255, 0, 0, 255]);
  });

  test('huge text costs bounded work', () => {
    const text = { id: 1, name: 't', x: 0, y: 0, width: 100, height: 100, text: { text: 'Ww'.repeat(5000), pixelsize: 200000, wrap: true } };
    const started = performance.now();
    composeMap(blank([text]), new Map(), { scale: 1 });
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test('colours follow Tiled: #RRGGBB, #AARRGGBB, and black otherwise', () => {
    expect(parseTextColour('#102030')).toEqual([16, 32, 48, 255]);
    expect(parseTextColour('#80102030')).toEqual([16, 32, 48, 128]);
    expect(parseTextColour(undefined)).toEqual([0, 0, 0, 255]);
    expect(parseTextColour('red')).toEqual([0, 0, 0, 255]);
  });
});
