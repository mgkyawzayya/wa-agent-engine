import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod';
import {
  STARTER_KIT_FILES,
  STARTER_KIT_SHA,
  starterKitCacheDir,
  starterKitRawUrl,
} from '../src/config/starter-kit.js';

const LOCK_PATH = fileURLToPath(new URL('./starter-kit.lock.json', import.meta.url));
const SAFE_PATH = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*\.[a-z]+$/;
const REGENERATE = 'regenerate it with `npm run fetch-assets -- --write-lock`';

const Lock = z.object({
  sha: z.string(),
  files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase SHA-256 hex digest')),
});
type Lock = z.infer<typeof Lock>;

export interface FetchResult {
  cacheDir: string;
  downloaded: string[];
}

export interface FetchOptions {
  writeLock?: boolean;
  cacheDir?: string;
  lockPath?: string;
  log?: (message: string) => void;
}

// A network-level failure (DNS, refused, timeout) aborts the whole run instead of
// waiting out every remaining download's timeout.
class NetworkError extends Error {}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

// Node's happy-eyeballs connect throws an AggregateError with an empty message when every
// address of a host fails (the usual firewall case), so fall back to its codes.
function describe(err: Error): string {
  if (err.message !== '') return err.message;
  if (err instanceof AggregateError) {
    return err.errors.map((e: unknown) => (e as NodeJS.ErrnoException).code ?? String(e)).join(', ');
  }
  return (err as NodeJS.ErrnoException).code ?? err.name;
}

function reasonOf(err: unknown): string {
  if (err instanceof Error && err.cause instanceof Error) return `${err.message}: ${describe(err.cause)}`;
  return err instanceof Error ? describe(err) : String(err);
}

async function readCached(path: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function writeAtomic(path: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, bytes, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') await rm(tmp, { force: true });
    throw err;
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

async function download(path: string): Promise<Uint8Array> {
  const url = starterKitRawUrl(path);
  const unreachable = (err: unknown): NetworkError =>
    new NetworkError(`${path}: cannot reach ${url} (${reasonOf(err)})`, { cause: err });
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    throw unreachable(err);
  }
  if (!res.ok) throw new Error(`${path}: download failed with HTTP ${res.status} (${url})`);
  try {
    return new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    throw unreachable(err);
  }
}

function assertSafePath(path: string): void {
  if (!SAFE_PATH.test(path) || path.split('/').includes('..')) {
    throw new Error(`${path}: unsafe path in starter-kit file list`);
  }
}

// Lists how the lock's file set differs from STARTER_KIT_FILES, so a lock with a dropped
// entry can't report "up to date" while the cache is incomplete.
export function lockDrift(lockFiles: readonly string[], expected: readonly string[]): string[] {
  const have = new Set(lockFiles);
  const want = new Set(expected);
  return [
    ...expected.filter((p) => !have.has(p)).map((p) => `missing ${p}`),
    ...lockFiles.filter((p) => !want.has(p)).map((p) => `unexpected ${p}`),
  ];
}

async function readLock(lockPath: string): Promise<Lock> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`lock file ${lockPath} is missing; ${REGENERATE}`);
    }
    throw new Error(`cannot read lock file ${lockPath} (${reasonOf(err)})`, { cause: err });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`lock file ${lockPath} is not valid JSON (${reasonOf(err)}); ${REGENERATE}`, { cause: err });
  }
  const parsed = Lock.safeParse(json);
  if (!parsed.success) {
    throw new Error(`lock file ${lockPath} is invalid:\n${z.prettifyError(parsed.error)}`);
  }
  const lock = parsed.data;
  if (lock.sha !== STARTER_KIT_SHA) {
    throw new Error(`lock file ${lockPath} pins ${lock.sha}, but the config pins ${STARTER_KIT_SHA}; ${REGENERATE}`);
  }
  const drift = lockDrift(Object.keys(lock.files), STARTER_KIT_FILES);
  if (drift.length > 0) {
    throw new Error(`lock file ${lockPath} does not match STARTER_KIT_FILES (${drift.join(', ')}); ${REGENERATE}`);
  }
  return lock;
}

export async function fetchStarterKit(options: FetchOptions = {}): Promise<FetchResult> {
  const cacheDir = options.cacheDir ?? starterKitCacheDir();
  const lockPath = options.lockPath ?? LOCK_PATH;
  const log = options.log ?? (() => {});
  const downloaded: string[] = [];

  if (options.writeLock === true) {
    const files: Record<string, string> = {};
    for (const path of STARTER_KIT_FILES) {
      assertSafePath(path);
      const bytes = await download(path);
      files[path] = sha256(bytes);
      await writeAtomic(join(cacheDir, path), bytes);
      downloaded.push(path);
      log(`locked ${path}`);
    }
    const lock: Lock = { sha: STARTER_KIT_SHA, files };
    await writeAtomic(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    log(`wrote ${lockPath}`);
    return { cacheDir, downloaded };
  }

  const lock = await readLock(lockPath);
  const failures: string[] = [];
  for (const [path, expected] of Object.entries(lock.files)) {
    try {
      assertSafePath(path);
      const target = join(cacheDir, path);
      const cached = await readCached(target);
      if (cached !== undefined && sha256(cached) === expected) continue;
      const bytes = await download(path);
      const actual = sha256(bytes);
      if (actual !== expected) {
        throw new Error(`${path}: SHA-256 mismatch against ${lockPath} (expected ${expected}, got ${actual})`);
      }
      await writeAtomic(target, bytes);
      downloaded.push(path);
      log(`downloaded ${path}`);
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
      if (err instanceof NetworkError) {
        failures.push('stopped after the first network error');
        break;
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`starter-kit fetch failed at ${STARTER_KIT_SHA}:\n  ${failures.join('\n  ')}`);
  }
  return { cacheDir, downloaded };
}

if (import.meta.main) {
  const writeLock = process.argv.includes('--write-lock');
  try {
    const result = await fetchStarterKit({ writeLock, log: (m) => console.log(m) });
    if (result.downloaded.length === 0) console.log(`starter-kit cache up to date (${result.cacheDir})`);
    else console.log(`cached ${result.downloaded.length} file(s) in ${result.cacheDir}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
