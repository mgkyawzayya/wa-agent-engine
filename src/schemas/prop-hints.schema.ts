import * as z from 'zod';

// The hints file that describes single-image props for import_prop_set: one entry per prop
// image, which must be a PNG exactly sizeTiles x 32 pixels. Other keys are allowed and ignored.

export const MAX_PROPS = 500;
export const MAX_PROP_TILES = 16;

const int = z.number().int();
const cellFlag = z.union([z.literal(0), z.literal(1), z.boolean()]);

export const PropHintSchema = z
  .looseObject({
    id: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'prop ids are 1-64 letters, digits, "_" or "-"')
      .describe('Prop id; "_" becomes "-" and letters become lowercase in the prefab id'),
    name: z.string().min(1).exactOptional(),
    image: z.string().min(1).describe('PNG path relative to the hints file'),
    sizeTiles: z.tuple([int.min(1).max(MAX_PROP_TILES), int.min(1).max(MAX_PROP_TILES)]).describe('[width, height] in 32 px tiles'),
    category: z.string().exactOptional(),
    tags: z.array(z.string()).exactOptional(),
    collisionGrid: z.array(z.array(cellFlag)).exactOptional().describe('Rows of 0/1, one per tile row; 1 blocks walking'),
    foregroundRows: z.array(int.min(0)).exactOptional().describe('Tile rows drawn above the player'),
    use: z.string().min(1).exactOptional(),
    license: z.string().min(1).exactOptional(),
    provenanceRun: z.string().exactOptional(),
  })
  .superRefine((prop, ctx) => {
    const [width, height] = prop.sizeTiles;
    const grid = prop.collisionGrid;
    if (grid !== undefined && (grid.length !== height || grid.some((row) => row.length !== width))) {
      ctx.addIssue({ code: 'custom', path: ['collisionGrid'], message: `must be ${height} rows of ${width} cells` });
    }
    for (const row of prop.foregroundRows ?? []) {
      if (row >= height) ctx.addIssue({ code: 'custom', path: ['foregroundRows'], message: `row ${row} is outside the prop (height ${height})` });
    }
  });
export type PropHint = z.infer<typeof PropHintSchema>;

export const PropHintsSchema = z.array(PropHintSchema).min(1).max(MAX_PROPS);
