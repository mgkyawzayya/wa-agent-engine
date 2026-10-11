import * as z from 'zod';
import { automapMap } from '../core/automap/automap-map.js';
import { attempt, toolOk } from './result.js';
import { mapPathField, projectDirField, tilesField, WarningsField, type ToolEntry } from './tool.js';

const input = z.strictObject({
  projectDir: projectDirField,
  mapPath: mapPathField,
  rules: z
    .string()
    .exactOptional()
    .describe('The Tiled rules file (rules.txt) or a single rule map (.tmj), relative to projectDir. Default: rules.txt next to the map, else rules.txt in projectDir'),
  region: z
    .strictObject({
      x: tilesField('Left tile column'),
      y: tilesField('Top tile row'),
      width: tilesField('Width in tiles'),
      height: tilesField('Height in tiles'),
    })
    .exactOptional()
    .describe('Limit the run to this rectangle inside the map, like a selection in Tiled: only rules whose input overlaps it are tried, and their output may land outside it; default: the whole map'),
  seed: z.number().exactOptional().describe('Seed for random output choices and rule probabilities; the same seed gives the same map. Default 0'),
  dryRun: z.boolean().exactOptional().describe('Report what would change without writing the map'),
});

const output = z.strictObject({
  rulesPath: z.string().describe('The rules file used, relative to projectDir'),
  ruleMaps: z.array(z.string()).describe('The rule maps applied, in order, relative to projectDir (filters already applied)'),
  rules: z.number().describe('Number of rules in those rule maps'),
  matches: z.number().describe('Number of times a rule was applied'),
  changedCells: z.number().describe('Number of tile cells that changed'),
  layersWritten: z.array(z.string()).describe('Tile layers that changed or were created'),
  written: z.boolean().describe('Whether the map file was written (false for a dry run or when nothing changed)'),
  warnings: WarningsField,
});

export const automapMapTool: ToolEntry<typeof input, typeof output> = {
  name: 'automap_map',
  command: 'automap',
  title: 'Apply Tiled automapping rules to a map',
  description:
    'Apply a Tiled automapping rules file (rules.txt listing rule maps with input_<layer>, inputnot_<layer>, output_<layer> and ' +
    'rule_options layers) to a map with the semantics of Tiled 1.12\'s AutoMap: deterministic rules give the same tiles as Tiled. ' +
    'Use it on a map with its own rules.txt, or with a rules file the user names. Rule maps must be JSON (.tmj). Random choices ' +
    'are seeded. Reports the rule maps applied, matches, changed cells and layers; dryRun reports without writing. Running it ' +
    'again changes nothing more unless the rules read their own output. On a map with an engine build record it warns ' +
    'AUTOMAP_ON_ENGINE_MAP: build_room_from_dsl does not re-run the rules.',
  input,
  output,
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  run: (args) => attempt(async () => toolOk(await automapMap(args))),
};
