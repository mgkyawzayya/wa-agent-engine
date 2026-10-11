# Room DSL reference

The DSL is the `dsl` argument of `build_room_from_dsl` (CLI command `build`). It describes the whole room layout of one map. The engine checks it in three passes, and any failure leaves the map file unchanged:

1. its shape (field names and types), which fails with `INVALID_INPUT`;
2. its geometry (sizes, overlaps, doors), which fails with the codes below;
3. the build itself against the map (styles, prefabs, zones, walkable doors).

All positions and sizes are whole tiles of 32 px. `x` grows to the east and `y` to the south; the top-left tile of the map is (0, 0).

## Top level

| Field | Type | Required | Meaning |
|---|---|---|---|
| `mapWidth`, `mapHeight` | whole number, 1 to 500 | yes | The map size in tiles. It must equal the size of the scaffolded map (`INVALID_INPUT`); over 500 fails with `MAP_TOO_LARGE`. |
| `tileSize` | `32` | no | Always 32; the default. |
| `assetSet` | asset set id | yes | `wa-starter-office` for the built-in set. It must be the set the map was scaffolded or first built with (`ASSET_SET_MISMATCH`). |
| `rooms` | array of rooms, up to 200 | yes | Every room of the layout. Rooms left out are removed from the map on the next build. |
| `modalOrigins` | array of up to 20 strings | no | Only for Stage B, the NPC map script: the https origins that script may open in a modal, each a bare origin such as `https://var.camp` (`BAD_URL` otherwise). It is stored in the map property `wa-agent-engine:modalOrigins`; leaving it out removes that property. |
| `variables` | array of variables, up to 100 | no | WorkAdventure variables for map scripts. |

## World

These top-level fields draw the world around the rooms. Leave them out for a single building. [world-recipe.md](world-recipe.md) explains how to plan with them.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `ground` | floor style | no | Every tile no room covers gets this floor, for example `"grass"`, if its floor is empty: floors drawn by hand stay. |
| `paths` | array, up to 100 | no | Each is `{"points": [[x, y], …], "width": 2, "style": "cobble"}` (a line; neighbouring points share x or y) or `{"rect": {…}, "style": …}` (a plaza). `width` is 1 to 12, 2 by default. A path never covers a room or its wall faces. |
| `water` | array, up to 50 | no | The same shapes without `style`: rivers and ponds. Water blocks walking; where a path crosses it, a walkable bridge deck is drawn instead. Needs an asset set with water tiles. Water over a start tile gives the build warning `START_TILE_BLOCKED`. |
| `scatter` | array, up to 50 | no | `{"area": {…}, "prefabs": ["…"], "count": 20, "seed": 1}`: up to `count` free-standing prefabs (at most 500 per area, 5,000 over all areas) at random spots in `area`, clear of rooms, paths, water, the fronts of doors, the spawn and the tiles around it, prefabs placed with `place_prefab`, and each other. A spot that would still cut a door off is skipped, and so is a prefab larger than the area. The same seed gives the same spots. Fewer than `count` fit: build warning `SCATTER_INCOMPLETE`. |

Points, rectangles and scatter areas must lie inside the map, and the points of a line must go straight across or straight down from one to the next; otherwise the DSL fails with `INVALID_INPUT`, naming the path, water or scatter entry. Unknown styles fail with `UNKNOWN_STYLE`.

Everything is redrawn on every build, like the rooms. Ground goes only on tiles whose floor is empty once the previous build is taken off, so floors drawn by hand before stay. The cells the build drew, ground, paths and water included, belong to it like room floors: a later build replaces hand edits on them. Make lasting changes in the DSL.

