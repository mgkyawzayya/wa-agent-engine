---
name: wa-asset-set-onboarding
description: Adds a tileset to wa-agent-engine as a project-local asset set, so the WorkAdventure map tools can draw walls, wall faces, floors, doors and furniture with it, or turns single prop images (stages, banners, boards, games) into furniture with import_prop_set. Use it when a user wants to build WorkAdventure maps with their own or third-party tiles or props, or asks to create, fix or check an asset set in .wa-asset-sets, its Tiled .tsj wall terrain, its set.json, or its prefab .tmj files.
compatibility: Needs Node.js 26 or newer, a WorkAdventure map project that holds the tileset images, and the wa-agent-engine MCP server or the CLI through npx -y wa-agent-engine@0.2.0. Tiled helps for drawing the Wang set but is optional.
---

# Asset set onboarding

An asset set tells wa-agent-engine how to draw with a group of tilesets: which tiles are walls and how they join, which are wall faces, floors and door lintels, which tile marks collisions and the spawn, and which furniture prefabs exist. A set holds definitions only, never images. The images stay in the user's project, and the set refers to them by path.

The built-in set `wa-starter-office` is the worked example throughout. Its definition files ship in the wa-agent-engine package under `assets/sets/wa-starter-office/`. Every file format is in [references/terrain-authoring.md](references/terrain-authoring.md).

## 1. Check the licence

Do this before anything else, and stop if the answer is unclear.

- Find out who made the tiles and under which licence. Ask the user if it is not written down next to the images.
- The licence must allow use in WorkAdventure maps, and publishing those maps the way the user plans, for example at a public event or for a company.
- Some licences are non-commercial, such as those of images generated with FLUX non-commercial models. Write that into the set and tell the user before anything is published.
- Record the licence and author of each image in its `tilesetCopyright`, and a credit for maps made with the set in `mapCopyright`. The engine copies both into every map it scaffolds.
- If a prefab copies an arrangement from someone else's map, give it a `credit` and a `license` property.
- Never copy, commit, upload or embed the PNG images. The set's JSON files hold tile ids and arrangements only; the images stay where the user keeps them in the project. The one exception is `import_prop_set`, which copies the user's own prop images into the project's `tilesets/` folder as one atlas.

## 2. Props only: import_prop_set

When the user has furniture as single images (one PNG per prop, such as a stage, a banner or a pinball machine) and wants to keep the walls and floors of an existing set, do not write a set by hand: `import_prop_set` makes one.

1. The images must be PNGs exactly `sizeTiles` × 32 px, inside the map project (for example `props/varcamp/images/`). Check the licence first (section 1) and write it into each prop's `license`.
2. Write a hints JSON next to them: an array with one entry per prop, `id`, `image` (relative to the hints file), `sizeTiles` `[width, height]`, and if possible `collisionGrid` (one row of 0/1 per tile row; 1 blocks walking), `foregroundRows` (rows drawn above players, such as the top of a tall cabinet), `placement: "north-wall"` with a `faceRow` for props that hang on the wall (screens, plaques, windows), `use` (one sentence an agent can pick the prop by), `name`, `tags` and `license`. Several hints files can go into one set: pass `source` as a list.
3. Import it:

   ```bash
   npx -y wa-agent-engine@0.2.0 import-props --input '{"projectDir": "/path/to/map-starter-kit", "setId": "varcamp", "source": "props/varcamp/props.json"}'
   ```

4. The result lists every prefab id (the prop id in lowercase, `_` as `-`), size, category and use. The set extends `wa-starter-office`, so maps built with `"assetSet": "varcamp"` have the starter walls and floors and all the furniture of both sets. A map built with `wa-starter-office` can switch to it at the next build.
5. Prove it like any set (section 4): a test map with a few props, `validate_wa_map`, `render_map_preview`.

The tool copies the images, pixel for pixel, into one atlas `tilesets/<setId>.png` in the project; that is the only copy to make. It refuses to replace an existing set (`ASSET_SET_EXISTS`) unless the user asks for `"overwrite": true`, and lists every bad image or hint in `details.problems` (`INVALID_INPUT`).

## 3. Create the set

A project-local set lives in the user's map project:

```text
<projectDir>/
  tilesets/                       the PNG images
  .wa-asset-sets/<id>/
    set.json
    tilesets/<tileset name>.tsj   one per image
    prefabs/<prefab id>.tmj       one per prefab
```

- `<id>` is lowercase letters, digits and `-`, and equals the `id` inside `set.json`.
- A project-local set with the same id as a built-in set replaces it in that project.
- A folder under `.wa-asset-sets/` without a `set.json` is an error. Complete it or remove it.
- Paths in `set.json` are relative and stay inside the project: `tsj` and prefab `path` relative to `set.json`, and `image` relative to the project root.

