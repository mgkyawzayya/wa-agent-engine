---
name: wa-map-design
description: Designs and draws WorkAdventure maps (Tiled .tmj) for online events and offices with the wa-agent-engine tools, from a venue brief to a validated and rendered map. Use it to build, furnish, extend or fix a WorkAdventure venue, room layout, meeting room, entry, exit or zone, for example a VarCamp venue, through the MCP tools scaffold_map, build_room_from_dsl, place_prefab, configure_wa_zone, validate_wa_map, render_map_preview and automap_map, or the wa-agent-engine CLI.
compatibility: Needs Node.js 26 or newer and a WorkAdventure map-starter-kit project with its tilesets folder. Uses the wa-agent-engine MCP server, or the CLI through npx -y wa-agent-engine@0.3.0.
---

# WorkAdventure map design

This skill turns a venue brief into a WorkAdventure map with the engine's map tools. You describe rooms, doors and furniture in a JSON room layout (the DSL). The engine draws the walls, wall faces, floors, collisions, door lintels and zones, and checks that every door can be walked through. Then you add the remaining zones, validate the map, and look at a rendered preview.

The tools never invent art. They place tiles from the user's own map-starter-kit tilesets and furniture prefabs from the built-in asset set `wa-starter-office`, plus the furniture of a prop set when the user has imported one with `import_prop_set` (see section 4).

## 1. Confirm the project

Every tool takes two paths:

- `projectDir`: the absolute path of the user's map project, a checkout of the WorkAdventure map-starter-kit with its `tilesets/` folder of PNG images. Ask the user for it if you do not know it. Do not guess, and do not create a project yourself: that would mean copying tileset images.
- `mapPath`: the map file relative to `projectDir`, ending in `.tmj`, for example `venue.tmj` next to the starter kit's own maps.

If the user has the map open in Tiled, ask them to save it before you start, and to reload it after your edits (see the rules at the end). Before you edit an existing map, run `validate_wa_map` on it and read the report. Errors you did not cause are worth telling the user about before you start. A map someone drew by hand can be edited too. The engine adds its standard layers next to the existing ones, never changes areas it did not create, and records every tile it replaces, so that taking a room out of the DSL later restores what was there.

## 2. Call the tools

When the `wa-agent-engine` MCP server is connected, call its tools directly. Otherwise use the CLI. If the package is installed (`wa-agent-engine --version` prints `0.3.0`), run `wa-agent-engine <command>`. If not, run it through npx, pinned to the version this skill was written for, as the examples below do. Both need Node.js 26: on an older Node the CLI prints a message on stderr and exits 1.

```bash
npx -y wa-agent-engine@0.3.0 <command> --input '<json>'
npx -y wa-agent-engine@0.3.0 <command> --input-file input.json
npx -y wa-agent-engine@0.3.0 <command> --input -
npx -y wa-agent-engine@0.3.0 <command> --help
```

The third form reads the JSON from stdin, and `--help` prints the command's input as a JSON Schema. The CLI input is the same JSON object as the MCP tool's arguments, and the CLI prints the same result as JSON on stdout. It exits 0 on success. On a tool error it exits 1 and prints `{"error": {...}}` with a `code`, a `message` and sometimes `details`. An unknown command or flag exits 2 with a message on stderr.

| Step | MCP tool | CLI command |
|---|---|---|
| Create an empty map | `scaffold_map` | `scaffold` |
| Draw rooms from the DSL | `build_room_from_dsl` | `build` |
| Add one furniture prefab | `place_prefab` | `prefab` |
| Add or update a zone | `configure_wa_zone` | `zone` |
| Check the map | `validate_wa_map` | `validate` |
| Render a preview | `render_map_preview` | `render` |
| Apply Tiled automapping rules: a map with its own `rules.txt`, or a rules file the user names | `automap_map` | `automap` |