## Room

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | 1 to 64 letters, digits, `_` or `-`, starting with a letter or digit | yes | Unique in the layout (`DUPLICATE_ROOM_ID`). It is also the name of the room's area, so no other zone may use it. |
| `name` | string, up to 60 characters | no, but give every room one | The room's label: WorkAdventure shows it on the wall at the top of the room, and the preview draws it there too. Keep it to 2–4 words ("Main Hall", "Q&A Room 2"). A room without a name has no label. |
| `details` | string, up to 120 characters | no | One or two short lines under the name: what happens in the room, for example "Talks 10:00–17:00, Q&A after each talk". |
| `bounds` | `{"x", "y", "width", "height"}` | yes | The room rectangle, walls included. It must lie inside the map (`ROOM_OUT_OF_BOUNDS`) and be at least 3 wide and 5 high (`ROOM_TOO_SMALL`). |
| `wallStyle` | string | no | The look of the wall faces inside the room. The built-in set has `white` (the default) and `yellow`. |
| `floorStyle` | string | no | The floor of the room. The built-in set has 14 styles; `wood-light` is the default. An unknown style fails with `UNKNOWN_STYLE`. |
| `doors` | array of doors, up to 16 | no | Openings in the room's walls. |
| `furniture` | array of prefabs, up to 100 | no | Furniture the build stamps and owns. |
| `waProperties` | object of string, number or boolean values | no | WorkAdventure zone properties for the room's area, for example `{"jitsiRoom": "VarCamp Daisy track"}`. They are checked like `configure_wa_zone` properties (`INVALID_ZONE_PROPERTY`, `BAD_URL`); see [zone-properties.md](zone-properties.md). |

**Labels.** The name (16 px, or 13 or 11 px when the room is narrow) and the details (11 px) are dark text on the room's top wall face, left-aligned on the widest stretch of that wall that no door or wall-mounted furniture covers (over a door gap if it must). Every build and every `place_prefab` rewrites them, reading the furniture that is on the wall at that moment; text objects you add yourself are kept. If furniture covers the whole wall, `validate_wa_map` warns `LABEL_COVERED`. A label that cannot fit its wall even at 11 px makes `validate_wa_map` warn `LABEL_TOO_LONG`: shorten the name or details, or widen the room.

