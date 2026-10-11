import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { loadAssetSet, type LoadedAssetSet } from '../../src/core/asset-set-registry.js';
import { listPrefabs, loadPrefab } from '../../src/core/prefab-registry.js';
import { writeDemoSet } from '../helpers/demo-set.js';
import { makeProject, type TempProject } from '../helpers/project.js';

// The VarCamp prefab catalog: id, width, height, and collision cells "x,y".
const CATALOG: [string, number, number, string][] = [
  ["stage-light-4x3", 4, 3, ""],
  ["stage-dark-4x3", 4, 3, ""],
  ["lectern-1x1", 1, 1, "0,0"],
  ["audience-row-2x1", 2, 1, ""],
  ["audience-row-4x1", 4, 1, ""],
  ["audience-row-6x1", 6, 1, ""],
  ["whiteboard-easel-3x3", 3, 3, "0,2 1,2 2,2"],
  ["wall-screen-3x2", 3, 2, ""],
  ["info-screen-stand-1x3", 1, 3, "0,1 0,2"],
  ["executive-desk-3x2", 3, 2, "0,0 0,1 1,0 1,1 2,0 2,1"],
  ["executive-desk-chair-3x3", 3, 3, "0,1 0,2 1,1 1,2 2,1 2,2"],
  ["table-long-6x3", 6, 3, "0,1 0,2 1,1 1,2 2,1 2,2 3,1 3,2 4,1 4,2 5,1 5,2"],
  ["table-long-6x5", 6, 5, "0,2 0,3 1,2 1,3 2,2 2,3 3,2 3,3 4,2 4,3 5,2 5,3"],
  ["table-long-4x3", 4, 3, "0,1 0,2 1,1 1,2 2,1 2,2 3,1 3,2"],
  ["table-long-4x5", 4, 5, "0,2 0,3 1,2 1,3 2,2 2,3 3,2 3,3"],
  ["coworking-pod-4x5", 4, 5, "1,1 1,2 1,3 1,4 2,1 2,2 2,3 2,4"],
  ["glass-table-4x6", 4, 6, "1,1 1,2 1,3 1,4 2,1 2,2 2,3 2,4"],
  ["cafe-table-3x2", 3, 2, "1,1"],
  ["lounge-sofa-set-4x4", 4, 4, "1,3 2,3"],
  ["conversation-pit-3x4", 3, 4, "1,2"],
  ["armchair-pair-3x2", 3, 2, "1,1"],
  ["kitchen-counter-2x5", 2, 5, "0,0 0,1 0,2 0,3 0,4 1,0 1,4"],
  ["snack-bar-5x3", 5, 3, "0,0 0,1 0,2 1,0 1,1 1,2 2,0 2,1 2,2 3,0 3,1 3,2 4,0 4,1 4,2"],
  ["low-shelf-2x2", 2, 2, "0,1 1,1"],
  ["plant-palm-3x3", 3, 3, "1,2"],
  ["plant-tree-1x2", 1, 2, "0,1"],
  ["plant-small-1x1", 1, 1, "0,0"],
  ["registration-desk-4x3", 4, 3, "0,1 0,2 1,1 1,2 2,1 2,2 3,2"],
  ["sponsor-booth-4x4", 4, 4, "0,1 0,2 0,3 1,1 1,2 1,3 2,1 2,2 2,3 3,1 3,2 3,3"],
  ["notice-board-3x1", 3, 1, ""],
  ["info-sign-1x3", 1, 3, "0,2"],
  ["game-circle-3x3", 3, 3, "1,1"],
  ["pouf-row-4x1", 4, 1, ""],
  ["party-balloons-1x1", 1, 1, ""],
  ["phone-pod-2x2", 2, 2, "1,1"],
];

let project: TempProject;
let set: LoadedAssetSet;
beforeEach(async () => {
  project = await makeProject();
  set = await loadAssetSet('wa-starter-office', project.dir);
});
afterEach(() => project.cleanup());

