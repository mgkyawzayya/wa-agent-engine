import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildRooms, placePrefab, scaffoldMap } from '../../src/core/compiler.js';
import { eachWrite, readState } from '../../src/core/engine-state.js';
import { decodeGid, tilesetForGid } from '../../src/core/gid.js';
import { readTileData, resolveRole, writeTileData, type TileRole } from '../../src/core/layers.js';
import { readMap } from '../../src/core/map-io.js';
import { validateMap } from '../../src/core/validator.js';
import { configureZone } from '../../src/core/zones.js';
import { getProperty, type TiledLayer, type TiledMap, type TiledObjectGroup, type TiledProperty } from '../../src/schemas/tiled.schema.js';
import { makeFullProject, type TempProject } from '../helpers/project.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/maps/office-like-groups.tmj', import.meta.url));

let project: TempProject;
beforeEach(async () => {
  project = await makeFullProject(['office.tmj', 'conference.tmj']);
});
afterEach(() => project.cleanup());

const load = async (mapPath: string): Promise<TiledMap> => (await readMap(join(project.dir, mapPath))).map;

function localAt(map: TiledMap, role: TileRole, x: number, y: number): string {
  const raw = readTileData(resolveRole(map, role).layer)[y * map.width + x] ?? 0;
  if (raw === 0) return '.';
  const hit = tilesetForGid(map.tilesets, decodeGid(raw).gid);
  return hit === undefined ? '?' : String(hit.localId);
}

function setTile(map: TiledMap, role: TileRole, x: number, y: number, raw: number): void {
  const { layer } = resolveRole(map, role);
  const data = readTileData(layer);
  data[y * map.width + x] = raw;
  writeTileData(layer, data);
}

const tileLayers = (m: TiledMap): string => JSON.stringify(m.layers.filter((l) => l.type !== 'objectgroup'));

// What Tiled does when it renumbers every tileset's first gid by +100.
function shiftFirstGids(m: TiledMap): TiledMap {
  const copy = structuredClone(m);
  for (const t of copy.tilesets) t.firstgid += 100;
  const walk = (layers: TiledLayer[]): void => {
    for (const l of layers) {
      if (l.type === 'group') walk(l.layers);
      if (l.type === 'tilelayer' && Array.isArray(l.data)) l.data = l.data.map((g) => (g === 0 ? 0 : ((g & 0xe0000000) | ((g & 0x0fffffff) + 100)) >>> 0));
    }
  };
  walk(copy.layers);
  return copy;
}

// What Tiled does when the map is widened by one empty column on the right.
function widen(m: TiledMap): TiledMap {
  const copy = structuredClone(m);
  const grow = (layers: TiledLayer[]): void => {
    for (const l of layers) {
      if (l.type === 'group') grow(l.layers);
      if (l.type === 'tilelayer' && Array.isArray(l.data)) {
        const rows: number[] = [];
        for (let y = 0; y < l.height; y++) rows.push(...l.data.slice(y * m.width, (y + 1) * m.width), 0);
        l.data = rows;
        l.width = m.width + 1;
      }
    }
  };
  grow(copy.layers);
  copy.width = m.width + 1;
  return copy;
}

const scaffold = (mapPath = 'venue.tmj', extra: Record<string, unknown> = {}) =>
  scaffoldMap({ projectDir: project.dir, mapPath, width: 30, height: 20, assetSet: 'wa-starter-office', spawn: { x: 5, y: 17 }, ...extra });

// Three rooms sharing walls, a horizontal and a vertical door, two prefabs, a zone, a variable.
const VENUE_DSL = {
  mapWidth: 30,
  mapHeight: 20,
  assetSet: 'wa-starter-office',
  rooms: [
    {
      id: 'talk',
      bounds: { x: 0, y: 0, width: 12, height: 9 },
      doors: [{ wall: 'south', offset: 4, width: 2 }, { wall: 'east', offset: 4 }],
      waProperties: { jitsiRoom: 'Talk', jitsiTrigger: 'onaction' },
      furniture: [{ prefabId: 'stage-light-4x3', x: 4, y: 3 }],
    },
    { id: 'lounge', bounds: { x: 11, y: 0, width: 10, height: 9 }, wallStyle: 'yellow', furniture: [{ prefabId: 'snack-bar-5x3', x: 13, y: 2 }] },
    { id: 'hall', bounds: { x: 0, y: 8, width: 21, height: 8 }, doors: [{ wall: 'south', offset: 9, width: 2 }] },
  ],
  variables: [{ name: 'agenda', default: 'tbd' }],
};

