import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { loadAssetSet } from '../../src/core/asset-set-registry.js';
import { buildRooms, placePrefab, scaffoldMap } from '../../src/core/compiler.js';
import { readState } from '../../src/core/engine-state.js';
import { readMap } from '../../src/core/map-io.js';
import { decodePng, encodePng, type Rgba8 } from '../../src/core/png.js';
import { importPropSet, propCategory } from '../../src/core/prop-import.js';
import { validateMap } from '../../src/core/validator.js';
import { makeFullProject, type TempProject } from '../helpers/project.js';

let project: TempProject;
beforeEach(async () => {
  project = await makeFullProject();
});
afterEach(() => project.cleanup());

const TILE = 32;

// A prop image whose every pixel encodes its prop number and position, so a copy can be checked.
function propImage(n: number, width: number, height: number, transparentRow?: number): Rgba8 {
  const w = width * TILE;
  const h = height * TILE;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const clear = transparentRow !== undefined && Math.floor(y / TILE) === transparentRow;
      data.set(clear ? [0, 0, 0, 0] : [n * 20, x % 256, y % 256, 255], i);
    }
  }
  return { width: w, height: h, data };
}

const PROPS = [
  { id: 'stage_big', name: 'Stage', image: 'images/stage.png', sizeTiles: [3, 2], tags: ['stage'], collisionGrid: [[0, 0, 0], [1, 1, 1]], foregroundRows: [0], use: 'a small stage', license: 'Test licence' },
  { id: 'beanbag', image: 'images/beanbag.png', sizeTiles: [1, 1], collisionGrid: [[1]], use: 'a beanbag' },
  { id: 'Water_Cooler', image: 'images/cooler.png', sizeTiles: [1, 2], tags: ['food'], collisionGrid: [[0], [1]], foregroundRows: [0] },
];

async function writeProps(props: unknown[] = PROPS, images: Record<string, Rgba8> = {}): Promise<void> {
  const dir = join(project.dir, 'props', 'images');
  await mkdir(dir, { recursive: true });
  const all = { 'stage.png': propImage(1, 3, 2), 'beanbag.png': propImage(2, 1, 1), 'cooler.png': propImage(3, 1, 2, 0), ...images };
  for (const [name, image] of Object.entries(all)) await writeFile(join(dir, name), encodePng(image));
  await writeFile(join(project.dir, 'props', 'props.json'), JSON.stringify(props));
}

const importVarcamp = (extra: Record<string, unknown> = {}) =>
  importPropSet({ projectDir: project.dir, setId: 'varcamp', source: 'props/props.json', ...extra });

const readJson = async (rel: string): Promise<any> => JSON.parse(await readFile(join(project.dir, rel), 'utf8'));

