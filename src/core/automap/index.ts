// The automapping API: load a Tiled rules file, apply it to a map in memory, or apply it to a
// map file (automap_map), or write a rule map to paint (automap_template).
export { automap } from './engine.js';
export { automapMap } from './automap-map.js';
export type { AutomapMapOptions, AutomapMapResult } from './automap-map.js';
export { automapTemplate } from './automap-template.js';
export type { AutomapTemplateOptions, AutomapTemplateResult } from './automap-template.js';
export { loadRules, wildcardToRegExp } from './rules-file.js';
export { resolveExternalTilesets } from './tiles.js';