describe('scaffoldMap', () => {
  test('a scaffolded map validates clean, with roles in contract order and copyrights set', async () => {
    const result = await scaffold('maps/lobby.tmj', { mapName: 'Lobby', mapDescription: 'Test' });
    expect(result.layers).toEqual(['start', 'collisions', 'floor', 'walls', 'furniture', 'floorLayer', 'foreground', 'wa_zones']);
    expect(await validateMap({ projectDir: project.dir, mapPath: 'maps/lobby.tmj' })).toEqual({ ok: true, errors: [], warnings: [] });
    const map = await load('maps/lobby.tmj');
    expect(getProperty(map, 'mapCopyright')?.value).toContain('wa-agent-engine');
    expect(map.tilesets.every((t) => getProperty(t as { properties?: TiledProperty[] }, 'tilesetCopyright') !== undefined)).toBe(true);
    expect((map.tilesets[0] as { image: string }).image).toBe('../tilesets/WA_Special_Zones.png');
    expect(localAt(map, 'start', 5, 17)).toBe('1');
    expect(readState(map)).toMatchObject({ assetSet: 'wa-starter-office', rooms: [] });
  });

  test('an existing file is never replaced by accident', async () => {
    await scaffold();
    await expect(scaffold()).rejects.toMatchObject({ code: 'MAP_EXISTS' });
    await expect(scaffold('venue.tmj', { overwrite: true, width: 10 })).resolves.toMatchObject({ mapPath: 'venue.tmj' });
    expect((await load('venue.tmj')).width).toBe(10);
    await writeFile(join(project.dir, 'notes.tmj'), 'not a map');
    await expect(scaffold('notes.tmj', { overwrite: true })).rejects.toMatchObject({ code: 'MAP_EXISTS' });
  });

  test('spawn, size, and script are checked', async () => {
    await expect(scaffold('a.tmj', { spawn: { x: 30, y: 0 } })).rejects.toMatchObject({ code: 'SPAWN_OUT_OF_BOUNDS' });
    await expect(scaffold('a.tmj', { width: 501 })).rejects.toMatchObject({ code: 'MAP_TOO_LARGE' });
    await expect(scaffold('a.tmj', { script: 'src/missing.ts' })).rejects.toMatchObject({ code: 'BAD_URL' });
    await expect(scaffold('a.tmj', { script: 'javascript:alert(1)' })).rejects.toMatchObject({ code: 'BAD_URL' });
    const external = await scaffold('b.tmj', { script: 'https://example.org/script.js' });
    expect(external.warnings.map((w) => w.code)).toEqual(['SCRIPT_EXTERNAL']);
  });
});

