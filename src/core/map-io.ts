import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import * as z from 'zod';
import { TiledMapSchema, type TiledMap } from '../schemas/tiled.schema.js';
import { WaEngineError } from './errors.js';
import { MAX_MAP_DIMENSION } from './limits.js';
import { isInside, realpathAllowMissing } from './project-paths.js';

export const MAX_MAP_FILE_BYTES = 20 * 1024 * 1024;
// Tiled 1.12.2 writes JSON format version "1.11" (its FileFormat::versionString for "latest").
export const NEW_MAP_VERSION = '1.11';
export const NEW_MAP_TILED_VERSION = '1.12.2';

const MAX_REPORTED_ISSUES = 20;
const READ_CHUNK = 1024 * 1024;

export interface ReadMapResult {
  map: TiledMap;
  sha256: string;
}

export interface WriteMapOptions {
  // The project the map belongs to; the write target is re-checked against it.
  projectDir: string;
  // sha256 of the file as it was read, or null when the file must not exist yet.
  expectedSha256: string | null;
}

export const sha256Hex = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

const errnoOf = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;

// JSON with 1-space indentation and tile `data` arrays written inline, one map row per
// line as Tiled does, so files stay close to Tiled's own size and diff well.
export function serializeMap(map: TiledMap): string {
  const arrays: { values: number[]; width: number }[] = [];
  const token = `@@wa-agent-engine-data-${randomBytes(4).toString('hex')}-`;
  const text = JSON.stringify(
    map,
    function (this: Record<string, unknown>, key: string, value: unknown) {
      if (
        key === 'data' &&
        Array.isArray(value) &&
        Number.isInteger(this.width) &&
        (this.width as number) > 0 &&
        value.every((v) => typeof v === 'number' && Number.isFinite(v))
      ) {
        arrays.push({ values: value as number[], width: this.width as number });
        return `${token}${arrays.length - 1}@@`;
      }
      return value;
    },
    1,
  );
  return text.replace(new RegExp(`"${token}(\\d+)@@"`, 'g'), (_match, index: string) => {
    const { values, width } = arrays[Number(index)]!;
    const rows: string[] = [];
    for (let i = 0; i < values.length; i += width) rows.push(values.slice(i, i + width).join(', '));
    return `[${rows.join(',\n  ')}]`;
  });
}

export interface BoundedReadErrors {
  open: (errno: string | undefined) => WaEngineError;
  notFile: () => WaEngineError;
  tooLarge: () => WaEngineError;
}

