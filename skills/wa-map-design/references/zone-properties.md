# WorkAdventure zone properties

A zone is a WorkAdventure area: a named rectangle in the map that does something when a player walks into it. Zones come from two places, and both take the same keys with the same checks:

- a room's `waProperties` in the DSL, which makes an area named after the room `id` over its walkable inside;
- the `properties` of `configure_wa_zone` (CLI command `zone`), for any other rectangle, such as an entry, an exit, or a website corner.

The engine accepts only the keys below. An unknown key fails with `INVALID_ZONE_PROPERTY`, so a typo never becomes a property WorkAdventure silently ignores. The old `playAudioLoop` key is refused with a hint to use `audioLoop`.

## Keys

The Tiled type column is the property type the engine writes, which is what Tiled shows.

### Meetings

| Key | Value | Tiled type | Meaning |
|---|---|---|---|
| `jitsiRoom` | non-empty string | string | The name of a Jitsi video meeting that players join when they enter. WorkAdventure prefixes it with a hash of the room URL, so two maps with the same name do not share a meeting by accident. |
| `jitsiTrigger` | `onaction` | string | The meeting opens only when the player presses Space, after a prompt. Without it, the meeting opens on entering. |
| `jitsiTriggerMessage` | string | string | The text of that prompt. |
| `jitsiConfig` | string holding a JSON object | string | Overrides Jitsi's `config.js`, for example `{"startWithAudioMuted": true}`. The engine refuses text that is not a JSON object. |
| `jitsiWidth` | number, 1 to 100 | float | The width of the meeting panel, in percent of the screen. |
| `jitsiClosable` | boolean | bool | Whether the meeting panel has a close button. |
| `jitsiNoPrefix` | boolean | bool | `true` drops the room-URL prefix, so several WorkAdventure rooms can share one Jitsi meeting. |

### Silence and sound

| Key | Value | Tiled type | Meaning |
|---|---|---|---|
| `silent` | boolean | bool | `true` makes a silent zone: players inside cannot start or join proximity conversations. |
| `playAudio` | string | string | An audio file, usually MP3, that plays while a player is inside. It must be an https URL, or a path relative to the map to a file that exists inside the project. |
| `audioLoop` | boolean | bool | `true` loops the audio. |
| `audioVolume` | number, 0 to 1 | float | The volume. WorkAdventure uses this or the player's own volume, whichever is lower. |

### Websites

| Key | Value | Tiled type | Meaning |
|---|---|---|---|
| `openWebsite` | string | string | A website opened in a side panel when a player enters. An http(s) URL or a relative path; WorkAdventure's documentation asks for https. |
| `openWebsiteTrigger` | `onaction` or `onicon` | string | `onaction`: the site opens when the player presses Space. `onicon`: the player clicks an icon. Without it, the site opens on entering. |
| `openWebsiteTriggerMessage` | string | string | The text of the Space prompt. |
| `openWebsitePolicy` | string | string | The iframe's `allow` attribute, such as `fullscreen; camera; microphone`. Unknown features give a warning. |

### Entries and exits

| Key | Value | Tiled type | Meaning |
|---|---|---|---|
| `start` | boolean | bool | `true` makes the area an entry point named after the area. A URL or `exitUrl` ending in `#<area name>` lands players here. |
| `exitUrl` | string | string | Where players go when they step in: another map relative to this one, such as `garden.tmj#entry`, or a full room URL. The part after `#` names the entry area of the target map. Cover every cell of an exit door with such a zone. |

### Camera

| Key | Value | Tiled type | Meaning |
|---|---|---|---|
| `focusable` | boolean | bool | `true` makes the camera zoom to fit the area while a player is inside, which suits talk rooms. |
| `zoomMargin` | number | float | Extra space around a focusable area, as a fraction of its size: 0.5 adds 50%. This is the spelling WorkAdventure documents. |
| `zoom_margin` | number | float | The same as `zoomMargin`; WorkAdventure's code reads both spellings. Prefer `zoomMargin`. |

### AI and description