describe('buildRooms', () => {
  test('three rooms with doors, furniture, a zone and a variable validate clean', async () => {
    await scaffold();
    const result = await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: VENUE_DSL });
    expect(result).toMatchObject({ zones: ['talk'], variables: ['agenda'], prefabs: ['b-talk-1', 'b-lounge-2'], warnings: [] });
    expect(await validateMap({ projectDir: project.dir, mapPath: 'venue.tmj' })).toMatchObject({ ok: true, errors: [] });
    const map = await load('venue.tmj');
    expect([localAt(map, 'walls', 11, 0), localAt(map, 'walls', 11, 8), localAt(map, 'foreground1', 4, 8), localAt(map, 'foreground1', 11, 4)]).toEqual([
      '160',
      '110',
      '64',
      '36',
    ]);
    const zones = resolveRole(map, 'zones').layer as TiledObjectGroup;
    const talk = zones.objects.find((o) => o.name === 'talk')!;
    // The walkable interior: inside the walls, below the 2 face rows.
    expect([talk.x, talk.y, talk.width, talk.height]).toEqual([32, 96, 320, 160]);
    const agenda = zones.objects.find((o) => o.name === 'agenda')!;
    expect(agenda.type).toBe('variable');
    expect(getProperty(agenda, 'writableBy')?.value).toBe('wa-agent-engine');
    expect(getProperty(agenda, 'default')?.value).toBe('tbd');
  });

  test('the DSL must match the map size, and every error aborts before writing', async () => {
    await scaffold();
    const before = await readFile(join(project.dir, 'venue.tmj'));
    await expect(buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: { ...VENUE_DSL, mapWidth: 31 } })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    const blocked = structuredClone(VENUE_DSL);
    blocked.rooms[0]!.furniture = [{ prefabId: 'stage-light-4x3', x: 4, y: 3 }, { prefabId: 'lectern-1x1', x: 5, y: 4 }];
    await expect(buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: blocked })).rejects.toMatchObject({ code: 'PREFAB_BLOCKED' });
    expect(await readFile(join(project.dir, 'venue.tmj'))).toEqual(before);
  });

  test('a rebuild with a moved door and a shrunk room leaves no ghost walls, collisions or lintels', async () => {
    await scaffold();
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: VENUE_DSL });
    await placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'phone-pod-2x2', x: 2, y: 12 });
    await configureZone({ projectDir: project.dir, mapPath: 'venue.tmj', name: 'user-zone', x: 1, y: 11, width: 4, height: 3, properties: { silent: true } });

    const smaller = structuredClone(VENUE_DSL);
    smaller.rooms[2]!.bounds = { x: 0, y: 8, width: 17, height: 8 };
    smaller.rooms[2]!.doors = [{ wall: 'south', offset: 4, width: 2 }];
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: smaller });

    const map = await load('venue.tmj');
    expect(await validateMap({ projectDir: project.dir, mapPath: 'venue.tmj' })).toMatchObject({ ok: true, errors: [] });
    // The old east wall of the hall (x=20, rows 11..15) and the old door at (9..10,15) are gone.
    for (let y = 11; y <= 15; y++) {
      expect(localAt(map, 'walls', 20, y), `walls (20,${y})`).toBe('.');
      expect(localAt(map, 'collisions', 20, y), `collisions (20,${y})`).toBe('.');
    }
    // The lounge wall the hall no longer covers now shows outside brick faces.
    expect([localAt(map, 'walls', 20, 9), localAt(map, 'walls', 20, 10), localAt(map, 'collisions', 20, 9)]).toEqual(['310', '310', '2']);
    expect([localAt(map, 'foreground1', 9, 15), localAt(map, 'foreground1', 10, 15)]).toEqual(['.', '.']);
    expect([localAt(map, 'foreground1', 4, 15), localAt(map, 'foreground1', 5, 15)]).toEqual(['64', '64']);
    // The prefab and zone a user placed afterwards survive.
    expect(localAt(map, 'furniture1', 3, 13)).toBe('140');
    const zones = resolveRole(map, 'zones').layer as TiledObjectGroup;
    expect(zones.objects.some((o) => o.name === 'user-zone')).toBe(true);
  });

  test('building into a map with WA-style group layers uses the group children and adds no second foreground group', async () => {
    await copyFile(FIXTURE, join(project.dir, 'groups.tmj'));
    await buildRooms({
      projectDir: project.dir,
      mapPath: 'groups.tmj',
      dsl: { mapWidth: 40, mapHeight: 30, assetSet: 'wa-starter-office', rooms: [{ id: 'r', bounds: { x: 2, y: 2, width: 10, height: 8 }, doors: [{ wall: 'south', offset: 3 }] }] },
    });
    const map = await load('groups.tmj');
    expect(map.layers.map((l: TiledLayer) => l.name)).toEqual(['start', 'collisions', 'floor', 'walls', 'furniture', 'floorLayer', 'above', 'wa_zones']);
    expect(localAt(map, 'walls', 2, 2)).toBe('28');
    expect(resolveRole(map, 'walls').path).toBe('walls/walls1');
    expect(resolveRole(map, 'foreground1').path).toBe('above/above1');
    expect(localAt(map, 'foreground1', 5, 9)).toBe('64');
  });

  test('a room built onto WA office walls is undone exactly when it is removed', async () => {
    const original = await load('office.tmj');
    // A room south of office's long south wall, using it as its north wall, with a door through it.
    const dsl = {
      mapWidth: 31,
      mapHeight: 21,
      assetSet: 'wa-starter-office',
      rooms: [{ id: 'annex', bounds: { x: 12, y: 14, width: 8, height: 6 }, doors: [{ wall: 'north', offset: 3 }] }],
    };
    await buildRooms({ projectDir: project.dir, mapPath: 'office.tmj', dsl });
    const built = await load('office.tmj');
    expect(localAt(built, 'foreground1', 15, 14)).toBe('64');
    expect(localAt(built, 'walls', 12, 14)).toBe('160');
    await buildRooms({ projectDir: project.dir, mapPath: 'office.tmj', dsl: { ...dsl, rooms: [] } });
    const restored = await load('office.tmj');
    const tileLayers = (m: TiledMap) => JSON.stringify(m.layers.filter((l) => l.name !== 'wa_zones'));
    expect(tileLayers(restored)).toBe(tileLayers(original));
  });
});

describe('placePrefab', () => {
  test('placing into free floor of WA office.tmj changes only the prefab box', async () => {
    const before = await load('office.tmj');
    const result = await placePrefab({ projectDir: project.dir, mapPath: 'office.tmj', prefabId: 'phone-pod-2x2', x: 23, y: 9 });
    expect(result).toMatchObject({ cells: 3, collisions: 1 });
    const after = await load('office.tmj');
    // Every layer that was there before, tile or object, is unchanged outside the prefab box.
    const flat = (layers: TiledLayer[], prefix = ''): [string, TiledLayer][] =>
      layers.flatMap((l): [string, TiledLayer][] => (l.type === 'group' ? flat(l.layers, `${prefix}${l.name}/`) : [[`${prefix}${l.name}`, l]]));
    const afterLayers = new Map(flat(after.layers));
    for (const [path, layer] of flat(before.layers)) {
      const now = afterLayers.get(path)!;
      if (layer.type !== 'tilelayer' || now.type !== 'tilelayer') {
        expect(JSON.stringify(now), path).toBe(JSON.stringify(layer));
        continue;
      }
      const a = readTileData(layer);
      const b = readTileData(now);
      for (let i = 0; i < a.length; i++) {
        const x = i % before.width;
        const y = Math.floor(i / before.width);
        if (x >= 23 && x <= 24 && y >= 9 && y <= 10) continue;
        expect(b[i], `${path} (${x},${y})`).toBe(a[i]);
      }
    }
    expect([...afterLayers.keys()].filter((k) => !flat(before.layers).some(([p]) => p === k))).toEqual(['wa_zones']);
  });

  test('walls, furniture, the map edge, and a mid-room wall prefab are refused', async () => {
    await scaffold();
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: VENUE_DSL });
    const place = (prefabId: string, x: number, y: number) => placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId, x, y });
    await expect(place('lectern-1x1', 0, 3)).rejects.toMatchObject({ code: 'PREFAB_BLOCKED' });
    await expect(place('lectern-1x1', 5, 4)).rejects.toMatchObject({ code: 'PREFAB_BLOCKED' });
    await expect(place('table-long-6x3', 27, 18)).rejects.toMatchObject({ code: 'PREFAB_OUT_OF_BOUNDS' });
    await expect(place('wall-screen-3x2', 2, 11)).rejects.toMatchObject({ code: 'PREFAB_PLACEMENT' });
    // The wall screen hangs on the upper face row of the hall's north wall.
    await expect(place('wall-screen-3x2', 13, 9)).resolves.toMatchObject({ cells: 6 });
  });

  test('three parallel placements on one map all persist', async () => {
    await scaffold();
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: VENUE_DSL });
    await Promise.all(
      [2, 5, 8].map((x) => placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'plant-small-1x1', x, y: 13 })),
    );
    const state = readState(await load('venue.tmj'));
    expect(state?.prefabs.filter((p) => p.prefabId === 'plant-small-1x1')).toHaveLength(3);
  });
});

