# VarCamp 2025 venue recipe

VarCamp is a fully online open-space event at play.var.camp, sponsored by WorkAdventure. This recipe draws a complete venue for it on one 52 × 31 map with the built-in asset set `wa-starter-office`. Every command below was run through the CLI as written, and the finished map validates with no errors and no warnings.

Replace `/path/to/map-starter-kit` with the user's project. Over MCP, pass the same objects as tool arguments.

## The brief

- Two talk tracks with a stage, a screen and audience rows: Daisy and Hnin Si.
- A workshop with a big table and a whiteboard: Padauk.
- A lounge with a snack bar, sofas and a phone pod: Sabal.
- A quiet co-working room, Khwar Nyo, with two walled phone booths under it.
- A registration hall, Thazin, with the entrance, the registration desk and the exit.
- A game corner: Khatta.
- A sponsor hall with three sponsor booths: Gant Gaw.

The rooms are named after the VarCamp tracks.

## Layout

The map has three bands. The top band holds the talk room, the workshop, the quiet room with its booths, and the lounge. The middle band is the registration hall, which runs the full width and connects everything. The bottom band holds the game corner, the sponsor hall and the second talk room. Rooms in a band share their side walls, and each band shares its wall rows with the hall, so every room opens straight into the hall.

```text
x=0                17           30   34   38             51
  +-----------------+------------+---------+--------------+ y=0
  | daisy           | padauk     | khwar-  | sabal        |
  | talks           | workshop   | nyo     | lounge       |
  |                 |            +----+----+              | y=8
  |                 |            |ph-1|ph-2|              |
  +-------  --------+----  ------+-  -+-  -+----  --------+ y=12
  | thazin: registration hall                               exit
  +------  ------+-------  -------+--  ---------------------+ y=21
  | khatta       | gant-gaw       | hnin-si                 |
  | games        | sponsors       | talks                   |
  +--------------+----------------+-------------------------+ y=30
x=0             14               35                         51
```

| Room | Bounds (x, y, width, height) | Doors | Zone properties |
|---|---|---|---|
| `daisy`, talks | 0, 0, 18, 13 | south, offset 8, width 2 | Jitsi meeting, focusable |
| `padauk`, workshop | 17, 0, 14, 13 | south, offset 6, width 2 | Jitsi meeting on Space |
| `khwar-nyo`, quiet room | 30, 0, 9, 9 | east into the lounge, offset 3, width 2 | silent |
| `phone-1`, `phone-2`, booths | 30, 8, 5, 5 and 34, 8, 5, 5 | south, offset 2 | Jitsi meeting on Space |
| `sabal`, lounge | 38, 0, 14, 13 | south, offset 6, width 2 | looping background audio |
| `thazin`, hall | 0, 12, 52, 10 | east, offset 3, width 2, exit | none; tool zones instead |
| `khatta`, games | 0, 21, 15, 10 | north, offset 6, width 2 | AI zone with a description |
| `gant-gaw`, sponsors | 14, 21, 22, 10 | north, offset 9, width 2 | none; a website zone per sponsor |
| `hnin-si`, talks | 35, 21, 17, 10 | north, offset 2, width 2 | Jitsi meeting |

## 1. Scaffold the map

```bash
npx -y wa-agent-engine@0.3.0 scaffold --input '{"projectDir": "/path/to/map-starter-kit", "mapPath": "varcamp.tmj", "width": 52, "height": 31, "spawn": {"x": 47, "y": 18}, "mapName": "VarCamp 2025", "mapDescription": "VarCamp 2025 venue: talks, workshop, lounge, games and sponsors"}'
```

The spawn tile is in the hall, next to the registration desk and the entrance.

## 2. Build the rooms

Save this input as `varcamp.build.json`:

