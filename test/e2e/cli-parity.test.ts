import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeStartRule } from '../helpers/automap.js';
import { makeFullProject, type TempProject } from '../helpers/project.js';
import { connectMcp, errorOf, REPO_ROOT, runCli } from './helpers.js';

// The CLI and the MCP server are two adapters over one tool table: the same input gives the
// same JSON on both. Each surface works in its own project, and project paths are masked.

let client: Client;
let cliProject: TempProject;
let mcpProject: TempProject;

beforeAll(async () => {
  client = await connectMcp();
  cliProject = await makeFullProject();
  mcpProject = await makeFullProject();
}, 60_000);
afterAll(async () => {
  await client.close();
  await cliProject.cleanup();
  await mcpProject.cleanup();
});

const mask = (value: unknown, dir: string): unknown => JSON.parse(JSON.stringify(value).replaceAll(dir, '<project>'));

async function both(name: string, command: string, args: Record<string, unknown>) {
  const cli = await runCli(command, { projectDir: cliProject.dir, ...args });
  const mcp = await client.callTool({ name, arguments: { projectDir: mcpProject.dir, ...args } });
  return { cli: { ...cli, json: mask(cli.json, cliProject.dir) }, mcp, mcpJson: mask(mcp.isError ? { error: errorOf(mcp) } : mcp.structuredContent, mcpProject.dir) };
}

const dsl = {
  mapWidth: 20,
  mapHeight: 12,
  assetSet: 'wa-starter-office',
  rooms: [{ id: 'padauk', bounds: { x: 0, y: 0, width: 10, height: 8 }, doors: [{ wall: 'south', offset: 4 }], waProperties: { silent: true } }],
};

test('successes and coded errors are identical on both surfaces, in workflow order', async () => {
  const steps: [string, string, Record<string, unknown>, number][] = [
    ['scaffold_map', 'scaffold', { mapPath: 'p.tmj', width: 20, height: 12, spawn: { x: 2, y: 10 } }, 0],
    ['scaffold_map', 'scaffold', { mapPath: 'p.tmj', width: 20, height: 12, spawn: { x: 2, y: 10 } }, 1],
    ['build_room_from_dsl', 'build', { mapPath: 'p.tmj', dsl }, 0],
    ['build_room_from_dsl', 'build', { mapPath: 'p.tmj', dsl: { ...dsl, rooms: [{ ...dsl.rooms[0], doors: [{ wall: 'south', offset: 0 }] }] } }, 1],
    ['place_prefab', 'prefab', { mapPath: 'p.tmj', prefabId: 'plant-small-1x1', x: 2, y: 5 }, 0],
    ['place_prefab', 'prefab', { mapPath: 'p.tmj', prefabId: 'no-such-prefab', x: 2, y: 5 }, 1],
    ['configure_wa_zone', 'zone', { mapPath: 'p.tmj', name: 'stage', x: 12, y: 2, width: 3, height: 3, properties: { jitsiRoom: 'Stage' } }, 0],
    ['configure_wa_zone', 'zone', { mapPath: 'p.tmj', name: 'padauk', x: 1, y: 1, width: 2, height: 2, properties: { silent: false } }, 1],
    ['validate_wa_map', 'validate', { mapPath: 'p.tmj' }, 0],
    ['render_map_preview', 'render', { mapPath: 'p.tmj', scale: 0.25 }, 0],
    ['render_map_preview', 'render', { mapPath: 'p.tmj', scale: 3 }, 1],
  ];
  const check = async ([name, command, args, code]: (typeof steps)[number]): Promise<void> => {
    const { cli, mcp, mcpJson } = await both(name, command, args);
    expect({ step: `${command} ${code}`, code: cli.code }).toEqual({ step: `${command} ${code}`, code });
    expect(Boolean(mcp.isError)).toBe(code === 1);
    expect(cli.json).toEqual(mcpJson);
  };
  for (const step of steps) await check(step);
  // automap: no rules file yet, then one in each project.
  await check(['automap_map', 'automap', { mapPath: 'p.tmj' }, 1]);
  await writeStartRule(cliProject.dir, 'p.tmj', '.');
  await writeStartRule(mcpProject.dir, 'p.tmj', '.');
  await check(['automap_map', 'automap', { mapPath: 'p.tmj' }, 0]);
  // automap-template: written, then refused without overwrite.
  const plain = { outDir: 'rules/template', tilesets: ['tilesets/WA_Room_Builder.tsj'] };
  await check(['automap_template', 'automap-template', { ...plain, assetSet: 'wa-starter-office' }, 1]);
  // The starter set's tileset, next to its image.
  const tsj = JSON.parse(await readFile(join(REPO_ROOT, 'assets/sets/wa-starter-office/tilesets/WA_Room_Builder.tsj'), 'utf8')) as object;
  for (const project of [cliProject, mcpProject]) await writeFile(join(project.dir, 'tilesets/WA_Room_Builder.tsj'), JSON.stringify({ ...tsj, image: 'WA_Room_Builder.png' }));
  await check(['automap_template', 'automap-template', plain, 0]);
  await check(['automap_template', 'automap-template', plain, 1]);
});

test('shape errors are rejected on both surfaces', async () => {
  const { cli, mcp } = await both('place_prefab', 'prefab', { mapPath: 'p.tmj', prefabId: 'plant-small-1x1', x: 'two', y: 1 });
  expect(cli.code).toBe(1);
  expect(cli.json).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  expect(mcp.isError).toBe(true);
});

test('unknown commands and flags exit 2, and every command prints its input schema', async () => {
  expect((await runCli('paint', {})).code).toBe(2);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { REPO_ROOT } = await import('./helpers.js');
  const run = promisify(execFile);
  await expect(run(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'render', '--colour', 'red'], { cwd: REPO_ROOT })).rejects.toMatchObject({ code: 2 });
  const help = await run(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'build', '--help'], { cwd: REPO_ROOT });
  expect(help.stdout).toContain('"mapWidth"');
  const stdin = run(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'validate', '--input', '-'], { cwd: REPO_ROOT });
  stdin.child.stdin?.end(JSON.stringify({ projectDir: cliProject.dir, mapPath: 'p.tmj' }));
  expect(JSON.parse((await stdin).stdout)).toMatchObject({ ok: true });
});

test('--input-file takes an absolute or a relative path, and mcp takes no arguments', async () => {
  const { execFile } = await import('node:child_process');
  const { writeFile } = await import('node:fs/promises');
  const { join, relative } = await import('node:path');
  const { promisify } = await import('node:util');
  const { REPO_ROOT } = await import('./helpers.js');
  const run = promisify(execFile);
  const cli = (...args: string[]) => run(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], { cwd: REPO_ROOT });
  const file = join(cliProject.dir, 'validate.json');
  await writeFile(file, JSON.stringify({ projectDir: cliProject.dir, mapPath: 'p.tmj' }));
  for (const path of [file, relative(REPO_ROOT, file)]) {
    expect(JSON.parse((await cli('validate', '--input-file', path)).stdout)).toMatchObject({ ok: true });
  }
  await expect(cli('validate', '--input-file', join(cliProject.dir, 'missing.json'))).rejects.toMatchObject({ code: 1 });
  await expect(cli('mcp', '--port', '80')).rejects.toMatchObject({ code: 2 });
  expect((await cli('mcp', '--help')).stdout).toContain('takes no arguments');
});