describe('import_prop_set', () => {
  test('makes a set that extends the starter set, one prefab per prop, with ids, sizes and categories', async () => {
    await writeProps();
    const result = await importVarcamp();
    expect(result).toMatchObject({ setId: 'varcamp', extends: 'wa-starter-office', image: expect.stringMatching(/^tilesets\/varcamp-[0-9a-f]{8}\.png$/) });
    expect(result.prefabs).toEqual([
      { id: 'stage-big', width: 3, height: 2, category: 'talks', use: 'a small stage' },
      { id: 'beanbag', width: 1, height: 1, category: 'social', use: 'a beanbag' },
      { id: 'water-cooler', width: 1, height: 2, category: 'logistics', use: 'Water_Cooler' },
    ]);
    const set = await loadAssetSet('varcamp', project.dir);
    expect(set.extends).toBe('wa-starter-office');
    // The starter set's walls, floors and prefabs, plus the props.
    expect(set.set.prefabs.map((p) => p.id)).toEqual(expect.arrayContaining(['lectern-1x1', 'stage-big', 'beanbag', 'water-cooler']));
    expect(set.set.floorStyles.default).toBe('wood-light');
  });

  test('copies every prop pixel unchanged into the atlas, and splits rows and collisions as the hints say', async () => {
    await writeProps();
    const { image } = await importVarcamp();
    const atlas = await decodePng(new Uint8Array(await readFile(join(project.dir, image))));
    const tsj = await readJson('.wa-asset-sets/varcamp/tilesets/varcamp.tsj');
    expect([atlas.width, atlas.height]).toEqual([tsj.imagewidth, tsj.imageheight]);
    const sources: Record<string, Rgba8> = { 'stage-big': propImage(1, 3, 2), 'water-cooler': propImage(3, 1, 2, 0) };
    for (const [id, source] of Object.entries(sources)) {
      const prefab = await readJson(`.wa-asset-sets/varcamp/prefabs/${id}.tmj`);
      const layer = (name: string): number[] => prefab.layers.find((l: { name: string }) => l.name === name)?.data ?? [];
      const tiles = layer('furniture1').map((gid: number, i: number) => gid || (layer('foreground1')[i] ?? 0));
      tiles.forEach((gid: number, i: number) => {
        const tx = i % prefab.width;
        const ty = Math.floor(i / prefab.width);
        if (gid === 0) return; // a fully transparent tile is left empty
        const ax = ((gid - 1) % tsj.columns) * TILE;
        const ay = Math.floor((gid - 1) / tsj.columns) * TILE;
        for (let y = 0; y < TILE; y++) {
          for (let x = 0; x < TILE; x++) {
            const s = ((ty * TILE + y) * source.width + tx * TILE + x) * 4;
            const a = ((ay + y) * atlas.width + ax + x) * 4;
            expect(Array.from(atlas.data.slice(a, a + 4))).toEqual(Array.from(source.data.slice(s, s + 4)));
          }
        }
      });
    }
    const stage = await readJson('.wa-asset-sets/varcamp/prefabs/stage-big.tmj');
    const data = (name: string): number[] => stage.layers.find((l: { name: string }) => l.name === name).data;
    expect(data('foreground1').map((g: number) => g > 0)).toEqual([true, true, true, false, false, false]);
    expect(data('furniture1').map((g: number) => g > 0)).toEqual([false, false, false, true, true, true]);
    expect(data('collisions')).toEqual([0, 0, 0, 1, 1, 1]);
    // The cooler's top row is transparent in the image: no tile there.
    const cooler = await readJson('.wa-asset-sets/varcamp/prefabs/water-cooler.tmj');
    expect(cooler.layers.find((l: { name: string }) => l.name === 'foreground1')).toBeUndefined();
    expect(cooler.properties).toContainEqual({ name: 'category', type: 'string', value: 'logistics' });
  });

  test('never replaces a set unless asked, and replaces it whole when asked', async () => {
    await writeProps();
    await importVarcamp();
    await expect(importVarcamp()).rejects.toMatchObject({ code: 'ASSET_SET_EXISTS' });
    await writeProps([PROPS[1]]);
    const again = await importVarcamp({ overwrite: true });
    expect(again.prefabs.map((p) => p.id)).toEqual(['beanbag']);
    expect((await loadAssetSet('varcamp', project.dir)).set.prefabs.some((p) => p.id === 'stage-big')).toBe(false);
  });

  test('re-importing changed props leaves maps built with the old ones editable', async () => {
    await writeProps();
    const first = await importVarcamp();
    await scaffoldMap({ projectDir: project.dir, mapPath: 'venue.tmj', width: 20, height: 12, assetSet: 'varcamp', spawn: { x: 2, y: 9 } });
    const dsl = { mapWidth: 20, mapHeight: 12, assetSet: 'varcamp', rooms: [{ id: 'hall', bounds: { x: 0, y: 0, width: 20, height: 12 }, furniture: [{ prefabId: 'stage-big', x: 8, y: 4 }] }] };
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl });
    await placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'beanbag', x: 3, y: 8 });
    // A taller prop changes the atlas layout and size.
    await writeProps([...PROPS, { id: 'tower', image: 'images/tower.png', sizeTiles: [1, 3], use: 'a tower' }], { 'tower.png': propImage(4, 1, 3) });
    const second = await importVarcamp({ overwrite: true });
    expect(second.image).not.toBe(first.image);
    await expect(readFile(join(project.dir, first.image))).resolves.toBeDefined();
    const result = await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl });
    expect(result.warnings).toEqual([]);
    expect(result.toolPrefabs).toHaveLength(1);
    expect(await validateMap({ projectDir: project.dir, mapPath: 'venue.tmj' })).toMatchObject({ ok: true, errors: [] });
  });

  test('refuses a fully transparent image, and a second import while one is running', async () => {
    await writeProps([PROPS[1]], { 'beanbag.png': { width: 32, height: 32, data: new Uint8ClampedArray(32 * 32 * 4) } });
    await expect(importVarcamp()).rejects.toMatchObject({ code: 'INVALID_INPUT', details: { problems: [expect.stringContaining('fully transparent')] } });
    await writeProps([PROPS[1]]);
    await mkdir(join(project.dir, '.wa-asset-sets', '.lock-varcamp'), { recursive: true });
    await expect(importVarcamp()).rejects.toMatchObject({ code: 'ASSET_SET_LOCKED' });
  });

  test('wall props hang on the face rows, and two hints files make one set', async () => {
    await writeProps();
    await mkdir(join(project.dir, 'wall', 'images'), { recursive: true });
    await writeFile(join(project.dir, 'wall', 'images', 'sign.png'), encodePng(propImage(5, 2, 2)));
    await writeFile(
      join(project.dir, 'wall', 'props.json'),
      JSON.stringify([{ id: 'sign', image: 'images/sign.png', sizeTiles: [2, 2], placement: 'north-wall', faceRow: 'upper', use: 'a sign on the wall' }]),
    );
    const result = await importPropSet({ projectDir: project.dir, setId: 'varcamp', source: ['props/props.json', 'wall/props.json'] });
    expect(result.prefabs.map((p) => p.id)).toEqual(['stage-big', 'beanbag', 'water-cooler', 'sign']);
    const entry = (await loadAssetSet('varcamp', project.dir)).set.prefabs.find((p) => p.id === 'sign');
    expect(entry).toMatchObject({ placement: 'north-wall', faceRow: 'upper' });
    await scaffoldMap({ projectDir: project.dir, mapPath: 'venue.tmj', width: 20, height: 12, assetSet: 'varcamp', spawn: { x: 2, y: 9 } });
    const room = { id: 'hall', name: 'Hall', bounds: { x: 0, y: 0, width: 20, height: 12 } };
    const dsl = (furniture: unknown[]) => ({ mapWidth: 20, mapHeight: 12, assetSet: 'varcamp', rooms: [{ ...room, furniture }] });
    await expect(buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: dsl([{ prefabId: 'sign', x: 8, y: 5 }]) })).rejects.toMatchObject({ code: 'PREFAB_PLACEMENT' });
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: dsl([{ prefabId: 'sign', x: 8, y: 1 }]) });
    expect(await validateMap({ projectDir: project.dir, mapPath: 'venue.tmj' })).toMatchObject({ ok: true, errors: [], warnings: [] });
  });

  test('refuses images of the wrong size, listing every problem, and writes nothing', async () => {
    await writeProps(PROPS, { 'stage.png': propImage(1, 2, 2) });
    await expect(importVarcamp()).rejects.toMatchObject({ code: 'INVALID_INPUT', details: { problems: [expect.stringContaining('stage_big')] } });
    await expect(loadAssetSet('varcamp', project.dir)).rejects.toMatchObject({ code: 'ASSET_SET_NOT_FOUND' });
  });

  test('refuses a prop that would take the id of a starter-set prefab', async () => {
    await writeProps([{ ...PROPS[1], id: 'lectern_1x1' }]);
    await expect(importVarcamp()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('maps and sets that extend another set', () => {
  const dsl = (assetSet: string, furniture: unknown[] = []) => ({
    mapWidth: 20,
    mapHeight: 12,
    assetSet,
    rooms: [{ id: 'hall', name: 'Main Hall', bounds: { x: 0, y: 0, width: 20, height: 12 }, furniture }],
  });

  test('a map built with the starter set moves to the prop set, and gets props from the DSL and place_prefab', async () => {
    await writeProps();
    await importVarcamp();
    await scaffoldMap({ projectDir: project.dir, mapPath: 'venue.tmj', width: 20, height: 12, assetSet: 'wa-starter-office', spawn: { x: 2, y: 9 } });
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: dsl('wa-starter-office') });
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: dsl('varcamp', [{ prefabId: 'stage-big', x: 8, y: 4 }, { prefabId: 'lectern-1x1', x: 5, y: 5 }]) });
    await placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'beanbag', x: 3, y: 8, assetSet: 'varcamp' });
    const { map } = await readMap(join(project.dir, 'venue.tmj'));
    expect(readState(map)!.assetSet).toBe('varcamp');
    expect(map.tilesets.map((t) => t.name)).toContainEqual(expect.stringMatching(/^varcamp-[0-9a-f]{8}$/));
    expect(await validateMap({ projectDir: project.dir, mapPath: 'venue.tmj' })).toMatchObject({ ok: true, errors: [], warnings: [] });
  });

  test('a map built with the prop set cannot go back to the starter set', async () => {
    await writeProps();
    await importVarcamp();
    await scaffoldMap({ projectDir: project.dir, mapPath: 'venue.tmj', width: 20, height: 12, assetSet: 'varcamp', spawn: { x: 2, y: 9 } });
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: dsl('varcamp') });
    await expect(buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: dsl('wa-starter-office') })).rejects.toMatchObject({ code: 'ASSET_SET_MISMATCH' });
  });

  test('an extending set may not reuse a name of its base, nor extend an extending set', async () => {
    await writeProps();
    await importVarcamp();
    const setJson = await readJson('.wa-asset-sets/varcamp/set.json');
    await mkdir(join(project.dir, '.wa-asset-sets', 'clash'), { recursive: true });
    await writeFile(
      join(project.dir, '.wa-asset-sets', 'clash', 'set.json'),
      JSON.stringify({ ...setJson, id: 'clash', prefabs: [{ ...setJson.prefabs[0], id: 'lectern-1x1' }] }),
    );
    await expect(loadAssetSet('clash', project.dir)).rejects.toMatchObject({ code: 'ASSET_SET_INVALID' });
    await mkdir(join(project.dir, '.wa-asset-sets', 'deeper'), { recursive: true });
    await writeFile(join(project.dir, '.wa-asset-sets', 'deeper', 'set.json'), JSON.stringify({ ...setJson, id: 'deeper', extends: 'varcamp' }));
    await expect(loadAssetSet('deeper', project.dir)).rejects.toMatchObject({ code: 'ASSET_SET_INVALID' });
    // Two sets that extend each other fail at once instead of loading forever.
    for (const [id, base] of [['ping', 'pong'], ['pong', 'ping']]) {
      await mkdir(join(project.dir, '.wa-asset-sets', id!), { recursive: true });
      await writeFile(join(project.dir, '.wa-asset-sets', id!, 'set.json'), JSON.stringify({ ...setJson, id, extends: base }));
    }
    await expect(loadAssetSet('ping', project.dir)).rejects.toMatchObject({ code: 'ASSET_SET_INVALID' });
  });
});

test('prop categories come from the id first, then the tags; the rest are social', () => {
  expect(propCategory({ id: 'audience_chairs_v2', tags: ['seat'] })).toBe('talks');
  expect(propCategory({ id: 'registration_desk_v3', tags: ['desk'] })).toBe('logistics');
  expect(propCategory({ id: 'pool_table_a', tags: ['games'] })).toBe('fun');
  expect(propCategory({ id: 'schedule_board_a' })).toBe('work');
  expect(propCategory({ id: 'beanbag_red', tags: ['varcamp', 'seat'] })).toBe('social');
  expect(propCategory({ id: 'anything', category: 'phone' })).toBe('phone');
  expect(propCategory({ id: 'street_lamp', tags: ['outdoor'] })).toBe('outdoor');
  expect(propCategory({ id: 'outdoor_stage' })).toBe('outdoor');
});