describe('rebuilds and the work done between them', () => {
  const smallVenue = (rooms: unknown[]) => ({ mapWidth: 30, mapHeight: 20, assetSet: 'wa-starter-office', rooms });

  test('furniture standing in a doorway aborts the build and leaves the file as it was', async () => {
    await scaffold();
    const before = await readFile(join(project.dir, 'venue.tmj'));
    const dsl = smallVenue([
      { id: 'a', bounds: { x: 0, y: 0, width: 10, height: 8 }, doors: [{ wall: 'south', offset: 4 }], furniture: [{ prefabId: 'lectern-1x1', x: 4, y: 6 }] },
    ]);
    await expect(buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl })).rejects.toMatchObject({ code: 'DOOR_UNREACHABLE' });
    expect(await readFile(join(project.dir, 'venue.tmj'))).toEqual(before);
  });

  test('place_prefab refuses to block an engine-built door', async () => {
    await scaffold();
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: smallVenue([{ id: 'a', bounds: { x: 0, y: 0, width: 10, height: 8 }, doors: [{ wall: 'south', offset: 4 }] }]) });
    await expect(placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'lectern-1x1', x: 4, y: 6 })).rejects.toMatchObject({ code: 'DOOR_UNREACHABLE' });
  });

  test('a rebuild removes a tool prefab its new walls would cover, and says so', async () => {
    await scaffold();
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: smallVenue([{ id: 'a', bounds: { x: 0, y: 0, width: 12, height: 9 } }]) });
    await placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'phone-pod-2x2', x: 6, y: 5 });
    const result = await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: smallVenue([{ id: 'a', bounds: { x: 0, y: 0, width: 7, height: 9 } }]) });
    expect(result.warnings.map((w) => w.code)).toContain('PREFAB_REMOVED');
    const map = await load('venue.tmj');
    expect(readState(map)?.prefabs.filter((p) => p.origin === 'tool')).toEqual([]);
    expect(localAt(map, 'walls', 6, 5)).toBe('102');
    expect(await validateMap({ projectDir: project.dir, mapPath: 'venue.tmj' })).toMatchObject({ ok: true });
  });

  test('a wall prefab placed with the tool is removed when its wall goes', async () => {
    await scaffold();
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: smallVenue([{ id: 'a', bounds: { x: 0, y: 0, width: 12, height: 9 } }]) });
    await placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'notice-board-3x1', x: 3, y: 2 });
    const result = await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: smallVenue([]) });
    expect(result.warnings.map((w) => w.message).join(' ')).toContain('its wall is gone');
    expect(reasons(result.warnings)).toEqual(['wall-gone']);
    expect(localAt(await load('venue.tmj'), 'furniture1', 4, 2)).toBe('.');
  });

  test("a room cannot take over a tool zone's name, and the tool cannot edit a room's zone", async () => {
    await scaffold();
    await configureZone({ projectDir: project.dir, mapPath: 'venue.tmj', name: 'a', x: 20, y: 15, width: 2, height: 2, properties: { silent: true } });
    const room = { id: 'a', bounds: { x: 0, y: 0, width: 10, height: 8 }, waProperties: { silent: true } };
    await expect(buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: smallVenue([room]) })).rejects.toMatchObject({ code: 'ZONE_NAME_TAKEN' });
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: smallVenue([{ ...room, id: 'b' }]) });
    await expect(
      configureZone({ projectDir: project.dir, mapPath: 'venue.tmj', name: 'b', x: 1, y: 3, width: 2, height: 2, properties: { focusable: true } }),
    ).rejects.toMatchObject({ code: 'ZONE_OWNED_BY_ROOM' });
  });

  test("a room's name is reserved for its zone even while the room has no waProperties", async () => {
    await scaffold();
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: smallVenue([{ id: 'quiet', bounds: { x: 0, y: 0, width: 10, height: 8 } }]) });
    await expect(
      configureZone({ projectDir: project.dir, mapPath: 'venue.tmj', name: 'quiet', x: 20, y: 15, width: 2, height: 2, properties: { silent: true } }),
    ).rejects.toMatchObject({ code: 'ZONE_OWNED_BY_ROOM' });
  });

  test('a key a person adds to a room zone in Tiled survives rebuilds', async () => {
    await scaffold();
    const dsl = smallVenue([{ id: 'a', bounds: { x: 0, y: 0, width: 10, height: 8 }, waProperties: { silent: true } }]);
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl });
    const map = await load('venue.tmj');
    const zone = (resolveRole(map, 'zones').layer as TiledObjectGroup).objects.find((o) => o.name === 'a')!;
    zone.properties!.push({ name: 'focusable', type: 'bool', value: true });
    await writeFile(join(project.dir, 'venue.tmj'), JSON.stringify(map));
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl });
    const after = (resolveRole(await load('venue.tmj'), 'zones').layer as TiledObjectGroup).objects.find((o) => o.name === 'a')!;
    expect(after.properties?.map((p) => p.name).sort()).toEqual(['focusable', 'silent']);
  });

  test('restoring after Tiled renumbered the tilesets translates the old tiles', async () => {
    await scaffold();
    const original = await load('venue.tmj');
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: smallVenue([{ id: 'a', bounds: { x: 2, y: 2, width: 10, height: 8 } }]) });
    await writeFile(join(project.dir, 'venue.tmj'), JSON.stringify(shiftFirstGids(await load('venue.tmj'))));
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: smallVenue([]) });
    expect(tileLayers(await load('venue.tmj'))).toBe(tileLayers(shiftFirstGids(original)));
  });

  test('a renumber followed by another edit before the rebuild still restores exactly', async () => {
    await scaffold();
    const original = await load('venue.tmj');
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: smallVenue([{ id: 'a', bounds: { x: 2, y: 2, width: 10, height: 8 } }]) });
    await writeFile(join(project.dir, 'venue.tmj'), JSON.stringify(shiftFirstGids(await load('venue.tmj'))));
    await configureZone({ projectDir: project.dir, mapPath: 'venue.tmj', name: 'z', x: 20, y: 15, width: 2, height: 2, properties: { silent: true } });
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: smallVenue([]) });
    expect(tileLayers(await load('venue.tmj'))).toBe(tileLayers(shiftFirstGids(original)));
  });

  test('a map resized since the last build is refused rather than restored onto the wrong cells', async () => {
    await scaffold();
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: smallVenue([{ id: 'a', bounds: { x: 0, y: 0, width: 10, height: 8 } }]) });
    await writeFile(join(project.dir, 'venue.tmj'), JSON.stringify(widen(await load('venue.tmj'))));
    await expect(buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: { ...smallVenue([]), mapWidth: 31 } })).rejects.toMatchObject({
      code: 'ENGINE_STATE_INVALID',
    });
  });

  test('every edit refuses a resized map, not only builds, and validation names the resize', async () => {
    await scaffold();
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: smallVenue([{ id: 'a', bounds: { x: 0, y: 0, width: 10, height: 8 }, doors: [{ wall: 'south', offset: 4 }] }]) });
    await writeFile(join(project.dir, 'venue.tmj'), JSON.stringify(widen(await load('venue.tmj'))));
    const before = await readFile(join(project.dir, 'venue.tmj'));
    await expect(
      configureZone({ projectDir: project.dir, mapPath: 'venue.tmj', name: 'z', x: 20, y: 15, width: 2, height: 2, properties: { silent: true } }),
    ).rejects.toMatchObject({ code: 'ENGINE_STATE_INVALID' });
    await expect(placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'plant-small-1x1', x: 2, y: 5 })).rejects.toMatchObject({
      code: 'ENGINE_STATE_INVALID',
    });
    expect(await readFile(join(project.dir, 'venue.tmj'))).toEqual(before);
    const report = await validateMap({ projectDir: project.dir, mapPath: 'venue.tmj' });
    expect(report.errors.map((e) => e.code)).toEqual(['ENGINE_STATE_INVALID']);
  });

  test('a map resized before anything was built is taken at its new size', async () => {
    await scaffold();
    await writeFile(join(project.dir, 'venue.tmj'), JSON.stringify(widen(await load('venue.tmj'))));
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: { ...smallVenue([{ id: 'a', bounds: { x: 20, y: 0, width: 11, height: 8 } }]), mapWidth: 31 } });
    expect(readState(await load('venue.tmj'))?.size).toEqual({ width: 31, height: 20 });
  });

  test('a build refuses another asset set than the map uses', async () => {
    await scaffold();
    await expect(buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: { ...smallVenue([]), assetSet: 'other-set' } })).rejects.toMatchObject({
      code: 'ASSET_SET_MISMATCH',
    });
  });

  test('a tool zone deleted in Tiled no longer holds its name', async () => {
    await scaffold();
    await configureZone({ projectDir: project.dir, mapPath: 'venue.tmj', name: 'a', x: 20, y: 15, width: 2, height: 2, properties: { silent: true } });
    const map = await load('venue.tmj');
    const zonesLayer = resolveRole(map, 'zones').layer as TiledObjectGroup;
    zonesLayer.objects = zonesLayer.objects.filter((o) => o.name !== 'a');
    await writeFile(join(project.dir, 'venue.tmj'), JSON.stringify(map));
    const room = { id: 'a', bounds: { x: 0, y: 0, width: 10, height: 8 }, waProperties: { silent: true } };
    await expect(buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: smallVenue([room]) })).resolves.toMatchObject({ zones: ['a'] });
    expect(readState(await load('venue.tmj'))?.zones.map((z) => [z.name, z.origin])).toEqual([['a', 'build']]);
  });
});

