import * as z from 'zod';
import { renderMap } from '../core/renderer.js';
import { attempt, toolOk } from './result.js';
import { mapPathField, projectDirField, type ToolEntry } from './tool.js';

// Previews larger than this are returned by path only. Base64 adds a third, and the Anthropic
// API refuses images over 5 MiB once encoded: 3.75 MiB raw is 5 MiB of base64.
export const MAX_INLINE_PNG_BYTES = 3_932_160;

const input = z.strictObject({
  projectDir: projectDirField,
  mapPath: mapPathField,
  scale: z.number().exactOptional().describe('0.25, 0.5, 1 (default) or 2; previews are limited to 4096 px a side'),
  overlays: z.array(z.enum(['zones'])).exactOptional().describe('["zones"] outlines every area, coloured by kind'),
});

const output = z.strictObject({
  pngPath: z.string(),
  width: z.number(),
  height: z.number(),
  bytes: z.number(),
  sha256: z.string(),
});

export const renderMapPreviewTool: ToolEntry<typeof input, typeof output> = {
  name: 'render_map_preview',
  command: 'render',
  title: 'Render a map preview',
  description:
    'Render the map to a PNG from the tileset images in the project, the way WorkAdventure draws it, and return the image to look at ' +
    'what was built. The file is written to .wa-preview/ in the project (gitignore it). Use scale 0.5 or 0.25 for big maps, and the ' +
    'zones overlay to check where areas lie. Images over 3.75 MB come back by path only: then, or if no image comes back, open pngPath.',
  input,
  output,
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run: (args) =>
    attempt(async () => {
      const { png, ...result } = await renderMap(args);
      return toolOk(result, png.length <= MAX_INLINE_PNG_BYTES ? png : undefined);
    }),
};