Then write the files, in this order:

1. **Tilesets.** One `.tsj` per image, with 32 × 32 px tiles, made in Tiled or by hand. Its `name` is the name `set.json` uses.
2. **Wall terrain.** One edge Wang set in the wall tileset, with a wall colour and a door colour, that covers all 21 wall and door patterns in the coverage table of [references/terrain-authoring.md](references/terrain-authoring.md). Walls are one tile thick.
3. **Collision tile.** One tile with the bool tile property `collides` set to `true`. Every `collides` property must be a bool, never a string.
4. **set.json.** The tilesets with their copyright, the wall terrain, the door lintels, the face rules (two rows of face per wall, with end variants), the wall and floor styles, the collision and start tiles, and `mapCopyright`.
5. **Prefabs.** One small Tiled map per piece of furniture, with its tiles split over the sub-layers `furniture1` to `furniture3` (under the avatar), `foreground1` and `foreground2` (over the avatar), and `collisions`. Its properties (`category`, `placement`, `faceRow` for north-wall pieces, `use`, and `credit` and `license` where needed) must match its entry in `set.json`.

## 4. Prove the set

Run these checks in order, and fix each problem before going on.

1. **Load the set** by scaffolding a test map with it. Loading checks `set.json` against its schema and checks every tile id, the wall and door colours, and the collision tile. Problems come back as `ASSET_SET_INVALID` with a list in the message and `details`.
2. **Coverage check.** Run `validate_wa_map` (CLI `validate`) on that test map with `"assetSet": "<id>"`. It checks that the set has a tile for every wall and door pattern in the coverage table. Any gap comes back as an `ASSET_SET_INCOMPLETE` warning that names the patterns as `wall N1 E0 S1 W0`: 1 means a wall on that side, as in the table's N, E, S and W columns. The test room below builds with 17 of the patterns; the 4 wall ends and the isolated tile are only needed next to walls drawn by hand, so this check is the only one that covers them.
3. **Build the test room**: four rooms around one crossing, with a horizontal and a vertical door, which uses every corner, edge, junction and door piece. A missing piece fails with `WALL_PIECE_MISSING` and names the cell.
4. **Place every prefab** once with `place_prefab` in an empty part of a room. A broken prefab fails with `PREFAB_INVALID`.
5. **Validate.** Expect `"ok": true` with no `WALL_WITHOUT_COLLISION`, `COLLIDES_NOT_BOOL` or `MISSING_COPYRIGHT`.
6. **Render and look.** Walls join without gaps, faces sit under north walls in the right style, lintels cover the doors, and furniture looks right. Tell the user that only a live WorkAdventure check shows whether `foreground` tiles really draw over the avatar.

`validate_wa_map` alone does not prove a set: when the set fails to load, it only warns `ASSET_SET_NOT_FOUND` and skips the coverage and wall checks. Always scaffold and build with the set too.

## Worked example

This makes `office-mini`, a minimal copy of the starter set with four tilesets, one wall style, two floors and the phone pod, then proves it. The full `set.json` is in [references/terrain-authoring.md](references/terrain-authoring.md).

1. Get the starter set's definition files. They ship in the wa-agent-engine package. With the package installed globally, they are under `$(npm root -g)/wa-agent-engine/`; otherwise `npm pack wa-agent-engine@0.2.0` fetches them as a tarball:

   ```bash
   cd "$(mktemp -d)"
   mkdir -p package/assets/sets && cp -R "$(npm root -g)/wa-agent-engine/assets/sets/wa-starter-office" package/assets/sets/
   ```

2. Create the set folder, copy the `.tsj` files the set uses and the prefab, and save the `set.json` from the reference as `set.json` in it. These are JSON definitions only; the images are already in the project's `tilesets/` folder, where every `.tsj` image path points.

   ```bash
   SET=/path/to/map-starter-kit/.wa-asset-sets/office-mini
   mkdir -p "$SET/tilesets" "$SET/prefabs"
   for name in WA_Special_Zones WA_Room_Builder WA_Seats WA_Tables; do
     cp "package/assets/sets/wa-starter-office/tilesets/$name.tsj" "$SET/tilesets/"
   done
   cp package/assets/sets/wa-starter-office/prefabs/phone-pod-2x2.tmj "$SET/prefabs/"
   ```

   To copy the whole starter set instead, copy `set.json`, `tilesets/` and `prefabs/` and change only the `id` in `set.json`.