```json
{
  "projectDir": "/path/to/map-starter-kit",
  "mapPath": "varcamp.tmj",
  "dsl": {
    "mapWidth": 52,
    "mapHeight": 31,
    "assetSet": "wa-starter-office",
    "rooms": [
      {
        "id": "daisy",
        "name": "Daisy track (talks)",
        "bounds": {"x": 0, "y": 0, "width": 18, "height": 13},
        "floorStyle": "carpet-red",
        "doors": [{"wall": "south", "offset": 8, "width": 2}],
        "furniture": [
          {"prefabId": "wall-screen-3x2", "x": 7, "y": 1},
          {"prefabId": "stage-light-4x3", "x": 7, "y": 3},
          {"prefabId": "lectern-1x1", "x": 11, "y": 4},
          {"prefabId": "audience-row-6x1", "x": 2, "y": 7},
          {"prefabId": "audience-row-6x1", "x": 10, "y": 7},
          {"prefabId": "audience-row-6x1", "x": 2, "y": 9},
          {"prefabId": "audience-row-6x1", "x": 10, "y": 9},
          {"prefabId": "plant-tree-1x2", "x": 1, "y": 3},
          {"prefabId": "plant-tree-1x2", "x": 16, "y": 3}
        ],
        "waProperties": {"jitsiRoom": "VarCamp Daisy track", "focusable": true, "zoomMargin": 0.2}
      },
      {
        "id": "padauk",
        "name": "Padauk workshop",
        "bounds": {"x": 17, "y": 0, "width": 14, "height": 13},
        "floorStyle": "wood-dark",
        "doors": [{"wall": "south", "offset": 6, "width": 2}],
        "furniture": [
          {"prefabId": "notice-board-3x1", "x": 26, "y": 1},
          {"prefabId": "whiteboard-easel-3x3", "x": 18, "y": 3},
          {"prefabId": "table-long-6x5", "x": 21, "y": 5},
          {"prefabId": "plant-small-1x1", "x": 29, "y": 3}
        ],
        "waProperties": {"jitsiRoom": "VarCamp Padauk workshop", "jitsiTrigger": "onaction"}
      },
      {
        "id": "khwar-nyo",
        "name": "Khwar Nyo quiet room",
        "bounds": {"x": 30, "y": 0, "width": 9, "height": 9},
        "floorStyle": "stripe-grey",
        "doors": [{"wall": "east", "offset": 3, "width": 2}],
        "furniture": [
          {"prefabId": "coworking-pod-4x5", "x": 32, "y": 3}
        ],
        "waProperties": {"silent": true}
      },
      {
        "id": "phone-1",
        "name": "Phone booth 1",
        "bounds": {"x": 30, "y": 8, "width": 5, "height": 5},
        "floorStyle": "carpet-navy",
        "doors": [{"wall": "south", "offset": 2}],
        "waProperties": {"jitsiRoom": "VarCamp phone booth 1", "jitsiTrigger": "onaction"}
      },
      {
        "id": "phone-2",
        "name": "Phone booth 2",
        "bounds": {"x": 34, "y": 8, "width": 5, "height": 5},
        "floorStyle": "carpet-navy",
        "doors": [{"wall": "south", "offset": 2}],
        "waProperties": {"jitsiRoom": "VarCamp phone booth 2", "jitsiTrigger": "onaction"}
      },
      {
        "id": "sabal",
        "name": "Sabal lounge",
        "bounds": {"x": 38, "y": 0, "width": 14, "height": 13},
        "wallStyle": "yellow",
        "floorStyle": "wood-honey",
        "doors": [{"wall": "south", "offset": 6, "width": 2}],
        "furniture": [
          {"prefabId": "snack-bar-5x3", "x": 45, "y": 2},
          {"prefabId": "lounge-sofa-set-4x4", "x": 40, "y": 6},
          {"prefabId": "plant-palm-3x3", "x": 47, "y": 7},
          {"prefabId": "phone-pod-2x2", "x": 49, "y": 10}
        ],
        "waProperties": {"playAudio": "https://example.com/varcamp/lounge-loop.mp3", "audioLoop": true, "audioVolume": 0.3}
      },
      {
        "id": "thazin",
        "name": "Thazin hall (registration)",
        "bounds": {"x": 0, "y": 12, "width": 52, "height": 10},
        "doors": [{"wall": "east", "offset": 3, "width": 2, "exit": true}],
        "furniture": [
          {"prefabId": "notice-board-3x1", "x": 2, "y": 13},
          {"prefabId": "plant-tree-1x2", "x": 1, "y": 15},
          {"prefabId": "info-sign-1x3", "x": 38, "y": 15},
          {"prefabId": "registration-desk-4x3", "x": 41, "y": 16},
          {"prefabId": "plant-tree-1x2", "x": 50, "y": 18}
        ]
      },
      {
        "id": "khatta",
        "name": "Khatta game corner",
        "bounds": {"x": 0, "y": 21, "width": 15, "height": 10},
        "floorStyle": "slate-purple",
        "doors": [{"wall": "north", "offset": 6, "width": 2}],
        "furniture": [
          {"prefabId": "party-balloons-1x1", "x": 1, "y": 24},
          {"prefabId": "party-balloons-1x1", "x": 13, "y": 24},
          {"prefabId": "game-circle-3x3", "x": 2, "y": 25},
          {"prefabId": "game-circle-3x3", "x": 9, "y": 25},
          {"prefabId": "pouf-row-4x1", "x": 5, "y": 29}
        ],
        "waProperties": {"ai-zone": true, "description": "Game corner: board games and werewolf rounds between sessions."}
      },
      {
        "id": "gant-gaw",
        "name": "Gant Gaw sponsor hall",
        "bounds": {"x": 14, "y": 21, "width": 22, "height": 10},
        "floorStyle": "boards",
        "doors": [{"wall": "north", "offset": 9, "width": 2}],
        "furniture": [
          {"prefabId": "sponsor-booth-4x4", "x": 16, "y": 22},
          {"prefabId": "sponsor-booth-4x4", "x": 26, "y": 22},
          {"prefabId": "sponsor-booth-4x4", "x": 31, "y": 22},
          {"prefabId": "low-shelf-2x2", "x": 20, "y": 27},
          {"prefabId": "cafe-table-3x2", "x": 24, "y": 27}
        ]
      },
      {
        "id": "hnin-si",
        "name": "Hnin Si track (talks)",
        "bounds": {"x": 35, "y": 21, "width": 17, "height": 10},
        "floorStyle": "carpet-red",
        "doors": [{"wall": "north", "offset": 2, "width": 2}],
        "furniture": [
          {"prefabId": "wall-screen-3x2", "x": 43, "y": 22},
          {"prefabId": "stage-dark-4x3", "x": 42, "y": 24},
          {"prefabId": "lectern-1x1", "x": 46, "y": 25},
          {"prefabId": "audience-row-4x1", "x": 39, "y": 28},
          {"prefabId": "audience-row-4x1", "x": 45, "y": 28},
          {"prefabId": "plant-tree-1x2", "x": 50, "y": 24}
        ],
        "waProperties": {"jitsiRoom": "VarCamp Hnin Si track"}
      }
    ],
    "variables": [{"name": "currentTalk", "default": "Opening session", "persist": true}]
  }
}
```

