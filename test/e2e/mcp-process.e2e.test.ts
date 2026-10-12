import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { afterEach, describe, expect, test } from 'vitest';
import { makeFullProject, type TempProject } from '../helpers/project.js';
import { REPO_ROOT } from './helpers.js';

// The server as a process: what it writes to stdout, and how it stops.

interface Server {
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  send(message: unknown): void;
  exit: Promise<number | null>;
}

const servers: Server[] = [];
let project: TempProject | undefined;

afterEach(async () => {
  for (const s of servers.splice(0)) if (s.child.exitCode === null) s.child.kill('SIGKILL');
  await project?.cleanup();
  project = undefined;
});

const spawnServer = (): ChildProcessWithoutNullStreams => spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'mcp'], { cwd: REPO_ROOT });

async function startServer(): Promise<Server> {
  const child = spawnServer();
  const stdout: string[] = [];
  let pending = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop()!;
    stdout.push(...lines);
  });
  const exit = once(child, 'exit').then(([code]) => code as number | null);
  // The banner on stderr means the server is reading stdin.
  let banner = '';
  child.stderr.setEncoding('utf8');
  for await (const chunk of child.stderr) {
    banner += chunk as string;
    if (banner.includes('MCP server on stdio')) break;
  }
  const server = { child, stdout, exit, send: (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`) };
  servers.push(server);
  return server;
}

const initialize = (s: Server): void => {
  s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } });
  s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
};

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('stdout carries JSON-RPC only, even after a malformed line', async () => {
  const s = await startServer();
  initialize(s);
  s.child.stdin.write('this is not json\n');
  s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await until(() => s.stdout.some((l) => l.includes('"id":2')));
  s.child.stdin.end();
  expect(await s.exit).toBe(0);
  for (const line of s.stdout.filter((l) => l !== '')) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
  expect(s.stdout.some((l) => l.includes('"tools"'))).toBe(true);
}, 30_000);

describe('stopping', () => {
  test('closing stdin, SIGTERM and SIGINT each stop the server with exit code 0', async () => {
    const eof = await startServer();
    eof.child.stdin.end();
    expect(await eof.exit).toBe(0);
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      const s = await startServer();
      s.child.kill(signal);
      expect(await s.exit).toBe(0);
    }
  }, 30_000);

  test('a signal sent the moment the banner appears still stops the server with exit code 0', async () => {
    // The banner tells a client the server is ready, so the stop handlers must already be in place.
    // Signalling from the stderr handler itself, with several servers at once, makes any gap show.
    const children = Array.from({ length: 8 }, () => spawnServer());
    try {
      const exits = await Promise.all(
        children.map((child, i) => {
          let banner = '';
          child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
            banner += chunk;
            if (banner.includes('MCP server on stdio') && !child.killed) child.kill(i % 2 === 0 ? 'SIGTERM' : 'SIGINT');
          });
          return once(child, 'exit').then(([code]) => code as number | null);
        }),
      );
      expect(exits).toEqual(Array(8).fill(0));
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 30_000);

  test('SIGTERM while a build runs leaves an intact map and no lock file behind', async () => {
    project = await makeFullProject();
    const s = await startServer();
    initialize(s);
    const call = (id: number, name: string, args: Record<string, unknown>) =>
      s.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { projectDir: project!.dir, mapPath: 'big.tmj', ...args } } });
    call(2, 'scaffold_map', { width: 200, height: 200, spawn: { x: 2, y: 4 } });
    await until(() => s.stdout.some((l) => l.includes('"id":2')));
    const rooms = Array.from({ length: 100 }, (_, i) => ({ id: `r${i}`, bounds: { x: (i % 10) * 20, y: Math.floor(i / 10) * 20, width: 12, height: 9 } }));
    call(3, 'build_room_from_dsl', { dsl: { mapWidth: 200, mapHeight: 200, assetSet: 'wa-starter-office', rooms } });
    await new Promise((r) => setTimeout(r, 30));
    s.child.kill('SIGTERM');
    expect(await s.exit).toBe(0);
    expect((await readdir(project.dir)).filter((f) => f.endsWith('.lock'))).toEqual([]);
    expect(JSON.parse(await readFile(`${project.dir}/big.tmj`, 'utf8'))).toMatchObject({ width: 200, height: 200 });
  }, 30_000);
});
