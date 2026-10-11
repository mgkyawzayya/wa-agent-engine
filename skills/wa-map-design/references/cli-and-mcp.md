# CLI and MCP reference

The engine has nine tools. The MCP server and the CLI are both built from one tool table, so the same input gives the same result and the same coded errors on both, with one exception for malformed input, described below.

## Calling the tools

**MCP.** When the `wa-agent-engine` MCP server is connected, call the tools by name with the input object as arguments. The server is started with `npx -y wa-agent-engine@0.2.0 mcp`, or `wa-agent-engine mcp` when the package is installed, and talks over stdio.

**CLI.** Otherwise run the command with Node.js 26 or newer. With the package installed, `wa-agent-engine <command>` works the same as the `npx` form below:

```bash
npx -y wa-agent-engine@0.2.0 <command> --input '<json>'
npx -y wa-agent-engine@0.2.0 <command> --input-file <path.json>
npx -y wa-agent-engine@0.2.0 <command> --input -
npx -y wa-agent-engine@0.2.0 <command> --help
npx -y wa-agent-engine@0.2.0 --help
```

Pass the input exactly once: inline, from a file, or on stdin with `--input -`. `<command> --help` (or `-h`) prints the description and the input as a JSON Schema. On its own, `--help` lists the commands and `--version` (or `-v`) prints the version. Commands take no other flags.

**Results.**

| Surface | Success | Tool error |
|---|---|---|
| CLI | Exit code 0. The result as JSON on stdout. | Exit code 1. `{"error": {"code": "...", "message": "...", "details": ...}}` on stdout. |
| MCP | `structuredContent` holds the result, and a text block holds the same JSON. `render_map_preview` adds an image block when the PNG is 3.75 MB or smaller (5 MB once base64-encoded). | `isError: true`, with a text block holding `{"error": {...}}`. |

An unknown CLI command or flag exits with code 2 and a message on stderr. `details` is optional and differs per code; it often names cells, rooms or doors. Branch on `code`, never on `message`.

**Malformed input.** When the input has the wrong shape (a missing field, a string where a number belongs, an unknown field), the CLI returns the coded error `INVALID_INPUT` and exits 1. The MCP server rejects it before the tool runs, with `isError: true` and a plain-text message that starts with "Input validation error", not a JSON body. Both are rejections; read the message and fix the field. Inputs with a valid shape but wrong meaning, such as a door at a corner, get the same coded error on both surfaces. Top-level coordinates are plain numbers, so a fraction there gets a coded `INVALID_INPUT` on both; inside `dsl`, a fraction is a shape error.

## Paths and units

- `projectDir` is the absolute path of an existing folder that holds `tilesets/`, normally a checkout of the WorkAdventure map-starter-kit (`PROJECT_DIR_INVALID` otherwise).
- `mapPath` is relative to `projectDir`, stays inside it (`PATH_OUTSIDE_PROJECT`), and ends in `.tmj` (`PATH_BAD_EXTENSION`). Folders in it are created when needed.
- Every position and size is in tiles of 32 px, with (0, 0) at the top-left. Only `configure_wa_zone`'s `pixelRect` and the preview size are in pixels.
- Writes are atomic: each edit reads the map, checks it, and writes it once, and any error leaves the file unchanged. A file that changed on disk since it was read is never overwritten (`MAP_CHANGED_ON_DISK`); a map another call is writing is `MAP_LOCKED`.

## The tools

### `scaffold_map` (CLI command `scaffold`)

Creates a new, empty map: the standard layers, every tileset of the asset set embedded with its copyright, the asset set's `mapCopyright`, and the spawn tile on the `start` layer.

| Input | Type | Required | Meaning |
|---|---|---|---|
| `projectDir`, `mapPath` | string | yes | See above. |
| `width`, `height` | whole number, 1 to 500 | yes | Map size in tiles. |
| `spawn` | `{"x", "y"}` | yes | The tile where players arrive without an entry name (`SPAWN_OUT_OF_BOUNDS` outside the map). |
| `assetSet` | string | no | Asset set id; `wa-starter-office` by default. |
| `mapName`, `mapDescription` | string | no | WorkAdventure map properties shown to players. |
| `script` | string | no | The map script: a file in the project, relative to the map, or an `https:` URL (`SCRIPT_EXTERNAL` warning). Anything else, or a missing file, fails with `BAD_URL`. |
| `overwrite` | boolean | no | Replace an existing map. Without it an existing file fails with `MAP_EXISTS`. |

