import * as z from 'zod';
import { DEFAULT_BASE_SET, importPropSet, MAX_SOURCES } from '../core/prop-import.js';
import { attempt, toolOk } from './result.js';
import { projectDirField, type ToolEntry } from './tool.js';

const input = z.strictObject({
  projectDir: projectDirField,
  setId: z
    .string()
    .describe('Id of the new asset set: lowercase letters, digits and "-", for example "varcamp". Use it as the assetSet of the DSL and of place_prefab'),
  source: z
    .union([z.string(), z.array(z.string()).min(1).max(MAX_SOURCES)])
    .describe(
      'One props hints JSON, or a list of them, relative to projectDir, for example "props/varcamp/props.json". Each file is an array of ' +
        'props: id, image (a PNG relative to that hints file, exactly sizeTiles x 32 px), sizeTiles [width, height], and optionally ' +
        'collisionGrid (rows of 0/1), foregroundRows (rows drawn above players), placement ("free" or "north-wall") with faceRow for ' +
        'wall props, use, name, tags and license. Prop ids must be unique across the files',
    ),
  extends: z.string().exactOptional().describe(`The set the props are added to; default "${DEFAULT_BASE_SET}"`),
  overwrite: z.boolean().exactOptional().describe('Replace an existing set with this id; without it an existing set is never touched'),
});

const output = z.strictObject({
  setId: z.string(),
  extends: z.string(),
  image: z.string().describe('The atlas image the set draws with, relative to projectDir'),
  prefabs: z.array(z.strictObject({ id: z.string(), width: z.number(), height: z.number(), category: z.string(), use: z.string() })),
});

export const importPropSetTool: ToolEntry<typeof input, typeof output> = {
  name: 'import_prop_set',
  command: 'import-props',
  title: 'Import prop images as furniture',
  description:
    'Turn single-image props (PNG images in 32 px tile multiples, described by a hints JSON) into furniture prefabs: a project asset ' +
    'set that extends another set, so maps get that set\'s walls and floors plus the props. Writes one atlas image, tilesets/<setId>.png ' +
    '(the pixels copied unchanged), and .wa-asset-sets/<setId>/. Prefab ids are the prop ids in lowercase with "_" as "-". Build maps ' +
    'with assetSet <setId>; a map built with the base set may switch to it. Returns every prefab with its size, category and use. ' +
    'Fails with ASSET_SET_EXISTS rather than replace a set unless overwrite is true.',
  input,
  output,
  annotations: { openWorldHint: false },
  run: (args) => attempt(async () => toolOk(await importPropSet(args))),
};
