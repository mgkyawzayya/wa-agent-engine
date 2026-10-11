import * as z from 'zod';
import type { ToolOutcome } from './result.js';

// One entry of the surface-neutral tool table. The input schema is structural only, so the
// MCP SDK's own validation checks shape alone; geometry and meaning are checked by the core
// inside `run`, which returns coded errors on both surfaces.

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolEntry<I extends z.ZodObject = z.ZodObject, O extends z.ZodObject = z.ZodObject> {
  // MCP tool name and CLI command.
  name: string;
  command: string;
  title: string;
  description: string;
  input: I;
  output: O;
  annotations: ToolAnnotations;
  run(input: z.output<I>): Promise<ToolOutcome<z.output<O>>>;
}

export const projectDirField = z
  .string()
  .describe('Absolute path to the WorkAdventure map project: the folder that holds tilesets/ (a map-starter-kit checkout)');
export const mapPathField = z.string().describe('The map file, relative to projectDir, ending in .tmj (for example "maps/venue.tmj")');
export const assetSetField = z.string().describe('Asset set id; the built-in set is "wa-starter-office"');

// A whole number of tiles. Plain numbers, so a fraction reaches the core and gets a coded
// INVALID_INPUT instead of the MCP SDK's own text.
export const tilesField = (description: string): z.ZodNumber => z.number().describe(`${description} (a whole number)`);

// Warnings and issues as the core reports them.
export const ErrorBodySchema = z.strictObject({ code: z.string(), message: z.string(), details: z.unknown().exactOptional() });

export const WarningsField = z
  .array(ErrorBodySchema)
  .describe(
    'Things that worked but deserve a look, each with a code. PREFAB_REMOVED and PREFAB_UNTRACKED carry details.reason: ' +
      'covered, floor-gone, wall-gone, blocks-door or out-of-bounds (removed), and erased, edited or not-in-set (no longer tracked)',
  );

// Runs a tool and holds its result to the output schema it advertises, so both surfaces return
// only what the schema promises; a mismatch is an engine bug, reported as INTERNAL.
export async function runTool(tool: ToolEntry, args: unknown): Promise<ToolOutcome<unknown>> {
  const outcome = await tool.run(args as z.output<z.ZodObject>);
  if (!outcome.ok || tool.output.safeParse(outcome.data).success) return outcome;
  return { ok: false, error: { code: 'INTERNAL', message: `${tool.name} produced a result that does not match its output schema` } };
}
