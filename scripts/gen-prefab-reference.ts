// Writes the wa-map-design skill's prefab catalog from the built-in asset set's set.json, so the
// catalog an agent reads always matches the prefabs and styles the engine really has.
//
//   npx tsx scripts/gen-prefab-reference.ts            write the catalog
//   npx tsx scripts/gen-prefab-reference.ts --check    exit 1 when the catalog on disk is stale
//   --file <path> writes or checks another file instead (tests use it).
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as z from 'zod';
import { BUILTIN_SETS_DIR } from '../src/core/asset-set-registry.js';
import { DEFAULT_ASSET_SET } from '../src/core/zones.js';
import { AssetSetSchema, type AssetSet } from '../src/schemas/asset-set.schema.js';
import { PREFAB_CATEGORIES, type PrefabCategory } from '../src/schemas/prefab.schema.js';

export const SET_JSON_PATH = join(BUILTIN_SETS_DIR, DEFAULT_ASSET_SET, 'set.json');
// Where the catalog lives inside a skills folder.
export const CATALOG_IN_SKILLS = join('wa-map-design', 'references', 'prefab-catalog.md');
export const CATALOG_PATH = join(fileURLToPath(new URL('../skills/', import.meta.url)), CATALOG_IN_SKILLS);
export const REGENERATE_COMMAND = 'npx tsx scripts/gen-prefab-reference.ts';

const CATEGORY_TITLES: Record<PrefabCategory, string> = {
  talks: 'Talks: stages, seating, screens',
  work: 'Work: desks and tables',
  social: 'Social: lounges, food, plants',
  logistics: 'Logistics: registration, sponsors, signs',
  fun: 'Fun: games and decoration',
  phone: 'Phone: call nooks',
  outdoor: 'Outdoor: trees, bushes, rocks, flowers, fountains',
};

const FACE_ROW_TEXT = {
  upper: 'north wall, upper face row (y = wall row + 1)',
  lower: 'north wall, lower face row (y = wall row + 2)',
  either: 'north wall, either face row (y = wall row + 1 or + 2)',
} as const;

const cell = (text: string): string => text.replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();

export async function readSet(path: string = SET_JSON_PATH): Promise<AssetSet> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = AssetSetSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${path} is not a valid set.json:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function renderCatalog(set: AssetSet): string {
  const lines: string[] = [
    `# Prefab catalog: ${set.id}`,
    '',
    `<!-- Generated from the built-in asset set's set.json by scripts/gen-prefab-reference.ts. Do not edit by hand; run \`${REGENERATE_COMMAND}\`. -->`,
    '',
    `The built-in asset set \`${set.id}\` (${set.title}) has ${set.prefabs.length} prefabs. Use their ids in the room DSL ` +
      '(`rooms[].furniture[].prefabId`) or with `place_prefab`. No other furniture exists: there is no sponsor-logo art, for example.',
    '',
    'How to place them:',
    '',
    "- A position is the map tile of the prefab's top-left cell. Size is width × height in tiles.",
    '- A free prefab needs its whole rectangle on floor, below the two wall-face rows, and clear of walls, other furniture and collisions. ' +
      'Prefab rectangles may not overlap, even where they look empty.',
    '- A north-wall prefab hangs on the wall-face rows under an unbroken stretch of north wall, never under a door or a corner. ' +
      "The wall row is the row of that wall: for a room's own north wall it is the room's `bounds.y`. " +
      'Rows of the prefab below the face rows need floor, like a free prefab.',
    '- Keep the cells in front of every door free, or the build fails with `DOOR_UNREACHABLE`.',
    '',
  ];
  for (const category of PREFAB_CATEGORIES) {
    const prefabs = set.prefabs.filter((p) => p.category === category);
    if (prefabs.length === 0) continue;
    lines.push(`## ${CATEGORY_TITLES[category]}`, '', '| Prefab | Size | Placement | What it is | Licence |', '|---|---|---|---|---|');
    for (const p of prefabs) {
      const placement = p.placement === 'north-wall' && p.faceRow !== undefined ? FACE_ROW_TEXT[p.faceRow] : p.placement;
      lines.push(`| \`${p.id}\` | ${p.width}×${p.height} | ${placement} | ${cell(p.use)} | ${p.license === undefined ? '-' : cell(p.license)} |`);
    }
    lines.push('');
  }
  const exterior = set.faceRules.exteriorStyle;
  const wallStyles = set.wallStyles.names.map((n) => (n === set.wallStyles.default ? `\`${n}\` (default)` : `\`${n}\``));
  const floorStyles = Object.entries(set.floorStyles.styles).map(([name, ref]) =>
    `| \`${name}\`${name === set.floorStyles.default ? ' (default)' : ''} | ${ref.tileset} tile ${ref.tile} |`,
  );
  lines.push(
    '## Wall and floor styles',
    '',
    `- \`wallStyle\` of a room: ${wallStyles.join(', ')}. It sets the wall faces inside the room.`,
    `- Wall faces outside every room use the \`${exterior}\` style, unless a face is already there. \`${exterior}\` cannot be chosen as a room's \`wallStyle\`.`,
    '- `floorStyle` of a room, and the `ground` and path `style` of a world:',
    '',
    '| Floor style | Tile |',
    '|---|---|',
    ...floorStyles,
    '',
    ...(set.water === undefined
      ? ['- No water tiles: this set cannot draw `water`.']
      : [
          `- \`water\` draws ${set.water.tile.tileset} tile ${set.water.tile.tile}, which blocks walking. A path that crosses it becomes a bridge: ${set.water.bridge.horizontal.tileset} tile ${set.water.bridge.horizontal.tile} where the path runs east-west, ${set.water.bridge.vertical.tileset} tile ${set.water.bridge.vertical.tile} where it runs north-south.`,
        ]),
    '',
    '## Licences',
    '',
    "The licence column covers the furniture arrangement. The CC-BY-SA-3.0 arrangements are adapted from the WorkAdventure map-starter-kit's " +
      "`office.tmj` or `conference.tmj`. The set's `mapCopyright`, which `scaffold_map` writes into every new map, credits them: keep it. " +
      'A dash means the arrangement is not adapted from a starter-kit map.',
    '',
    "The tiles themselves stay the starter kit's, under the licence in each tileset's `tilesetCopyright`. The engine reads the tileset " +
      "images from the user's project and never ships or copies them.",
    '',
  );
  return lines.join('\n');
}

// A message when the catalog file differs from what the set would generate, else undefined.
export async function staleCatalogProblem(file: string, setJsonPath: string = SET_JSON_PATH): Promise<string | undefined> {
  const expected = renderCatalog(await readSet(setJsonPath));
  let actual: string;
  try {
    actual = await readFile(file, 'utf8');
  } catch {
    return `the prefab catalog is missing; run ${REGENERATE_COMMAND}`;
  }
  return actual === expected ? undefined : `the prefab catalog is stale (set.json changed or the file was edited by hand); run ${REGENERATE_COMMAND}`;
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: { check: { type: 'boolean' }, file: { type: 'string' } }, strict: true, allowPositionals: false });
    const file = values.file ?? CATALOG_PATH;
    if (values.check === true) {
      const problem = await staleCatalogProblem(file);
      if (problem !== undefined) {
        console.error(`${file}: ${problem}`);
        process.exitCode = 1;
      }
    } else {
      await writeFile(file, renderCatalog(await readSet()));
      console.log(`wrote ${file}`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