Output: `mapPath`, `layers` (layer names, bottom to top: `start`, `collisions`, `floor`, `walls`, `furniture`, `floorLayer`, `foreground`, `wa_zones`), `tilesets` (embedded tileset names) and `warnings`.

Every tileset image of the asset set must be in the project, or the call fails with `ASSET_IMAGE_MISSING`.

### `build_room_from_dsl` (CLI command `build`)

Draws the whole room layout from the DSL, replacing the previous build. See [dsl-reference.md](dsl-reference.md).

| Input | Type | Required | Meaning |
|---|---|---|---|
| `projectDir`, `mapPath` | string | yes | See above. |
| `dsl` | object | yes | The room layout. |

Output:

| Field | Meaning |
|---|---|
| `placedCells` | Number of tiles the build placed. |
| `zones` | Names of the room areas, one per room with `waProperties`. |
| `variables` | Names of the variables. |
| `prefabs` | Instances of the DSL furniture, named `b-<room id>-<n>`. |
| `toolPrefabs` | Instances placed with `place_prefab` that are still in the map. |
| `warnings` | Coded warnings such as `PREFAB_REMOVED`, `PREFAB_UNTRACKED`, `VARIABLE_DEFAULT_AS_TEXT` or `ISOLATED_WALL`. |

### `place_prefab` (CLI command `prefab`)

Stamps one prefab, with its collisions, at a tile position. It never overwrites anything.

| Input | Type | Required | Meaning |
|---|---|---|---|
| `projectDir`, `mapPath` | string | yes | See above. |
| `prefabId` | string | yes | An id from [prefab-catalog.md](prefab-catalog.md). A wrong id fails with `PREFAB_NOT_FOUND`, and `details.available` lists the ids. |
| `x`, `y` | whole number | yes | The map tile of the prefab's top-left cell. |
| `assetSet` | string | no | The set to use on a map the engine has not built on yet. On an engine-built map it must be the map's set, or a set that extends it (`ASSET_SET_MISMATCH`). |

Output: `instance` (such as `p1`), `cells` (tiles stamped) and `collisions` (collision cells the prefab carries).

It fails with `PREFAB_BLOCKED` on an occupied or floorless cell, `PREFAB_PLACEMENT` for a north-wall prefab off the face rows, `PREFAB_OUT_OF_BOUNDS` past the map edge, and `DOOR_UNREACHABLE` when it would block an engine-built door.

### `configure_wa_zone` (CLI command `zone`)

Creates or updates a named WorkAdventure area. See [zone-properties.md](zone-properties.md).

| Input | Type | Required | Meaning |
|---|---|---|---|
| `projectDir`, `mapPath` | string | yes | See above. |
| `name` | string, 1 to 128 characters | yes | The area name, unique in the map. Calling again with the same name updates that zone. |
| `x`, `y`, `width`, `height` | whole number | yes | The rectangle in tiles, inside the map and at least 1 × 1 (`ZONE_OUT_OF_BOUNDS`). |
| `properties` | object | yes | WorkAdventure zone properties. |

Output: `objectId` (the Tiled object id), `pixelRect` (`x`, `y`, `width`, `height` in pixels: the tile values times 32) and `warnings`.

### `validate_wa_map` (CLI command `validate`)

Checks any Tiled map, whether the engine built it or someone drew it by hand. It is read-only.

| Input | Type | Required | Meaning |
|---|---|---|---|
| `projectDir`, `mapPath` | string | yes | See above. |
| `assetSet` | string | no | The set for the wall checks; by default the set the map was built with, else `wa-starter-office`. |

Output: `ok` (false when there is any error), `errors` and `warnings`. Each issue has a `code` and a `message`, and may have `layer`, `x`, `y` (tiles) and `objectName`. Each code is reported at most 50 times per layer, and the lists hold at most 200 errors and 100 warnings. When issues were left out, `omitted` says how many (`{"errors": n, "warnings": n}`); fix the listed ones and validate again.

