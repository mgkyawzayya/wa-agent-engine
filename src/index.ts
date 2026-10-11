// The wa-agent-engine library: the core map operations, the room DSL, and the tool table the
// MCP server and the CLI are built from.

export { buildRooms, placePrefab, scaffoldMap } from './core/compiler.js';
export type {
  BuildRoomsOptions,
  BuildRoomsResult,
  PlacePrefabOptions,
  PlacePrefabResult,
  PrefabRemovedReason,
  PrefabUntrackedReason,
  ScaffoldOptions,
  ScaffoldResult,
} from './core/compiler.js';
export { configureZone, DEFAULT_ASSET_SET } from './core/zones.js';
export type { ConfigureZoneOptions, ConfigureZoneResult } from './core/zones.js';
export { MAX_REPORTED_ERRORS, MAX_REPORTED_WARNINGS, VALIDATION_CODES, validateMap } from './core/validator.js';
export type { ValidateOptions, ValidationCode, ValidationIssue, ValidationReport } from './core/validator.js';
export { renderMap, RENDER_SCALES } from './core/renderer.js';
export type { RenderOptions, RenderResult } from './core/renderer.js';
export { automap, automapMap, loadRules, resolveExternalTilesets } from './core/automap/index.js';
export type { AutomapMapOptions, AutomapMapResult } from './core/automap/index.js';
export type { AutomapOptions, AutomapReport, ExternalTilesetInfo, RuleSet } from './schemas/automap.schema.js';
export { ERROR_CODES, isWaEngineError, WaEngineError } from './core/errors.js';
export type { ErrorBody, ErrorCode } from './core/errors.js';
export { DslShape, parseDsl } from './schemas/dsl.schema.js';
export type { Dsl, DslInput, DslRoom } from './schemas/dsl.schema.js';
export { TOOLS } from './tools/registry.js';
export { runTool } from './tools/tool.js';
export type { ToolEntry } from './tools/tool.js';
export type { ToolOutcome } from './tools/result.js';
export { createServer, startMcpServer } from './mcp/index.js';
export { VERSION } from './version.js';