const reasons = (warnings: { details: unknown }[]) => warnings.map((w) => (w.details as { reason?: string }).reason);

describe('tool prefabs across rebuilds', () => {
  const room = (extra: Record<string, unknown> = {}) => ({ mapWidth: 30, mapHeight: 20, assetSet: 'wa-starter-office', rooms: [{ id: 'a', bounds: { x: 0, y: 0, width: 12, height: 9 }, ...extra }] });
  const toolRecords = async () => readState(await load('venue.tmj'))!.prefabs.filter((p) => p.origin === 'tool');

  test('an identical rebuild keeps every tool prefab that still fits, wall-mounted ones included', async () => {
    await scaffold();
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: room() });
    await placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'notice-board-3x1', x: 2, y: 2 });
    await placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'wall-screen-3x2', x: 6, y: 1 });
    await placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'plant-small-1x1', x: 9, y: 6 });
    const before = await load('venue.tmj');
    const result = await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: room() });
    expect(result.warnings).toEqual([]);
    expect(result.toolPrefabs).toEqual(['p1', 'p2', 'p3']);
    expect(tileLayers(await load('venue.tmj'))).toBe(tileLayers(before));
    expect((await toolRecords()).map((p) => p.instance)).toEqual(['p1', 'p2', 'p3']);
    expect(await validateMap({ projectDir: project.dir, mapPath: 'venue.tmj' })).toMatchObject({ ok: true });
  });

  test('a tool prefab standing in an empty cell of another is not taken for a hand edit', async () => {
    await scaffold();
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: room() });
    // The cafe table leaves its top corners empty; the plant stands in one of them.
    await placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'cafe-table-3x2', x: 3, y: 4 });
    await placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'plant-small-1x1', x: 3, y: 4 });
    const before = await load('venue.tmj');
    const result = await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: room() });
    expect(result.warnings).toEqual([]);
    expect(result.toolPrefabs).toEqual(['p1', 'p2']);
    expect(tileLayers(await load('venue.tmj'))).toBe(tileLayers(before));
  });

  test('a tool prefab erased by hand stays gone and takes its hidden collisions with it', async () => {
    await scaffold();
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: room() });
    await placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'phone-pod-2x2', x: 6, y: 5 });
    const map = await load('venue.tmj');
    const writes = [...eachWrite((await toolRecords())[0]!.writes, { width: 30, height: 20 })];
    expect(writes.some((w) => w.role === 'collisions')).toBe(true);
    for (const w of writes) if (w.role !== 'collisions') setTile(map, w.role, w.x, w.y, 0);
    await writeFile(join(project.dir, 'venue.tmj'), JSON.stringify(map));
    const result = await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: room() });
    expect(result.warnings.map((w) => w.code)).toEqual(['PREFAB_UNTRACKED']);
    const after = await load('venue.tmj');
    for (const w of writes) expect(localAt(after, w.role, w.x, w.y)).toBe('.');
    expect(await toolRecords()).toEqual([]);
  });

  test('a tool prefab edited by hand is left exactly as the person left it', async () => {
    await scaffold();
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: room() });
    await placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'phone-pod-2x2', x: 6, y: 5 });
    const map = await load('venue.tmj');
    const tile = [...eachWrite((await toolRecords())[0]!.writes, { width: 30, height: 20 })].find((w) => w.role !== 'collisions')!;
    setTile(map, tile.role, tile.x, tile.y, readTileData(resolveRole(map, tile.role).layer)[tile.y * 30 + tile.x]! + 1);
    await writeFile(join(project.dir, 'venue.tmj'), JSON.stringify(map));
    const result = await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: room() });
    expect(result.warnings.map((w) => w.message).join(' ')).toContain('edited by hand');
    expect(reasons(result.warnings)).toEqual(['edited']);
    expect(tileLayers(await load('venue.tmj'))).toBe(tileLayers(map));
    expect(await toolRecords()).toEqual([]);
  });

  test('a tile or collision a person adds inside a tool prefab makes it edited, so nothing is deleted', async () => {
    await scaffold();
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: room() });
    await placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'table-long-4x3', x: 2, y: 4 });
    await placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'phone-pod-2x2', x: 8, y: 5 });
    const map = await load('venue.tmj');
    const anyTile = readTileData(resolveRole(map, 'floor').layer).find((v) => v !== 0)!;
    const collision = readTileData(resolveRole(map, 'collisions').layer).find((v) => v !== 0)!;
    // A decoration on another layer inside the table's rectangle, and a collision inside the pod's.
    const tableCells = [...eachWrite((await toolRecords())[0]!.writes, { width: 30, height: 20 })];
    const free = [2, 3, 4, 5].flatMap((x) => [4, 5, 6].map((y) => ({ x, y }))).find((c) => !tableCells.some((w) => w.role === 'foreground2' && w.x === c.x && w.y === c.y))!;
    setTile(map, 'foreground2', free.x, free.y, anyTile);
    const podCells = [...eachWrite((await toolRecords())[1]!.writes, { width: 30, height: 20 })];
    const open = [8, 9].flatMap((x) => [5, 6].map((y) => ({ x, y }))).find((c) => !podCells.some((w) => w.role === 'collisions' && w.x === c.x && w.y === c.y));
    if (open !== undefined) setTile(map, 'collisions', open.x, open.y, collision);
    await writeFile(join(project.dir, 'venue.tmj'), JSON.stringify(map));
    const result = await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: room() });
    expect(result.warnings.map((w) => w.code)).not.toContain('PREFAB_REMOVED');
    expect(reasons(result.warnings)).toEqual(open === undefined ? ['edited'] : ['edited', 'edited']);
    expect(tileLayers(await load('venue.tmj'))).toBe(tileLayers(map));
  });

  test('a prefab repainted by hand, or with a collision removed, is edited and keeps the rest', async () => {
    await scaffold();
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: room() });
    await placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'phone-pod-2x2', x: 6, y: 5 });
    await placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'plant-small-1x1', x: 9, y: 6 });
    const map = await load('venue.tmj');
    const [pod, plant] = await toolRecords();
    const other = readTileData(resolveRole(map, 'floor').layer).find((v) => v !== 0)!;
    for (const w of eachWrite(pod!.writes, { width: 30, height: 20 })) if (w.role !== 'collisions') setTile(map, w.role, w.x, w.y, other);
    const plantCollision = [...eachWrite(plant!.writes, { width: 30, height: 20 })].find((w) => w.role === 'collisions')!;
    setTile(map, 'collisions', plantCollision.x, plantCollision.y, 0);
    await writeFile(join(project.dir, 'venue.tmj'), JSON.stringify(map));
    const result = await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: room() });
    expect(reasons(result.warnings)).toEqual(['edited', 'edited']);
    // The repainted pod keeps its collisions, and the removed one stays removed.
    expect(tileLayers(await load('venue.tmj'))).toBe(tileLayers(map));
  });

  test('a rebuild removes a tool prefab that would block one of its new doors, instead of failing', async () => {
    await scaffold();
    const small = (doors: unknown[]) => ({ ...room(), rooms: [{ id: 'a', bounds: { x: 0, y: 0, width: 10, height: 8 }, doors }] });
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: small([]) });
    await placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'lectern-1x1', x: 4, y: 6 });
    const result = await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: small([{ wall: 'south', offset: 4 }]) });
    expect(result.warnings.map((w) => w.message).join(' ')).toContain('block a door');
    expect(reasons(result.warnings)).toEqual(['blocks-door']);
    expect(await toolRecords()).toEqual([]);
    expect(await validateMap({ projectDir: project.dir, mapPath: 'venue.tmj' })).toMatchObject({ ok: true });
  });

  test('a door blocked by hand elsewhere does not stop place_prefab, but blocking a door still does', async () => {
    await scaffold();
    await buildRooms({
      projectDir: project.dir,
      mapPath: 'venue.tmj',
      dsl: {
        ...room(),
        rooms: [
          { id: 'a', bounds: { x: 0, y: 0, width: 10, height: 8 }, doors: [{ wall: 'south', offset: 4 }] },
          { id: 'b', bounds: { x: 0, y: 7, width: 10, height: 9 } },
        ],
      },
    });
    const map = await load('venue.tmj');
    const collision = readTileData(resolveRole(map, 'collisions').layer).find((v) => v !== 0)!;
    setTile(map, 'collisions', 4, 6, collision);
    await writeFile(join(project.dir, 'venue.tmj'), JSON.stringify(map));
    await expect(placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'plant-small-1x1', x: 2, y: 13 })).resolves.toMatchObject({ instance: 'p1' });
    await expect(placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'lectern-1x1', x: 4, y: 10 })).rejects.toMatchObject({
      code: 'DOOR_UNREACHABLE',
    });
  });
});

