import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pinned WorkAdventure map-starter-kit commit. Its tileset PNGs are licensed for WA maps
// only, so they are cached under .cache/ for tests and scripts and never committed or shipped.
// The shipped CLI never reads this cache.
export const STARTER_KIT_REPO = 'workadventure/map-starter-kit';
export const STARTER_KIT_SHA = '1143646a9c02c3928eac4acbb123642c62a48a85';

export const STARTER_KIT_FILES: readonly string[] = [
  'office.tmj',
  'conference.tmj',
  'conference.png',
  'tilesets/WA_Decoration.png',
  'tilesets/WA_Exterior.png',
  'tilesets/WA_Logo_Long.png',
  'tilesets/WA_Miscellaneous.png',
  'tilesets/WA_Other_Furniture.png',
  'tilesets/WA_Room_Builder.png',
  'tilesets/WA_Seats.png',
  'tilesets/WA_Special_Zones.png',
  'tilesets/WA_Tables.png',
  'tilesets/WA_User_Interface.png',
];

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function starterKitCacheDir(root: string = REPO_ROOT): string {
  return join(root, '.cache', 'starter-kit', STARTER_KIT_SHA);
}

export function starterKitRawUrl(path: string): string {
  return `https://raw.githubusercontent.com/${STARTER_KIT_REPO}/${STARTER_KIT_SHA}/${path}`;
}
