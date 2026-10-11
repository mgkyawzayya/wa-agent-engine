import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, lstat, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, onTestFinished, test } from 'vitest';
import { ensureStandardLayers } from '../../src/core/layers.js';
import {
  createEmptyMap,
  lockPathFor,
  MAX_MAP_FILE_BYTES,
  readMap,
  serializeMap,
  tempPathFor,
  withMapLock,
  writeMap,
} from '../../src/core/map-io.js';
import { getProperty, setProperty, type TiledGroupLayer, type TiledObjectGroup } from '../../src/schemas/tiled.schema.js';
import { makeProject, type TempProject } from '../helpers/project.js';

let project: TempProject;

beforeEach(async () => {
  project = await makeProject({ maps: ['office.tmj', 'conference.tmj'] });
});
afterEach(() => project.cleanup());

describe('round-trip', () => {
  test.each(['office.tmj', 'conference.tmj'])('%s survives read and write unchanged, key order included', async (name) => {
    const abs = join(project.dir, name);
    const original: unknown = JSON.parse(await readFile(abs, 'utf8'));
    const { map, sha256 } = await readMap(abs);
    await writeMap(abs, map, { projectDir: project.dir, expectedSha256: sha256 });
    const reread: unknown = JSON.parse(await readFile(abs, 'utf8'));
    expect(reread).toEqual(original);
    expect(JSON.stringify(reread)).toBe(JSON.stringify(original));
  });

  test('unknown and Tiled-only fields survive', async () => {
    const abs = join(project.dir, 'office.tmj');
    const first = await readMap(abs);
    const map = first.map;
    map.class = 'venue';
    map['wa-custom'] = { nested: [1, 2, 3] };
    const floor = map.layers.find((l): l is TiledGroupLayer => l.name === 'floor' && l.type === 'group')!;
    floor.parallaxx = 0.5;
    floor.tintcolor = '#ff00ff';
    floor.layers[0]!.mode = 'multiply';
    const floorLayer = map.layers.find((l): l is TiledObjectGroup => l.name === 'floorLayer' && l.type === 'objectgroup')!;
    floorLayer.objects[0]!.capsule = true;
    await writeMap(abs, map, { projectDir: project.dir, expectedSha256: first.sha256 });

    const { map: back } = await readMap(abs);
    expect(back.class).toBe('venue');
    expect(back['wa-custom']).toEqual({ nested: [1, 2, 3] });
    const backFloor = back.layers.find((l) => l.name === 'floor') as TiledGroupLayer;
    expect(backFloor.parallaxx).toBe(0.5);
    expect(backFloor.tintcolor).toBe('#ff00ff');
    expect(backFloor.layers[0]!.mode).toBe('multiply');
    expect((back.layers.find((l) => l.name === 'floorLayer') as TiledObjectGroup).objects[0]!.capsule).toBe(true);
    expect(getProperty(back, 'script')?.value).toBe('src/main.ts');
  });
});