| Code | Severity | Meaning |
|---|---|---|
| `NOT_ORTHOGONAL` | error | WorkAdventure needs an orthogonal map. |
| `TILE_SIZE_NOT_32` | error | Tiles must be 32 × 32 px. |
| `INFINITE_MAP` | error | WorkAdventure rejects infinite maps. |
| `MISSING_FLOOR_LAYER` | error | No top-level object layer named `floorLayer`, or it sits inside a group. |
| `MISSING_START_LAYER` | error | No `start` layer, `startLayer` property, or area named `start`, so players would spawn at the map centre. |
| `START_LAYER_NESTED` | warning | The start layer is inside a group. |
| `START_LAYER_EMPTY` | warning | The start layer has no tiles. |
| `START_TILE_BLOCKED` | warning | A start tile lies under a wall, wall face, furniture or water, so players would spawn stuck. |
| `OVERLAY_ABOVE_FLOOR` | error | The start, collisions or sketch layer (`wa_sketch`, `wa_style`) draws above the floor, so its marker tiles show. |
| `LAYER_DATA_UNSUPPORTED` | error | A tile layer cannot be decoded. |
| `LAYER_SIZE_MISMATCH` | error | A tile layer is not the size of the map. |
| `NON_EMBEDDED_TILESET` | error | An external or image-collection tileset; WorkAdventure needs embedded tilesets with one image. |
| `TILESET_IMAGE_MISSING` | error | A tileset image is not in the project. |
| `COLLIDES_NOT_BOOL` | error | A `collides` tile property is not a bool. |
| `MISSING_COPYRIGHT` | warning | A tileset without `tilesetCopyright`, or a map without `mapCopyright`. Common on maps drawn by hand. |
| `INVALID_GID` | error | A tile id that belongs to no tileset. |
| `ASSET_SET_NOT_FOUND` | warning | The asset set could not be loaded, so the wall checks were skipped. |
| `ASSET_SET_INCOMPLETE` | warning | The asset set has no tile for some wall or door patterns, so rooms that need them fail to build. For a set drawn with automapping rules: its rules draw no tile for the listed pieces (wall patterns, lintels, face variants, floors), or they cannot be loaded. |
| `WALL_WITHOUT_COLLISION` | error | A wall or wall-face tile without a collision, so players walk through it. For a set drawn with automapping rules: a wall or wall-face cell of the sketch (`wa_sketch`) without one. |
| `ISOLATED_WALL` | warning | A wall cell with no wall neighbours. |
| `DOOR_UNREACHABLE` | error | An engine-built door is blocked or leads nowhere. |
| `EXIT_WITHOUT_EXIT_ZONE` | error | An exit door has no area with `exitUrl` over it. |
| `NEGATIVE_COORDS` | error | An object has negative coordinates. |
| `OUT_OF_BOUNDS_OBJECT` | error | An object extends past the map edge. |
| `AREA_WITHOUT_SIZE` | error | An area without width or height, which WorkAdventure skips. |
| `DUPLICATE_AREA_NAME` | error | Two areas share a name; WorkAdventure renames one, which breaks scripts. |
| `ORPHAN_ZONE` | warning | An area with no WorkAdventure property, in a map without a script. |
| `INVALID_ZONE_PROPERTY` | error or warning | A known zone key with a bad value. Templates on areas that are not dynamic, and unknown `openWebsitePolicy` features, are warnings. |
| `BAD_URL` | error | A URL WorkAdventure would refuse, in a zone or the map script. |
| `LABEL_TOO_LONG` | warning | A room's name or details need more room than its top wall has; shorten them or widen the room. |
| `LABEL_COVERED` | warning | Furniture stands where a room's label is; leave 2 tiles of the wall free and build again, or widen the room. |
| `SCRIPT_EXTERNAL` | warning | The map script is loaded from outside the project. |
| `SCRIPT_NOT_FOUND` | warning | The map script file is not in the project. |
| `SCRIPT_WHITESPACE` | warning | The map script value has leading or trailing spaces. |
| `ENGINE_STATE_INVALID` | error | The engine's build record does not fit the map, for example after a resize in Tiled. As a warning: the asset set's automapping rules changed since the rooms were built; build them again. |

