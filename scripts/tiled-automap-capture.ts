// Records Tiled's own automapping output for every deterministic fixture under
// test/fixtures/automap/ as expected.tmj, so the engine is tested against real Tiled behaviour,
// and for the proving set's goldens under test/fixtures/automap-office/ (named office/<name>),
// which run in a throwaway project with the starter-kit images (npm run fetch-assets).
//
//   npx tsx scripts/tiled-automap-capture.ts [fixture-name ...]
//
// Tiled cannot automap from its command line (tiled.open() needs the editor), so this starts
// the Tiled app with a temporary startup extension that opens each fixture, runs AutoMap
// (over the fixture's region, when it has one) and exports JSON next to the fixture as
// expected.new.tmj. Only when every output is written and parses are they renamed to
// expected.tmj, and fixture.json records which inputs they were captured from.
//
// Safety: the script refuses to run while Tiled is open (a running Tiled would load the
// extension too); the extension acts only while a trigger file exists and deletes it at once;
// the extension, the trigger and the Tiled process this script started are removed on every
// exit path, Ctrl-C included. Tiled does not quit from a script, so the process is stopped.
// Skips with a message when Tiled is not installed (set TILED to its binary otherwise).

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { copyFile, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeOfficeProject, OFFICE_GOLDENS_DIR, OFFICE_RULES, type OfficeProject } from './gen-office-goldens.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'automap');
const TILED = process.env.TILED ?? '/Applications/Tiled.app/Contents/MacOS/Tiled';
const EXTENSIONS_DIR =
  process.env.TILED_EXTENSIONS_DIR ??
  (process.platform === 'darwin' ? join(homedir(), 'Library', 'Preferences', 'Tiled', 'extensions') : join(homedir(), '.config', 'tiled', 'extensions'));
const EXTENSION = join(EXTENSIONS_DIR, 'wa-agent-engine-automap-capture.js');
const TIMEOUT_MS = 120_000;

interface Meta {
  random: boolean;
  region?: { x: number; y: number; width: number; height: number };
  inputsHash: string;
  capturedInputsHash?: string;
}

interface Job {
  name: string;
  map: string;
  rules: string;
  // Where Tiled writes, and where the output goes once every job succeeded.
  out: string;
  dest: string;
  metaPath: string;
  region?: Meta['region'];
}

function extensionSource(trigger: string, jobs: string, done: string): string {
  return `// Temporary: written by wa-agent-engine scripts/tiled-automap-capture.ts. Safe to delete.
if (File.exists(${JSON.stringify(trigger)})) {
  File.remove(${JSON.stringify(trigger)});
  const jobsFile = new TextFile(${JSON.stringify(jobs)}, TextFile.ReadOnly);
  const jobs = JSON.parse(jobsFile.readAll());
  jobsFile.close();
  for (const job of jobs) {
    try {
      const map = tiled.open(job.map);
      if (job.region) map.autoMap(Qt.rect(job.region.x, job.region.y, job.region.width, job.region.height), job.rules);
      else map.autoMap(job.rules);
      tiled.mapFormat("json").write(map, job.out);
      tiled.close(map);
    } catch (e) {
      const f = new TextFile(job.out + ".error", TextFile.WriteOnly);
      f.write(String(e));
      f.commit();
    }
  }
  const d = new TextFile(${JSON.stringify(done)}, TextFile.WriteOnly);
  d.write("done");
  d.commit();
}
`;
}

let child: ChildProcess | undefined;
let trigger: string | undefined;
// Temporary folders to remove on every exit path.
const temporary: string[] = [];

// Removes the extension and the trigger and stops the Tiled process this script started.
function stopTiled(): void {
  rmSync(EXTENSION, { force: true });
  if (trigger !== undefined) rmSync(trigger, { force: true });
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    const pid = child.pid;
    setTimeout(() => {
      try {
        if (pid !== undefined) process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }, 3000).unref();
  }
}

function removeTemporary(): void {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopTiled();
    removeTemporary();
    process.exit(130);
  });
}

async function jobsFor(only: string[]): Promise<Job[]> {
  const jobs: Job[] = [];
  for (const name of (await readdir(ROOT)).sort()) {
    const metaPath = join(ROOT, name, 'fixture.json');
    if (!existsSync(metaPath) || (only.length > 0 && !only.includes(name))) continue;
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Meta;
    if (meta.random) continue;
    jobs.push({
      name,
      map: join(ROOT, name, 'map.tmj'),
      rules: join(ROOT, name, 'rules.txt'),
      out: join(ROOT, name, 'expected.new.tmj'),
      dest: join(ROOT, name, 'expected.tmj'),
      metaPath,
      ...(meta.region !== undefined ? { region: meta.region } : {}),
    });
  }
  return jobs;
}

