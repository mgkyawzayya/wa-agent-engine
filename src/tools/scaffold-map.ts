import * as z from 'zod';
import { scaffoldMap } from '../core/compiler.js';
import { DEFAULT_ASSET_SET } from '../core/zones.js';
import { attempt, toolOk } from './result.js';
import { assetSetField, mapPathField, projectDirField, tilesField, WarningsField, type ToolEntry } from './tool.js';

const input = z.strictObject({
  projectDir: projectDirField,
  mapPath: mapPathField,
  width: tilesField('Map width in tiles, 1-500'),
  height: tilesField('Map height in tiles, 1-500'),
  assetSet: assetSetField.default(DEFAULT_ASSET_SET),
  spawn: z
    .strictObject({ x: tilesField('Tile column'), y: tilesField('Tile row') })
    .describe(
      'The tile where players arrive; pick a walkable one: inside a room below its wall-face rows, or in a world on a plaza or path; ' +
        'clear of furniture, doors and water',
    ),
  mapName: z.string().exactOptional().describe('Map name WorkAdventure shows, for example "VarCamp 2025"'),
  mapDescription: z.string().exactOptional().describe('One-line description of the map'),
  script: z.string().exactOptional().describe('Map script: a file in the project, relative to the map, or an https URL'),
  overwrite: z.boolean().exactOptional().describe('Replace an existing map file; without it an existing map is never touched'),
});

const output = z.strictObject({
  mapPath: z.string(),
  layers: z.array(z.string()),
  tilesets: z.array(z.string()),
  warnings: WarningsField,
});

export const scaffoldMapTool: ToolEntry<typeof input, typeof output> = {
  name: 'scaffold_map',
  command: 'scaffold',
  title: 'Scaffold a WorkAdventure map',
  description:
    'Create a new, empty WorkAdventure map with the standard layers, bottom to top: start, collisions, floor, walls, the furniture ' +
    'group (furniture1-3), floorLayer, the foreground group (foreground1-2, drawn over avatars) and wa_zones; the asset set ' +
    'tilesets embedded with their copyright; and the spawn tile. Then draw rooms with build_room_from_dsl. Coordinates are tiles ' +
    'of 32 px. Fails with MAP_EXISTS rather than replace a map unless overwrite is true.',
  input,
  output,
  annotations: { openWorldHint: false },
  run: (args) =>
    attempt(async () => {
      const result = await scaffoldMap(args);
      return toolOk({ ...result, warnings: result.warnings.map((w) => w.toJSON()) });
    }),
};
