import * as z from 'zod';

// WorkAdventure property names and value types, verified against WA's docs and its map
// validator and variables source. Zone properties are strict: an unknown key is an error, so a typo
// never silently becomes a property WA ignores.

export const WaZonePropertiesSchema = z.strictObject({
  jitsiRoom: z.string().min(1).exactOptional(),
  jitsiTriggerMessage: z.string().exactOptional(),
  jitsiTrigger: z.literal('onaction').exactOptional(),
  jitsiConfig: z.string().exactOptional(),
  jitsiWidth: z.number().min(1).max(100).exactOptional(),
  jitsiClosable: z.boolean().exactOptional(),
  jitsiNoPrefix: z.boolean().exactOptional(),
  silent: z.boolean().exactOptional(),
  openWebsite: z.string().min(1).exactOptional(),
  openWebsiteTrigger: z.enum(['onaction', 'onicon']).exactOptional(),
  openWebsiteTriggerMessage: z.string().exactOptional(),
  openWebsitePolicy: z.string().exactOptional(),
  playAudio: z.string().min(1).exactOptional(),
  audioLoop: z.boolean().exactOptional(),
  audioVolume: z.number().min(0).max(1).exactOptional(),
  exitUrl: z.string().min(1).exactOptional(),
  start: z.boolean().exactOptional(),
  focusable: z.boolean().exactOptional(),
  // WA documents zoomMargin; its code also reads zoom_margin.
  zoomMargin: z.number().exactOptional(),
  zoom_margin: z.number().exactOptional(),
  'ai-zone': z.boolean().exactOptional(),
  description: z.string().max(500).exactOptional(),
});

export type WaZoneProperties = z.infer<typeof WaZonePropertiesSchema>;

export const WA_ZONE_PROPERTY_NAMES = Object.keys(WaZonePropertiesSchema.shape) as (keyof WaZoneProperties)[];

// Tiled property type per WA zone key, so Tiled shows the right editor for each value.
export const WA_ZONE_PROPERTY_TYPES: Record<keyof WaZoneProperties, 'string' | 'bool' | 'int' | 'float'> = {
  jitsiRoom: 'string',
  jitsiTriggerMessage: 'string',
  jitsiTrigger: 'string',
  jitsiConfig: 'string',
  jitsiWidth: 'float',
  jitsiClosable: 'bool',
  jitsiNoPrefix: 'bool',
  silent: 'bool',
  openWebsite: 'string',
  openWebsiteTrigger: 'string',
  openWebsiteTriggerMessage: 'string',
  openWebsitePolicy: 'string',
  playAudio: 'string',
  audioLoop: 'bool',
  audioVolume: 'float',
  exitUrl: 'string',
  start: 'bool',
  focusable: 'bool',
  zoomMargin: 'float',
  zoom_margin: 'float',
  'ai-zone': 'bool',
  description: 'string',
};

// Deprecated WA keys that get a targeted hint instead of a generic "unknown key".
export const WA_DEPRECATED_ZONE_PROPERTIES: Readonly<Record<string, string>> = {
  playAudioLoop: 'is deprecated; use playAudio with audioLoop: true',
};

export const WaMapPropertiesSchema = z.object({
  mapName: z.string().exactOptional(),
  mapDescription: z.string().exactOptional(),
  mapCopyright: z.string().exactOptional(),
  mapImage: z.string().exactOptional(),
  mapLink: z.string().exactOptional(),
  script: z.string().exactOptional(),
});

export type WaMapProperties = z.infer<typeof WaMapPropertiesSchema>;

export const TILESET_COPYRIGHT_PROPERTY = 'tilesetCopyright';

// Sentinel `writableBy` tag: no player carries it, so on self-hosted WA only Room API
// writes (the NPC service) can change the variable.
export const NPC_WRITABLE_BY = 'wa-agent-engine';

export const WaVariableSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'variable names are identifiers: letters, digits, underscore'),
  default: z.json(),
  persist: z.boolean().exactOptional(),
  writableBy: z.string().min(1).exactOptional(),
});

export type WaVariable = z.infer<typeof WaVariableSchema>;
