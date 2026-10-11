import { createHash } from 'node:crypto';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { encodePng } from '../../src/core/png.js';
import { composeMap, loadSheets } from '../../src/core/renderer.js';
import { OFFICE_AUTOMAP_DIR, staleOfficeAutomapFiles } from '../../scripts/gen-office-automap.js';
import { makeFullProject, type TempProject } from '../helpers/project.js';
import { buildFixture, cells, existingArt, readRoomFixture, roomFixtureNames, type Art, type RoomFixture } from '../helpers/room-fixtures.js';

// The proof that asset sets drawn with automapping rules work: office-automap draws the
// built-in set's walls, faces, lintels, collisions and floors with Tiled rules, and building
// every room fixture with it gives the same picture as building it with wa-starter-office (or
// fails with the same error).

const WANG = 'wa-starter-office';
const AUTOMAP = 'office-automap';

let project: TempProject;
beforeAll(async () => {
  project = await makeFullProject();
  await cp(OFFICE_AUTOMAP_DIR, join(project.dir, '.wa-asset-sets', AUTOMAP), { recursive: true });
});
afterAll(() => project.cleanup());

// Builds the fixture with one set and returns the picture's hash, or the error code. Both maps
// get the same art; the rules also find the existing walls on the sketch.
async function build(name: string, fixture: RoomFixture, setId: string, art: Art | undefined): Promise<string> {
  const built = await buildFixture(project.dir, name, fixture, setId, art, { sketchExisting: setId === AUTOMAP });
  if (typeof built === 'string') return built;
  const picture = composeMap(built.map, await loadSheets(project.dir, built.mapAbs, built.map));
  return createHash('sha256').update(encodePng(picture)).digest('hex');
}

describe('office-automap draws the room fixtures like wa-starter-office', async () => {
  for (const name of await roomFixtureNames()) {
    test(name, async () => {
      const fixture = await readRoomFixture(name);
      const art = fixture.existingWalls === undefined ? undefined : await existingArt(project.dir, name, fixture, AUTOMAP);
      // Existing walls come with their faces.
      if (art !== undefined) expect(art.get('walls')!.filter(Boolean).length).toBeGreaterThan(cells(fixture.existingWalls).length);
      const wang = await build(name, fixture, WANG, art);
      const rules = await build(name, fixture, AUTOMAP, art);
      expect(rules).toBe(wang);
    });
  }
});

test('the proving set is what scripts/gen-office-automap.ts writes', async () => {
  expect(await staleOfficeAutomapFiles()).toEqual([]);
});
