import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createEmptyMap, readMap } from '../../src/core/map-io.js';
import { embedTileset } from '../../src/core/tileset-embed.js';
import type { TiledTilesetFile } from '../../src/schemas/tiled.schema.js';
import { makeProject, type TempProject } from '../helpers/project.js';

let project: TempProject;
beforeEach(async () => {
  project = await makeProject({ maps: ['office.tmj'] });
  await mkdir(join(project.dir, 'maps'));
});
afterEach(() => project.cleanup());

const roomBuilder = (): TiledTilesetFile => ({
  columns: 25,
  image: 'tilesets/WA_Room_Builder.png',
  imageheight: 1280,
  imagewidth: 800,
  margin: 0,
  name: 'WA_Room_Builder',
  spacing: 0,
  tilecount: 1000,
  tiledversion: '1.12.2',
  tileheight: 32,
  tilewidth: 32,
  type: 'tileset',
  version: '1.11',
});

test('the image path is written relative to the map file', async () => {
  const mapAbs = join(project.dir, 'maps', 'lobby.tmj');
  const map = createEmptyMap(10, 10);
  const result = await embedTileset(project.dir, map, mapAbs, roomBuilder(), join(project.dir, 'tilesets', 'WA_Room_Builder.png'));
  expect(result).toMatchObject({ firstgid: 1, added: true });
  expect(map.tilesets[0]).toMatchObject({ image: '../tilesets/WA_Room_Builder.png', firstgid: 1, tilecount: 1000 });
  expect(Object.keys(map.tilesets[0]!)).toEqual([
    'columns',
    'firstgid',
    'image',
    'imageheight',
    'imagewidth',
    'margin',
    'name',
    'spacing',
    'tilecount',
    'tileheight',
    'tilewidth',
  ]);
});

test('embedding the same tileset twice is a no-op; a different one with the same name conflicts', async () => {
  const mapAbs = join(project.dir, 'lobby.tmj');
  const map = createEmptyMap(10, 10);
  const image = join(project.dir, 'tilesets', 'WA_Room_Builder.png');
  await embedTileset(project.dir, map, mapAbs, roomBuilder(), image);
  expect(await embedTileset(project.dir, map, mapAbs, roomBuilder(), image)).toMatchObject({ firstgid: 1, added: false });
  expect(map.tilesets).toHaveLength(1);
  await expect(embedTileset(project.dir, map, mapAbs, { ...roomBuilder(), tilecount: 999 }, image)).rejects.toMatchObject({
    code: 'TILESET_CONFLICT',
  });
});

test('an equivalent image path spelled differently is the same tileset', async () => {
  const mapAbs = join(project.dir, 'maps', 'lobby.tmj');
  const map = createEmptyMap(10, 10);
  const image = join(project.dir, 'tilesets', 'WA_Room_Builder.png');
  await embedTileset(project.dir, map, mapAbs, roomBuilder(), image);
  const embedded = map.tilesets[0] as { image: string };
  embedded.image = './../tilesets//WA_Room_Builder.png';
  expect(await embedTileset(project.dir, map, mapAbs, roomBuilder(), image)).toMatchObject({ added: false });
});

test('firstgid follows every existing range, external tilesets included', async () => {
  const mapAbs = join(project.dir, 'maps', 'lobby.tmj');
  await writeFile(join(project.dir, 'tilesets', 'ext.tsj'), JSON.stringify({ ...roomBuilder(), name: 'Ext', tilecount: 50 }));
  const map = createEmptyMap(10, 10);
  map.tilesets.push({ firstgid: 1, source: '../tilesets/ext.tsj' });
  const result = await embedTileset(project.dir, map, mapAbs, roomBuilder(), join(project.dir, 'tilesets', 'WA_Room_Builder.png'));
  expect(result.firstgid).toBe(51);
});

test('an unreadable external tileset fails the embed', async () => {
  const mapAbs = join(project.dir, 'lobby.tmj');
  const map = createEmptyMap(10, 10);
  map.tilesets.push({ firstgid: 1, source: 'tilesets/missing.tsj' });
  await expect(
    embedTileset(project.dir, map, mapAbs, roomBuilder(), join(project.dir, 'tilesets', 'WA_Room_Builder.png')),
  ).rejects.toMatchObject({ code: 'EXTERNAL_TILESET_UNRESOLVED' });
  map.tilesets[0] = { firstgid: 1, source: '../../outside.tsj' };
  await expect(
    embedTileset(project.dir, map, mapAbs, roomBuilder(), join(project.dir, 'tilesets', 'WA_Room_Builder.png')),
  ).rejects.toMatchObject({ code: 'EXTERNAL_TILESET_UNRESOLVED' });
});

test('on office.tmj a new tileset lands after the last range', async () => {
  const mapAbs = join(project.dir, 'office.tmj');
  const { map } = await readMap(mapAbs);
  const result = await embedTileset(
    project.dir,
    map,
    mapAbs,
    { ...roomBuilder(), name: 'Extra', image: 'tilesets/Extra.png' },
    join(project.dir, 'tilesets', 'Extra.png'),
  );
  // WA_User_Interface starts at 2683 with 273 tiles.
  expect(result.firstgid).toBe(2683 + 273);
  expect(map.tilesets.at(-1)).toMatchObject({ name: 'Extra', image: 'tilesets/Extra.png' });
});
