// The automapping API: load a Tiled rules file, apply it to a map in memory, or apply it to a
// map file (automap_map).
export { automap } from './engine.js';
export { automapMap } from './automap-map.js';
export type { AutomapMapOptions, AutomapMapResult } from './automap-map.js';
export { loadRules, wildcardToRegExp } from './rules-file.js';
export { resolveExternalTilesets } from './tiles.js';
