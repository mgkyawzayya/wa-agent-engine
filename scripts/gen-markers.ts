// Writes the built-in marker tileset (assets/markers/wa-markers.tsj) from the palette in
// src/core/markers.ts. The package ships the .tsj only; the engine writes the image into a
// project when a map is drawn with automapping rules.
//
//   npx tsx scripts/gen-markers.ts            write the tileset
//   npx tsx scripts/gen-markers.ts --check    exit 1 when the file on disk is stale
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { MARKER_TSJ, markerTsj } from '../src/core/markers.js';

export const markerTsjText = (): string => `${JSON.stringify(markerTsj(), null, 1)}\n`;

if (import.meta.main) {
  const { values } = parseArgs({ options: { check: { type: 'boolean' } }, strict: true, allowPositionals: false });
  const text = markerTsjText();
  if (values.check === true) {
    const current = await readFile(MARKER_TSJ, 'utf8').catch(() => '');
    if (current !== text) {
      console.error(`${MARKER_TSJ} is stale; run: npx tsx scripts/gen-markers.ts`);
      process.exitCode = 1;
    }
  } else {
    await writeFile(MARKER_TSJ, text);
    console.log(`wrote ${MARKER_TSJ}`);
  }
}