describe('inputs and damaged state', () => {
  test('fractional and NaN coordinates are refused before anything is written', async () => {
    await scaffold();
    const before = await readFile(join(project.dir, 'venue.tmj'));
    await expect(scaffold('b.tmj', { spawn: { x: 1.5, y: 2 } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'lectern-1x1', x: Number.NaN, y: 2 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      configureZone({ projectDir: project.dir, mapPath: 'venue.tmj', name: 'z', x: 1, y: 1, width: Number.NaN, height: 2, properties: {} }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await readFile(join(project.dir, 'venue.tmj'))).toEqual(before);
  });

  test('a damaged engine record stops edits and is reported by validation', async () => {
    await scaffold();
    const map = await load('venue.tmj');
    const state = JSON.parse(String(getProperty(map, 'wa-agent-engine:build')?.value)) as { footprint: string };
    state.footprint = '0:0-200000000';
    (map.properties ?? []).find((p) => p.name === 'wa-agent-engine:build')!.value = JSON.stringify(state);
    await writeFile(join(project.dir, 'venue.tmj'), JSON.stringify(map));
    const before = await readFile(join(project.dir, 'venue.tmj'));
    await expect(placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'lectern-1x1', x: 5, y: 5 })).rejects.toMatchObject({
      code: 'ENGINE_STATE_INVALID',
    });
    expect(await readFile(join(project.dir, 'venue.tmj'))).toEqual(before);
    const report = await validateMap({ projectDir: project.dir, mapPath: 'venue.tmj' });
    expect(report.errors.map((e) => e.code)).toEqual(['ENGINE_STATE_INVALID']);
  });

  test('damaged records that would decode past the map, or hold rooms outside it, are refused quickly', async () => {
    await scaffold();
    const clean = await load('venue.tmj');
    const damages: ((state: Record<string, unknown>) => void)[] = [
      (state) => { state['footprint'] = `0:${new Array(200_000).fill('0-29').join(',')}`; },
      (state) => { state['rooms'] = [{ id: 'x', bounds: { x: 0, y: 0, width: 200_000, height: 200_000 } }]; },
      (state) => { state['footprint'] = '0:'; },
      (state) => { state['writes'] = { floor: { cells: '0:0', originals: '0:0=4294967296' } }; },
      (state) => { state['rooms'] = [{ id: 'x', bounds: { x: 0, y: 0, width: 10, height: 8 }, doors: [{ wall: 'south', offset: 2, width: 300_000_000 }] }]; },
    ];
    const started = Date.now();
    for (const damage of damages) {
      const map = structuredClone(clean);
      const property = (map.properties ?? []).find((p) => p.name === 'wa-agent-engine:build')!;
      const state = JSON.parse(String(property.value)) as Record<string, unknown>;
      damage(state);
      property.value = JSON.stringify(state);
      await writeFile(join(project.dir, 'venue.tmj'), JSON.stringify(map));
      const report = await validateMap({ projectDir: project.dir, mapPath: 'venue.tmj' });
      expect(report.errors.map((e) => e.code)).toEqual(['ENGINE_STATE_INVALID']);
    }
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test('a layer smaller than the map is refused instead of silently dropping tiles', async () => {
    await scaffold();
    const map = await load('venue.tmj');
    const layer = resolveRole(map, 'furniture2').layer;
    Object.assign(layer, { width: 10, height: 10, data: new Array<number>(100).fill(0) });
    await writeFile(join(project.dir, 'venue.tmj'), JSON.stringify(map));
    await expect(placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'lectern-1x1', x: 5, y: 5 })).rejects.toMatchObject({
      code: 'LAYER_DATA_UNSUPPORTED',
    });
  });

  test('configure_wa_zone refuses a name or properties of the wrong type', async () => {
    await scaffold();
    const zone = { projectDir: project.dir, mapPath: 'venue.tmj', name: 'z', x: 1, y: 1, width: 2, height: 2, properties: {} };
    await expect(configureZone({ ...zone, name: 42 as unknown as string })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(configureZone({ ...zone, properties: null as unknown as Record<string, unknown> })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  test('place_prefab refuses another asset set than the map uses', async () => {
    await scaffold();
    await expect(
      placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'lectern-1x1', x: 5, y: 5, assetSet: 'other-set' }),
    ).rejects.toMatchObject({ code: 'ASSET_SET_MISMATCH' });
  });

  test('zone warnings and JSON-text variable defaults are reported by the build', async () => {
    await scaffold();
    const result = await buildRooms({
      projectDir: project.dir,
      mapPath: 'venue.tmj',
      dsl: {
        mapWidth: 30,
        mapHeight: 20,
        assetSet: 'wa-starter-office',
        rooms: [{ id: 'a', bounds: { x: 0, y: 0, width: 10, height: 8 }, waProperties: { openWebsite: 'https://var.camp', openWebsitePolicy: 'fullscreen; teleport' } }],
        variables: [{ name: 'agenda', default: ['opening', 'talks'] }],
      },
    });
    expect(result.warnings.map((w) => w.code).sort()).toEqual(['INVALID_ZONE_PROPERTY', 'VARIABLE_DEFAULT_AS_TEXT']);
  });
});

describe('wall-mounted prefabs', () => {
  test('an either-row prefab fits both face rows, and WA office walls take wall prefabs', async () => {
    await scaffold();
    await buildRooms({ projectDir: project.dir, mapPath: 'venue.tmj', dsl: VENUE_DSL });
    await expect(placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'notice-board-3x1', x: 6, y: 9 })).resolves.toMatchObject({ cells: 4 });
    await expect(placePrefab({ projectDir: project.dir, mapPath: 'venue.tmj', prefabId: 'notice-board-3x1', x: 16, y: 10 })).resolves.toMatchObject({ cells: 4 });
    await expect(placePrefab({ projectDir: project.dir, mapPath: 'office.tmj', prefabId: 'wall-screen-3x2', x: 13, y: 1 })).resolves.toMatchObject({ cells: 6 });
  });
});
