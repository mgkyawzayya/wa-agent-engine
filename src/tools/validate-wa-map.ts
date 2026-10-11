import * as z from 'zod';
import { MAX_REPORTED_ERRORS, MAX_REPORTED_WARNINGS, VALIDATION_CODES, validateMap } from '../core/validator.js';
import { attempt, toolOk } from './result.js';
import { assetSetField, mapPathField, projectDirField, type ToolEntry } from './tool.js';

const input = z.strictObject({
  projectDir: projectDirField,
  mapPath: mapPathField,
  assetSet: assetSetField.exactOptional().describe('Asset set for the wall checks; defaults to the one the map was built with'),
});

const IssueSchema = z.strictObject({
  code: z.enum(VALIDATION_CODES),
  message: z.string(),
  layer: z.string().exactOptional(),
  x: z.number().exactOptional(),
  y: z.number().exactOptional(),
  objectName: z.string().exactOptional(),
});

const output = z.strictObject({
  ok: z.boolean(),
  errors: z.array(IssueSchema),
  warnings: z.array(IssueSchema),
  omitted: z
    .strictObject({ errors: z.number(), warnings: z.number() })
    .exactOptional()
    .describe('How many issues were left out of the lists; only present when some were'),
});

export const validateWaMapTool: ToolEntry<typeof input, typeof output> = {
  name: 'validate_wa_map',
  command: 'validate',
  title: 'Validate a WorkAdventure map',
  description:
    'Check any Tiled map (built by this engine or by hand) against what WorkAdventure needs: orthogonal 32 px tiles, floorLayer and ' +
    'start layer, embedded tilesets with images, valid tile ids, walls with collisions, walkable doors, zone properties and URLs, and ' +
    'the map script. Read-only. ok is false when there is any error; warnings are worth a look but do not break the map. ' +
    `At most ${MAX_REPORTED_ERRORS} errors and ${MAX_REPORTED_WARNINGS} warnings are listed (50 per code and layer); omitted counts the rest.`,
  input,
  output,
  annotations: { readOnlyHint: true, openWorldHint: false },
  run: (args) => attempt(async () => toolOk(await validateMap(args))),
};
