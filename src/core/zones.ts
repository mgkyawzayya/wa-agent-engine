import { access } from 'node:fs/promises';
import {
  WA_DEPRECATED_ZONE_PROPERTIES,
  WA_ZONE_PROPERTY_TYPES,
  WaZonePropertiesSchema,
  type WaZoneProperties,
} from '../schemas/wa.schema.js';
import { getProperty, setProperty, type TiledMap, type TiledObject, type TiledProperty } from '../schemas/tiled.schema.js';
import { emptyState, type EngineState } from './engine-state.js';
import { assertWhole, WaEngineError } from './errors.js';
import { allocObjectId, ensureStandardLayers, forEachObjectGroup, resolveRole } from './layers.js';
import { editMap } from './map-session.js';
import { resolveMapRelative } from './project-paths.js';

export const DEFAULT_ASSET_SET = 'wa-starter-office';
const TILE = 32;

// Permissions-Policy features WA can pass to a website iframe's `allow` attribute.
const PERMISSIONS_POLICY_FEATURES = new Set([
  'accelerometer', 'ambient-light-sensor', 'attribution-reporting', 'autoplay', 'bluetooth', 'browsing-topics',
  'camera', 'clipboard-read', 'clipboard-write', 'compute-pressure', 'cross-origin-isolated', 'display-capture',
  'document-domain', 'encrypted-media', 'fullscreen', 'gamepad', 'geolocation', 'gyroscope', 'hid',
  'identity-credentials-get', 'idle-detection', 'local-fonts', 'magnetometer', 'microphone', 'midi',
  'otp-credentials', 'payment', 'picture-in-picture', 'publickey-credentials-create', 'publickey-credentials-get',
  'screen-wake-lock', 'serial', 'speaker-selection', 'storage-access', 'usb', 'web-share', 'window-management',
  'xr-spatial-tracking',
]);

// WA map templates ("{{{ websiteURL }}}", or Mustache sections such as "{{#on}}...{{/on}}")
// are filled in at runtime by the Scripting API Extra, on dynamic areas only.
const isTemplate = (value: string): boolean => value.includes('{{');

