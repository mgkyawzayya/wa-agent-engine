import type { TiledMap } from '../schemas/tiled.schema.js';
import { alignState, readState, writeState, type EngineState } from './engine-state.js';
import { readMap, withMapLock, writeMap } from './map-io.js';
import { assertProjectDir, resolveInProject } from './project-paths.js';

// One guarded, locked read-modify-write of a map: every mutating operation goes through here,
// so each is a single sha-checked write and an error before the write leaves the file as it was.
// The engine state is aligned with the map first (resize refused, renumbered tilesets
// followed), so no edit can save a state that no longer matches the map.

export interface MapSession {
  projectDir: string;
  mapAbs: string;
  map: TiledMap;
  state: EngineState | undefined;
}

export interface SessionOutcome<T> {
  result: T;
  // Omit (or leave undefined) to skip the write.
  write?: { state: EngineState };
}

export async function resolveMap(projectDir: string, mapPath: string): Promise<{ projectDir: string; mapAbs: string }> {
  const realProject = await assertProjectDir(projectDir);
  return { projectDir: realProject, mapAbs: await resolveInProject(realProject, mapPath, { ext: '.tmj' }) };
}

export async function editMap<T>(
  projectDir: string,
  mapPath: string,
  fn: (session: MapSession) => Promise<SessionOutcome<T>>,
): Promise<T> {
  const target = await resolveMap(projectDir, mapPath);
  return withMapLock(target.mapAbs, async () => {
    const { map, sha256 } = await readMap(target.mapAbs);
    const state = readState(map);
    if (state !== undefined) alignState(state, map);
    const outcome = await fn({ ...target, map, state });
    if (outcome.write !== undefined) {
      writeState(map, outcome.write.state);
      await writeMap(target.mapAbs, map, { projectDir: target.projectDir, expectedSha256: sha256 });
    }
    return outcome.result;
  });
}
