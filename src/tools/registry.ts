import { buildRoomTool } from './build-room.js';
import { configureWaZoneTool } from './configure-wa-zone.js';
import { placePrefabTool } from './place-prefab.js';
import { renderMapPreviewTool } from './render-map-preview.js';
import { scaffoldMapTool } from './scaffold-map.js';
import type { ToolEntry } from './tool.js';
import { validateWaMapTool } from './validate-wa-map.js';

// The six map tools, in workflow order. Both the MCP server and the CLI are built from this
// table and nothing else.
export const TOOLS: readonly ToolEntry[] = [
  scaffoldMapTool,
  buildRoomTool,
  placePrefabTool,
  configureWaZoneTool,
  validateWaMapTool,
  renderMapPreviewTool,
];

for (const key of ['name', 'command'] as const) {
  const seen = new Set<string>();
  for (const tool of TOOLS) {
    if (seen.has(tool[key])) throw new Error(`duplicate tool ${key}: ${tool[key]}`);
    seen.add(tool[key]);
  }
}