### `render_map_preview` (CLI command `render`)

Renders the map to a PNG from the tileset images in the project, the way WorkAdventure draws it, so you can look at what was built.

| Input | Type | Required | Meaning |
|---|---|---|---|
| `projectDir`, `mapPath` | string | yes | See above. |
| `scale` | `0.25`, `0.5`, `1` or `2` | no | 1 by default. A preview is at most 4096 px a side (`PREVIEW_TOO_LARGE`); use 0.5 or 0.25 for big maps. |
| `overlays` | `["zones"]` | no | Outlines every area: meetings blue, websites green, audio purple, silent red, exits orange, others grey. |

Output: `pngPath` (absolute path of the file), `width` and `height` (pixels), `bytes`, and `sha256` of the PNG.

The file is written to `.wa-preview/` in the project, named after the map's path and the scale, for example `.wa-preview/venue@1x.png` or `.wa-preview/maps__venue@0.5x.png`. Keep that folder out of version control. Over MCP the image comes back as an image block when it is 3.75 MB or smaller; otherwise, or when your client shows no image, open `pngPath`. A missing tileset image fails with `TILESET_IMAGE_MISSING`.

### `automap_map` (CLI command `automap`)

Applies a Tiled automapping rules file to a map with the semantics of Tiled 1.12's **Map > AutoMap**: deterministic rules give the same tiles as Tiled, which test fixtures captured from Tiled check. Use it on a map that comes with its own `rules.txt`, or with a rules file the user names.

| Input | Type | Required | Meaning |
|---|---|---|---|
| `projectDir`, `mapPath` | string | yes | See above. |
| `rules` | string | no | The rules file (`rules.txt`) or a single rule map (`.tmj`), relative to `projectDir` and inside it (`PATH_OUTSIDE_PROJECT`, `PATH_BAD_EXTENSION`). By default `rules.txt` next to the map, else `rules.txt` in `projectDir`; with neither, `AUTOMAP_RULES_NOT_FOUND`. |
| `region` | `{x, y, width, height}` | no | Limit the run to this rectangle, like a selection in Tiled: only rules whose input overlaps it are tried, their output may land outside it, and `AutomappingRadius` and earlier rule maps' output widen it for the rule maps after. It must be at least 1×1 and lie inside the map (`INVALID_INPUT`). |
| `seed` | number | no | Seed for random output choices and rule probabilities: a whole number of 0 or more (`INVALID_INPUT`), 0 by default. The same map, rules and seed always give the same result. |
| `dryRun` | boolean | no | Report what would change without writing the map. |

Output: `rulesPath`, `ruleMaps` (the rule maps applied, in order, after `[filter]` lines), `rules`, `matches`, `changedCells`, `layersWritten` (tile layers whose cells or properties changed, or that were created), `written` (false for a dry run or when nothing changed) and `warnings`. Running it again changes nothing more, unless the rules read their own output.

A rules file lists rule maps, one per line, relative to the file; a line ending in `.txt` includes another rules file, `#` and `//` start comment lines, and a `[pattern]` line limits the following rule maps to maps whose file name matches (`*`, `?`, `[...]`, case-insensitive). A rule map is a Tiled map with layers named `input_<layer>`, `inputnot_<layer>` and `output_<layer>` (with an optional index such as `input2_<layer>` or `output1_<layer>`), an optional `rule_options` object layer, and the special tiles of Tiled's automapping rules tileset (`MatchType` Empty, NonEmpty, Other, Ignore, Negate).

Errors and warnings:

