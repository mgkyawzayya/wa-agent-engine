# Agent setup

wa-agent-engine reaches an agent in two ways:

- **The MCP server** gives the agent six tools (`scaffold_map`, `build_room_from_dsl`, `place_prefab`, `configure_wa_zone`, `validate_wa_map`, `render_map_preview`).
- **Two skills** teach the agent how to use them:
  - `wa-map-design` turns a venue brief into a validated map;
  - `wa-asset-set-onboarding` describes a new tileset for the engine.

An agent that can run shell commands can also use the CLI (`npx -y wa-agent-engine@0.1.0 <command> --input '<json>'`) without MCP. The skills explain both ways.

Every tool call takes `projectDir`, the absolute path of your WorkAdventure map project (the folder with `tilesets/`). Agents start the server from different working directories, so the server never guesses the project from its own location.

Setup has three steps: make sure agents find Node.js 26, register the MCP server, and install the skills. Always pin the version (`@0.1.0`, `v0.1.0`), as the snippets do, so an update never changes a working setup by surprise.

## 1. Node version

The server needs Node.js 26 or newer, and it must be the `node` your agent finds on its `PATH`. On an older Node, the server prints "wa-agent-engine needs Node.js 26 or newer" on stderr and exits, and the agent reports the server as failed.

With nvm, make 26 the default:

```bash
nvm install 26
nvm alias default 26
```

If an agent still starts an older Node, give it the Node 26 binary explicitly. With the package installed globally (`npm install -g wa-agent-engine@0.1.0` under Node 26), the server command becomes:

```json
{ "command": "/Users/you/.nvm/versions/node/v26.11.1/bin/node", "args": ["/Users/you/.nvm/versions/node/v26.11.1/bin/wa-agent-engine", "mcp"] }
```

## 2. Register the MCP server

The first start downloads the package with `npx`, which can take a few seconds.

### Claude Code

```bash
claude mcp add --transport stdio --scope user wa-agent-engine -- npx -y wa-agent-engine@0.1.0 mcp
claude mcp list        # wa-agent-engine: … - ✔ Connected
```

For one project only, put this in `.mcp.json` at the project root instead:

```json
{ "mcpServers": { "wa-agent-engine": { "type": "stdio", "command": "npx", "args": ["-y", "wa-agent-engine@0.1.0", "mcp"] } } }
```

### Codex

```bash
codex mcp add wa-agent-engine -- npx -y wa-agent-engine@0.1.0 mcp
codex mcp list         # wa-agent-engine … enabled
```

Or add this to `~/.codex/config.toml` (or `.codex/config.toml` in a trusted project). Codex waits 10 seconds for a server by default, and the first `npx` download can take longer:

```toml
[mcp_servers.wa-agent-engine]
command = "npx"
args = ["-y", "wa-agent-engine@0.1.0", "mcp"]
startup_timeout_sec = 60
```

`codex mcp list` only reads the configuration. In a session, `/mcp` shows whether the server started.

### Cursor

Put this in `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{ "mcpServers": { "wa-agent-engine": { "type": "stdio", "command": "npx", "args": ["-y", "wa-agent-engine@0.1.0", "mcp"] } } }
```

Check it with the Cursor Agent CLI:

```bash
cursor-agent mcp list                          # wa-agent-engine: ready
cursor-agent mcp list-tools wa-agent-engine    # the six tools and their arguments
```

### Pi

Pi's default `codemode` exposure wraps MCP tools in code. `direct` makes the six tools first-class:

```bash
pi mcp add wa-agent-engine --exposure direct -- npx -y wa-agent-engine@0.1.0 mcp
pi mcp list            # wa-agent-engine: connected, 6 tools (direct, global)
```

The same in `~/.pi/agent/mcp.json`, or in `.pi/mcp.json` in a trusted project (`pi mcp add -l` writes there):

```json
{ "mcpServers": { "wa-agent-engine": { "command": "npx", "args": ["-y", "wa-agent-engine@0.1.0", "mcp"], "exposure": "direct" } } }
```

## 3. Install the skills

### With the skills CLI

[`skills`](https://github.com/vercel-labs/skills) installs both skills from the `v0.1.0` release of this repository:

```bash
# for all your projects
npx skills add https://github.com/mgkyawzayya/wa-agent-engine/tree/v0.1.0/skills --agent claude-code --global --yes

# for the current project only (writes .claude/skills/)
npx skills add https://github.com/mgkyawzayya/wa-agent-engine/tree/v0.1.0/skills --agent claude-code --yes
```

Use `--agent codex`, `--agent cursor` or `--agent pi` for the other agents (several `--agent` flags are allowed). `--list` shows the skills without installing them.

### By hand

The npm package contains the skills too. Copy both folders into the agent's skills directory:

| Agent | For one user | For one project |
|---|---|---|
| Claude Code | `~/.claude/skills/` | `.claude/skills/` |
| Codex | `~/.agents/skills/` | `.agents/skills/` |
| Cursor | `~/.cursor/skills/` or `~/.agents/skills/` | `.cursor/skills/` or `.agents/skills/` (it also reads `.claude/skills/`) |
| Pi | `~/.pi/agent/skills/` or `~/.agents/skills/` | `.pi/skills/` or `.agents/skills/` |

For example, for Claude Code:

```bash
cd "$(mktemp -d)"
npm pack wa-agent-engine@0.1.0 && tar -xzf wa-agent-engine-0.1.0.tgz
mkdir -p ~/.claude/skills
cp -R package/skills/wa-map-design package/skills/wa-asset-set-onboarding ~/.claude/skills/
```

Codex, Cursor and Pi all read `~/.agents/skills/`, so one copy there serves all three.

### If the agent ignores the skills

Agents list installed skills to the model within a budget. With many skills installed, a skill may reach the model by name only, without its description, so the agent may not pick it up on its own. Ask for it by name: "use the wa-map-design skill".

## 4. Check it works

In a WorkAdventure map project (see the [README quick start](../README.md#quick-start)), ask the agent:

> Use the wa-map-design skill to draw a small venue with a talk room, a lounge and a hall with the entry point in this project, then show me the preview.

The agent should scaffold, build, validate and render, then show the preview. When the engine returns an error, the agent should fix it by its code and try again.

Add `.wa-preview/` and `.*.tmj.lock` to the project's `.gitignore`.

## What has been tested

wa-agent-engine is tested with Claude Code. The Codex, Cursor and Pi sections follow each agent's documented format, and the MCP server was registered and listed in each, but whether those agents load the skills and draw a map has not been tested.

| Agent | Version | MCP server | Skills and a full drawing session |
|---|---|---|---|
| Claude Code | 2.1.296 | `claude mcp list`: ✔ Connected | Tested on 2026-10-11 with the release package: skills installed with the skills CLI; a fresh Sonnet session given only the README's coworking brief drew four rooms with doors, furniture, a video-call zone and the entry point, validated clean, and rendered the preview in 37 seconds. |
| Codex | 0.162.0 | `codex mcp list`: enabled | Not tested. |
| Cursor Agent | 2026.10.01 | `cursor-agent mcp list`: ready; `list-tools` shows all six tools | Not tested. |
| Pi | 1.1.0 | `pi mcp list`: connected, 6 tools (direct, global) | Not tested. |