| Key | Value | Tiled type | Meaning |
|---|---|---|---|
| `ai-zone` | boolean | bool | `true` marks the area for AI bots. WorkAdventure's own bot example map marks areas this way, and the Stage B NPC lists these areas with their descriptions. |
| `description` | string, up to 500 characters | string | A plain description of what happens in the area, read by AI bots, for example "Game corner: board games between sessions." Treat it as public text. |

## URL rules

The engine checks every URL it writes and never fetches one.

- `openWebsite` and `exitUrl` accept an absolute `http:` or `https:` URL, or a true relative path: no scheme, no leading `//`, and no backslash, so that it stays on the map's own server. `javascript:`, `data:` and protocol-relative values fail with `BAD_URL`.
- `playAudio` accepts an `https:` URL, or a path relative to the map that points at a file inside the project. A missing file fails with `BAD_URL`.
- Values with `{{` templates are refused (`INVALID_ZONE_PROPERTY`). WorkAdventure fills templates only on dynamic areas, which the engine never makes.

## Room areas and tool zones

- A room's area belongs to the DSL. `configure_wa_zone` with a room's `id` fails with `ZONE_OWNED_BY_ROOM`; change the room's `waProperties` and build again. A rebuild removes keys you took out of `waProperties` and keeps keys someone added in Tiled.
- A zone made with `configure_wa_zone` is updated by calling it again with the same `name`: the rectangle moves to the new one and the new properties are merged in. Keys are never removed this way.
- An area the user drew in Tiled is never changed. A zone or room with its name fails with `ZONE_NAME_TAKEN`.
- Zone names are 1 to 128 characters without control characters, and must be unique in the map: WorkAdventure renames duplicates, which breaks scripts (`DUPLICATE_AREA_NAME` in validate).
- Zones may overlap each other and rooms.

## Checks on existing maps

`validate_wa_map` checks the zones of any map, including hand-made ones, more leniently: keys it does not know are skipped, because other tools add their own. It reports:

- `INVALID_ZONE_PROPERTY` and `BAD_URL` for known keys with bad values;
- `AREA_WITHOUT_SIZE` for an area of no width or height, which WorkAdventure skips;
- `DUPLICATE_AREA_NAME` for two areas with one name;
- `ORPHAN_ZONE`, a warning, for an area with no WorkAdventure key in a map without a script.

## Examples

These run on the small venue from SKILL.md (a 24 × 14 map with the rooms `daisy` and `hall`):

```bash
npx -y wa-agent-engine@0.3.1 zone --input '{"projectDir": "/path/to/map-starter-kit", "mapPath": "venue.tmj", "name": "standup", "x": 13, "y": 6, "width": 3, "height": 3, "properties": {"jitsiRoom": "VarCamp standup", "jitsiTrigger": "onaction", "jitsiTriggerMessage": "Press SPACE to join the stand-up", "jitsiConfig": "{\"startWithAudioMuted\": true}", "jitsiWidth": 50}}'
npx -y wa-agent-engine@0.3.1 zone --input '{"projectDir": "/path/to/map-starter-kit", "mapPath": "venue.tmj", "name": "schedule", "x": 18, "y": 7, "width": 4, "height": 1, "properties": {"openWebsite": "https://var.camp", "openWebsiteTrigger": "onicon", "openWebsitePolicy": "fullscreen"}}'
npx -y wa-agent-engine@0.3.1 zone --input '{"projectDir": "/path/to/map-starter-kit", "mapPath": "venue.tmj", "name": "music", "x": 20, "y": 9, "width": 3, "height": 3, "properties": {"playAudio": "https://example.com/varcamp/lounge-loop.mp3", "audioLoop": true, "audioVolume": 0.3}}'
npx -y wa-agent-engine@0.3.1 zone --input '{"projectDir": "/path/to/map-starter-kit", "mapPath": "venue.tmj", "name": "quiet-corner", "x": 1, "y": 12, "width": 3, "height": 1, "properties": {"silent": true, "focusable": true, "zoomMargin": 0.5, "ai-zone": true, "description": "Quiet corner at the back of the Daisy talk room."}}'
```

The audio URL is a placeholder on `example.com`: replace it with a real file, or with a path such as `audio/lounge.mp3` that exists in the project.