| Code | Kind | Meaning |
|---|---|---|
| `AUTOMAP_RULES_NOT_FOUND` | error | The rules file or a rule map it lists does not exist. |
| `AUTOMAP_RULES_INVALID` | error | The rules cannot be used: a rules file that cannot be read, a rule map that is not a readable Tiled JSON map, no input or output layer, a layer without `_`, layers of the wrong size, tile ids no tileset has, a tile from a tileset that is XML (`.tsx`) or whose image is missing, rules files that include each other, or an `AutomappingRadius` above 1000. `details` names the rules file, rule map, layer or tileset. |
| `AUTOMAP_UNSUPPORTED` | error | Outside what the engine runs: legacy `regions` layers, object layers other than `rule_options`, isometric, staggered, hexagonal or infinite maps. `details.feature` says which. |
| `PATH_BAD_EXTENSION` | error | A rule map is not `.tmj` or `.json`. Save `.tmx` rule maps as JSON in Tiled. |
| `TILESET_CONFLICT` | error | The rules need a tileset the map lacks, and the map already has a different tileset with that name. |
| `EXTERNAL_TILESET_UNRESOLVED` | error or warning | As an error: the rules need a tileset added, and the map has an external tileset the engine cannot read, so no tile id is free. As a warning: rules never match that tileset's tiles. Embed it in Tiled or save it as `.tsj`. |
| `AUTOMAP_RULES_IGNORED` | warning | A rule-map layer, property or `rule_options` object Tiled would also ignore. |
| `AUTOMAP_ON_ENGINE_MAP` | warning | The map has a wa-agent-engine build record: `build_room_from_dsl` does not re-run these rules, and a rebuild may undo their tiles inside built rooms. |