Every input, output and exit code is in [references/cli-and-mcp.md](references/cli-and-mcp.md).

## 3. Turn the brief into a room layout

List the spaces the brief asks for, give each a size, and arrange them on a grid of 32 px tiles. Draw the arrangement as a sketch before you write JSON. A room's `bounds` include its walls, and the engine adds two rows of wall face under every north wall, so a room of `height` 13 has 11 inside rows, of which the top 2 are wall faces and 9 are walkable.

The geometry rules, each with the error code the build returns when it is broken:

- **Rooms share wall lines.** Neighbouring rooms overlap by exactly one tile: a room at `x: 0, width: 18` and its east neighbour at `x: 17` share the wall column 17. Rooms that overlap more fail with `ROOM_OVERLAP`.
- **No thick walls.** Two walls side by side, such as a room ending at column 17 and the next starting at column 18, fail with `THICK_WALL`. Share the line instead.
- **Interiors are at least 3 rows.** Bounds must be at least 3 wide and 5 high (`ROOM_TOO_SMALL`), so that one walkable row remains under the two face rows.
- **Doors keep straight wall at both ends.** A door's `offset` counts cells from the west end of a north or south wall, or from the north end of an east or west wall. Keep `offset` at least 2 and `offset + width` at most the wall length minus 2 (`DOOR_AT_CORNER`). Where another wall meets the wall line, keep at least one plain wall cell between it and the door (`DOOR_AT_JUNCTION`). Doors on one wall line need at least 2 wall cells between them (`DOOR_TOO_CLOSE`).
- **Side doors avoid the face rows.** A door on an east or west wall needs `offset` 3 or more, and must also miss the two face rows of the room on the other side (`DOOR_BLOCKED_BY_FACE`).
- **Every door leads somewhere.** Each side of a door must open onto the inside of a room it belongs to, or onto at least 4 connected walkable cells, and furniture must not block it (`DOOR_UNREACHABLE`). A door that opens off the map edge must be marked `"exit": true`, lie on a wall on the map edge (`EXIT_NOT_AT_MAP_EDGE`), and get a zone with `exitUrl` over it later (`EXIT_WITHOUT_EXIT_ZONE`).
- **`modalOrigins` is only for Stage B,** the NPC map script. It lists the https origins that script may open in a modal. Leave it out otherwise.

Furniture positions in the DSL are map coordinates, not coordinates inside the room. Each room with `waProperties` gets a WorkAdventure area of the same name over its walkable inside, below the face rows.

**Name and describe every room.** Give each room a `name` of 2–4 words and `details` that say what happens there ("Keynotes 10:00 and 16:30", "Q&A with the speaker after each talk", "Ask the organizers anything"). The engine writes them as a label on the room's top wall, which WorkAdventure shows; a room without a name has no label. Number rooms of the same kind ("Session Room 3").

**One building or a world.** For one building, scaffold the map exactly as wide and tall as the rooms together: map area outside every room shows as empty void. For a world (a campus, a park, separate buildings in a landscape), set `ground` and add `paths`, `water` and `scatter` around the buildings, and leave space between them: see [references/world-recipe.md](references/world-recipe.md). When the user asks for a big venue or a world, prefer separate buildings on the ground to one block of rooms.

For an event venue, plan the spaces in the venue checklist of [references/event-hall-recipe.md](references/event-hall-recipe.md): lobby with registration and a help desk, main hall, session rooms, Q&A rooms, workshop rooms, an organizer room, a sponsor row, a food court, a games and chill area, and phone booths.

Every field, the styles and a worked example are in [references/dsl-reference.md](references/dsl-reference.md). A complete VarCamp venue with 10 rooms is in [references/varcamp-venue-recipe.md](references/varcamp-venue-recipe.md).

## 4. Furnish from the catalog

The prefab ids, sizes and placement rules are in [references/prefab-catalog.md](references/prefab-catalog.md), grouped into talks, work, social, logistics, fun and phone. It is generated from the asset set, so it is complete: do not use ids that are not in it.