```bash
npx -y wa-agent-engine@0.3.0 build --input-file varcamp.build.json
```

The result lists the 8 room areas (`daisy`, `padauk`, `khwar-nyo`, `phone-1`, `phone-2`, `sabal`, `khatta`, `hnin-si`), the variable `currentTalk`, 39 furniture instances, and no warnings.

## 3. Add extras with place_prefab

```bash
npx -y wa-agent-engine@0.3.0 prefab --input '{"projectDir": "/path/to/map-starter-kit", "mapPath": "varcamp.tmj", "prefabId": "party-balloons-1x1", "x": 46, "y": 15}'
npx -y wa-agent-engine@0.3.0 prefab --input '{"projectDir": "/path/to/map-starter-kit", "mapPath": "varcamp.tmj", "prefabId": "plant-palm-3x3", "x": 12, "y": 17}'
```

These two are decoration that belongs to no room. If a later build covers one of them, the build removes it with a `PREFAB_REMOVED` warning; place it again elsewhere.

## 4. Add the zones

```bash
npx -y wa-agent-engine@0.3.0 zone --input '{"projectDir": "/path/to/map-starter-kit", "mapPath": "varcamp.tmj", "name": "entry", "x": 46, "y": 16, "width": 4, "height": 4, "properties": {"start": true}}'
npx -y wa-agent-engine@0.3.0 zone --input '{"projectDir": "/path/to/map-starter-kit", "mapPath": "varcamp.tmj", "name": "exit", "x": 51, "y": 15, "width": 1, "height": 2, "properties": {"exitUrl": "garden.tmj#entry"}}'
npx -y wa-agent-engine@0.3.0 zone --input '{"projectDir": "/path/to/map-starter-kit", "mapPath": "varcamp.tmj", "name": "registration", "x": 40, "y": 19, "width": 6, "height": 2, "properties": {"openWebsite": "https://var.camp", "openWebsiteTrigger": "onaction", "openWebsiteTriggerMessage": "Press SPACE to register for VarCamp"}}'
npx -y wa-agent-engine@0.3.0 zone --input '{"projectDir": "/path/to/map-starter-kit", "mapPath": "varcamp.tmj", "name": "sponsor-workadventure", "x": 26, "y": 26, "width": 4, "height": 1, "properties": {"openWebsite": "https://workadventu.re", "openWebsiteTrigger": "onicon"}}'
```