// The proving set's goldens run in a project with its images; Tiled writes there, so the image
// paths in its output stay relative to a project root.
async function officeJobsFor(only: string[], project: OfficeProject): Promise<Job[]> {
  const jobs: Job[] = [];
  for (const dir of (await readdir(OFFICE_GOLDENS_DIR).catch(() => [] as string[])).sort()) {
    const name = `office/${dir}`;
    const metaPath = join(OFFICE_GOLDENS_DIR, dir, 'fixture.json');
    if (!existsSync(metaPath) || (only.length > 0 && !only.includes(name))) continue;
    const map = join(project.dir, `${dir}.tmj`);
    await copyFile(join(OFFICE_GOLDENS_DIR, dir, 'map.tmj'), map);
    jobs.push({ name, map, rules: join(project.dir, OFFICE_RULES), out: join(project.dir, `${dir}.expected.tmj`), dest: join(OFFICE_GOLDENS_DIR, dir, 'expected.tmj'), metaPath });
  }
  return jobs;
}

async function main(): Promise<void> {
  if (!existsSync(TILED)) {
    console.log(`skipped: Tiled not found at ${TILED} (set TILED to the Tiled binary)`);
    return;
  }
  const versionRun = spawnSync(TILED, ['--version'], { encoding: 'utf8' });
  const version = (versionRun.stdout ?? '').trim();
  if (versionRun.error !== undefined || !/^Tiled 1\.12\./.test(version)) throw new Error(`expected Tiled 1.12.x at ${TILED}, found "${version || String(versionRun.error)}"`);
  if (spawnSync('pgrep', ['-x', 'Tiled']).status === 0) throw new Error('Tiled is running: close it first, it would run the capture too');

  const only = process.argv.slice(2);
  const jobs = await jobsFor(only);
  // The proving set's goldens need the starter-kit images: only set up when they are wanted.
  if (only.length === 0 || only.some((n) => n.startsWith('office/'))) {
    const office = await makeOfficeProject();
    temporary.push(office.dir);
    jobs.push(...(await officeJobsFor(only, office)));
  }
  try {
    await capture(version, jobs);
  } finally {
    removeTemporary();
  }
}

async function capture(version: string, jobs: Job[]): Promise<void> {
  let work: string | undefined;
  try {
    work = await mkdtemp(join(tmpdir(), 'wa-automap-capture-'));
    temporary.push(work);
    trigger = join(work, 'trigger');
    const jobsPath = join(work, 'jobs.json');
    const done = join(work, 'done');
    for (const job of jobs) await rm(job.out, { force: true });
    await writeFile(jobsPath, JSON.stringify(jobs));
    await writeFile(trigger, 'capture');
    await mkdir(EXTENSIONS_DIR, { recursive: true });
    await writeFile(EXTENSION, extensionSource(trigger, jobsPath, done));
    const started = spawn(TILED, [], { stdio: 'ignore' });
    child = started;
    const launchError = new Promise<never>((_, reject) => started.on('error', reject));
    const finished = (async () => {
      const begin = Date.now();
      while (!existsSync(done)) {
        if (Date.now() - begin > TIMEOUT_MS) throw new Error('Tiled did not finish the capture in time');
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
    await Promise.race([finished, launchError]);
  } finally {
    stopTiled();
    if (work !== undefined) await rm(work, { recursive: true, force: true });
  }

  const failures: string[] = [];
  for (const job of jobs) {
    if (existsSync(`${job.out}.error`)) {
      failures.push(`${job.name}: ${await readFile(`${job.out}.error`, 'utf8')}`);
      await rm(`${job.out}.error`, { force: true });
      continue;
    }
    try {
      JSON.parse(await readFile(job.out, 'utf8'));
    } catch {
      failures.push(`${job.name}: no readable output`);
    }
  }
  if (failures.length > 0) {
    for (const job of jobs) await rm(job.out, { force: true });
    for (const f of failures) console.log(`failed ${f}`);
    console.log(`${version}: nothing replaced (${failures.length} of ${jobs.length} fixtures failed)`);
    process.exitCode = 1;
    return;
  }
  for (const job of jobs) {
    await copyFile(job.out, job.dest);
    await rm(job.out, { force: true });
    const meta = JSON.parse(await readFile(job.metaPath, 'utf8')) as Meta;
    meta.capturedInputsHash = meta.inputsHash;
    await writeFile(job.metaPath, `${JSON.stringify(meta, null, 1)}\n`);
  }
  console.log(`${version}: captured ${jobs.length} of ${jobs.length} fixtures`);
}

await main();
