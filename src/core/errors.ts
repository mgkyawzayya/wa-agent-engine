// Closed set of machine-readable error codes shared by the core, the MCP server, and the CLI.
// Later phases extend this list; agents branch on `code`, never on message text.
export const ERROR_CODES = [
  'INVALID_INPUT',
  'INTERNAL',
  // project paths
  'PROJECT_DIR_INVALID',
  'PATH_OUTSIDE_PROJECT',
  'PATH_BAD_EXTENSION',
  // map I/O
  'MAP_NOT_FOUND',
  'MAP_FILE_TOO_LARGE',
  'MAP_PARSE_ERROR',
  'MAP_INVALID',
  'MAP_CHANGED_ON_DISK',
  'MAP_LOCKED',
  'IO_ERROR',
  // layers and tile data
  'LAYER_IS_GROUP',
  'LAYER_WRONG_TYPE',
  'LAYER_ROLE_UNRESOLVED',
  'LAYER_DATA_UNSUPPORTED',
  // tilesets, asset sets and prefabs
  'EXTERNAL_TILESET_UNRESOLVED',
  'TILESET_CONFLICT',
  'ASSET_SET_NOT_FOUND',
  'ASSET_SET_INVALID',
  'ASSET_IMAGE_MISSING',
  'PREFAB_NOT_FOUND',
  'PREFAB_INVALID',
  // DSL geometry
  'MAP_TOO_LARGE',
  'ROOM_OUT_OF_BOUNDS',
  'DUPLICATE_ROOM_ID',
  'ROOM_TOO_SMALL',
  'ROOM_OVERLAP',
  'THICK_WALL',
  'DOOR_OUT_OF_WALL',
  'DOOR_AT_CORNER',
  'DOOR_BLOCKED_BY_FACE',
  'DOOR_TOO_CLOSE',
  'FURNITURE_OUT_OF_BOUNDS',
  'DUPLICATE_VARIABLE',
  // wall autotiling
  'UNKNOWN_STYLE',
  'DOOR_AT_JUNCTION',
  'WALL_PIECE_MISSING',
  'ISOLATED_WALL',
  'DOOR_UNREACHABLE',
  'EXIT_NOT_AT_MAP_EDGE',
  'EXIT_WITHOUT_EXIT_ZONE',
  // URLs written into maps
  'BAD_URL',
  // compiler
  'MAP_EXISTS',
  'ENGINE_STATE_INVALID',
  'SPAWN_OUT_OF_BOUNDS',
  'PREFAB_OUT_OF_BOUNDS',
  'PREFAB_BLOCKED',
  'PREFAB_PLACEMENT',
  'INVALID_ZONE_PROPERTY',
  'ZONE_NAME_TAKEN',
  'VARIABLE_NAME_TAKEN',
  'SCRIPT_EXTERNAL',
  'ZONE_OUT_OF_BOUNDS',
  'ZONE_OWNED_BY_ROOM',
  'ASSET_SET_MISMATCH',
  // preview renderer
  'TILESET_IMAGE_MISSING',
  'IMAGE_TOO_LARGE',
  'PREVIEW_TOO_LARGE',
  // warnings
  'PREFAB_REMOVED',
  'PREFAB_UNTRACKED',
  'VARIABLE_DEFAULT_AS_TEXT',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export class WaEngineError extends Error {
  override name = 'WaEngineError';
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }

  toJSON(): ErrorBody {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export function isWaEngineError(err: unknown, code?: ErrorCode): err is WaEngineError {
  return err instanceof WaEngineError && (code === undefined || err.code === code);
}

// Tile coordinates and sizes arriving from agents must be whole numbers.
export function assertWhole(values: Record<string, number>): void {
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isInteger(value)) throw new WaEngineError('INVALID_INPUT', `${name} must be a whole number of tiles, not ${value}`);
  }
}
