#!/usr/bin/env bash
# Draws the VarCamp 2025 sample venue into a WorkAdventure map project (a map-starter-kit
# checkout with its tilesets/ folder) using only wa-agent-engine CLI commands. Everything it
# prints is the evidence transcript: each command, then its JSON result.
#
# Usage: examples/varcamp-venue.commands.sh <absolute project dir> [map path]
# It runs wa-agent-engine when that is installed, and npx -y wa-agent-engine@0.1.0 otherwise.
# WA_AGENT_ENGINE overrides the command; it is split on spaces into the command and its
# arguments. The map must not exist yet (scaffold refuses to replace it).
set -euo pipefail

PROJECT="${1:?usage: $0 <absolute project dir> [map path]}"
MAP="${2:-varcamp-venue.tmj}"
HERE="$(cd "$(dirname "$0")" && pwd)"
if [[ -n "${WA_AGENT_ENGINE:-}" ]]; then
  read -r -a WAE <<< "$WA_AGENT_ENGINE"
elif command -v wa-agent-engine > /dev/null; then
  WAE=(wa-agent-engine)
else
  WAE=(npx -y wa-agent-engine@0.1.0)
fi

json() {
  local s=${1//\\/\\\\}
  printf '"%s"' "${s//\"/\\\"}"
}
BASE="\"projectDir\":$(json "$PROJECT"),\"mapPath\":$(json "$MAP")"

# Runs one command; the project and map are added to every input. The transcript shows the
# input without them (and the build's layout by file name).
step() {
  local command=$1 input=${2:-} shown=${3:-}
  printf '\n$ wa-agent-engine %s --input {%s}\n' "$command" "${shown:-$input}"
  "${WAE[@]}" "$command" --input "{$BASE${input:+,$input}}"
}

# 1. An empty 43x24 map with the standard layers; players arrive in the registration hall.
step scaffold '"width":43,"height":24,"spawn":{"x":4,"y":19},"mapName":"VarCamp 2025","mapDescription":"An Open Space for Tech, Creativity & Beyond"'

# 2. Eight rooms with shared walls, doors, furniture, room zones and a variable.
step build "\"dsl\":$(cat "$HERE/varcamp-venue.dsl.json")" '"dsl": <examples/varcamp-venue.dsl.json>'

# 3. A few extra pieces placed one by one.
step prefab '"prefabId":"phone-pod-2x2","x":39,"y":9'
step prefab '"prefabId":"plant-small-1x1","x":21,"y":14'
step prefab '"prefabId":"plant-small-1x1","x":1,"y":21'

# 4. Zones that are not a whole room.
step zone '"name":"entry","x":3,"y":18,"width":3,"height":3,"properties":{"start":true}'
step zone '"name":"to-office","x":10,"y":22,"width":2,"height":2,"properties":{"exitUrl":"office.tmj#from-conference"}'
step zone '"name":"info-desk","x":9,"y":18,"width":4,"height":1,"properties":{"openWebsite":"https://var.camp/","openWebsiteTrigger":"onaction","openWebsiteTriggerMessage":"Press SPACE to open the VarCamp website"}'
step zone '"name":"quiet-corner","x":18,"y":18,"width":4,"height":3,"properties":{"silent":true}'
step zone '"name":"ask-varcamp","x":30,"y":17,"width":4,"height":3,"properties":{"ai-zone":true,"description":"Ask about the VarCamp 2025 schedule, the tracks and the hosts"}'

# 5. Check the map, then render it to look at.
step validate ''
step render '"scale":1'