Both style lists are at the end of [prefab-catalog.md](prefab-catalog.md#wall-and-floor-styles). Wall faces outside every room use the `brick` style, which cannot be chosen as a `wallStyle`.

## Door

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wall` | `north`, `south`, `east` or `west` | yes | The wall of this room the door is in. |
| `offset` | whole number | yes | Cells from the start of the wall: the west corner for north and south walls, the north corner for east and west walls. The corner cell is 0. |
| `width` | whole number, 1 or more | no | Door width in cells; 1 by default. Use 2 or 3 for big rooms. |
| `exit` | `true` | no | The door opens off the map edge. Its wall must lie on the map edge (`EXIT_NOT_AT_MAP_EDGE`), and a zone with `exitUrl` must cover it before the map validates (`EXIT_WITHOUT_EXIT_ZONE`). |

A door in a wall two rooms share can be declared in either room, or in both if it covers the same cells. Its floor is the floor of the inner room: the south room for a door in a horizontal wall, the east room for a door in a vertical wall.

## Furniture

| Field | Type | Required | Meaning |
|---|---|---|---|
| `prefabId` | string | yes | A prefab id from [prefab-catalog.md](prefab-catalog.md). |
| `x`, `y` | whole number, 0 or more | yes | The map tile of the prefab's top-left cell, in map coordinates rather than room coordinates. It must lie inside the map (`FURNITURE_OUT_OF_BOUNDS`). |

DSL furniture is stamped under the same rules as `place_prefab` and fails with the same codes: `PREFAB_NOT_FOUND`, `PREFAB_OUT_OF_BOUNDS`, `PREFAB_PLACEMENT` and `PREFAB_BLOCKED`. List each piece under the room it stands in; the build records it with that room.

## Variable

| Field | Type | Required | Meaning |
|---|---|---|---|
| `name` | identifier: letters, digits and `_`, not starting with a digit | yes | Unique in the layout (`DUPLICATE_VARIABLE`). A variable with this name that the engine did not create fails with `VARIABLE_NAME_TAKEN`. |
| `default` | any JSON value | yes | The starting value. Strings, numbers and booleans are stored as typed Tiled properties. Objects, arrays and `null` are stored as JSON text with a `VARIABLE_DEFAULT_AS_TEXT` warning, and the map script must parse them. |
| `persist` | boolean | no | `true` saves the value in WorkAdventure's database. Otherwise it lives in server memory and is lost when the room empties or the server restarts. |
| `writableBy` | string | no | The tag a player needs to change the value. The default, `wa-agent-engine`, is a tag no player carries, so on a self-hosted WorkAdventure only Room API calls, such as the Stage B NPC service, can change it. |

Each variable becomes an object of class `variable` in the `wa_zones` layer.

## Geometry rules

| Rule | Code |
|---|---|
| Neighbouring rooms share exactly one wall line; their insides may not overlap another room. | `ROOM_OVERLAP` |
| Walls are one tile thick: two parallel walls side by side are refused. | `THICK_WALL` |
| A room is at least 3 wide and 5 high, so one walkable row stays under the two face rows. | `ROOM_TOO_SMALL` |
| A door fits in its wall. | `DOOR_OUT_OF_WALL` |
| A door keeps a straight wall cell before each corner: `offset` ≥ 2 and `offset + width` ≤ wall length − 2. | `DOOR_AT_CORNER` |
| A door keeps a straight wall cell before any wall that meets its wall line, and no wall crosses it. | `DOOR_AT_JUNCTION` |
| A door in an east or west wall has `offset` ≥ 3, and misses the two face rows of the room on its other side. | `DOOR_BLOCKED_BY_FACE` |
| Doors on one wall line, across all rooms, have at least 2 wall cells between them. | `DOOR_TOO_CLOSE` |
| Each side of a door opens onto the inside of a room it belongs to, or onto at least 4 connected walkable cells, with nothing solid in the doorway. Below a door in a south wall that does not open into another room, the gap it leaves in the two wall-face rows does not count: the 4 cells must lie past the faces. | `DOOR_UNREACHABLE` |
| An exit door lies on a map-edge wall. | `EXIT_NOT_AT_MAP_EDGE` |

To place a room east of another, start it at the other room's `x + width − 1`. To place it south, start it at `y + height − 1`. A long hall under a row of rooms works well: each room gets a door in its south wall, which is the hall's north wall.

## What a build draws

- **Wall tops** on every room's outline, on the `walls` layer, chosen from the asset set's wall pieces by their neighbours, so corners, T-junctions and crossings join up. Walls drawn by hand that touch the new rooms are redrawn to join them too.
- **Wall faces**, two rows under every wall whose south side is open. Inside a room they use the room's `wallStyle`; outside every room they keep the face already there, or use `brick`. No faces are drawn under a door.
- **Floors** on the whole inside of each room and on its door cells.
- **Door lintels** over each door on the foreground layer, so players walk under them.
- **Collisions** on every wall top and wall face, never on doors.
- **Room areas.** Each room with `waProperties` gets an area named after its `id` over its walkable inside: from tile (`x + 1`, `y + 3`), `width − 2` wide and `height − 4` high.
- **Furniture, variables and `modalOrigins`** from the layout.
- **The world** when the layout has one: ground, paths, water and bridges, and scattered prefabs (see [World](#world)).
- **The build record** in the map property `wa-agent-engine:build`: the layout, and the original of every tile the build replaced.

## Rebuilds

Building again is the normal way to change a layout. Each build:

- takes the previous build off first, in reverse order: prefabs placed with `place_prefab`, then DSL furniture and scattered prefabs, then rooms and the world, restoring the tiles that were there before;
- draws the new layout, so cells outside both the old and the new layout stay as they were, and hand edits on cells the build drew are replaced;
- puts each `place_prefab` prefab back where it was, under `place_prefab`'s rules, or removes it with a `PREFAB_REMOVED` warning whose `details.reason` is `covered`, `floor-gone`, `wall-gone`, `blocks-door` or `out-of-bounds`;
- leaves a `place_prefab` prefab that someone erased or edited in Tiled, or that left the asset set, as it is, with a `PREFAB_UNTRACKED` warning (`details.reason`: `erased`, `edited` or `not-in-set`);
- updates room areas: keys removed from `waProperties` are removed, keys someone added in Tiled stay, and the area of a removed room goes;
- removes variables that left the layout.

Building next to walls drawn by hand works: walls touching the new rooms join them, an existing wall inside a new room fails with `ROOM_OVERLAP`, and an existing door in a new room's wall is closed.

## Example

Three rooms: a workshop and a lounge side by side, sharing wall column 13 and joined by a side door, above a hall that has an exit door in the bottom map edge. The map was scaffolded at 30 × 16.

```bash
npx -y wa-agent-engine@0.2.0 scaffold --input '{"projectDir": "/path/to/map-starter-kit", "mapPath": "workshop.tmj", "width": 30, "height": 16, "spawn": {"x": 24, "y": 13}}'
npx -y wa-agent-engine@0.2.0 build --input '{
  "projectDir": "/path/to/map-starter-kit",
  "mapPath": "workshop.tmj",
  "dsl": {
    "mapWidth": 30,
    "mapHeight": 16,
    "assetSet": "wa-starter-office",
    "rooms": [
      {
        "id": "padauk",
        "name": "Padauk workshop",
        "bounds": {"x": 0, "y": 0, "width": 14, "height": 10},
        "wallStyle": "yellow",
        "floorStyle": "wood-dark",
        "doors": [{"wall": "south", "offset": 5, "width": 2}],
        "furniture": [
          {"prefabId": "whiteboard-easel-3x3", "x": 1, "y": 3},
          {"prefabId": "table-long-6x3", "x": 5, "y": 4}
        ],
        "waProperties": {"jitsiRoom": "VarCamp Padauk workshop", "jitsiTrigger": "onaction"}
      },
      {
        "id": "sabal",
        "name": "Sabal lounge",
        "bounds": {"x": 13, "y": 0, "width": 17, "height": 10},
        "floorStyle": "carpet-navy",
        "doors": [{"wall": "west", "offset": 4}],
        "furniture": [
          {"prefabId": "snack-bar-5x3", "x": 20, "y": 2},
          {"prefabId": "lounge-sofa-set-4x4", "x": 15, "y": 5}
        ],
        "waProperties": {"focusable": true, "zoomMargin": 0.3}
      },
      {
        "id": "hall",
        "bounds": {"x": 0, "y": 9, "width": 30, "height": 7},
        "doors": [{"wall": "south", "offset": 20, "width": 2, "exit": true}],
        "furniture": [{"prefabId": "plant-tree-1x2", "x": 1, "y": 12}]
      }
    ],
    "modalOrigins": ["https://var.camp"],
    "variables": [{"name": "doorsOpen", "default": true, "persist": true}]
  }
}'
npx -y wa-agent-engine@0.2.0 zone --input '{"projectDir": "/path/to/map-starter-kit", "mapPath": "workshop.tmj", "name": "exit", "x": 20, "y": 15, "width": 2, "height": 1, "properties": {"exitUrl": "venue.tmj#entry"}}'
npx -y wa-agent-engine@0.2.0 validate --input '{"projectDir": "/path/to/map-starter-kit", "mapPath": "workshop.tmj"}'
```

How the rules apply here:

- The lounge starts at `x: 13`, the workshop's `x + width − 1`, so they share one wall column. The hall starts at `y: 9`, the rooms' `y + height − 1`, so they share one wall row.
- The lounge's west door at `offset` 4 is below both rooms' face rows (rows 1 and 2), and the hall's north wall has a junction at column 13, well away from the workshop door at columns 5 and 6.
- The snack bar is a `north-wall` prefab with `faceRow` `lower`, so its top row sits on row 2, the lounge's wall row 0 plus 2.
- The hall's south wall is the bottom map edge (`y + height` = 16), so its door can be an exit. The `exit` zone covers both door cells, and validate returns `"ok": true`.
