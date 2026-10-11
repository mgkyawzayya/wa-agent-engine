import { fetchStarterKit } from '../../scripts/fetch-starter-kit.js';

// Runs once per test session. Cached files with a matching hash are skipped, so this is a
// no-op once `npm run fetch-assets` has populated .cache/.
export default async function setup(): Promise<void> {
  try {
    await fetchStarterKit();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Starter-kit tileset cache is unavailable. Run \`npm run fetch-assets\` (needs network once).\n${reason}`);
  }
}