// Reads a regular file of at most `limit` bytes. It is opened non-blocking, so a FIFO or
// device put in its place is refused instead of hanging the read.
export async function readFileBounded(abs: string, limit: number, errors: BoundedReadErrors): Promise<Buffer> {
  let handle;
  try {
    handle = await open(abs, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (err) {
    throw errors.open(errnoOf(err));
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw errors.notFile();
    if (info.size > limit) throw errors.tooLarge();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      // Sized from the stat so a small file needs no large buffer; past it, read in chunks.
      const want = total < info.size ? Math.min(READ_CHUNK, info.size - total + 1) : 64 * 1024;
      const chunk = Buffer.alloc(want);
      const { bytesRead } = await handle.read(chunk, 0, want, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      // The file can grow after the size check, so the cap also holds while reading.
      if (total > limit) throw errors.tooLarge();
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

function readBounded(abs: string): Promise<Buffer> {
  return readFileBounded(abs, MAX_MAP_FILE_BYTES, {
    open: (errno) =>
      errno === 'ENOENT'
        ? new WaEngineError('MAP_NOT_FOUND', `map not found: ${basename(abs)}`)
        : new WaEngineError('INVALID_INPUT', `map cannot be opened (${errno ?? 'error'}): ${basename(abs)}`),
    notFile: () => new WaEngineError('MAP_NOT_FOUND', `map path is not a file: ${basename(abs)}`),
    tooLarge: () => new WaEngineError('MAP_FILE_TOO_LARGE', `map file is larger than ${MAX_MAP_FILE_BYTES / 1024 / 1024} MB`),
  });
}

export async function readMap(abs: string): Promise<ReadMapResult> {
  const bytes = await readBounded(abs);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    // V8's JSON.parse message quotes file content, so it is never surfaced.
    throw new WaEngineError('MAP_PARSE_ERROR', `map is not valid JSON: ${basename(abs)}`);
  }
  const parsed = TiledMapSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, MAX_REPORTED_ISSUES);
    throw new WaEngineError(
      'MAP_INVALID',
      `not a Tiled JSON map: ${basename(abs)}\n${z.prettifyError(new z.ZodError(issues))}`,
      {
        issues: issues.map((i) => ({ path: i.path, message: i.message })),
        truncated: parsed.error.issues.length > issues.length,
      },
    );
  }
  const map = raw as TiledMap;
  if (map.width > MAX_MAP_DIMENSION || map.height > MAX_MAP_DIMENSION) {
    throw new WaEngineError('MAP_TOO_LARGE', `maps larger than ${MAX_MAP_DIMENSION}x${MAX_MAP_DIMENSION} tiles are not supported`, {
      width: map.width,
      height: map.height,
    });
  }
  // The original object, not zod's output, so key order and unknown fields survive.
  return { map, sha256: sha256Hex(bytes) };
}

async function readIfExists(abs: string): Promise<Buffer | undefined> {
  try {
    return await readFile(abs);
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return undefined;
    throw new WaEngineError('INVALID_INPUT', `map cannot be read (${errnoOf(err) ?? 'error'}): ${basename(abs)}`);
  }
}

export function tempPathFor(target: string): string {
  return join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
}

function outsideProject(abs: string): WaEngineError {
  return new WaEngineError('PATH_OUTSIDE_PROJECT', `write target resolves outside the project: ${basename(abs)}`);
}

function changedOnDisk(target: string): WaEngineError {
  return new WaEngineError('MAP_CHANGED_ON_DISK', `map already exists: ${basename(target)}; read it first`);
}

// Filesystem errors become coded errors that name only the file, never an absolute path.
function ioError(err: unknown, abs: string, action: string): WaEngineError {
  if (err instanceof WaEngineError) return err;
  return new WaEngineError('IO_ERROR', `cannot ${action} ${basename(abs)} (${errnoOf(err) ?? 'error'})`, {
    errno: errnoOf(err),
  });
}

async function writeTemp(tmp: string, text: string, mode: number | undefined): Promise<void> {
  const handle = await open(tmp, 'wx');
  try {
    await handle.writeFile(text);
    if (mode !== undefined) await handle.chmod(mode);
    await handle.sync();
  } catch (err) {
    await handle.close();
    await rm(tmp, { force: true });
    throw err;
  }
  await handle.close();
}

// Errors from link() on filesystems without hard links (FAT/exFAT, some network mounts).
const NO_HARD_LINKS = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS', 'EXDEV', 'EMLINK']);

// Creates the target only if it does not exist yet, so a concurrent create fails instead of
// being overwritten.
async function createExclusive(target: string, text: string): Promise<void> {
  const tmp = tempPathFor(target);
  await writeTemp(tmp, text, undefined);
  try {
    await link(tmp, target);
  } catch (err) {
    if (errnoOf(err) === 'EEXIST') throw changedOnDisk(target);
    if (!NO_HARD_LINKS.has(errnoOf(err) ?? '')) throw err;
    let handle;
    try {
      handle = await open(target, 'wx');
    } catch (openErr) {
      if (errnoOf(openErr) === 'EEXIST') throw changedOnDisk(target);
      throw openErr;
    }
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } finally {
    await rm(tmp, { force: true });
  }
}

// Identifies one version of a file: another program saving it replaces or rewrites it,
// which changes at least one of these.
async function fileStamp(abs: string): Promise<string | undefined> {
  try {
    const s = await stat(abs, { bigint: true });
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return undefined;
    throw err;
  }
}

// `unchanged` checks the content and returns the stamp taken before reading it. The stamp is
// compared again right before the rename, so only a save that lands between that stat and the
// rename itself (microseconds) can still be lost; POSIX has no compare-and-swap rename.
async function replaceAtomic(
  target: string,
  text: string,
  unchanged: () => Promise<string | undefined>,
  changed: (exists: boolean) => WaEngineError,
): Promise<void> {
  let mode: number;
  try {
    mode = (await stat(target)).mode & 0o777;
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') throw changed(false);
    throw err;
  }
  const tmp = tempPathFor(target);
  await writeTemp(tmp, text, mode);
  try {
    const stamp = await unchanged();
    const now = await fileStamp(target);
    if (now !== stamp) throw changed(now !== undefined);
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

// Writes atomically, and only if the file on disk is still the version the caller read.
// A rename alone would silently lose a concurrent edit (another agent call or a Tiled save).
export async function writeMap(abs: string, map: TiledMap, options: WriteMapOptions): Promise<string> {
  try {
    const root = await realpath(options.projectDir);
    const dir = await realpathAllowMissing(dirname(abs));
    if (!isInside(root, dir)) throw outsideProject(abs);
    // Re-resolve after the guard ran: a symlink swapped in since then must not redirect the write.
    const target = await realpathAllowMissing(join(dir, basename(abs)));
    if (!isInside(root, target)) throw outsideProject(abs);
    await mkdir(dirname(target), { recursive: true });

    const text = serializeMap(map);
    if (Buffer.byteLength(text) > MAX_MAP_FILE_BYTES) {
      throw new WaEngineError('MAP_FILE_TOO_LARGE', `the map would grow past ${MAX_MAP_FILE_BYTES / 1024 / 1024} MB, which the engine could not read back`);
    }
    const changed = (exists: boolean): WaEngineError =>
      new WaEngineError(
        'MAP_CHANGED_ON_DISK',
        options.expectedSha256 === null
          ? `map already exists: ${basename(target)}; read it first`
          : !exists
            ? `map was deleted after it was read: ${basename(target)}; read it again`
            : `map changed on disk after it was read: ${basename(target)}; read it again and retry`,
      );
    // Checked as late as possible: just before the rename, after the new file is on disk.
    const unchanged = async (): Promise<string | undefined> => {
      const stamp = await fileStamp(target);
      const current = await readIfExists(target);
      const currentSha = current === undefined ? null : sha256Hex(current);
      if (currentSha !== options.expectedSha256) throw changed(current !== undefined);
      return stamp;
    };
    if (options.expectedSha256 === null) {
      await unchanged();
      await createExclusive(target, text);
    } else {
      await replaceAtomic(target, text, unchanged, changed);
    }
    return sha256Hex(text);
  } catch (err) {
    throw ioError(err, abs, 'write map');
  }
}

// ---- locking ----

const LOCK_TIMEOUT_MS = 15_000;
// A lock whose owner cannot be checked (another host) expires after this long. Engine
// writes take milliseconds, so a lock this old was abandoned.
const LOCK_STALE_MS = 60_000;
// Same-host locks also expire, in case the owner's pid was reused after a crash (for example
// a container restart that hands the new server the same pid).
const LOCK_MAX_AGE_MS = 10 * 60_000;
// A break marker older than this was left by a process that crashed while breaking a lock.
const BREAK_STALE_MS = 10_000;

interface LockInfo {
  pid: number;
  host: string;
  token: string;
  at: number;
}

// Tokens of the locks this process holds right now.
const heldTokens = new Set<string>();

export function lockPathFor(target: string): string {
  return join(dirname(target), `.${basename(target)}.lock`);
}

async function readLock(lockPath: string): Promise<LockInfo | undefined> {
  try {
    const info = JSON.parse(await readFile(lockPath, 'utf8')) as Partial<LockInfo>;
    return typeof info.pid === 'number' && typeof info.token === 'string' && typeof info.at === 'number'
      ? (info as LockInfo)
      : undefined;
  } catch {
    return undefined;
  }
}

// What identifies one particular lock file: its token, or its mtime if it is unreadable.
async function lockIdentity(lockPath: string): Promise<string | undefined> {
  const info = await readLock(lockPath);
  if (info !== undefined) return `token:${info.token}`;
  try {
    return `mtime:${(await stat(lockPath)).mtimeMs}`;
  } catch {
    return undefined;
  }
}

function ownerAlive(info: LockInfo): boolean {
  const age = Date.now() - info.at;
  if (info.host !== hostname()) return age < LOCK_STALE_MS;
  if (info.pid === process.pid) return heldTokens.has(info.token);
  if (age > LOCK_MAX_AGE_MS) return false;
  try {
    process.kill(info.pid, 0);
    return true;
  } catch (err) {
    return errnoOf(err) === 'EPERM';
  }
}

async function isStale(lockPath: string): Promise<boolean> {
  const info = await readLock(lockPath);
  if (info !== undefined) return !ownerAlive(info);
  // Unreadable or half-written lock: judge by age.
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

// Deletes a stale lock, letting only one process break it at a time, and only if the lock is
// still the same file that was judged stale.
async function breakStaleLock(lockPath: string, identity: string | undefined): Promise<void> {
  const breakPath = `${lockPath}.break`;
  try {
    await (await open(breakPath, 'wx')).close();
  } catch (err) {
    if (errnoOf(err) !== 'EEXIST') throw err;
    try {
      if (Date.now() - (await stat(breakPath)).mtimeMs > BREAK_STALE_MS) await rm(breakPath, { force: true });
    } catch {
      // The other breaker finished meanwhile.
    }
    return;
  }
  try {
    if ((await lockIdentity(lockPath)) === identity) await rm(lockPath, { force: true });
  } finally {
    await rm(breakPath, { force: true });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Cross-process lock: a `.<map>.lock` file created exclusively next to the map, so separate
// MCP servers, CLI runs, and agents serialise their writes to one map.
async function acquireFileLock(target: string): Promise<() => Promise<void>> {
  const lockPath = lockPathFor(target);
  const info: LockInfo = { pid: process.pid, host: hostname(), token: randomBytes(8).toString('hex'), at: Date.now() };
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let delay = 5;
  await mkdir(dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(JSON.stringify(info));
      } finally {
        await handle.close();
      }
      heldTokens.add(info.token);
      return async () => {
        heldTokens.delete(info.token);
        if ((await readLock(lockPath))?.token === info.token) await rm(lockPath, { force: true });
      };
    } catch (err) {
      if (errnoOf(err) !== 'EEXIST') throw err;
    }
    const identity = await lockIdentity(lockPath);
    if (await isStale(lockPath)) {
      await breakStaleLock(lockPath, identity);
      continue;
    }
    if (Date.now() > deadline) {
      const holder = await readLock(lockPath);
      throw new WaEngineError('MAP_LOCKED', `map is locked by another process: ${basename(target)}; retry shortly`, {
        lock: basename(lockPath),
        ...(holder === undefined ? {} : { holderPid: holder.pid, ageSeconds: Math.round((Date.now() - holder.at) / 1000) }),
      });
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 200);
  }
}

const locks = new Map<string, Promise<unknown>>();

// Serialises every read-modify-write of one map: queued in-process, then guarded across
// processes by the lock file. Not reentrant: never call a locked operation on the same map
// from inside fn.
export async function withMapLock<T>(abs: string, fn: () => Promise<T>): Promise<T> {
  const key = await realpathAllowMissing(abs).catch((err: unknown) => {
    throw ioError(err, abs, 'lock map');
  });
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(async () => {
    const release = await acquireFileLock(key).catch((err: unknown) => {
      throw ioError(err, abs, 'lock map');
    });
    try {
      return await fn();
    } finally {
      await release();
    }
  });
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, settled);
  try {
    return await run;
  } finally {
    if (locks.get(key) === settled) locks.delete(key);
  }
}

// A new finite orthogonal map in Tiled's own (alphabetical) key order.
export function createEmptyMap(width: number, height: number): TiledMap {
  return {
    compressionlevel: -1,
    height,
    infinite: false,
    layers: [],
    nextlayerid: 1,
    nextobjectid: 1,
    orientation: 'orthogonal',
    renderorder: 'right-down',
    tiledversion: NEW_MAP_TILED_VERSION,
    tileheight: 32,
    tilesets: [],
    tilewidth: 32,
    type: 'map',
    version: NEW_MAP_VERSION,
    width,
  };
}
