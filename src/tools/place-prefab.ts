import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { BUILTIN_SETS_DIR } from '../core/asset-set-registry.js';
import { placePrefab } from '../core/compiler.js';
import { DEFAULT_ASSET_SET } from '../core/zones.js';
import { attempt, toolOk } from './result.js';
import { assetSetField, mapPathField, projectDirField, tilesField, type ToolEntry } from './tool.js';

// The built-in prefab ids, so agents can pick one without a failing call first.
function builtinPrefabs(): string {
  const set = JSON.parse(readFileSync(join(BUILTIN_SETS_DIR, DEFAULT_ASSET_SET, 'set.json'), 'utf8')) as {
    prefabs: { id: string; placement: string }[];
  };
  const ids = (placement: string): string =>
    set.prefabs
      .filter((p) => p.placement === placement)
      .map((p) => p.id)
      .join(', ');
  return (
    `Prefabs of ${DEFAULT_ASSET_SET} (the id ends in its size, width x height): floor prefabs ${ids('free')}; wall-mounted ${ids('north-wall')}. ` +
    'A prop set made with import_prop_set adds its own prefabs: read their ids in .wa-asset-sets/<id>/set.json and pass that id as assetSet.'
  );
}

const input = z.strictObject({
  projectDir: projectDirField,
  mapPath: mapPathField,
  prefabId: z.string().describe('Prefab id from the asset set, for example "plant-small-1x1"; a wrong id lists the available ones'),
  x: tilesField('Map tile column of the prefab top-left cell'),
  y: tilesField('Map tile row of the prefab top-left cell'),
  assetSet: assetSetField.exactOptional(),
});

const output = z.strictObject({
  instance: z.string(),
  cells: z.number(),
  collisions: z.number(),
});

export const placePrefabTool: ToolEntry<typeof input, typeof output> = {
  name: 'place_prefab',
  command: 'prefab',
  title: 'Place a furniture prefab',
  description:
    'Stamp one prefab (furniture, plants, stage, signs; with its collisions) into a map at a tile position. Floor prefabs need floor ' +
    'and free cells under them; wall-mounted prefabs hang on the wall-face rows under a north wall. Never overwrites anything: an ' +
    'occupied cell fails with PREFAB_BLOCKED, and blocking a door fails with DOOR_UNREACHABLE. Furniture that belongs to a room is ' +
    `better listed in the room DSL. ${builtinPrefabs()}`,
  input,
  output,
  annotations: { destructiveHint: false, openWorldHint: false },
  run: (args) => attempt(async () => toolOk(await placePrefab(args))),
};
