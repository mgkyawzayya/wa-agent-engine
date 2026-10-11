import { stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import type { AutomapReport } from '../../schemas/automap.schema.js';
import type { Rect } from '../../schemas/dsl.schema.js';
import { getProperty } from '../../schemas/tiled.schema.js';
import { ENGINE_STATE_PROPERTY } from '../engine-state.js';
import { assertWhole, WaEngineError } from '../errors.js';
import { readMap, serializeMap, withMapLock, writeMap } from '../map-io.js';
import { resolveMap } from '../map-session.js';
import { automap } from './engine.js';
import { loadRules } from './rules-file.js';
import { resolveExternalTilesets } from './tiles.js';

// automap_map: applies a project's Tiled rules file to a map file, in one locked, atomic
// read-modify-write.

export interface AutomapMapOptions {
  projectDir: string;
  mapPath: string;
  rules?: string;
  region?: Rect;
  seed?: number;
  dryRun?: boolean;
}

export interface AutomapMapResult extends AutomapReport {
  written: boolean;
}

const errnoOf = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;

// Whether a default rules file is there: only "not found" means absent; any other failure is
// reported rather than silently falling back to another rules file.
async function present(abs: string, shown: string): Promise<boolean> {
  try {
    return (await stat(abs)).isFile();
  } catch (err) {
    const errno = errnoOf(err);
    if (errno === 'ENOENT' || errno === 'ENOTDIR') return false;
    throw new WaEngineError('AUTOMAP_RULES_INVALID', `rules file cannot be read (${errno ?? 'error'}): ${shown}`, { rules: shown });
  }
}

// The rules file, as given (not resolved through links, as Tiled reads it): the one named,
// else rules.txt next to the map, else rules.txt in the project. loadRules checks it lies
// inside the project.
async function findRules(options: AutomapMapOptions): Promise<string> {
  const root = resolve(options.projectDir);
  if (options.rules !== undefined) {
    if (isAbsolute(options.rules) || /^[A-Za-z]:/.test(options.rules)) {
      throw new WaEngineError('PATH_OUTSIDE_PROJECT', `expected a path relative to the project: ${options.rules}`);
    }
    return resolve(root, options.rules);
  }
  const mapDir = dirname(options.mapPath);
  for (const shown of [`${mapDir === '.' ? '' : `${mapDir}/`}rules.txt`, 'rules.txt']) {
    if (await present(resolve(root, shown), shown)) return resolve(root, shown);
  }
  throw new WaEngineError('AUTOMAP_RULES_NOT_FOUND', 'no rules.txt next to the map or in the project; name a rules file with "rules"');
}

export async function automapMap(options: AutomapMapOptions): Promise<AutomapMapResult> {
  if (options.seed !== undefined && (!Number.isSafeInteger(options.seed) || options.seed < 0)) {
    throw new WaEngineError('INVALID_INPUT', 'seed must be a whole number of 0 or more');
  }
  const { projectDir, mapAbs } = await resolveMap(options.projectDir, options.mapPath);
  // The map is checked before the rules, so a wrong mapPath is reported as such.
  try {
    if (!(await stat(mapAbs)).isFile()) throw new Error('not a file');
  } catch {
    throw new WaEngineError('MAP_NOT_FOUND', `map not found: ${options.mapPath}`);
  }
  // The rules do not depend on the map's content, so they load before the lock is taken.
  const rules = await loadRules(options.projectDir, await findRules(options));

  return withMapLock(mapAbs, async () => {
    const { map, sha256 } = await readMap(mapAbs);
    const region = options.region;
    if (region !== undefined) {
      assertWhole({ 'region.x': region.x, 'region.y': region.y, 'region.width': region.width, 'region.height': region.height });
      if (region.width < 1 || region.height < 1 || region.x < 0 || region.y < 0 || region.x + region.width > map.width || region.y + region.height > map.height) {
        throw new WaEngineError('INVALID_INPUT', `region must be at least 1x1 and lie inside the ${map.width}x${map.height} map`, { region });
      }
    }
    const externalTilesets = await resolveExternalTilesets(projectDir, map, mapAbs);
    const working = structuredClone(map);
    const report = automap(working, rules, {
      mapFileName: basename(options.mapPath),
      mapAbs,
      externalTilesets,
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
      ...(region !== undefined ? { region } : {}),
    });
    if (getProperty(map, ENGINE_STATE_PROPERTY) !== undefined) {
      report.warnings.push({
        code: 'AUTOMAP_ON_ENGINE_MAP',
        message: 'this map has a wa-agent-engine build record: build_room_from_dsl does not re-run these rules, and a rebuild may undo their tiles inside built rooms',
      });
    }
    let written = false;
    if (options.dryRun !== true && serializeMap(working) !== serializeMap(map)) {
      await writeMap(mapAbs, working, { projectDir, expectedSha256: sha256 });
      written = true;
    }
    return { ...report, written };
  });
}
