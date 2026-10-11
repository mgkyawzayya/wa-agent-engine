// Opens a map in Tiled and writes it back with Tiled's own JSON writer, then compares the two
// semantically: the check that maps the engine writes are maps Tiled reads and writes the same
// way. Prints "skipped" when Tiled is not installed.
//
// Usage: npx tsx scripts/tiled-roundtrip.ts <map.tmj>   (TILED=<path> to use another binary)
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { TiledMap } from '../src/schemas/tiled.schema.js';
import { meaningDifferences } from './lib/tiled-meaning.js';

const TILED = process.env['TILED'] ?? '/Applications/Tiled.app/Contents/MacOS/Tiled';

async function main(): Promise<number> {
  const input = process.argv[2];
  if (input === undefined) {
    console.error('usage: npx tsx scripts/tiled-roundtrip.ts <map.tmj>');
    return 2;
  }
  if (!existsSync(TILED)) {
    console.log(`skipped: Tiled is not installed at ${TILED} (set TILED to its binary)`);
    return 0;
  }
  const formats = execFileSync(TILED, ['--export-formats'], { encoding: 'utf8' });
  if (!/\bjson\b/i.test(formats)) {
    console.error(`this Tiled build has no JSON map export:\n${formats}`);
    return 1;
  }
  const source = resolve(input);
  // The copy sits next to the original, so Tiled keeps relative tileset image paths as they are.
  const target = join(dirname(source), `.${basename(source, '.tmj')}.${randomBytes(4).toString('hex')}.roundtrip.tmj`);
  try {
    execFileSync(TILED, ['--export-map', 'json', source, target], { stdio: 'inherit' });
    const differences = meaningDifferences(
      JSON.parse(await readFile(source, 'utf8')) as TiledMap,
      JSON.parse(await readFile(target, 'utf8')) as TiledMap,
    );
    if (differences.length > 0) {
      console.error(`Tiled changed ${differences.length} part(s) of the map:\n${differences.map((k) => `  ${k}`).join('\n')}`);
      return 1;
    }
    console.log(`ok: Tiled read and wrote ${input} with the same meaning`);
    return 0;
  } finally {
    await rm(target, { force: true });
  }
}

process.exitCode = await main();