describe('catalog', () => {
  test('has all 35 prefabs, matching set.json', () => {
    expect(CATALOG).toHaveLength(35);
    expect(listPrefabs(set).map((p) => p.id).sort()).toEqual(CATALOG.map(([id]) => id).sort());
  });

  test.each(CATALOG)('%s loads with its catalog size and collisions', async (id, width, height, collisions) => {
    const prefab = await loadPrefab(set, id);
    expect([prefab.width, prefab.height]).toEqual([width, height]);
    const actual = prefab.collisions.map((c) => `${c.x},${c.y}`).sort();
    expect(actual).toEqual(collisions === '' ? [] : collisions.split(' ').sort());
    expect(Object.keys(prefab.layers).length).toBeGreaterThan(0);
  });

  test('exactly the four wall-mounted prefabs need a north wall', () => {
    expect(
      listPrefabs(set)
        .filter((p) => p.placement === 'north-wall')
        .map((p) => p.id)
        .sort(),
    ).toEqual(['notice-board-3x1', 'snack-bar-5x3', 'sponsor-booth-4x4', 'wall-screen-3x2']);
  });

  test('categories cover talks, work, social, logistics, fun, and phone', () => {
    const counts = Object.fromEntries(
      (['talks', 'work', 'social', 'logistics', 'fun', 'phone'] as const).map((c) => [c, listPrefabs(set, { category: c }).length]),
    );
    expect(counts).toEqual({ talks: 9, work: 9, social: 9, logistics: 4, fun: 3, phone: 1 });
  });
});

describe('decoding', () => {
  test('mixed-tileset layers resolve each cell to its own tileset', async () => {
    const pod = await loadPrefab(set, 'phone-pod-2x2');
    expect(pod.layers.furniture1).toEqual([
      { x: 0, y: 0, tileset: 'WA_Seats', tile: 82, h: false, v: false, d: false },
      { x: 0, y: 1, tileset: 'WA_Seats', tile: 95, h: false, v: false, d: false },
      { x: 1, y: 1, tileset: 'WA_Tables', tile: 140, h: false, v: false, d: false },
    ]);
    expect(pod.credit).toContain('conference.tmj');
  });

  test('flip flags and higher sub-layers survive', async () => {
    const podium = await loadPrefab(set, 'coworking-pod-4x5');
    expect(podium.layers.furniture3).toContainEqual({ x: 1, y: 2, tileset: 'WA_Miscellaneous', tile: 59, h: true, v: false, d: false });
    expect(podium.layers.foreground2).toEqual([{ x: 2, y: 0, tileset: 'WA_Miscellaneous', tile: 74, h: false, v: false, d: false }]);
  });

  test('adapted arrangements carry a credit and the CC-BY-SA 3.0 licence; original designs carry neither', async () => {
    const credited = listPrefabs(set).filter((p) => p.license !== undefined);
    expect(credited).toHaveLength(26);
    for (const summary of credited) {
      const prefab = await loadPrefab(set, summary.id);
      expect(prefab.license).toContain('CC-BY-SA-3.0');
      expect(prefab.credit).toContain('creativecommons.org/licenses/by-sa/3.0');
    }
    const original = await loadPrefab(set, 'lectern-1x1');
    expect([original.credit, original.license]).toEqual([undefined, undefined]);
  });

  test('north-wall prefabs say which face row their top row sits on', () => {
    const rows = Object.fromEntries(listPrefabs(set).filter((p) => p.faceRow !== undefined).map((p) => [p.id, p.faceRow]));
    expect(rows).toEqual({
      'snack-bar-5x3': 'lower',
      'sponsor-booth-4x4': 'upper',
      'wall-screen-3x2': 'upper',
      'notice-board-3x1': 'either',
    });
  });
});

describe('errors', () => {
  test('an unknown prefab is coded and lists what exists', async () => {
    await expect(loadPrefab(set, 'arcade-cabinet-1x2')).rejects.toMatchObject({
      code: 'PREFAB_NOT_FOUND',
      details: { available: expect.arrayContaining(['phone-pod-2x2']) },
    });
  });

  test('a valid project-local prefab loads', async () => {
    await writeDemoSet(project.dir);
    const demo = await loadAssetSet('demo', project.dir);
    expect((await loadPrefab(demo, 'box-1x1')).layers.furniture1).toEqual([
      { x: 0, y: 0, tileset: 'T', tile: 3, h: false, v: false, d: false },
    ]);
  });

  test.each([
    ['a foreign layer name', { layers: [{ type: 'tilelayer', name: 'walls', width: 1, height: 1, data: [1] }] }],
    ['a tileset outside the set', { tilesets: [{ firstgid: 1, source: '../../other/T.tsj' }] }],
    ['a tile past the tileset end', { layers: [{ type: 'tilelayer', name: 'furniture1', width: 1, height: 1, data: [9] }] }],
    ['a use text that differs from set.json', { properties: [{ name: 'category', type: 'string', value: 'fun' }, { name: 'placement', type: 'string', value: 'free' }, { name: 'use', type: 'string', value: 'other' }] }],
  ])('a project-local prefab with %s is rejected', async (_name, prefab) => {
    await writeDemoSet(project.dir, { prefab });
    const demo = await loadAssetSet('demo', project.dir);
    await expect(loadPrefab(demo, 'box-1x1')).rejects.toMatchObject({ code: 'PREFAB_INVALID' });
  });
});
