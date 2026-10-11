import * as z from 'zod';
import { automapTemplate, MAX_TEMPLATE_TILESETS } from '../core/automap/automap-template.js';
import { attempt, toolOk } from './result.js';
import { projectDirField, type ToolEntry } from './tool.js';

const input = z.strictObject({
  projectDir: projectDirField,
  assetSet: z
    .string()
    .exactOptional()
    .describe(
      'An asset set whose wall styles and floor styles get rules (and whose markers are kept if it is drawn with rules). ' +
        'Default: one wall style and one floor style, both "plain". A set with more than 14 floor styles needs automapping markers of its own',
    ),
  outDir: z
    .string()
    .describe('Folder for rules.txt, walls.tmj and README.md, relative to projectDir, usually the set\'s own folder, for example ".wa-asset-sets/dungeon/automap"'),
  tilesets: z
    .array(z.string())
    .min(1)
    .max(MAX_TEMPLATE_TILESETS)
    .describe(
      'The Tiled tilesets (.tsj) to paint with, relative to projectDir, for example ".wa-asset-sets/dungeon/tilesets/Dungeon.tsj": ' +
        'every tileset of the walls, faces, lintels and floors, and the one with the collision tile (WA_Special_Zones in the starter kit). 32x32 tiles',
    ),
  overwrite: z.boolean().exactOptional().describe('Replace rules.txt, walls.tmj and README.md in outDir; without it existing files fail with MAP_EXISTS'),
});

const markerIds = z.strictObject({
  wall: z.number(),
  door: z.number(),
  floor: z.record(z.string(), z.number()),
  wallStyle: z.record(z.string(), z.number()),
});

const output = z.strictObject({
  ruleMap: z.string().describe('The rule map to paint in Tiled, relative to projectDir'),
  rulesFile: z.string().describe('The rules file that lists it, relative to projectDir; drawing.rules in set.json is this path relative to set.json'),
  readme: z.string().describe('The three steps for the user, relative to projectDir'),
  rules: z
    .array(z.strictObject({ name: z.string(), x: z.number(), y: z.number(), paint: z.array(z.string()) }))
    .describe('Every rule in the order it runs: the piece it draws, its anchor cell in the rule map, and the layers to paint there (empty when the rule is complete)'),
  markerTileset: z.string().describe('drawing.markerTileset for set.json'),
  markers: markerIds.describe('drawing.markers for set.json'),
  wallStyles: z.strictObject({ default: z.string(), names: z.array(z.string()) }).describe('wallStyles for set.json'),
  floorStyles: z
    .strictObject({ default: z.string(), styles: z.record(z.string(), z.strictObject({ tileset: z.string().exactOptional(), tile: z.number().exactOptional() })) })
    .describe('floorStyles for set.json'),
});

export const automapTemplateTool: ToolEntry<typeof input, typeof output> = {
  name: 'automap_template',
  command: 'automap-template',
  title: 'Write a Tiled rule map to paint for an asset set',
  description:
    'Write a ready-to-paint Tiled automapping rule map for an asset set drawn with rules: outDir/walls.tmj, with one rule for every ' +
    'wall pattern, both lintels, the 4 face variants of both face rows outside rooms and per wall style, and each floor style (on ' +
    'floors and on doors), whose input cells already hold the markers a room build paints and whose output cells are empty apart from the Empty tiles ' +
    'of its clean-up and lintel rules; ' +
    'outDir/rules.txt; and outDir/README.md, the three steps for the user: paint the tiles in Tiled, write set.json with "drawing", ' +
    'prove the set. The named tilesets are attached, and the marker and special-tile images are written into tilesets/ when missing. ' +
    'Returns every rule with the cell and layers to paint, and the markers and styles for set.json. Fails with MAP_EXISTS rather ' +
    'than replace files unless overwrite is true.',
  input,
  output,
  annotations: { openWorldHint: false },
  run: (args) => attempt(async () => toolOk(await automapTemplate(args))),
};
