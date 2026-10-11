import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// A minimal valid project-local asset set: one 4-tile tileset, a wall terrain with wall and
// door colours, a colliding tile 0, and one 1x1 prefab. Tests override parts of it.
export function demoTileset(): Record<string, unknown> {
  return {
    columns: 2,
    image: 'T.png',
    imageheight: 64,
    imagewidth: 64,
    margin: 0,
    name: 'T',
    spacing: 0,
    tilecount: 4,
    tileheight: 32,
    tiles: [{ id: 0, properties: [{ name: 'collides', type: 'bool', value: true }] }],
    tilewidth: 32,
    type: 'tileset',
    wangsets: [
      {
        name: 'walls',
        type: 'edge',
        tile: 1,
        colors: [{ name: 'wall', color: '#000000', tile: 1, probability: 1 }, { name: 'door', color: '#ffffff', tile: 2, probability: 1 }],
        wangtiles: [{ tileid: 1, wangid: [0, 0, 1, 0, 0, 0, 1, 0] }],
      },
    ],
  };
}

export function demoSetJson(): Record<string, unknown> {
  const ref = { tileset: 'T', tile: 0 };
  const row = { mid: 3, openW: 3, openE: 3, openWE: 3 };
  return {
    id: 'demo',
    title: 'Demo',
    tilesets: [{ name: 'T', tsj: 'tilesets/T.tsj', image: 'tilesets/T.png', tilesetCopyright: 'mine' }],
    wallTerrain: { tileset: 'T', wangset: 'walls', wallColor: 1, doorColor: 2, isolatedWallTile: 1 },
    doorLintelTiles: [2],
    faceRules: { tileset: 'T', height: 2, exteriorStyle: 'plain', styles: { plain: { row1: row, row2: row } } },
    wallStyles: { default: 'plain', names: ['plain'] },
    floorStyles: { default: 'f', styles: { f: { tileset: 'T', tile: 3 } } },
    collisionTile: ref,
    startTile: ref,
    prefabs: [{ id: 'box-1x1', path: 'prefabs/box-1x1.tmj', width: 1, height: 1, category: 'fun', placement: 'free', use: 'test' }],
  };
}

export function demoPrefab(): Record<string, unknown> {
  return {
    orientation: 'orthogonal',
    width: 1,
    height: 1,
    tilewidth: 32,
    tileheight: 32,
    layers: [{ type: 'tilelayer', name: 'furniture1', width: 1, height: 1, data: [4] }],
    tilesets: [{ firstgid: 1, source: '../tilesets/T.tsj' }],
    properties: [
      { name: 'category', type: 'string', value: 'fun' },
      { name: 'placement', type: 'string', value: 'free' },
      { name: 'use', type: 'string', value: 'test' },
    ],
  };
}

export async function writeDemoSet(
  projectDir: string,
  overrides: { set?: Record<string, unknown>; tileset?: Record<string, unknown>; prefab?: Record<string, unknown> } = {},
): Promise<string> {
  const dir = join(projectDir, '.wa-asset-sets', 'demo');
  await mkdir(join(dir, 'tilesets'), { recursive: true });
  await mkdir(join(dir, 'prefabs'), { recursive: true });
  await writeFile(join(dir, 'tilesets', 'T.tsj'), JSON.stringify({ ...demoTileset(), ...overrides.tileset }));
  await writeFile(join(dir, 'set.json'), JSON.stringify({ ...demoSetJson(), ...overrides.set }));
  await writeFile(join(dir, 'prefabs', 'box-1x1.tmj'), JSON.stringify({ ...demoPrefab(), ...overrides.prefab }));
  return dir;
}
