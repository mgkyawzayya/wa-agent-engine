#!/usr/bin/env node
// The wa-agent-engine bin. The Node check runs before anything else is loaded, so an older
// Node gets this message instead of a syntax or API error from deeper in the engine.
const major = Number(process.versions.node.split('.')[0]);
if (major < 26) {
  console.error(`wa-agent-engine needs Node.js 26 or newer, but this is Node.js ${process.versions.node}. Install Node 26 (for example with nvm) and try again.`);
  process.exit(1);
}
const { main } = await import('./main.js');
process.exitCode = await main(process.argv.slice(2));
