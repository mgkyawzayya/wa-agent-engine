import * as z from 'zod';
import { buildRooms } from '../core/compiler.js';
import { DslShape } from '../schemas/dsl.schema.js';
import { attempt, toolOk } from './result.js';
import { mapPathField, projectDirField, WarningsField, type ToolEntry } from './tool.js';

const input = z.strictObject({
  projectDir: projectDirField,
  mapPath: mapPathField,
  dsl: DslShape.describe('The whole room layout of the map; each call replaces the previous build'),
});

const output = z.strictObject({
  placedCells: z.number(),
  zones: z.array(z.string()),
  variables: z.array(z.string()),
  prefabs: z.array(z.string()).describe('Instances of the DSL furniture; scattered prefabs are not listed'),
  toolPrefabs: z.array(z.string()).describe('Instances placed with place_prefab that are still in the map'),
  warnings: WarningsField,
});

export const buildRoomTool: ToolEntry<typeof input, typeof output> = {
  name: 'build_room_from_dsl',
  command: 'build',
  title: 'Build rooms from the room DSL',
  description:
    'Draw rooms into a map from a declarative layout. Each room is a rectangle in tiles that includes its walls; neighbouring rooms ' +
    'share one wall line. Doors sit on a wall (north/south/east/west) at an offset from its west or north corner; every door must lead ' +
    'to walkable space on both sides, except exit doors (exit: true) on the map edge, which need an exitUrl zone. ' +
    'Rules agents most often break: rooms are at least 3 wide and 5 tall; a door offset is at least 2 and offset + width at most ' +
    'the wall length - 2; east and west doors need offset 3 or more (the 2 face rows under the north wall); doors on one wall line ' +
    'need 2 wall cells between them. ' +
    'The engine autotiles walls, wall faces (2 rows under north walls), floors, collisions and door lintels; stamps furniture prefabs; ' +
    'and makes one WorkAdventure area per room from its waProperties (for example {"jitsiRoom": "Talks"}). wallStyle and ' +
    'floorStyle name styles of the asset set; an unknown style fails with UNKNOWN_STYLE, which lists them. ' +
    'Optional world fields draw around the rooms: ground (a floor style for the empty tiles no room covers), paths and plazas, ' +
    'water (blocks walking; a path across it becomes a bridge), and scatter (seeded random trees, bushes and flowers on free ground, ' +
    'clear of rooms, paths, water, door fronts, the spawn and prefabs placed with place_prefab). ' +
    'The DSL is the source of truth: a rebuild first undoes the previous build exactly. Ground goes only where the floor is empty, ' +
    'so floors drawn by hand stay; but the cells the build drew (rooms, ground, paths, water) belong to it, and a later build ' +
    'replaces hand edits on them. Prefabs placed with place_prefab go back where they were, or are removed with a PREFAB_REMOVED ' +
    'warning when the new build leaves no room for them. ' +
    'Any error leaves the file unchanged.',
  input,
  output,
  annotations: { idempotentHint: true, openWorldHint: false },
  run: (args) =>
    attempt(async () => {
      const result = await buildRooms(args);
      return toolOk({ ...result, warnings: result.warnings.map((w) => w.toJSON()) });
    }),
};
