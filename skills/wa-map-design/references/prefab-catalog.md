# Prefab catalog: wa-starter-office

<!-- Generated from the built-in asset set's set.json by scripts/gen-prefab-reference.ts. Do not edit by hand; run `npx tsx scripts/gen-prefab-reference.ts`. -->

The built-in asset set `wa-starter-office` (WorkAdventure map-starter-kit office tiles) has 35 prefabs. Use their ids in the room DSL (`rooms[].furniture[].prefabId`) or with `place_prefab`. No other furniture exists: there is no sponsor-logo art, for example.

How to place them:

- A position is the map tile of the prefab's top-left cell. Size is width × height in tiles.
- A free prefab needs its whole rectangle on floor, below the two wall-face rows, and clear of walls, other furniture and collisions. Prefab rectangles may not overlap, even where they look empty.
- A north-wall prefab hangs on the wall-face rows under an unbroken stretch of north wall, never under a door or a corner. The wall row is the row of that wall: for a room's own north wall it is the room's `bounds.y`. Rows of the prefab below the face rows need floor, like a free prefab.
- Keep the cells in front of every door free, or the build fails with `DOOR_UNREACHABLE`.

## Talks: stages, seating, screens

| Prefab | Size | Placement | What it is | Licence |
|---|---|---|---|---|
| `stage-light-4x3` | 4×3 | free | Speaker stage with steps at the front centre; walkable | CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/) |
| `stage-dark-4x3` | 4×3 | free | Darker speaker stage variant; walkable | CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/) |
| `lectern-1x1` | 1×1 | free | Speaker lectern with microphone, on or beside a stage | - |
| `audience-row-2x1` | 2×1 | free | Audience seats facing north; stack rows with one empty row between | CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/) |
| `audience-row-4x1` | 4×1 | free | Audience seats facing north; stack rows with one empty row between | CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/) |
| `audience-row-6x1` | 6×1 | free | Audience seats facing north; stack rows with one empty row between | CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/) |
| `whiteboard-easel-3x3` | 3×3 | free | Flip-chart or session board | CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/) |
| `wall-screen-3x2` | 3×2 | north wall, upper face row (y = wall row + 1) | Projector screen or display; place on the 2 face rows of a north wall | - |
| `info-screen-stand-1x3` | 1×3 | free | Schedule or info display stand | CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/) |

## Work: desks and tables

| Prefab | Size | Placement | What it is | Licence |
|---|---|---|---|---|
| `executive-desk-3x2` | 3×2 | free | Organiser or host desk with a monitor | CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/) |
| `executive-desk-chair-3x3` | 3×3 | free | Desk with a seat behind it | CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/) |
| `table-long-6x3` | 6×3 | free | Workshop or hack table | CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/) |
| `table-long-6x5` | 6×5 | free | Meeting table with 3 chairs a side | CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/) |
| `table-long-4x3` | 4×3 | free | Workshop or hack table | CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/) |
| `table-long-4x5` | 4×5 | free | Meeting table with 2 chairs a side | CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/) |
| `coworking-pod-4x5` | 4×5 | free | Four-seat face-to-face work pod | CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/) |
| `glass-table-4x6` | 4×6 | free | 8-seat glass meeting table | CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/) |
| `cafe-table-3x2` | 3×2 | free | Round cafe or chat table with 3 seats | - |

## Social: lounges, food, plants

| Prefab | Size | Placement | What it is | Licence |
|---|---|---|---|---|
| `lounge-sofa-set-4x4` | 4×4 | free | Lounge or chill-out corner: sofa and coffee table | CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/) |
| `conversation-pit-3x4` | 3×4 | free | Two sofas facing each other over a table | - |
| `armchair-pair-3x2` | 3×2 | free | Two armchairs and a side table for a 1:1 chat | CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/) |
| `kitchen-counter-2x5` | 2×5 | free | Coffee or kitchen counter along a west wall | CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/) |
| `snack-bar-5x3` | 5×3 | north wall, lower face row (y = wall row + 2) | Buffet or snack bar; place with its top row on the lower face row of a north wall | CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/) |
| `low-shelf-2x2` | 2×2 | free | Low shelf or swag table | CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/) |
| `plant-palm-3x3` | 3×3 | free | Large potted palm | CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/) |
| `plant-tree-1x2` | 1×2 | free | Potted tree, for example flanking a door | CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/) |
| `plant-small-1x1` | 1×1 | free | Table-side flowers | - |

## Logistics: registration, sponsors, signs

| Prefab | Size | Placement | What it is | Licence |
|---|---|---|---|---|
| `registration-desk-4x3` | 4×3 | free | Registration or info desk with an "i" sign | CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/) |
| `sponsor-booth-4x4` | 4×4 | north wall, upper face row (y = wall row + 1) | Sponsor table with an empty banner frame (no sponsor-logo art exists); rows 0-1 sit on the face rows of a north wall | CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/) |
| `notice-board-3x1` | 3×1 | north wall, either face row (y = wall row + 1 or + 2) | Wall notice board; place on a face row of a north wall | CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/) |
| `info-sign-1x3` | 1×3 | free | Way-finding or info sign on a stand | - |

## Fun: games and decoration

| Prefab | Size | Placement | What it is | Licence |
|---|---|---|---|---|
| `game-circle-3x3` | 3×3 | free | Board-game or werewolf circle: rug, 4 poufs, round table, balloons | - |
| `pouf-row-4x1` | 4×1 | free | Bean-bag style seating for games | - |
| `party-balloons-1x1` | 1×1 | free | Party decoration | - |

## Phone: call nooks

| Prefab | Size | Placement | What it is | Licence |
|---|---|---|---|---|
| `phone-pod-2x2` | 2×2 | free | Phone or 1:1 call nook: high-back armchair and side table | CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/) |

## Wall and floor styles

- `wallStyle` of a room: `white` (default), `yellow`. It sets the wall faces inside the room.
- Wall faces outside every room use the `brick` style, unless a face is already there. `brick` cannot be chosen as a room's `wallStyle`.
- `floorStyle` of a room:

| Floor style | Tile |
|---|---|
| `wood-light` (default) | WA_Room_Builder tile 350 |
| `wood-dark` | WA_Room_Builder tile 375 |
| `wood-rough` | WA_Room_Builder tile 352 |
| `wood-honey` | WA_Room_Builder tile 353 |
| `wood-walnut` | WA_Room_Builder tile 377 |
| `wood-maple` | WA_Room_Builder tile 378 |
| `boards` | WA_Room_Builder tile 355 |
| `stripe-light` | WA_Room_Builder tile 358 |
| `stripe-grey` | WA_Room_Builder tile 383 |
| `slate-blue` | WA_Room_Builder tile 360 |
| `slate-purple` | WA_Room_Builder tile 385 |
| `carpet-navy` | WA_Room_Builder tile 362 |
| `carpet-red` | WA_Room_Builder tile 387 |
| `grass` | WA_Exterior tile 628 |

## Licences

The licence column covers the furniture arrangement. The CC-BY-SA-3.0 arrangements are adapted from the WorkAdventure map-starter-kit's `office.tmj` or `conference.tmj`. The set's `mapCopyright`, which `scaffold_map` writes into every new map, credits them: keep it. A dash means the arrangement is not adapted from a starter-kit map.

The tiles themselves stay the starter kit's, under the licence in each tileset's `tilesetCopyright`. The engine reads the tileset images from the user's project and never ships or copies them.
