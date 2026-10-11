import * as z from 'zod';
import { WA_ZONE_PROPERTY_TYPES } from '../schemas/wa.schema.js';
import { configureZone } from '../core/zones.js';
import { attempt, toolOk } from './result.js';
import { mapPathField, projectDirField, tilesField, WarningsField, type ToolEntry } from './tool.js';

const JSON_TYPES = { string: 'string', bool: 'boolean', int: 'whole number', float: 'number' } as const;
const KNOWN_PROPERTIES = Object.entries(WA_ZONE_PROPERTY_TYPES)
  .map(([name, type]) => `${name} (${JSON_TYPES[type]})`)
  .join(', ');

const input = z.strictObject({
  projectDir: projectDirField,
  mapPath: mapPathField,
  name: z.string().describe('Area name, unique in the map'),
  x: tilesField('Left tile column'),
  y: tilesField('Top tile row'),
  width: tilesField('Width in tiles'),
  height: tilesField('Height in tiles'),
  properties: z
    .record(z.string(), z.unknown())
    .describe(
      `WorkAdventure area properties: ${KNOWN_PROPERTIES}. openWebsite and exitUrl take an http(s) URL or a path relative to ` +
        'the map; playAudio takes an https URL or an audio file in the project',
    ),
});

const output = z.strictObject({
  objectId: z.number(),
  pixelRect: z.strictObject({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  warnings: WarningsField,
});

export const configureWaZoneTool: ToolEntry<typeof input, typeof output> = {
  name: 'configure_wa_zone',
  command: 'zone',
  title: 'Create or update a WorkAdventure zone',
  description:
    'Create or update a named WorkAdventure area (zone) over a tile rectangle: meeting rooms (jitsiRoom), websites (openWebsite), ' +
    'audio (playAudio), silent zones, exits (exitUrl), entry points (start). Calling it again with the same name updates that area and ' +
    'merges its properties. URLs must be http(s) or relative; templates are refused. A room built from the DSL owns its area: change ' +
    "its waProperties instead (ZONE_OWNED_BY_ROOM). An area someone drew by hand is never taken over (ZONE_NAME_TAKEN).",
  input,
  output,
  annotations: { idempotentHint: true, openWorldHint: false },
  run: (args) =>
    attempt(async () => {
      const result = await configureZone(args);
      return toolOk({ ...result, warnings: result.warnings.map((w) => w.toJSON()) });
    }),
};
