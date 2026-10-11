import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readState } from '../../src/core/engine-state.js';
import { readMap } from '../../src/core/map-io.js';
import { makeFullProject, makeProject, type TempProject } from '../helpers/project.js';
import { connectMcp, errorOf } from './helpers.js';

let client: Client;
let project: TempProject;

beforeAll(async () => {
  client = await connectMcp();
  project = await makeFullProject();
}, 60_000);
afterAll(async () => {
  await client.close();
  await project.cleanup();
});

const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

const VENUE = {
  mapWidth: 24,
  mapHeight: 16,
  assetSet: 'wa-starter-office',
  rooms: [
    {
      id: 'daisy',
      bounds: { x: 0, y: 0, width: 12, height: 9 },
      doors: [{ wall: 'south', offset: 5, width: 2 }],
      waProperties: { jitsiRoom: 'Daisy' },
      furniture: [{ prefabId: 'lectern-1x1', x: 5, y: 4 }],
    },
    { id: 'hall', bounds: { x: 0, y: 8, width: 24, height: 8 } },
  ],
};

test('the server lists exactly the seven map tools, with schemas', async () => {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toEqual(['scaffold_map', 'build_room_from_dsl', 'place_prefab', 'configure_wa_zone', 'validate_wa_map', 'render_map_preview', 'import_prop_set']);
  for (const tool of tools) {
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.outputSchema?.type).toBe('object');
  }
  expect(tools.find((t) => t.name === 'validate_wa_map')?.annotations?.readOnlyHint).toBe(true);
});

describe('the whole workflow over stdio', () => {
  test('scaffold, build, prefab, zone, validate and render', async () => {
    const base = { projectDir: project.dir, mapPath: 'maps/venue.tmj' };
    const scaffold = await call('scaffold_map', { ...base, width: 24, height: 16, spawn: { x: 3, y: 13 }, mapName: 'VarCamp' });
    expect(scaffold.isError).toBeFalsy();
    expect(scaffold.structuredContent).toMatchObject({ mapPath: 'maps/venue.tmj', warnings: [] });

    const build = await call('build_room_from_dsl', { ...base, dsl: VENUE });
    expect(build.isError).toBeFalsy();
    expect(build.structuredContent).toMatchObject({ zones: ['daisy'], prefabs: ['b-daisy-1'] });

    const prefab = await call('place_prefab', { ...base, prefabId: 'plant-small-1x1', x: 2, y: 12 });
    expect(prefab.structuredContent).toEqual({ instance: 'p1', cells: expect.any(Number), collisions: 1 });

    const zone = await call('configure_wa_zone', { ...base, name: 'welcome', x: 14, y: 11, width: 4, height: 3, properties: { openWebsite: 'https://var.camp/' } });
    expect(zone.structuredContent).toMatchObject({ pixelRect: { x: 448, y: 352, width: 128, height: 96 } });

    const validate = await call('validate_wa_map', base);
    expect(validate.structuredContent).toMatchObject({ ok: true, errors: [] });

    const render = await call('render_map_preview', { ...base, scale: 0.5, overlays: ['zones'] });
    expect(render.structuredContent).toMatchObject({ width: 384, height: 256, pngPath: join(project.dir, '.wa-preview', 'maps__venue@0.5x.png') });
    const image = (render.content as { type: string; data?: string; mimeType?: string }[]).find((c) => c.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    const onDisk = await readFile((render.structuredContent as { pngPath: string }).pngPath);
    expect(Buffer.from(image!.data!, 'base64').equals(onDisk)).toBe(true);
    // Every success also carries its result as JSON text.
    expect(JSON.parse((render.content as { text: string }[])[0]!.text)).toEqual(render.structuredContent);
  });

  test('three parallel place_prefab calls on one map all persist', async () => {
    const base = { projectDir: project.dir, mapPath: 'maps/parallel.tmj' };
    await call('scaffold_map', { ...base, width: 24, height: 16, spawn: { x: 3, y: 13 } });
    await call('build_room_from_dsl', { ...base, dsl: VENUE });
    const results = await Promise.all([16, 18, 20].map((x) => call('place_prefab', { ...base, prefabId: 'plant-small-1x1', x, y: 12 })));
    expect(results.every((r) => !r.isError)).toBe(true);
    const state = readState((await readMap(join(project.dir, base.mapPath))).map);
    expect(state?.prefabs.filter((p) => p.origin === 'tool').map((p) => p.x).sort()).toEqual([16, 18, 20]);
  });
});

describe('errors come back as coded JSON bodies', () => {
  test('geometry, missing images and paths each have their code', async () => {
    await call('scaffold_map', { projectDir: project.dir, mapPath: 'thick.tmj', width: 20, height: 10, spawn: { x: 1, y: 1 } });
    const thick = await call('build_room_from_dsl', {
      projectDir: project.dir,
      mapPath: 'thick.tmj',
      dsl: { mapWidth: 20, mapHeight: 10, assetSet: 'wa-starter-office', rooms: [{ id: 'a', bounds: { x: 0, y: 0, width: 8, height: 8 } }, { id: 'b', bounds: { x: 8, y: 0, width: 8, height: 8 } }] },
    });
    expect(thick.isError).toBe(true);
    expect(errorOf(thick).code).toBe('THICK_WALL');

    const bare = await makeProject();
    try {
      const missing = await call('scaffold_map', { projectDir: bare.dir, mapPath: 'm.tmj', width: 10, height: 10, spawn: { x: 1, y: 1 } });
      expect(errorOf(missing).code).toBe('ASSET_IMAGE_MISSING');
    } finally {
      await bare.cleanup();
    }
    expect(errorOf(await call('validate_wa_map', { projectDir: project.dir, mapPath: '../x.tmj' })).code).toBe('PATH_OUTSIDE_PROJECT');
    expect(errorOf(await call('validate_wa_map', { projectDir: project.dir, mapPath: '.env' })).code).toBe('PATH_BAD_EXTENSION');
    expect(errorOf(await call('validate_wa_map', { projectDir: 'relative/dir', mapPath: 'm.tmj' })).code).toBe('PROJECT_DIR_INVALID');
  });

  test('a shape error is an isError result, and an unknown tool rejects', async () => {
    const shape = await call('place_prefab', { projectDir: project.dir, mapPath: 'm.tmj', prefabId: 'plant-small-1x1', x: 'two', y: 1 });
    expect(shape.isError).toBe(true);
    expect(errorOf(shape).message).toContain('Input validation error');
    await expect(call('no_such_tool', {})).rejects.toThrow();
  });
});
