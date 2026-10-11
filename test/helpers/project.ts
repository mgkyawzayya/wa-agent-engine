import { copyFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { starterKitCacheDir } from '../../src/config/starter-kit.js';

export interface TempProject {
  dir: string;
  cleanup: () => Promise<void>;
}

// A throwaway starter-kit-style project (a folder with tilesets/), outside the repo.
export async function makeProject(options: { maps?: string[]; tilesets?: string[] } = {}): Promise<TempProject> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'wa-engine-')));
  await mkdir(join(dir, 'tilesets'));
  const cache = starterKitCacheDir();
  for (const map of options.maps ?? []) await copyFile(join(cache, map), join(dir, map));
  for (const png of options.tilesets ?? []) await copyFile(join(cache, 'tilesets', png), join(dir, 'tilesets', png));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export function cachedMapPath(name: string): string {
  return join(starterKitCacheDir(), name);
}

// Every starter-kit tileset image, for projects that build or render maps.
export const ALL_TILESET_PNGS: readonly string[] = [
  'WA_Decoration.png',
  'WA_Exterior.png',
  'WA_Logo_Long.png',
  'WA_Miscellaneous.png',
  'WA_Other_Furniture.png',
  'WA_Room_Builder.png',
  'WA_Seats.png',
  'WA_Special_Zones.png',
  'WA_Tables.png',
  'WA_User_Interface.png',
];

export function makeFullProject(maps: string[] = []): Promise<TempProject> {
  return makeProject({ maps, tilesets: [...ALL_TILESET_PNGS] });
}