const TEMPLATE_TAG = /\{\{\{?[^}]*\}?\}\}/g;
// Tags that put text in ({{x}}, {{{x}}}, {{&x}}, partials); sections and comments do not.
const insertsText = (tag: string): boolean => !/^\{\{[#^/!]/.test(tag);

// A lint for template URLs, not a sandbox (a map's author controls its script anyway). The
// fixed text, with every tag removed, must not already be a URL WA would refuse:
// "java{{#a}}{{/a}}script:..." is "javascript:..." once rendered. Nor may text be put in before
// the scheme is complete: "{{x}}:alert(1)" and "{{x}}https://site" can become any scheme. A
// value that starts with put-in text and has no scheme of its own ("{{{ base }}}/page.html", or
// all tags) is decided at runtime. New delimiters ({{=...=}}) would hide tags from this check.
function templateLiteralAllowed(value: string): boolean {
  if (value.includes('{{=')) return false;
  const literal = value.replace(TEMPLATE_TAG, '').trim();
  if (literal === '') return true;
  if (!isAllowedUrl(literal)) return false;
  const first = [...value.matchAll(TEMPLATE_TAG)].find((m) => insertsText(m[0]));
  if (first === undefined) return true;
  const before = value.slice(0, first.index).replace(TEMPLATE_TAG, '').trim();
  const schemeSettled = /^[a-z][a-z0-9+.-]*:/i.test(before) || /[/?#]/.test(before);
  return schemeSettled || !/^[^/?#]*:/.test(literal);
}

// Accepts an absolute http(s) URL, or a true relative path that stays on the map's origin.
// javascript:, data:, protocol-relative and other schemes are refused. Never fetches.
export function isAllowedUrl(value: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }
  if (value.startsWith('//') || value.startsWith('\\') || value.includes('\\')) return false;
  try {
    const base = new URL('https://map.invalid/maps/map.tmj');
    return new URL(value, base).origin === base.origin;
  } catch {
    return false;
  }
}

async function exists(abs: string): Promise<boolean> {
  try {
    await access(abs);
    return true;
  } catch {
    return false;
  }
}

export interface PropertyCheck {
  values: Record<string, string | number | boolean>;
  errors: WaEngineError[];
  warnings: WaEngineError[];
}

// Checks WA zone properties. Strict mode (what the engine writes) refuses unknown keys and
// templates; lenient mode (existing maps) only checks the keys it knows, since maps may carry
// other tools' properties, and accepts templates on dynamic areas.
export async function checkZoneProperties(
  input: Record<string, unknown>,
  ctx: { projectDir: string; mapAbs: string; zone: string },
  mode: 'strict' | 'lenient',
): Promise<PropertyCheck> {
  const out: PropertyCheck = { values: {}, errors: [], warnings: [] };
  const dynamic = input['dynamic'] === true;
  const bad = (code: 'INVALID_ZONE_PROPERTY' | 'BAD_URL', key: string, message: string): void => {
    out.errors.push(new WaEngineError(code, `zone "${ctx.zone}": ${key} ${message}`, { zone: ctx.zone, property: key }));
  };
  const shape = WaZonePropertiesSchema.shape;
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(shape, key)) {
      if (mode === 'strict') {
        bad('INVALID_ZONE_PROPERTY', key, WA_DEPRECATED_ZONE_PROPERTIES[key] ?? 'is not a WorkAdventure zone property');
      }
      continue;
    }
    const parsed = shape[key as keyof WaZoneProperties].safeParse(value);
    if (!parsed.success) {
      bad('INVALID_ZONE_PROPERTY', key, `has an invalid value: ${parsed.error.issues[0]?.message ?? 'wrong type'}`);
      continue;
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    // The engine never marks areas dynamic, so a template it wrote would reach WA as a literal
    // string. On an existing area that is not dynamic, a template is that literal too.
    const template = typeof value === 'string' && isTemplate(value);
    if (template && mode === 'strict') {
      bad('INVALID_ZONE_PROPERTY', key, 'must not contain a {{{ template }}}; the engine writes plain values only');
      continue;
    }
    if (template && dynamic) {
      if ((key === 'openWebsite' || key === 'exitUrl' || key === 'playAudio') && !templateLiteralAllowed(value)) {
        bad('BAD_URL', key, 'starts with a scheme or host WorkAdventure would not load');
        continue;
      }
    } else if (template) {
      out.warnings.push(new WaEngineError('INVALID_ZONE_PROPERTY', `zone "${ctx.zone}": ${key} holds a template, but WorkAdventure fills templates only on areas with dynamic: true`, {
        zone: ctx.zone,
        property: key,
      }));
    }
    if (typeof value === 'string' && !(template && dynamic)) {
      if ((key === 'openWebsite' || key === 'exitUrl') && !isAllowedUrl(value)) {
        bad('BAD_URL', key, 'must be an http(s) URL or a relative path');
        continue;
      }
      if (key === 'playAudio') {
        if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
          if (!value.startsWith('https:') || !isAllowedUrl(value)) {
            bad('BAD_URL', key, 'must be an https URL or an audio file inside the project');
            continue;
          }
        } else {
          let found = false;
          try {
            found = await exists(await resolveMapRelative(ctx.projectDir, ctx.mapAbs, value.split(/[?#]/)[0]!));
          } catch {
            found = false;
          }
          if (!found) {
            bad('BAD_URL', key, `points at a file that is not in the project: ${value}`);
            continue;
          }
        }
      }
      if (key === 'jitsiConfig') {
        let config: unknown;
        try {
          config = JSON.parse(value);
        } catch {
          config = undefined;
        }
        if (config === null || typeof config !== 'object' || Array.isArray(config)) {
          bad('INVALID_ZONE_PROPERTY', key, 'must be a JSON object string');
          continue;
        }
      }
      if (key === 'openWebsitePolicy') {
        const unknown = value
          .split(';')
          .map((part) => part.trim().split(/\s+/)[0] ?? '')
          .filter((feature) => feature !== '' && !PERMISSIONS_POLICY_FEATURES.has(feature));
        if (unknown.length > 0) {
          out.warnings.push(new WaEngineError('INVALID_ZONE_PROPERTY', `zone "${ctx.zone}": openWebsitePolicy has unknown features: ${unknown.join(', ')}`, {
            zone: ctx.zone,
            property: key,
            unknown,
          }));
        }
      }
    }
    out.values[key] = value;
  }
  return out;
}

export function zonePropertyType(key: string, value: string | number | boolean): string {
  if (Object.hasOwn(WA_ZONE_PROPERTY_TYPES, key)) return WA_ZONE_PROPERTY_TYPES[key as keyof WaZoneProperties];
  return typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? (Number.isInteger(value) ? 'int' : 'float') : 'string';
}

export const isArea = (o: TiledObject): boolean => (o.type ?? o.class) === 'area' || (o.type ?? o.class) === 'zone';

export function findAreas(map: TiledMap, name: string): TiledObject[] {
  const found: TiledObject[] = [];
  forEachObjectGroup(map.layers, (layer) => {
    for (const o of layer.objects) if (isArea(o) && o.name === name) found.push(o);
  });
  return found;
}

export interface AreaSpec {
  name: string;
  rect: { x: number; y: number; width: number; height: number }; // pixels
  values: Record<string, string | number | boolean>;
  origin: 'build' | 'tool';
}

// Creates or updates an engine-owned area. A user's area of the same name is never touched.
// Keys the engine set before but not now are dropped for builds; keys anyone else added stay.
export function upsertArea(map: TiledMap, state: EngineState, spec: AreaSpec): number {
  const existing = findAreas(map, spec.name);
  // A recorded zone whose area was deleted by hand no longer holds its name.
  const recorded = state.zones.find((z) => z.name === spec.name);
  const record = existing.some((o) => o.id === recorded?.objectId) ? recorded : undefined;
  if (record === undefined && recorded !== undefined) state.zones = state.zones.filter((z) => z !== recorded);
  if (record !== undefined && record.origin !== spec.origin) {
    throw spec.origin === 'tool'
      ? new WaEngineError('ZONE_OWNED_BY_ROOM', `zone "${spec.name}" belongs to the room "${spec.name}"; change that room's waProperties in the DSL and rebuild`, {
          name: spec.name,
        })
      : new WaEngineError('ZONE_NAME_TAKEN', `a zone named "${spec.name}" was made with configure_wa_zone; rename the room or that zone`, {
          name: spec.name,
        });
  }
  const owned = record === undefined ? undefined : existing.find((o) => o.id === record.objectId);
  if (existing.some((o) => o !== owned)) {
    throw new WaEngineError('ZONE_NAME_TAKEN', `an area named "${spec.name}" already exists and was not created by wa-agent-engine; pick another name`, {
      name: spec.name,
    });
  }
  const keys = Object.keys(spec.values);
  let object = owned;
  if (object === undefined) {
    object = {
      height: spec.rect.height,
      id: allocObjectId(map),
      name: spec.name,
      properties: [],
      rotation: 0,
      type: 'area',
      visible: true,
      width: spec.rect.width,
      x: spec.rect.x,
      y: spec.rect.y,
    };
    resolveRole(map, 'zones').layer.objects.push(object);
  } else {
    Object.assign(object, spec.rect);
    if (spec.origin === 'build') {
      const stale = (record?.keys ?? []).filter((k) => !keys.includes(k));
      object.properties = (object.properties ?? []).filter((p: TiledProperty) => !stale.includes(p.name));
    }
  }
  for (const [key, value] of Object.entries(spec.values)) setProperty(object, key, zonePropertyType(key, value), value);
  const previousKeys = spec.origin === 'tool' ? (record?.keys ?? []) : [];
  const entry = { name: spec.name, objectId: object.id, origin: spec.origin, keys: [...new Set([...previousKeys, ...keys])] };
  state.zones = [...state.zones.filter((z) => z.name !== spec.name), entry];
  return object.id;
}

export interface ConfigureZoneOptions {
  projectDir: string;
  mapPath: string;
  name: string;
  // Tile units.
  x: number;
  y: number;
  width: number;
  height: number;
  properties: Record<string, unknown>;
}

export interface ConfigureZoneResult {
  objectId: number;
  pixelRect: { x: number; y: number; width: number; height: number };
  warnings: WaEngineError[];
}

export async function configureZone(options: ConfigureZoneOptions): Promise<ConfigureZoneResult> {
  return editMap(options.projectDir, options.mapPath, async (session) => {
    const { map } = session;
    const { x, y, width, height, name, properties } = options;
    assertWhole({ x, y, width, height });
    if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
      throw new WaEngineError('INVALID_INPUT', 'properties must be an object of WorkAdventure zone properties');
    }
    if (typeof name !== 'string' || name.trim() === '' || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new WaEngineError('INVALID_INPUT', 'zone names are 1-128 characters with no control characters');
    }
    if (width < 1 || height < 1 || x < 0 || y < 0 || x + width > map.width || y + height > map.height) {
      throw new WaEngineError('ZONE_OUT_OF_BOUNDS', `zone "${name}" must lie inside the ${map.width}x${map.height} map and be at least 1x1`, {
        x,
        y,
        width,
        height,
      });
    }
    const check = await checkZoneProperties(properties, { projectDir: session.projectDir, mapAbs: session.mapAbs, zone: name }, 'strict');
    if (check.errors.length > 0) {
      const [first] = check.errors;
      throw new WaEngineError(first!.code, first!.message, { errors: check.errors.map((e) => e.toJSON()) });
    }
    const state = session.state ?? emptyState(DEFAULT_ASSET_SET, map);
    // A room owns the area named after it, even before the build has written one.
    if (state.rooms.some((room) => room.id === name)) {
      throw new WaEngineError('ZONE_OWNED_BY_ROOM', `zone "${name}" belongs to the room "${name}"; change that room's waProperties in the DSL and rebuild`, { name });
    }
    ensureStandardLayers(map);
    const pixelRect = { x: x * TILE, y: y * TILE, width: width * TILE, height: height * TILE };
    const objectId = upsertArea(map, state, { name, rect: pixelRect, values: check.values, origin: 'tool' });
    return { result: { objectId, pixelRect, warnings: check.warnings }, write: { state } };
  });
}

export function areaProperty(object: TiledObject, key: string): unknown {
  return getProperty(object, key)?.value;
}
