import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  BUILTIN_SETS_DIR,
  checkCoverage,
  loadAssetSet,
  resolveImages,
  type WallNeighbour,
} from '../../src/core/asset-set-registry.js';
import { readMap } from '../../src/core/map-io.js';
import { loadPrefab } from '../../src/core/prefab-registry.js';
import { isExternalTileset } from '../../src/schemas/tiled.schema.js';
import { demoTileset, writeDemoSet } from '../helpers/demo-set.js';
import { cachedMapPath, makeProject, type TempProject } from '../helpers/project.js';
import { starterKitCacheDir } from '../../src/config/starter-kit.js';

const ALL_PNGS = [
  'WA_Special_Zones.png',
  'WA_Room_Builder.png',
  'WA_Tables.png',
  'WA_Seats.png',
  'WA_Miscellaneous.png',
  'WA_Other_Furniture.png',
  'WA_Decoration.png',
  'WA_User_Interface.png',
  'WA_Exterior.png',
];

let project: TempProject;
beforeEach(async () => {
  project = await makeProject();
});
afterEach(() => project.cleanup());

describe('built-in wa-starter-office', () => {
  test('loads its nine tilesets from the package, not the project', async () => {
    const set = await loadAssetSet('wa-starter-office', project.dir);
    expect(set.source).toBe('builtin');
    expect([...set.tilesets.keys()].sort()).toEqual(ALL_PNGS.map((p) => p.replace('.png', '')).sort());
    expect(set.set.starterKitSha).toBe('1143646a9c02c3928eac4acbb123642c62a48a85');
  });

  test('tileset headers match the embedded tilesets of WA office.tmj and the real PNGs', async () => {
    const set = await loadAssetSet('wa-starter-office', project.dir);
    const { map } = await readMap(cachedMapPath('office.tmj'));
    for (const ts of set.tilesets.values()) {
      const embedded = map.tilesets.find((t) => !isExternalTileset(t) && t.name === ts.name);
      expect(embedded, ts.name).toBeDefined();
      for (const key of ['columns', 'tilecount', 'imagewidth', 'imageheight', 'margin', 'spacing'] as const) {
        expect(ts.tsj[key], `${ts.name}.${key}`).toBe(embedded?.[key]);
      }
      const png = await readFile(join(starterKitCacheDir(), ts.image));
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], ts.name).toEqual([ts.tsj.imagewidth, ts.tsj.imageheight]);
    }
  });

  test('wall terrain covers all 16 neighbour patterns and every door piece', async () => {
    const set = await loadAssetSet('wa-starter-office', project.dir);
    expect(checkCoverage(set)).toEqual({ ok: true, missing: [] });
    const t = (n: WallNeighbour, e: WallNeighbour, s: WallNeighbour, w: WallNeighbour) => set.walls.tileFor(n, e, s, w);
    expect([t(0, 2, 0, 1), t(0, 2, 0, 2), t(0, 1, 0, 2)]).toEqual([63, 64, 65]);
    expect([t(1, 0, 2, 0), t(2, 0, 2, 0), t(2, 0, 1, 0)]).toEqual([11, 36, 61]);
    expect([t(0, 1, 1, 0), t(1, 1, 1, 1), t(0, 1, 1, 1), t(1, 1, 0, 1), t(0, 0, 0, 0)]).toEqual([28, 137, 160, 110, 106]);
    expect(set.walls.wallTops.has(64)).toBe(false);
    expect(set.walls.wallTops.has(63)).toBe(true);
  });

  test('the collision tile is a bool collides tile', async () => {
    const set = await loadAssetSet('wa-starter-office', project.dir);
    const zones = set.tilesets.get('WA_Special_Zones')!.tsj;
    expect(zones.tiles?.find((t) => t.id === 2)?.properties).toEqual([{ name: 'collides', type: 'bool', value: true }]);
  });

  test('coverage reports a missing piece', async () => {
    // A project-local copy whose wangset lacks the cross piece.
    await cp(join(BUILTIN_SETS_DIR, 'wa-starter-office'), join(project.dir, '.wa-asset-sets', 'wa-starter-office'), { recursive: true });
    const tsjPath = join(project.dir, '.wa-asset-sets', 'wa-starter-office', 'tilesets', 'WA_Room_Builder.tsj');
    const tsj = JSON.parse(await readFile(tsjPath, 'utf8')) as { wangsets: { wangtiles: { tileid: number }[] }[] };
    tsj.wangsets[0]!.wangtiles = tsj.wangsets[0]!.wangtiles.filter((w) => w.tileid !== 137);
    await writeFile(tsjPath, JSON.stringify(tsj));
    expect(checkCoverage(await loadAssetSet('wa-starter-office', project.dir))).toEqual({ ok: false, missing: ['wall N1 E1 S1 W1'] });
  });
});

