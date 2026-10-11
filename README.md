# wa-agent-engine

wa-agent-engine lets a coding agent such as Claude Code draw [WorkAdventure](https://workadventu.re) maps. You describe a venue in plain words; the agent lays out the rooms, and the engine turns that layout into a real Tiled map:

- walls, wall faces, floors, collisions and doors, drawn with the tilesets of your WorkAdventure map project;
- a name and details on every room's wall, so people find their way;
- furniture from a catalog of 69 prefabs (desks, stages, sofas, plants, trees, phone booths and more), plus furniture made from your own prop images;
- whole worlds: separate buildings on grass, joined by roads and plazas, with rivers, bridges and forests;
- WorkAdventure zones for meetings, websites, audio, exits and entry points;
- a check against WorkAdventure's rules;
- a PNG preview, so the agent can see what it built and fix it.

The result is an ordinary `.tmj` file that WorkAdventure loads and that you can keep editing in [Tiled](https://www.mapeditor.org/).

The engine reaches agents through an MCP server, a CLI and two agent skills. It is tested with Claude Code; [docs/agent-setup.md](docs/agent-setup.md) also covers Codex, Cursor and Pi.

## Quick start

You need **Node.js 26 or newer** and an agent that supports MCP. These steps use Claude Code.

### 1. Get a WorkAdventure map project

The engine draws with the tileset images of a WorkAdventure map project. Start from the official [map-starter-kit](https://github.com/workadventure/map-starter-kit):

```bash
git clone https://github.com/workadventure/map-starter-kit my-venue
cd my-venue
npm install
```

If `npm install` stops because `pngquant failed to build`, see [Troubleshooting](#troubleshooting).

### 2. Connect your agent

Register the MCP server and install the skills:

```bash
claude mcp add --transport stdio --scope user wa-agent-engine -- npx -y wa-agent-engine@0.2.0 mcp
npx skills add https://github.com/mgkyawzayya/wa-agent-engine/tree/v0.2.0/skills --agent claude-code --global --yes
```

`claude mcp list` should show `wa-agent-engine: … ✔ Connected`. Setup for Codex, Cursor and Pi is in [docs/agent-setup.md](docs/agent-setup.md).

### 3. Ask for a map

Start your agent in the map project and describe the venue, for example:

> Use the wa-map-design skill to draw a small coworking space in this project: a reception with the entry point, an open desk area for eight people, a meeting room with a video call, and a kitchen. Save it as `cowork.tmj` and show me the preview.

The agent scaffolds the map, builds the rooms, places furniture, adds zones, validates the result and shows you the preview. When something is wrong, the engine answers with an error code that tells the agent what to fix.

### 4. Walk around it in WorkAdventure

The starter kit serves your maps locally, and WorkAdventure's public test server can load them from your computer:

```bash
npm run dev      # in the map project; serves http://localhost:5173
```

Open the test link on http://localhost:5173, or go straight to `https://play.workadventu.re/_/test/localhost:5173/cowork.tmj` (any name works in place of `test`). Nothing is uploaded: your browser loads the map from your computer.

When the map is ready to share, publish it with the starter kit's `npm run upload` (see its README).

## How it works

```
your brief ──▶ agent + wa-map-design skill ──▶ MCP tools ──▶ cowork.tmj + preview
                  (plans rooms, doors,          (draw, check,
                   furniture and zones)          render)
```

The agent writes the venue as a small JSON layout: rooms with bounds, doors, furniture and zone properties. Rooms share walls; doors sit on a wall at an offset. The engine turns the layout into tiles using an **asset set**, a description of which tile in the tilesets is a wall piece, a face, a floor or a lintel, plus the furniture prefabs.

The package ships one asset set, `wa-starter-office`, for the starter kit's tilesets. It holds tile ids only, no pixels: the art always comes from your map project. The `wa-asset-set-onboarding` skill shows an agent how to describe another tileset.

For a campus, a park or a village, the layout also takes a `ground` style, `paths` and plazas, `water` for rivers and ponds (bridges appear where a path crosses), and `scatter` areas of trees, bushes and flowers; the skill's [world recipe](skills/wa-map-design/references/world-recipe.md) shows how to plan one.

The layout format, the prefab catalog and the zone properties are documented in the skill's references: [layout](skills/wa-map-design/references/dsl-reference.md), [prefabs](skills/wa-map-design/references/prefab-catalog.md), [zones](skills/wa-map-design/references/zone-properties.md).

## The tools

The MCP server (`wa-agent-engine mcp`, over stdio) and the CLI expose the same seven tools from one table, with the same results and error codes.

| MCP tool | CLI command | What it does |
|---|---|---|
| `scaffold_map` | `scaffold` | Creates an empty map with the standard layers, the embedded tilesets and a spawn tile. It never replaces an existing map unless asked to. |
| `build_room_from_dsl` | `build` | Draws the rooms from the layout, and the world around them when the layout has one. Each build replaces the previous one exactly; tiles drawn by hand outside rooms, paths and water stay. |
| `place_prefab` | `prefab` | Places one furniture prefab without overwriting anything or blocking a door. |
| `configure_wa_zone` | `zone` | Creates or updates a named WorkAdventure area with checked properties. |
| `validate_wa_map` | `validate` | Checks any Tiled map against WorkAdventure's rules. Read-only. |
| `render_map_preview` | `render` | Renders a PNG preview into `.wa-preview/`. Over MCP it also returns the image. |
| `import_prop_set` | `import-props` | Turns your own prop images (PNGs in 32 px tile multiples) into furniture prefabs, in a set that extends the starter kit's. |

Every failure carries a code from a closed list (`ERROR_CODES`, plus `VALIDATION_CODES` for validation issues), so an agent can act on the code instead of the message.

## Using the CLI

Agents that can run shell commands, and people, can use the CLI without MCP. Every command reads one JSON object (`--input '<json>'`, `--input-file <path>`, or `--input -` for stdin) and prints JSON. `npx -y wa-agent-engine@0.2.0 <command> --help` shows a command's input schema.

```bash
npm install -g wa-agent-engine@0.2.0     # or prefix each command with npx -y wa-agent-engine@0.2.0
P=/absolute/path/to/my-venue

wa-agent-engine scaffold --input "{\"projectDir\":\"$P\",\"mapPath\":\"venue.tmj\",\"width\":24,\"height\":16,\"spawn\":{\"x\":3,\"y\":13}}"

wa-agent-engine build --input "{\"projectDir\":\"$P\",\"mapPath\":\"venue.tmj\",\"dsl\":{
  \"mapWidth\":24,\"mapHeight\":16,\"assetSet\":\"wa-starter-office\",
  \"rooms\":[
    {\"id\":\"talks\",\"bounds\":{\"x\":0,\"y\":0,\"width\":12,\"height\":9},
     \"doors\":[{\"wall\":\"south\",\"offset\":5,\"width\":2}],
     \"furniture\":[{\"prefabId\":\"lectern-1x1\",\"x\":5,\"y\":4}],
     \"waProperties\":{\"jitsiRoom\":\"talks\"}},
    {\"id\":\"hall\",\"bounds\":{\"x\":0,\"y\":8,\"width\":24,\"height\":8}}]}}"

wa-agent-engine validate --input "{\"projectDir\":\"$P\",\"mapPath\":\"venue.tmj\"}"
wa-agent-engine render   --input "{\"projectDir\":\"$P\",\"mapPath\":\"venue.tmj\",\"scale\":0.5}"
```

`projectDir` is always the absolute path of the map project (the folder with `tilesets/`). A room's bounds include its walls, and neighbouring rooms share one wall line, which is why the hall starts at `y` 8 where the talk room ends.

Exit codes: 0 means success; 1 means a tool error or invalid input, with a JSON error body such as `{"error":{"code":"THICK_WALL","message":"…"}}`; 2 means an unknown command or flag.

## Sample: VarCamp 2025 venue

[`examples/varcamp-venue.dsl.json`](examples/varcamp-venue.dsl.json) is a full venue for [VarCamp 2025](https://var.camp/): a talk room, a workshop, a lounge, a registration hall, a game corner, a sponsor room and two phone booths. [`examples/varcamp-venue.commands.sh`](examples/varcamp-venue.commands.sh) draws it into a map project with CLI commands only, and prints a transcript of every command and its result:

```bash
examples/varcamp-venue.commands.sh /absolute/path/to/my-venue
```

It writes `varcamp-venue.tmj` (pass another map path as the second argument) and uses `wa-agent-engine` when installed, `npx -y wa-agent-engine@0.2.0` otherwise, or the command in `WA_AGENT_ENGINE`. The lounge's `playAudio` URL is a placeholder on example.com; point it at real audio before you use the map.

## Working alongside Tiled

The engine writes a map only if the file on disk is still the version it read, and holds a lock file next to the map while it writes.

- Save in Tiled before an agent edits the map, and reload in Tiled afterwards.
- If an agent gets `MAP_CHANGED_ON_DISK`, it should read the map again and retry.
- Rooms built from the layout belong to the engine: a rebuild redraws them. Furniture placed with `place_prefab` is put back after a rebuild, or removed with a warning if the new rooms leave no space for it. If you edited such a piece in Tiled, the engine leaves your version alone.

Add `.wa-preview/` and `.*.tmj.lock` to your map project's `.gitignore`.

## Troubleshooting

- **"wa-agent-engine needs Node.js 26 or newer".** The `node` your agent finds is older. With nvm, run `nvm install 26 && nvm alias default 26`, or give the agent the Node 26 path ([docs/agent-setup.md](docs/agent-setup.md#1-node-version)).
- **`pngquant failed to build` during `npm install` in the starter kit.** The kit's image optimiser needs libpng. Either `brew install libpng` (macOS) and retry, or skip it, since only map publishing uses it: `npm install --ignore-scripts && npm rebuild sharp`.
- **The agent does not use the skills.** Ask for them by name ("use the wa-map-design skill"). Agents with many installed skills may list them by name only.
- **`MAP_EXISTS`.** `scaffold_map` never replaces a map; pick another map path, or ask the agent to rebuild the existing one.

## Art and licences

The engine ships no artwork. It draws with the tileset images in your map project. Don't commit or redistribute the starter kit's tileset PNGs, or previews rendered from them, outside a WorkAdventure map project. Previews go to `.wa-preview/` in your project.

- **Tilesets:** WorkAdventure, from the [map-starter-kit](https://github.com/workadventure/map-starter-kit) at commit `1143646a`, under its [assets licence](https://github.com/workadventure/map-starter-kit/blob/1143646a9c02c3928eac4acbb123642c62a48a85/LICENSE.assets). Each embedded tileset carries this notice in its `tilesetCopyright` property, and every map the engine scaffolds carries a `mapCopyright`.
- **Furniture arrangements:** 26 of the 35 prefabs adapt arrangements from the starter kit's `office.tmj` and `conference.tmj` ([CC-BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)). Those prefabs carry `credit` and `license` properties. This describes what the files hold; it is not legal advice.
- **The engine:** the code, skills and docs are under the [MIT licence](LICENSE). The asset data above keeps its own terms.

## Development

```bash
git clone https://github.com/mgkyawzayya/wa-agent-engine
cd wa-agent-engine
npm ci
npm run fetch-assets    # downloads the pinned starter-kit maps and tilesets into .cache/ (gitignored)
npm test                # unit, end-to-end and packaging tests
npm run typecheck
npm run build
npm run smoke           # runs the built CLI
npm run check-skills    # checks the skills and these docs against the tool table
```

The tests use the cached starter kit and store only hashes of rendered images, never the images. To try a local build in an agent, `npm pack` and point the MCP command at the tarball: `npx -y --package=/absolute/path/wa-agent-engine-0.2.0.tgz wa-agent-engine mcp`.