3. Scaffold a test map with the set:

   ```bash
   npx -y wa-agent-engine@0.2.0 scaffold --input '{"projectDir": "/path/to/map-starter-kit", "mapPath": "set-test.tmj", "width": 20, "height": 14, "assetSet": "office-mini", "spawn": {"x": 4, "y": 4}}'
   ```

4. Build the test room. The four rooms meet at the crossing (9, 6); the doors at (9, 3) and (9, 9) are vertical, and those at (4, 6) and (14, 6) horizontal.

   ```bash
   npx -y wa-agent-engine@0.2.0 build --input '{
     "projectDir": "/path/to/map-starter-kit",
     "mapPath": "set-test.tmj",
     "dsl": {
       "mapWidth": 20,
       "mapHeight": 14,
       "assetSet": "office-mini",
       "rooms": [
         {"id": "nw", "bounds": {"x": 0, "y": 0, "width": 10, "height": 7}, "floorStyle": "carpet-red", "doors": [{"wall": "east", "offset": 3}, {"wall": "south", "offset": 4}]},
         {"id": "ne", "bounds": {"x": 9, "y": 0, "width": 11, "height": 7}, "doors": [{"wall": "south", "offset": 5}]},
         {"id": "sw", "bounds": {"x": 0, "y": 6, "width": 10, "height": 8}, "doors": [{"wall": "east", "offset": 3}]},
         {"id": "se", "bounds": {"x": 9, "y": 6, "width": 11, "height": 8}}
       ]
     }
   }'
   ```

5. Place the prefab, validate, and render:

   ```bash
   npx -y wa-agent-engine@0.2.0 prefab --input '{"projectDir": "/path/to/map-starter-kit", "mapPath": "set-test.tmj", "prefabId": "phone-pod-2x2", "x": 2, "y": 10}'
   npx -y wa-agent-engine@0.2.0 validate --input '{"projectDir": "/path/to/map-starter-kit", "mapPath": "set-test.tmj"}'
   npx -y wa-agent-engine@0.2.0 render --input '{"projectDir": "/path/to/map-starter-kit", "mapPath": "set-test.tmj"}'
   ```

   Validate returns `{"ok": true, "errors": [], "warnings": []}`, and the preview shows four rooms with joined walls, white faces under each north wall, red carpet in the north-west room, four doors with lintels, and the phone pod.

With your own art, the steps are the same: write the files, then scaffold, build the test room, place each prefab, validate and render. Delete the test map when the set is proven, or keep it as the set's test.

## Errors while onboarding

| Code | Usual fix |
|---|---|
| `ASSET_SET_NOT_FOUND` | The id has a typo, or `.wa-asset-sets/<id>/set.json` is missing. |
| `ASSET_SET_INVALID` | The message lists every problem: a schema error in `set.json`, an `id` that differs from the folder, a `.tsj` whose name or tile size is wrong, a tile id past the end of its tileset, a missing or non-edge Wang set, equal or unknown wall and door colours, or a collision tile without `collides` = `true`. |
| `ASSET_IMAGE_MISSING` | An `image` path in `set.json` does not point at a PNG in the project. Fix the path; ask the user for the image if it is really missing. |
| `PATH_OUTSIDE_PROJECT`, `PATH_BAD_EXTENSION` | A path in the set leaves the project, or a file has the wrong extension (`.tsj` or `.json` for tilesets, `.tmj` for prefabs). |
| `ASSET_SET_INCOMPLETE` | The set has no tile for the listed wall or door patterns. Add them to the Wang set (see the coverage table). |
| `WALL_PIECE_MISSING` | The Wang set lacks the pattern the named cell needs. Find it in the coverage table and add a tile for it. |
| `PREFAB_INVALID` | The prefab is not a valid prefab map: a wrong size, an unknown layer name, a tile from a tileset outside the set, or properties that differ from `set.json`. |
| `PREFAB_NOT_FOUND` | The prefab has no entry in `set.json`. |
| `UNKNOWN_STYLE` | A room asks for a `wallStyle` or `floorStyle` the set does not define. |

## Rules

- Never change the built-in set inside the installed package. Make a project-local set instead, under a new id, or under the built-in id to replace it in one project.
- Keep images out of the set folder and out of version control; the set refers to them where they are.
- Write licences down where the engine carries them into maps: `tilesetCopyright`, `mapCopyright`, and prefab `credit` and `license`.
- Prove every change to a set with the steps in section 4 before using it for a real map.

## Reference

- [references/terrain-authoring.md](references/terrain-authoring.md): `set.json` fields, tileset rules, the edge Wang set and its coverage table, wall faces, lintels, floors, and the prefab format, with the starter set's files as examples.
