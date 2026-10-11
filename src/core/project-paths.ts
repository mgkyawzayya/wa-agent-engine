import { lstat, readlink, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { WaEngineError } from './errors.js';

// The single guard for every file path the engine touches, including paths read from
// inside maps (tileset images, audio files, external tilesets).

const MAX_LINK_DEPTH = 40;

export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function looksAbsolute(p: string): boolean {
  return isAbsolute(p) || p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p);
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

const errnoOf = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;

// Real path of p even when p (or some ancestor) does not exist yet, as for a new map or
// preview. Dangling symlinks are followed to where they point, so a link to a missing file
// outside the project cannot be approved and then written through.
export async function realpathAllowMissing(p: string, linkHops = 0): Promise<string> {
  if (linkHops > MAX_LINK_DEPTH) throw Object.assign(new Error('too many symbolic links'), { code: 'ELOOP' });
  try {
    return await realpath(p);
  } catch (err) {
    if (errnoOf(err) !== 'ENOENT') throw err;
  }
  let isLink = false;
  try {
    isLink = (await lstat(p)).isSymbolicLink();
  } catch (err) {
    if (errnoOf(err) !== 'ENOENT') throw err;
  }
  if (isLink) {
    // Resolve the link target from the link's real folder, as the OS does.
    const base = await realpathAllowMissing(dirname(p), linkHops);
    return realpathAllowMissing(resolve(base, await readlink(p)), linkHops + 1);
  }
  const parent = dirname(p);
  if (parent === p) return p;
  return join(await realpathAllowMissing(parent, linkHops), basename(p));
}

// A project is a starter-kit-style map folder: an absolute, existing directory with tilesets/.
export async function assertProjectDir(dir: string): Promise<string> {
  if (typeof dir !== 'string' || !isAbsolute(dir) || dir.includes('\0')) {
    throw new WaEngineError('PROJECT_DIR_INVALID', 'projectDir must be an absolute path to a starter-kit map project');
  }
  if (!(await isDirectory(dir))) {
    throw new WaEngineError('PROJECT_DIR_INVALID', `projectDir does not exist or is not a directory: ${dir}`);
  }
  const real = await realpath(dir);
  if (!(await isDirectory(join(real, 'tilesets')))) {
    throw new WaEngineError('PROJECT_DIR_INVALID', `projectDir has no tilesets/ directory: ${dir}`);
  }
  return real;
}

export interface ResolveOptions {
  ext?: string | readonly string[];
}

async function guard(projectDir: string, abs: string, shown: string, options: ResolveOptions): Promise<string> {
  let root: string;
  let real: string;
  try {
    root = await realpath(projectDir);
    if (!isInside(root, resolve(root, relative(projectDir, abs)))) {
      throw new WaEngineError('PATH_OUTSIDE_PROJECT', `path escapes the project: ${shown}`);
    }
    real = await realpathAllowMissing(abs);
  } catch (err) {
    if (err instanceof WaEngineError) throw err;
    // ENOTDIR, ELOOP and the like: never echo the absolute path or the raw system message.
    throw new WaEngineError('INVALID_INPUT', `path cannot be resolved (${errnoOf(err) ?? 'error'}): ${shown}`);
  }
  if (!isInside(root, real)) {
    throw new WaEngineError('PATH_OUTSIDE_PROJECT', `path resolves outside the project: ${shown}`);
  }
  if (options.ext !== undefined) {
    const allowed = typeof options.ext === 'string' ? [options.ext] : options.ext;
    if (!allowed.includes(extname(real).toLowerCase())) {
      throw new WaEngineError('PATH_BAD_EXTENSION', `expected a ${allowed.join(' or ')} file: ${shown}`);
    }
  }
  return real;
}

function checkInput(rel: string): void {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0')) {
    throw new WaEngineError('INVALID_INPUT', 'expected a non-empty path');
  }
}

// Resolves a project-relative path (as given by an agent) to an absolute real path.
export async function resolveInProject(projectDir: string, rel: string, options: ResolveOptions = {}): Promise<string> {
  checkInput(rel);
  if (looksAbsolute(rel)) {
    throw new WaEngineError('PATH_OUTSIDE_PROJECT', `expected a path relative to the project: ${rel}`);
  }
  return guard(projectDir, resolve(projectDir, rel), rel, options);
}

// Resolves a path stored inside a map (tileset image, audio file, external tileset),
// which Tiled and WA resolve relative to the map file.
export async function resolveMapRelative(
  projectDir: string,
  mapAbs: string,
  rel: string,
  options: ResolveOptions = {},
): Promise<string> {
  checkInput(rel);
  if (looksAbsolute(rel) || /^[a-z][a-z0-9+.-]*:/i.test(rel)) {
    throw new WaEngineError('PATH_OUTSIDE_PROJECT', `expected a path relative to the map: ${rel}`);
  }
  return guard(projectDir, resolve(dirname(mapAbs), rel), rel, options);
}

// Path written into a map so Tiled and WA find the target relative to the map file.
export function mapRelativePath(mapAbs: string, targetAbs: string): string {
  return relative(dirname(mapAbs), targetAbs).split(sep).join('/');
}