describe('write preconditions', () => {
  test('a write after an external change fails', async () => {
    const abs = join(project.dir, 'office.tmj');
    const { map, sha256 } = await readMap(abs);
    const external = await readMap(abs);
    setProperty(external.map, 'mapName', 'string', 'Edited in Tiled');
    await writeMap(abs, external.map, { projectDir: project.dir, expectedSha256: external.sha256 });
    await expect(writeMap(abs, map, { projectDir: project.dir, expectedSha256: sha256 })).rejects.toMatchObject({ code: 'MAP_CHANGED_ON_DISK' });
    expect(getProperty((await readMap(abs)).map, 'mapName')?.value).toBe('Edited in Tiled');
  });

  test('a new-file write fails if the file appeared meanwhile', async () => {
    const abs = join(project.dir, 'new.tmj');
    await writeMap(abs, createEmptyMap(4, 4), { projectDir: project.dir, expectedSha256: null });
    await expect(writeMap(abs, createEmptyMap(4, 4), { projectDir: project.dir, expectedSha256: null })).rejects.toMatchObject({
      code: 'MAP_CHANGED_ON_DISK',
    });
  });

  test('concurrent locked mutations both survive', async () => {
    const abs = join(project.dir, 'office.tmj');
    const mutate = (name: string) =>
      withMapLock(abs, async () => {
        const { map, sha256 } = await readMap(abs);
        await new Promise((r) => setTimeout(r, 10));
        setProperty(map, name, 'bool', true);
        await writeMap(abs, map, { projectDir: project.dir, expectedSha256: sha256 });
      });
    await Promise.all([mutate('first'), mutate('second'), mutate('third')]);
    const { map } = await readMap(abs);
    expect(['first', 'second', 'third'].map((n) => getProperty(map, n)?.value)).toEqual([true, true, true]);
  });

  test('temp files are named per target, pid, and random suffix', () => {
    const target = join(project.dir, 'office.tmj');
    const names = Array.from({ length: 50 }, () => basename(tempPathFor(target)));
    expect(new Set(names).size).toBe(50);
    for (const name of names) expect(name).toMatch(new RegExp(`^\\.office\\.tmj\\.${process.pid}\\.[0-9a-f]{12}\\.tmp$`));
  });

  test('two creates of the same new map: exactly one wins', async () => {
    const abs = join(project.dir, 'race.tmj');
    const results = await Promise.allSettled([
      writeMap(abs, createEmptyMap(2, 2), { projectDir: project.dir, expectedSha256: null }),
      writeMap(abs, createEmptyMap(3, 3), { projectDir: project.dir, expectedSha256: null }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'MAP_CHANGED_ON_DISK' } });
    expect((await readdir(project.dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  test('writes through an in-project symlink replace the real file, keep the link and the mode', async () => {
    const real = join(project.dir, 'office.tmj');
    await chmod(real, 0o600);
    await symlink(real, join(project.dir, 'alias.tmj'));
    const { map, sha256 } = await readMap(join(project.dir, 'alias.tmj'));
    setProperty(map, 'viaLink', 'bool', true);
    await writeMap(join(project.dir, 'alias.tmj'), map, { projectDir: project.dir, expectedSha256: sha256 });
    expect((await lstat(join(project.dir, 'alias.tmj'))).isSymbolicLink()).toBe(true);
    expect(getProperty((await readMap(real)).map, 'viaLink')?.value).toBe(true);
    expect((await stat(real)).mode & 0o777).toBe(0o600);
  });

  test('a new map in a missing folder creates the folder', async () => {
    await writeMap(join(project.dir, 'maps', 'lobby.tmj'), createEmptyMap(2, 2), {
      projectDir: project.dir,
      expectedSha256: null,
    });
    expect((await readMap(join(project.dir, 'maps', 'lobby.tmj'))).map.width).toBe(2);
  });

  test('a map deleted after it was read is reported as changed, not recreated', async () => {
    const abs = join(project.dir, 'office.tmj');
    const { map, sha256 } = await readMap(abs);
    await rm(abs);
    await expect(writeMap(abs, map, { projectDir: project.dir, expectedSha256: sha256 })).rejects.toMatchObject({
      code: 'MAP_CHANGED_ON_DISK',
      message: expect.stringContaining('deleted'),
    });
    expect(existsSync(abs)).toBe(false);
    expect((await readdir(project.dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  test('a write target outside the project is refused', async () => {
    await expect(
      writeMap(join(project.dir, '..', 'escape.tmj'), createEmptyMap(2, 2), { projectDir: project.dir, expectedSha256: null }),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' });
  });

  test('parallel writes in one directory use unique temp files and leave none behind', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        writeMap(join(project.dir, `m${i}.tmj`), createEmptyMap(2, 2), { projectDir: project.dir, expectedSha256: null }),
      ),
    );
    const files = await readdir(project.dir);
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(files.filter((f) => /^m\d+\.tmj$/.test(f))).toHaveLength(20);
  });
});

describe('read errors', () => {
  test('a FIFO in place of a map is refused, not waited on', async () => {
    const abs = join(project.dir, 'pipe.tmj');
    execFileSync('mkfifo', [abs]);
    await expect(readMap(abs)).rejects.toMatchObject({ code: 'MAP_NOT_FOUND' });
  });

  test('parse errors never quote file content', async () => {
    const abs = join(project.dir, 'broken.tmj');
    await writeFile(abs, '{ "layers": [ SECRET_TOKEN_123 ');
    const err = await readMap(abs).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'MAP_PARSE_ERROR' });
    expect(JSON.stringify(err)).not.toContain('SECRET_TOKEN_123');
    expect((err as Error).message).not.toContain('SECRET_TOKEN_123');
  });

  test('missing files and non-maps are coded', async () => {
    await expect(readMap(join(project.dir, 'missing.tmj'))).rejects.toMatchObject({ code: 'MAP_NOT_FOUND' });
    await writeFile(join(project.dir, 'list.tmj'), '[1, 2, 3]');
    await expect(readMap(join(project.dir, 'list.tmj'))).rejects.toMatchObject({ code: 'MAP_INVALID' });
  });
});

describe('size limits', () => {
  test('files over 20 MB are refused', async () => {
    const abs = join(project.dir, 'huge.tmj');
    await writeFile(abs, Buffer.alloc(MAX_MAP_FILE_BYTES + 1, 0x20));
    await expect(readMap(abs)).rejects.toMatchObject({ code: 'MAP_FILE_TOO_LARGE' });
  });

  test('a write that would pass 20 MB is refused before anything reaches the disk', async () => {
    const abs = join(project.dir, 'office.tmj');
    const before = await readFile(abs);
    const { map, sha256 } = await readMap(abs);
    setProperty(map, 'padding', 'string', 'x'.repeat(MAX_MAP_FILE_BYTES));
    await expect(writeMap(abs, map, { projectDir: project.dir, expectedSha256: sha256 })).rejects.toMatchObject({ code: 'MAP_FILE_TOO_LARGE' });
    expect(await readFile(abs)).toEqual(before);
    expect((await readdir(project.dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  test('declared map sizes over the cap are refused', async () => {
    const abs = join(project.dir, 'wide.tmj');
    await writeFile(abs, JSON.stringify({ ...createEmptyMap(100_000, 100_000) }));
    await expect(readMap(abs)).rejects.toMatchObject({ code: 'MAP_TOO_LARGE' });
  });

  test('data arrays that cannot be written inline are left to JSON.stringify', () => {
    const map = createEmptyMap(2, 1);
    map.layers.push({ id: 1, name: 'odd', type: 'tilelayer', width: 1.5, height: 1, data: [1, 2] });
    map.layers.push({ id: 2, name: 'nan', type: 'tilelayer', width: 2, height: 1, data: [Number.NaN, 1] });
    expect(() => JSON.parse(serializeMap(map))).not.toThrow();
  });

  test('tile data is written inline, one row per line, so files stay Tiled-sized', async () => {
    const abs = join(project.dir, 'office.tmj');
    const originalLines = (await readFile(abs, 'utf8')).split('\n').length;
    const { map, sha256 } = await readMap(abs);
    await writeMap(abs, map, { projectDir: project.dir, expectedSha256: sha256 });
    const lines = (await readFile(abs, 'utf8')).split('\n').length;
    expect(lines).toBeLessThan(originalLines * 1.5);

    const big = createEmptyMap(500, 500);
    ensureStandardLayers(big);
    expect(serializeMap(big).length).toBeLessThan(MAX_MAP_FILE_BYTES / 2);
  });
});

describe('cross-process lock', () => {
  test('a lock held by a live process makes the write wait', async () => {
    const abs = join(project.dir, 'office.tmj');
    const lock = lockPathFor(abs);
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    onTestFinished(() => {
      holder.kill();
    });
    await writeFile(lock, JSON.stringify({ pid: holder.pid, host: hostname(), token: 'other', at: Date.now() }));
    let done = false;
    const pending = withMapLock(abs, async () => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(done).toBe(false);
    await rm(lock);
    await pending;
    expect(done).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  test('a lock left by a dead process is taken over', async () => {
    const abs = join(project.dir, 'office.tmj');
    const child = spawn(process.execPath, ['-e', '']);
    await new Promise((r) => child.on('exit', r));
    await writeFile(lockPathFor(abs), JSON.stringify({ pid: child.pid, host: hostname(), token: 'dead', at: Date.now() }));
    await expect(withMapLock(abs, async () => 'ran')).resolves.toBe('ran');
    expect(existsSync(lockPathFor(abs))).toBe(false);
  });

  test('a lock left by this process under an unknown token is stale (pid reuse after a restart)', async () => {
    const abs = join(project.dir, 'office.tmj');
    await writeFile(lockPathFor(abs), JSON.stringify({ pid: process.pid, host: hostname(), token: 'previous-run', at: Date.now() }));
    await expect(withMapLock(abs, async () => 'ran')).resolves.toBe('ran');
  });

  test('a same-host lock older than 10 minutes is stale even if its pid is alive', async () => {
    const abs = join(project.dir, 'office.tmj');
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    onTestFinished(() => {
      holder.kill();
    });
    const at = Date.now() - 11 * 60_000;
    await writeFile(lockPathFor(abs), JSON.stringify({ pid: holder.pid, host: hostname(), token: 'old', at }));
    await expect(withMapLock(abs, async () => 'ran')).resolves.toBe('ran');
  });

  test('a failed task releases the lock for the next one', async () => {
    const abs = join(project.dir, 'office.tmj');
    await expect(withMapLock(abs, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(withMapLock(abs, async () => 'next')).resolves.toBe('next');
  });
});

test('new maps carry Tiled 1.12 version fields', () => {
  const map = createEmptyMap(10, 8);
  expect(map).toMatchObject({ type: 'map', version: '1.11', tiledversion: '1.12.2', infinite: false, width: 10, height: 8 });
});