- List the furniture of a room in its DSL `furniture`. The build owns that furniture and redraws it on every rebuild.
- Use `place_prefab` for single extras, such as a plant in a hall. Prefabs placed this way survive rebuilds when there is still room for them.
- A free prefab needs its whole rectangle on floor, below the two face rows, and clear of walls, other furniture and collisions.
- A `north-wall` prefab (wall screen, sponsor booth, snack bar, notice board) hangs on the face rows under an unbroken stretch of north wall, never under a door or a corner. Its `faceRow` sets its row: `upper` puts its top row at the wall row + 1, `lower` at the wall row + 2, and `either` accepts both. For a room's own north wall, the wall row is the room's `bounds.y`.
- Keep the cells in front of every door free.

**Furnish densely, by what happens in the room.** A hall with a few plants on a big empty floor looks unfinished. [references/event-hall-recipe.md](references/event-hall-recipe.md) gives a layout with furniture and counts for every kind of event room: the main hall's stage, screen, lectern and 4–8 audience rows with an aisle; the lobby's registration and help desk with schedule and topic boards; and so on. Vary the furniture between rooms of the same kind.

**Prop sets.** Look for `.wa-asset-sets/*/set.json` files in the project that have an `extends` key: those are prop sets the user imported (for example VarCamp stages, banners, schedule boards and games). To use one, set the DSL `assetSet` (and `place_prefab`'s `assetSet`) to its id; the map keeps the base set's walls and floors and gains the props. Read the prefab ids, sizes and uses from that `set.json`. A map built with the base set can switch to the prop set at the next build. If the user gives you prop images and a hints file, `import_prop_set` makes such a set; see the asset-set onboarding skill.

**Phone booths.** Use one of two patterns:

- the `phone-pod-2x2` prefab, an armchair nook placed inside any room, for example the lounge;
- a walled room of its own. A room 5 wide, with a 1-wide door at `offset` 2 in its north or south wall, works at any height of 5 or more; a 5×5 one has 3 walkable cells. A 4×6 room with a 1-wide door at `offset` 3 in its east or west wall has 2×2 walkable cells. A room only 4 wide cannot take a north or south door, because both of its inside cells touch a corner. Give the booth `waProperties` such as `{"jitsiRoom": "VarCamp phone booth 1", "jitsiTrigger": "onaction"}` so a call starts only when someone asks for it.

## 5. Run the tools in order

1. **Scaffold** the map at the size of the layout. Choose the spawn tile now, because it stays where scaffolding puts it: a walkable cell inside a room, below its two face rows, clear of furniture and of the cells in front of doors. In a world map it may also be on a plaza or a path, away from water. If a later build covers it, `validate_wa_map` warns `START_TILE_BLOCKED`; then move the furniture or the room, or add an entry area with `start` and point people at it.

   ```bash
   npx -y wa-agent-engine@0.3.0 scaffold --input '{"projectDir": "/path/to/map-starter-kit", "mapPath": "venue.tmj", "width": 24, "height": 14, "spawn": {"x": 17, "y": 10}, "mapName": "VarCamp test venue"}'
   ```

2. **Build** the rooms. Send the whole layout every time: each build replaces the previous one, so a room left out of the DSL is removed from the map.

   ```bash
   npx -y wa-agent-engine@0.3.0 build --input '{
     "projectDir": "/path/to/map-starter-kit",
     "mapPath": "venue.tmj",
     "dsl": {
       "mapWidth": 24,
       "mapHeight": 14,
       "assetSet": "wa-starter-office",
       "rooms": [
         {
           "id": "daisy",
           "name": "Daisy Track",
           "details": "Talks all day, Q&A after each talk",
           "bounds": {"x": 0, "y": 0, "width": 12, "height": 14},
           "doors": [{"wall": "east", "offset": 4, "width": 2}],
           "furniture": [
             {"prefabId": "wall-screen-3x2", "x": 4, "y": 1},
             {"prefabId": "stage-light-4x3", "x": 4, "y": 3},
             {"prefabId": "audience-row-6x1", "x": 3, "y": 8},
             {"prefabId": "audience-row-6x1", "x": 3, "y": 10}
           ],
           "waProperties": {"jitsiRoom": "VarCamp Daisy track"}
         },
         {
           "id": "hall",
           "name": "Registration",
           "details": "Badges and help desk",
           "bounds": {"x": 11, "y": 0, "width": 13, "height": 14},
           "floorStyle": "wood-dark",
           "doors": [{"wall": "south", "offset": 5, "width": 2, "exit": true}],
           "furniture": [{"prefabId": "registration-desk-4x3", "x": 18, "y": 4}]
         }
       ]
     }
   }'
   ```

3. **Place** extra prefabs one at a time:

   ```bash
   npx -y wa-agent-engine@0.3.0 prefab --input '{"projectDir": "/path/to/map-starter-kit", "mapPath": "venue.tmj", "prefabId": "plant-tree-1x2", "x": 13, "y": 3}'
   ```

4. **Add zones** that do not belong to one room: an entry area with `start` near the spawn, so other maps can send players to `venue.tmj#entry`, and an `exitUrl` zone over every exit door. Websites, sponsor links and similar zones go here too. The keys and their rules are in [references/zone-properties.md](references/zone-properties.md).

   ```bash
   npx -y wa-agent-engine@0.3.0 zone --input '{"projectDir": "/path/to/map-starter-kit", "mapPath": "venue.tmj", "name": "entry", "x": 15, "y": 9, "width": 4, "height": 3, "properties": {"start": true}}'
   npx -y wa-agent-engine@0.3.0 zone --input '{"projectDir": "/path/to/map-starter-kit", "mapPath": "venue.tmj", "name": "exit", "x": 16, "y": 13, "width": 2, "height": 1, "properties": {"exitUrl": "garden.tmj#entry"}}'
   ```

5. **Validate**, and fix every error before you go on. Warnings are worth reading but do not break the map.

   ```bash
   npx -y wa-agent-engine@0.3.0 validate --input '{"projectDir": "/path/to/map-starter-kit", "mapPath": "venue.tmj"}'
   ```

6. **Render** a preview and look at it. The MCP tool returns the image; if you get no image, or you use the CLI, open the file at `pngPath`. Add `"overlays": ["zones"]` to outline the areas, and use `"scale": 0.5` or `0.25` for big maps.

   ```bash
   npx -y wa-agent-engine@0.3.0 render --input '{"projectDir": "/path/to/map-starter-kit", "mapPath": "venue.tmj", "overlays": ["zones"]}'
   ```

Check the preview against the brief: every room present and labelled, doors where you meant them, furniture facing the right way, no hall left mostly empty, nothing blocking a doorway. To change the layout, edit the DSL and build again, then validate and render again. Tell the user where the map is, and show or describe the preview.

## 6. Fix errors by code

Branch on `code`, never on the message text. `details` often names the cells, the room or the door involved.

| Code | Usual fix |
|---|---|
| `PROJECT_DIR_INVALID` | `projectDir` must be an absolute path to an existing folder with `tilesets/`. Ask the user for their starter-kit project. |
| `PATH_OUTSIDE_PROJECT`, `PATH_BAD_EXTENSION` | Give `mapPath` relative to `projectDir`, staying inside it, ending in `.tmj`. |
| `INVALID_INPUT` | The input has the wrong shape or an impossible value, such as a fractional tile or a DSL whose size differs from the map. Read the message and fix that field; `--help` shows the schema. |
| `MAP_NOT_FOUND` | Scaffold the map first, or fix `mapPath`. |
| `MAP_EXISTS` | Edit the existing map with the other tools, or pick a new `mapPath`. Pass `"overwrite": true` only when the user asked to replace the map. |
| `MAP_CHANGED_ON_DISK` | The file changed while the tool worked, usually a save in Tiled. Nothing was written. Run the same call again; it reads the file afresh. |
| `MAP_LOCKED` | Another call is writing this map. Retry after a moment. |
| `MAP_PARSE_ERROR`, `MAP_INVALID` | The file is not a valid Tiled JSON map. Tell the user; do not overwrite it. |
| `MAP_TOO_LARGE`, `MAP_FILE_TOO_LARGE` | The engine draws maps of up to 500×500 tiles and reads map files of up to 20 MB. Split the venue into several maps joined by `exitUrl`. |
| `ROOM_TOO_SMALL` | Make the bounds at least 3 wide and 5 high. |
| `ROOM_OUT_OF_BOUNDS`, `FURNITURE_OUT_OF_BOUNDS` | Keep bounds and furniture inside `mapWidth` × `mapHeight`. Furniture uses map coordinates. |
| `ROOM_OVERLAP` | Neighbours share exactly one wall line; a room may not cover another room or a wall already in the map. |
| `THICK_WALL` | Move the rooms so they share one wall line instead of two parallel ones. |
| `DUPLICATE_ROOM_ID`, `DUPLICATE_VARIABLE` | Give every room and variable its own name. |
| `DOOR_OUT_OF_WALL`, `DOOR_AT_CORNER` | Keep `offset` at least 2 and `offset + width` at most the wall length minus 2. |
| `DOOR_AT_JUNCTION` | Move the door so a plain wall cell separates it from any wall that meets this one. |
| `DOOR_BLOCKED_BY_FACE` | Use `offset` 3 or more on east and west walls, and keep clear of the neighbour's two face rows. |
| `DOOR_TOO_CLOSE` | Leave at least 2 wall cells between doors on one wall line. A shared door declared from both rooms must cover the same cells. |
| `DOOR_UNREACHABLE` | Something closes a side of the door: a wall, face rows, furniture, or fewer than 4 walkable cells. Move the door or the furniture, or mark an outside door `exit` on the map edge. |
| `EXIT_NOT_AT_MAP_EDGE` | Only a wall on the map edge can hold an exit door. |
| `EXIT_WITHOUT_EXIT_ZONE` | Add a zone with `exitUrl` that covers every cell of the exit door. |
| `UNKNOWN_STYLE` | Use a `wallStyle` or `floorStyle` from the catalog; `details.available` lists them. |
| `PREFAB_NOT_FOUND` | Use an id from the catalog; `details.available` lists them. |
| `PREFAB_BLOCKED` | The rectangle overlaps a wall, face row, furniture or collision, or lacks floor. `details.conflicts` lists the cells; move the prefab. |
| `PREFAB_PLACEMENT` | A north-wall prefab must sit on the face rows: top row at the wall row + 1 for `upper`, + 2 for `lower`. |
| `PREFAB_OUT_OF_BOUNDS` | The prefab does not fit in the map at that position. |
| `PREFAB_REMOVED` (warning) | A rebuild left no room for a prefab placed with `place_prefab`. `details.reason` is `covered`, `floor-gone`, `wall-gone`, `blocks-door` or `out-of-bounds`. Place it again somewhere else if it is still wanted. |
| `PREFAB_UNTRACKED` (warning) | Someone erased or edited that prefab in Tiled, or it left the asset set (`details.reason`: `erased`, `edited`, `not-in-set`). It stays as it is, and the engine stops managing it. |
| `INVALID_ZONE_PROPERTY` | Unknown key, wrong type, `{{ template }}` value, or a `jitsiConfig` that is not a JSON object. Check [references/zone-properties.md](references/zone-properties.md). |
| `BAD_URL` | Use an http(s) URL or a relative path. `playAudio` needs https or a file in the project; `modalOrigins` entries are bare https origins. |
| `SCATTER_INCOMPLETE` (warning) | A scatter area had less free ground than `count` asked for. Lower the count, widen the area, or move paths and rooms out of it. |
| `START_TILE_BLOCKED` (warning) | The build's water covers the spawn tile. Move the water, or add an entry area with `start` on walkable ground. |
| `LABEL_COVERED` (warning) | Wall furniture covers the room's top wall, so its label overlaps it. Move the screen, board or booth along the wall to leave 2 free tiles, or widen the room. |
| `LABEL_TOO_LONG` (warning) | A room's name or details do not fit on its top wall. Shorten them (name 2–4 words, details one short line), or make the room wider. |
| `ZONE_OWNED_BY_ROOM` | That zone is a room's area. Change the room's `waProperties` in the DSL and build again. |
| `ZONE_NAME_TAKEN` | An area with that name exists and the engine did not make it, or a tool zone holds a new room's id. Choose another name; never take over the user's area. |
| `ZONE_OUT_OF_BOUNDS` | Keep the zone inside the map and at least 1×1. |
| `VARIABLE_NAME_TAKEN` | The map already has a hand-made variable with that name. Rename yours. |
| `SPAWN_OUT_OF_BOUNDS` | Put the spawn tile inside the map, on a walkable cell of a room, or of the ground in a world. |
| `ASSET_SET_NOT_FOUND`, `ASSET_SET_MISMATCH` | Use the set the map was built with (named in the message), or a set that extends it, such as a prop set made with `import_prop_set`. A map cannot go back from a prop set to its base set. |
| `ASSET_SET_EXISTS` | A set with that id is already in the project. Pick another `setId`, or pass `overwrite: true` if the user wants it replaced. |
| `ASSET_SET_LOCKED` | Another import of that set is running. Wait for it, then try again. |
| `ASSET_IMAGE_MISSING`, `TILESET_IMAGE_MISSING` | The project lacks a tileset image the map needs. Check `projectDir`. If the image is really missing, ask the user to restore it from their starter-kit checkout; never copy tileset images yourself. |
| `PREVIEW_TOO_LARGE` | Render with `"scale": 0.5` or `0.25`. |
| `ENGINE_STATE_INVALID` | The engine's build record no longer fits the map, usually because the map was resized in Tiled. Ask the user to undo the change. |
| `TILESET_CONFLICT` | The map has another tileset with the same name as one of the asset set's. Ask the user how to resolve it. |
| `AUTOMAP_RULES_NOT_FOUND` | No `rules.txt` next to the map or in the project, or a rule map it lists is missing. Ask the user for the rules file and pass it as `rules`. |
| `AUTOMAP_RULES_INVALID`, `AUTOMAP_UNSUPPORTED` | A rule map is broken or uses something the engine does not run (`details` says what). Tell the user; do not edit their rule maps. |
| `AUTOMAP_RULES_IGNORED` (warning) | Tiled would ignore that rule-map layer or property too. Mention it to the user. |
| `AUTOMAP_ON_ENGINE_MAP` (warning) | The map has an engine build record: `build_room_from_dsl` does not re-run the rules. If you build rooms on this map, run `automap_map` again afterwards. |
| `WALL_PIECE_MISSING` | The asset set has no tile for a wall shape the layout needs. With `wa-starter-office` this does not happen; with another set, see the asset-set onboarding skill. |
| `LAYER_IS_GROUP`, `LAYER_WRONG_TYPE`, `LAYER_ROLE_UNRESOLVED`, `LAYER_DATA_UNSUPPORTED` | A hand-drawn map uses a layer name the engine needs for something else, or tile data it cannot read (for example an infinite map). Tell the user which layer the message names; do not rename layers yourself. |
| `EXTERNAL_TILESET_UNRESOLVED` | The map links a tileset file instead of embedding it. Ask the user to embed it in Tiled (Map > Embed Tilesets). |
| `IMAGE_TOO_LARGE` | From `render_map_preview`: a tileset image is too large to preview; the map itself is fine, so skip the preview or ask the user about the image. From `import_prop_set`: the props need an atlas over 4096 px tall; split them into several sets. |
| `IO_ERROR` | The file system refused a read or write; `details.errno` says why, for example `EACCES`. Tell the user. |
| `INTERNAL` | An engine bug. Report the message to the user. |

The validator's own codes, such as `WALL_WITHOUT_COLLISION`, `START_TILE_BLOCKED`, `DUPLICATE_AREA_NAME` or `MISSING_COPYRIGHT`, are listed with their meaning in [references/cli-and-mcp.md](references/cli-and-mcp.md).

## 7. Rules

- **Licence.** The tileset images belong to the user's starter-kit project and are licensed for WorkAdventure maps. Never copy, move, upload, commit or embed tileset PNGs anywhere, including into this skill, another project or a repository. Prop images the user gives you for `import_prop_set` are theirs: the tool copies them into the project's own `tilesets/` folder, and that is the only copy to make. The engine reads them where they are. Previews in `.wa-preview/` are made from those images: use them to check the map, and keep them out of version control.
- **Engine ownership.** The DSL is the source of truth for the rooms. Each build first undoes the previous build exactly, then draws the new layout, so walls, faces, floors and DSL furniture of DSL rooms are regenerated every time. Hand edits to those cells in Tiled are lost on the next build. To customise a room, change the DSL or add prefabs. Taking a room out of the DSL and building again removes the room's tiles and restores what was under them; only then is that part of the map free for drawing by hand. The world fields work the same way: ground, paths and water belong to the build like room floors. Ground goes only on empty floor, so floors drawn by hand before stay.
- **Tool prefabs.** A prefab placed with `place_prefab` goes back where it was after a rebuild, or is removed with a `PREFAB_REMOVED` warning and a reason. Read the warnings of every build and place removed prefabs again where they fit.
- **Zones.** A room's area is owned by the DSL; change it through `waProperties`. Areas the user drew by hand are never changed. Calling `configure_wa_zone` again with the same name moves that zone and merges in the new properties; it does not remove keys.
- **Tiled co-editing.** The user may have the map open in Tiled. Before an agent edit, ask the user to save in Tiled. After the edit, the user must reload the map in Tiled before editing there again, or Tiled will save the old version over yours. If a tool returns `MAP_CHANGED_ON_DISK`, read the map again by repeating the call. Never resize an engine-built map in Tiled.
- **Only through the tools.** Change maps with these tools or in Tiled, not by editing the `.tmj` JSON yourself. Do not remove the map properties that start with `wa-agent-engine:`; they hold the build record.
- **Overwrites.** Use `"overwrite": true` on `scaffold_map` only when the user asked for the map to be replaced.

## References

- [references/dsl-reference.md](references/dsl-reference.md): every DSL field, the geometry rules, what a build draws, and a worked example.
- [references/zone-properties.md](references/zone-properties.md): every WorkAdventure zone key with its type and meaning, and the URL rules.
- [references/cli-and-mcp.md](references/cli-and-mcp.md): the tools, their inputs and outputs, exit codes, and the validation codes.
- [references/prefab-catalog.md](references/prefab-catalog.md): the furniture prefabs and the wall and floor styles, generated from the asset set.
- [references/varcamp-venue-recipe.md](references/varcamp-venue-recipe.md): a complete, validated VarCamp venue with every step.
- [references/event-hall-recipe.md](references/event-hall-recipe.md): the spaces of a VarCamp venue and how to furnish each, with built-in and prop-set furniture.
- [references/world-recipe.md](references/world-recipe.md): worlds of separate buildings with ground, paths, plazas, rivers, bridges and forests.