Rule maps run in the listed order, each on the result of the previous one. Tiles the rules need from a tileset the map lacks are added with that tileset, with its image path relative to the map. Like Tiled, a missing target layer is created at the top of the map when the rules put tiles on it; a locked target layer is left alone unless the rule map sets `IgnoreLock` (only the layer's own lock counts, not a locked group around it), and `DeleteTiles` clears output layers even when they are locked.

As in Tiled, an embedded rule-map tileset with the same image, tile size, tile count, margin, spacing and offset as one of the map's tilesets (embedded or a `.tsj`), or else as one an earlier rule map brings, is that tileset, and an external rule-map tileset is the map's tileset from the same `.tsj` file. Its tiles match that tileset's tiles, and their `MatchType` comes from it. Give the special tiles a tileset of their own.

Where the engine differs from Tiled: random choices are seeded (Tiled's are not, so random rules cannot match Tiled draw for draw); a rule map that is broken or missing fails the whole call (Tiled skips it); `MatchType` is read from the tile's own property, not from class defaults of a Tiled project; and the fallback rules file is `rules.txt` in `projectDir`, not the rules file set in a Tiled project.

### `import_prop_set` (CLI command `import-props`)

Turns single-image props into furniture prefabs: a project asset set that extends another set, so a map gets that set's walls, floors and furniture plus the props.

| Input | Type | Required | Meaning |
|---|---|---|---|
| `projectDir` | string | yes | See above. |
| `setId` | string | yes | The new set's id: lowercase letters, digits and `-`, for example `varcamp`. |
| `source` | string or list of strings | yes | A props hints JSON, or several, relative to `projectDir`; prop ids must be unique across them. Each prop has `id`, `image` (a PNG relative to its hints file, exactly `sizeTiles` × 32 px) and `sizeTiles` `[width, height]`, and optionally `collisionGrid` (rows of 0/1), `foregroundRows` (rows drawn above players), `placement` (`free`, the default, or `north-wall` with a `faceRow` of `upper`, `lower` or `either`, for screens, plaques and windows that hang on the wall face), `use`, `name`, `tags` and `license`. |
| `extends` | string | no | The set the props are added to; `wa-starter-office` by default. |
| `overwrite` | boolean | no | Replace an existing set with this id. Without it, an existing set fails with `ASSET_SET_EXISTS`. |

Output: `setId`, `extends`, `image` (the atlas, `tilesets/<setId>.png`) and `prefabs`: every prefab's `id` (the prop id in lowercase, `_` as `-`), `width`, `height`, `category` and `use`.

The images are copied pixel for pixel into one atlas; each prop's rows go on `furniture1`, or `foreground1` for its foreground rows, and its collision cells block walking. Use `setId` as the `assetSet` of the DSL and of `place_prefab`. A map built with the base set can be rebuilt with the new set; the other way fails with `ASSET_SET_MISMATCH`.

The atlas is named after its content (`tilesets/<setId>-<hash>.png`). Importing changed props again with `overwrite` writes a new atlas and leaves the old one in place, so maps built with it still show their furniture; their next build draws every prop, DSL and placed ones alike, from the new atlas. Delete an old atlas only when no map uses it. Two imports of the same set at once: the second fails with `ASSET_SET_LOCKED`. A bad hints file fails with `INVALID_INPUT`; bad images (wrong size, fully transparent, unreadable) fail with `INVALID_INPUT` and are listed in `details.problems`. An atlas taller than 4096 px fails with `IMAGE_TOO_LARGE`: split the props into several sets.

### `automap_template` (CLI command `automap-template`)

Writes a ready-to-paint Tiled rule map for an asset set drawn with automapping rules (`drawing` in `set.json`), so a user onboards a tileset by painting tiles in Tiled instead of typing tile ids. The asset-set onboarding skill walks through it.

| Input | Type | Required | Meaning |
|---|---|---|---|
| `projectDir` | string | yes | See above. |
| `assetSet` | string | no | A set whose wall styles and floor styles get rules; a set drawn with rules keeps its markers, any other set gets `wa-markers` tiles in order (wall 0, door 1, the floors from 2, then the wall styles). The 16 markers hold at most 14 floor styles (`INVALID_INPUT`). Without it: one wall style and one floor style, both `plain`. |
| `outDir` | string | yes | Folder for the files, relative to `projectDir`, usually inside the set's folder, for example `.wa-asset-sets/dungeon/automap`. |
| `tilesets` | list of strings | yes | 1 to 32 Tiled tilesets (`.tsj` or `.json`, `PATH_BAD_EXTENSION`) relative to `projectDir`, with 32 × 32 px tiles and their image in the project (`TILESET_IMAGE_MISSING`): every tileset the walls, faces, lintels and floors are painted with, and the one with the collision tile. Two different tilesets with one name fail with `INVALID_INPUT`; the same tileset twice is attached once. |
| `overwrite` | boolean | no | Replace the files. Without it, existing files fail with `MAP_EXISTS`, and `details.files` lists them. A file the tool did not write (or a link) is never replaced, even with `overwrite` (`MAP_EXISTS`). |

It writes three files into `outDir`:

- `walls.tmj`, the rule map. Its input layers hold the markers a room build paints on `wa_sketch` and `wa_style` for every wall pattern (the 16 of walls and open cells, a wall beside a door in each direction, and a wall between two doors), both lintels, the 4 variants of both face rows outside rooms and for each wall style, and each floor style on floors and on doors. Its outputs are empty, apart from the Empty tiles that clear the wall and collision under each lintel and those of the clean-up rules (old faces under a new door, the lintel of a door a wall now closes; the user paints that lintel over an Empty tile on `input1_foreground1`, and until then the rule changes nothing). Each rule has a rectangle on `rule_options` named after its piece, with the names `validate_wa_map` uses in `ASSET_SET_INCOMPLETE`; that check does not cover the walls between two doors, which rooms need only beside a door drawn by hand. The marker tileset, the special tiles' tileset `wa-automap-rules` and the named tilesets are embedded.
- `rules.txt`, which lists `walls.tmj`.
- `README.md`: paint in Tiled, write `set.json` with `drawing`, prove the set.

The images of `wa-markers` and the special tiles are written to `tilesets/wa-markers.png` and `tilesets/wa-automap-rules.png` when they are missing, so Tiled shows them; existing files are left alone.

Output: `ruleMap`, `rulesFile` and `readme` (relative to `projectDir`), `rules` (every rule in the order it runs: `name`, its anchor cell `x` and `y` in the rule map, and `paint`, the layers to paint there, such as `output_walls` and `output_collisions`, or none when the rule is complete), and `markerTileset`, `markers`, `wallStyles` and `floorStyles` for `set.json` (a floor style keeps its tile only when its tileset is one of `tilesets`). `drawing.rules` in `set.json` is `rulesFile` relative to `set.json`.

## Exit codes

| Exit code | Meaning |
|---|---|
| 0 | Success; the result is on stdout. `validate` exits 0 even when `ok` is false: read `ok`. |
| 1 | A tool error or invalid input; the JSON error body is on stdout. |
| 2 | An unknown command or flag; a message is on stderr. |
