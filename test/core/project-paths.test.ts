import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  assertProjectDir,
  mapRelativePath,
  resolveInProject,
  resolveMapRelative,
} from '../../src/core/project-paths.js';
import { makeProject, type TempProject } from '../helpers/project.js';

let project: TempProject;
let outside: string;

beforeEach(async () => {
  project = await makeProject();
  outside = await realpath(await mkdtemp(join(tmpdir(), 'wa-outside-')));
});
afterEach(async () => {
  await project.cleanup();
  await rm(outside, { recursive: true, force: true });
});

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => undefined,
    (err: { code?: string }) => err.code,
  );

describe('assertProjectDir', () => {
  test('accepts a directory with tilesets/', async () => {
    expect(await assertProjectDir(project.dir)).toBe(project.dir);
  });

  test('rejects relative, missing, and tilesets-less directories', async () => {
    expect(await codeOf(assertProjectDir('relative/dir'))).toBe('PROJECT_DIR_INVALID');
    expect(await codeOf(assertProjectDir(join(project.dir, 'nope')))).toBe('PROJECT_DIR_INVALID');
    expect(await codeOf(assertProjectDir(outside))).toBe('PROJECT_DIR_INVALID');
  });
});

describe('resolveInProject', () => {
  test('resolves a nested path that does not exist yet', async () => {
    expect(await resolveInProject(project.dir, 'maps/lobby.tmj', { ext: '.tmj' })).toBe(
      join(project.dir, 'maps', 'lobby.tmj'),
    );
  });

  test('rejects traversal and absolute paths', async () => {
    expect(await codeOf(resolveInProject(project.dir, '../x.tmj', { ext: '.tmj' }))).toBe('PATH_OUTSIDE_PROJECT');
    expect(await codeOf(resolveInProject(project.dir, 'maps/../../x.tmj'))).toBe('PATH_OUTSIDE_PROJECT');
    expect(await codeOf(resolveInProject(project.dir, join(project.dir, 'a.tmj')))).toBe('PATH_OUTSIDE_PROJECT');
  });

  test('rejects symlinks that escape the project', async () => {
    await writeFile(join(outside, 'secret.tmj'), '{}');
    await symlink(join(outside, 'secret.tmj'), join(project.dir, 'link.tmj'));
    await symlink(outside, join(project.dir, 'linkdir'));
    expect(await codeOf(resolveInProject(project.dir, 'link.tmj', { ext: '.tmj' }))).toBe('PATH_OUTSIDE_PROJECT');
    expect(await codeOf(resolveInProject(project.dir, 'linkdir/new.tmj', { ext: '.tmj' }))).toBe(
      'PATH_OUTSIDE_PROJECT',
    );
  });

  test('rejects a dangling symlink that points outside the project', async () => {
    await symlink(join(outside, 'not-yet.png'), join(project.dir, 'dangling.png'));
    await symlink(join(outside, 'missing-dir', 'x.tmj'), join(project.dir, 'dangling.tmj'));
    expect(await codeOf(resolveInProject(project.dir, 'dangling.png', { ext: '.png' }))).toBe('PATH_OUTSIDE_PROJECT');
    expect(await codeOf(resolveInProject(project.dir, 'dangling.tmj', { ext: '.tmj' }))).toBe('PATH_OUTSIDE_PROJECT');
    expect(
      await codeOf(resolveMapRelative(project.dir, join(project.dir, 'office.tmj'), 'dangling.png', { ext: '.png' })),
    ).toBe('PATH_OUTSIDE_PROJECT');
  });

  test('unresolvable paths get a coded error without the absolute path', async () => {
    await writeFile(join(project.dir, 'file.tmj'), '{}');
    await symlink(join(project.dir, 'loop-b'), join(project.dir, 'loop-a'));
    await symlink(join(project.dir, 'loop-a'), join(project.dir, 'loop-b'));
    for (const rel of ['file.tmj/inner.tmj', 'loop-a/x.tmj', 'bad\0name.tmj', '']) {
      const err = await resolveInProject(project.dir, rel, { ext: '.tmj' }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'INVALID_INPUT' });
      expect((err as Error).message).not.toContain(project.dir);
    }
  });

  test('allows symlinks that stay inside the project', async () => {
    await mkdir(join(project.dir, 'real'));
    await symlink(join(project.dir, 'real'), join(project.dir, 'alias'));
    expect(await resolveInProject(project.dir, 'alias/a.tmj', { ext: '.tmj' })).toBe(join(project.dir, 'real', 'a.tmj'));
  });

  test('enforces the extension', async () => {
    expect(await codeOf(resolveInProject(project.dir, '.env', { ext: '.tmj' }))).toBe('PATH_BAD_EXTENSION');
    expect(await codeOf(resolveInProject(project.dir, 'map.json', { ext: '.tmj' }))).toBe('PATH_BAD_EXTENSION');
    expect(await resolveInProject(project.dir, 'p.PNG', { ext: '.png' })).toBe(join(project.dir, 'p.PNG'));
  });
});

describe('resolveMapRelative', () => {
  test('resolves relative to the map file', async () => {
    const mapAbs = join(project.dir, 'maps', 'lobby.tmj');
    expect(await resolveMapRelative(project.dir, mapAbs, '../tilesets/WA_Room_Builder.png')).toBe(
      join(project.dir, 'tilesets', 'WA_Room_Builder.png'),
    );
    expect(mapRelativePath(mapAbs, join(project.dir, 'tilesets', 'WA_Room_Builder.png'))).toBe(
      '../tilesets/WA_Room_Builder.png',
    );
  });

  test('rejects absolute paths, URLs, and escapes', async () => {
    const mapAbs = join(project.dir, 'office.tmj');
    expect(await codeOf(resolveMapRelative(project.dir, mapAbs, '/etc/passwd'))).toBe('PATH_OUTSIDE_PROJECT');
    expect(await codeOf(resolveMapRelative(project.dir, mapAbs, 'file:///etc/passwd'))).toBe('PATH_OUTSIDE_PROJECT');
    expect(await codeOf(resolveMapRelative(project.dir, mapAbs, '../outside.png'))).toBe('PATH_OUTSIDE_PROJECT');
  });
});