- `entry` is the named entry point. Another map reaches this venue with an `exitUrl` ending in `varcamp.tmj#entry`.
- `exit` covers both cells of the hall's exit door, which opens off the east edge of the map.
- `registration` sits in front of the registration desk and opens the VarCamp website when a player presses Space.
- `sponsor-workadventure` is the row in front of the middle sponsor booth. Add one such zone per sponsor.

## 5. Validate

```bash
npx -y wa-agent-engine@0.3.0 validate --input '{"projectDir": "/path/to/map-starter-kit", "mapPath": "varcamp.tmj"}'
```

Expected result: `{"ok": true, "errors": [], "warnings": []}`.

## 6. Render and look

```bash
npx -y wa-agent-engine@0.3.0 render --input '{"projectDir": "/path/to/map-starter-kit", "mapPath": "varcamp.tmj", "scale": 0.5, "overlays": ["zones"]}'
```

At scale 0.5 the preview is 832 × 496 px. Check that every room is there, that each door opens into the hall, that the booths and the quiet room connect as planned, and that the zone outlines lie where the brief wants them.

## How the rules shape this layout

- **Shared walls.** The talk room ends at column 17 and the workshop starts there; the top band ends at row 12 and the hall starts there. No two walls run side by side.
- **Doors and junctions.** The hall's north wall, row 12, has walls meeting it at columns 17, 30, 34 and 38. Every door in it keeps at least one plain wall cell away from those columns: the booth doors at columns 32 and 36 sit exactly in the middle of their 5-wide booths.
- **Walled phone booths.** Each booth is the 5 × 5 pattern: a 1-wide door at offset 2 in its south wall, which is the hall's north wall. The two face rows inside leave one walkable row of 3 cells, and the booth's area covers exactly that row.
- **Side door.** The quiet room's door is in its east wall at offset 3, below the face rows of both the quiet room and the lounge, which start at the same row.
- **North-wall prefabs.** The wall screens (`upper`) sit on row 1 under the top band's wall row 0, and on row 22 under the hall's south wall, row 21. The snack bar (`lower`) sits on row 2. The sponsor booths (`upper`) sit on row 22 and avoid the door columns 23 and 24, where no faces are drawn. The notice boards (`either`) sit on rows 1 and 13.
- **Doorways stay free.** The aisle between the audience rows in the Daisy track lines up with its door, and nothing stands on the row inside any door.
- **Exit.** The hall reaches the east edge of the map (`x + width` = 52), so its east door can be an exit, and the `exit` zone covers both door cells.

## Adapting it

- The lounge audio URL is a placeholder on `example.com`. Use a real https MP3 file, or a path to an audio file inside the project.
- `garden.tmj#entry` stands for the next map. Point `exitUrl` at the map or room players should go to, with that map's entry name after `#`.
- The sponsor booths show an empty banner frame; the set has no sponsor-logo art. Put each sponsor's link in a website zone in front of its booth.
- To add a track, add a room that shares a wall with the hall and give it a door into the hall. Keep its doors clear of the junctions on the hall's wall rows.
- To change anything, edit the DSL and build again with the whole layout, then validate and render. The two `place_prefab` extras come back where they were, or a `PREFAB_REMOVED` warning says why not.
