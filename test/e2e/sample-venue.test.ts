import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { sha256Hex } from '../../src/core/map-io.js';
import { makeFullProject, type TempProject } from '../helpers/project.js';
import { REPO_ROOT } from './helpers.js';

// The VarCamp sample venue is drawn only through CLI commands (examples/varcamp-venue.commands.sh).
// Its preview is derived from licensed art, so only its hash is committed.
const GOLDEN_PREVIEW_SHA256 = '0725f40dc0a653106f7888ca09c875b0bccfaba73ca197ae320a82ddf9dad118';

let project: TempProject;
let steps: { command: string; result: Record<string, unknown> }[];

beforeAll(async () => {
  project = await makeFullProject();
  const { stdout } = await promisify(execFile)('bash', [join(REPO_ROOT, 'examples', 'varcamp-venue.commands.sh'), project.dir], {
    cwd: REPO_ROOT,
    env: { ...process.env, WA_AGENT_ENGINE: `${process.execPath} --import tsx ${join(REPO_ROOT, 'src', 'cli', 'index.ts')}` },
    maxBuffer: 16 * 1024 * 1024,
  });
  // The transcript is "$ wa-agent-engine <command> --input {…}" followed by the JSON result.
  steps = stdout
    .split(/^\$ wa-agent-engine /m)
    .slice(1)
    .map((block) => {
      const [line, ...json] = block.split('\n');
      return { command: line!.split(' ')[0]!, result: JSON.parse(json.join('\n')) as Record<string, unknown> };
    });
}, 120_000);
afterAll(() => project.cleanup());

test('the transcript runs every tool, and no step reports an error', () => {
  expect([...new Set(steps.map((s) => s.command))]).toEqual(['scaffold', 'build', 'prefab', 'zone', 'validate', 'render']);
  for (const step of steps) expect(step.result['error']).toBeUndefined();
  expect(steps.find((s) => s.command === 'build')?.result).toMatchObject({ warnings: [], zones: expect.arrayContaining(['daisy-talks', 'sabal-lounge']) });
});

test('the sample venue validates clean', () => {
  expect(steps.find((s) => s.command === 'validate')?.result).toEqual({ ok: true, errors: [], warnings: [] });
});

test('the sample covers the brief: rooms, doors, prefabs and zones', async () => {
  const dsl = JSON.parse(await readFile(join(REPO_ROOT, 'examples', 'varcamp-venue.dsl.json'), 'utf8')) as {
    rooms: { id: string; bounds: { width: number; height: number }; doors?: { wall: string; exit?: boolean }[]; furniture?: { prefabId: string }[]; waProperties?: Record<string, unknown> }[];
    variables: unknown[];
  };
  expect(dsl.rooms.length).toBeGreaterThanOrEqual(5);
  // The brief's room types, and a phone booth that is a small walled room of its own.
  for (const kind of ['talks', 'workshop', 'lounge', 'registration', 'games', 'phone-booth', 'sponsors']) {
    expect(dsl.rooms.some((r) => r.id.includes(kind))).toBe(true);
  }
  expect(dsl.rooms.some((r) => r.id.includes('phone-booth') && r.bounds.width <= 5 && r.bounds.height <= 6)).toBe(true);
  const doors = dsl.rooms.flatMap((r) => r.doors ?? []);
  expect(doors.some((d) => d.wall === 'north' || d.wall === 'south')).toBe(true);
  expect(doors.some((d) => d.wall === 'east' || d.wall === 'west')).toBe(true);
  expect(doors.some((d) => d.exit === true)).toBe(true);
  const script = await readFile(join(REPO_ROOT, 'examples', 'varcamp-venue.commands.sh'), 'utf8');
  const prefabs = new Set([
    ...dsl.rooms.flatMap((r) => (r.furniture ?? []).map((f) => f.prefabId)),
    ...[...script.matchAll(/"prefabId":"([^"]+)"/g)].map((m) => m[1]!),
  ]);
  expect(prefabs.size).toBeGreaterThanOrEqual(12);
  expect(prefabs.has('wall-screen-3x2') || prefabs.has('notice-board-3x1')).toBe(true);
  const zoneKeys = new Set(dsl.rooms.flatMap((r) => Object.keys(r.waProperties ?? {})));
  for (const key of ['jitsiRoom', 'playAudio', 'focusable']) expect(zoneKeys.has(key)).toBe(true);
  for (const key of ['"openWebsite"', '"silent"', '"exitUrl":"office.tmj#', '"start":true', '"ai-zone":true']) expect(script).toContain(key);
  expect(dsl.variables).toHaveLength(1);
});

test('the preview matches the golden hash', async () => {
  const render = steps.find((s) => s.command === 'render')!.result as { pngPath: string; sha256: string };
  expect(sha256Hex(await readFile(render.pngPath))).toBe(render.sha256);
  expect(render.sha256).toBe(GOLDEN_PREVIEW_SHA256);
});