describe('project-local sets', () => {
  test('a project set wins over the built-in set with the same id', async () => {
    const dir = join(project.dir, '.wa-asset-sets', 'wa-starter-office');
    await cp(join(BUILTIN_SETS_DIR, 'wa-starter-office'), dir, { recursive: true });
    const setJson = JSON.parse(await readFile(join(dir, 'set.json'), 'utf8')) as { title: string };
    setJson.title = 'Project copy';
    await writeFile(join(dir, 'set.json'), JSON.stringify(setJson));
    const set = await loadAssetSet('wa-starter-office', project.dir);
    expect(set.source).toBe('project');
    expect(set.set.title).toBe('Project copy');
  });

  test('a broken project set is reported, not silently replaced by the built-in one', async () => {
    const dir = join(project.dir, '.wa-asset-sets', 'wa-starter-office');
    await cp(join(BUILTIN_SETS_DIR, 'wa-starter-office'), dir, { recursive: true });
    await writeFile(join(dir, 'set.json'), JSON.stringify({ id: 'wa-starter-office' }));
    await expect(loadAssetSet('wa-starter-office', project.dir)).rejects.toMatchObject({ code: 'ASSET_SET_INVALID' });
  });

  test('a project set folder without set.json is reported instead of silently using the built-in set', async () => {
    await mkdir(join(project.dir, '.wa-asset-sets', 'wa-starter-office'), { recursive: true });
    await expect(loadAssetSet('wa-starter-office', project.dir)).rejects.toMatchObject({ code: 'ASSET_SET_INVALID' });
  });

  test.each([
    ['a floor tile past the tileset end', { set: { floorStyles: { default: 'f', styles: { f: { tileset: 'T', tile: 99 } } } } }],
    ['the same colour for walls and doors', { set: { wallTerrain: { tileset: 'T', wangset: 'walls', wallColor: 1, doorColor: 1, isolatedWallTile: 1 } } }],
    ['a collision tile that does not collide', { tileset: { tiles: [] } }],
    ['two tilesets with one name', { set: { tilesets: [0, 1].map(() => ({ name: 'T', tsj: 'tilesets/T.tsj', image: 'tilesets/T.png', tilesetCopyright: 'mine' })) } }],
    ['a path with ..', { set: { tilesets: [{ name: 'T', tsj: '../../../x.tsj', image: 'tilesets/T.png', tilesetCopyright: 'mine' }] } }],
    ['a drive-letter path', { set: { tilesets: [{ name: 'T', tsj: 'C:/x.tsj', image: 'tilesets/T.png', tilesetCopyright: 'mine' }] } }],
    ['an id that differs from its folder', { set: { id: 'other' } }],
    ['a north-wall prefab without faceRow', { set: { prefabs: [{ id: 'box-1x1', path: 'prefabs/box-1x1.tmj', width: 1, height: 1, category: 'fun', placement: 'north-wall', use: 'test' }] } }],
  ])('a project set with %s is invalid', async (_name, overrides) => {
    await writeDemoSet(project.dir, overrides);
    await expect(loadAssetSet('demo', project.dir)).rejects.toMatchObject({ code: 'ASSET_SET_INVALID' });
  });

  test('variant wall tiles with a repeated wangid still count as walls', async () => {
    const tileset = demoTileset() as { wangsets: { wangtiles: unknown[] }[] };
    tileset.wangsets[0]!.wangtiles.push({ tileid: 3, wangid: [0, 0, 1, 0, 0, 0, 1, 0] });
    await writeDemoSet(project.dir, { tileset });
    const demo = await loadAssetSet('demo', project.dir);
    expect(demo.walls.tileFor(0, 1, 0, 1)).toBe(1);
    expect([...demo.walls.wallTops].sort()).toEqual([1, 3]);
  });

  test('files symlinked from outside the project are refused', async () => {
    const dir = await writeDemoSet(project.dir);
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'wa-outside-')));
    try {
      await writeFile(join(outside, 'box-1x1.tmj'), '{}');
      await rm(join(dir, 'prefabs', 'box-1x1.tmj'));
      await symlink(join(outside, 'box-1x1.tmj'), join(dir, 'prefabs', 'box-1x1.tmj'));
      const demo = await loadAssetSet('demo', project.dir);
      await expect(loadPrefab(demo, 'box-1x1')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('the project folder itself is validated', async () => {
    await expect(loadAssetSet('wa-starter-office', 'relative/project')).rejects.toMatchObject({ code: 'PROJECT_DIR_INVALID' });
  });

  test('unknown and malformed ids are not found', async () => {
    await expect(loadAssetSet('no-such-set', project.dir)).rejects.toMatchObject({ code: 'ASSET_SET_NOT_FOUND' });
    await expect(loadAssetSet('../../etc', project.dir)).rejects.toMatchObject({ code: 'ASSET_SET_NOT_FOUND' });
  });
});

describe('images', () => {
  test('missing tileset images are listed', async () => {
    const set = await loadAssetSet('wa-starter-office', project.dir);
    const err = await resolveImages(set, project.dir).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'ASSET_IMAGE_MISSING' });
    expect((err as { details: { missing: string[] } }).details.missing).toHaveLength(9);
  });

  test('an empty file or a folder named like the image is not an image', async () => {
    await project.cleanup();
    project = await makeProject({ tilesets: ALL_PNGS.slice(2) });
    await writeFile(join(project.dir, 'tilesets', 'WA_Special_Zones.png'), '');
    await mkdir(join(project.dir, 'tilesets', 'WA_Room_Builder.png'));
    const err = await resolveImages(await loadAssetSet('wa-starter-office', project.dir), project.dir).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'ASSET_IMAGE_MISSING', details: { missing: ['tilesets/WA_Special_Zones.png', 'tilesets/WA_Room_Builder.png'] } });
  });

  test('present images resolve inside the project', async () => {
    await project.cleanup();
    project = await makeProject({ tilesets: ALL_PNGS });
    const images = await resolveImages(await loadAssetSet('wa-starter-office', project.dir), project.dir);
    expect(images.get('WA_Room_Builder')).toBe(join(project.dir, 'tilesets', 'WA_Room_Builder.png'));
  });
});

test('the built-in sets hold no images', async () => {
  const files = await readdir(BUILTIN_SETS_DIR, { recursive: true });
  expect(files.filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f))).toEqual([]);
});
