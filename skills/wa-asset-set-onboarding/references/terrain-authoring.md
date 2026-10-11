# Terrain authoring reference

This reference describes every file of an asset set, with the built-in set `wa-starter-office` as the worked example. Its definition files ship in the wa-agent-engine package under `assets/sets/wa-starter-office/`; the tileset images they refer to are the map-starter-kit's own and stay in the user's project.

Tile ids in all these files are local ids inside one tileset, counted from 0, left to right and then top to bottom: id = row × columns + column.

## set.json

| Field | Meaning |
|---|---|
| `id` | The set id: lowercase letters, digits and `-`. It must equal the folder name under `.wa-asset-sets/`. |
| `title` | A human-readable name. |
| `mapCopyright` | Optional. The credit `scaffold_map` writes into every new map as its `mapCopyright`. |
| `starterKitSha` | Optional. The map-starter-kit commit the set was made for. |
| `tilesets` | One entry per tileset: `name` (equal to the name inside the `.tsj`), `tsj` (path relative to `set.json`), `image` (path of the PNG relative to the project root) and `tilesetCopyright` (the licence and author of the image). |
| `wallTerrain` | The tileset and the name of its edge Wang set for walls, the colour numbers of the wall colour (`wallColor`) and the door colour (`doorColor`) in that Wang set, and `isolatedWallTile`, the tile for a wall cell with no wall neighbours. |
| `doorLintelTiles` | The lintel tiles drawn over door cells: the horizontal and the vertical lintel. They must also be in the Wang set. |
| `faceRules` | The wall faces: their tileset, `height` (always 2), the `styles`, and `exteriorStyle`, the style used outside every room. |
| `wallStyles` | `names`: the face styles a room may choose as `wallStyle`, and the `default`. |
| `floorStyles` | `styles`: a name and a tile for each floor, and the `default`. |
| `collisionTile` | The tile written on the `collisions` layer. It must carry the bool tile property `collides` = `true`. |
| `startTile` | The tile written on the `start` layer for the spawn point. |
| `prefabs` | One entry per prefab: `id`, `path` (relative to `set.json`), `width`, `height`, `category`, `placement`, `faceRow` (north-wall prefabs only), `use`, and an optional `license`. |

Paths are relative and may not contain `..`; the engine resolves them through its project guard, so nothing outside the project is read.

A minimal but complete set, made from four of the starter kit's tilesets with one wall style, two floors and one prefab:

```json
{
  "id": "office-mini",
  "title": "Starter-kit office tiles, minimal",
  "mapCopyright": "Built with wa-agent-engine from the WorkAdventure map-starter-kit tilesets (https://github.com/workadventure/map-starter-kit). The phone pod arrangement is adapted from its conference.tmj (CC-BY-SA 3.0).",
  "tilesets": [
    {
      "name": "WA_Special_Zones",
      "tsj": "tilesets/WA_Special_Zones.tsj",
      "image": "tilesets/WA_Special_Zones.png",
      "tilesetCopyright": "WorkAdventure (https://workadventu.re) - WorkAdventure specific resources license: https://github.com/workadventure/map-starter-kit/blob/1143646a9c02c3928eac4acbb123642c62a48a85/LICENSE.assets"
    },
    {
      "name": "WA_Room_Builder",
      "tsj": "tilesets/WA_Room_Builder.tsj",
      "image": "tilesets/WA_Room_Builder.png",
      "tilesetCopyright": "WorkAdventure (https://workadventu.re) - WorkAdventure specific resources license: https://github.com/workadventure/map-starter-kit/blob/1143646a9c02c3928eac4acbb123642c62a48a85/LICENSE.assets"
    },
    {
      "name": "WA_Seats",
      "tsj": "tilesets/WA_Seats.tsj",
      "image": "tilesets/WA_Seats.png",
      "tilesetCopyright": "WorkAdventure (https://workadventu.re) - WorkAdventure specific resources license: https://github.com/workadventure/map-starter-kit/blob/1143646a9c02c3928eac4acbb123642c62a48a85/LICENSE.assets"
    },
    {
      "name": "WA_Tables",
      "tsj": "tilesets/WA_Tables.tsj",
      "image": "tilesets/WA_Tables.png",
      "tilesetCopyright": "WorkAdventure (https://workadventu.re) - WorkAdventure specific resources license: https://github.com/workadventure/map-starter-kit/blob/1143646a9c02c3928eac4acbb123642c62a48a85/LICENSE.assets"
    }
  ],
  "wallTerrain": {"tileset": "WA_Room_Builder", "wangset": "walls", "wallColor": 1, "doorColor": 2, "isolatedWallTile": 106},
  "doorLintelTiles": [64, 36],
  "faceRules": {
    "tileset": "WA_Room_Builder",
    "height": 2,
    "exteriorStyle": "brick",
    "styles": {
      "white": {
        "row1": {"mid": 203, "openW": 205, "openE": 206, "openWE": 280},
        "row2": {"mid": 228, "openW": 230, "openE": 231, "openWE": 305}
      },
      "brick": {
        "row1": {"mid": 310, "openW": 310, "openE": 310, "openWE": 310},
        "row2": {"mid": 310, "openW": 310, "openE": 310, "openWE": 310}
      }
    }
  },
  "wallStyles": {"default": "white", "names": ["white"]},
  "floorStyles": {
    "default": "wood-light",
    "styles": {
      "wood-light": {"tileset": "WA_Room_Builder", "tile": 350},
      "carpet-red": {"tileset": "WA_Room_Builder", "tile": 387}
    }
  },
  "collisionTile": {"tileset": "WA_Special_Zones", "tile": 2},
  "startTile": {"tileset": "WA_Special_Zones", "tile": 1},
  "prefabs": [
    {
      "id": "phone-pod-2x2",
      "path": "prefabs/phone-pod-2x2.tmj",
      "width": 2,
      "height": 2,
      "category": "phone",
      "placement": "free",
      "use": "Phone or 1:1 call nook: high-back armchair and side table",
      "license": "CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/)"
    }
  ]
}
```

## Tilesets (.tsj)

- One Tiled tileset file in JSON format per image, with 32 × 32 px tiles. A different size fails with `ASSET_SET_INVALID`.
- The tileset's `name` equals its `name` in `set.json`.
- Its `image` field is relative to the `.tsj` file, as Tiled writes it. For a set in `.wa-asset-sets/<id>/tilesets/`, the path `../../../tilesets/<file>.png` points at the project's `tilesets/` folder. The engine itself reads the image path from `set.json`.
- Every `collides` tile property is of type bool, never string. WorkAdventure ignores a string, and validate reports it as `COLLIDES_NOT_BOOL`.

Create the files in Tiled (New Tileset, based on the image, saved as JSON) or write them by hand.

## Wall terrain

Walls are one tile thick, and each wall cell's tile depends on which of its four neighbours are walls or doors. Describe this with one **edge** Wang set in the wall tileset, with two colours: a wall colour and a door colour. A Wang tile lists 8 colours clockwise from the top: top, top-right, right, bottom-right, bottom, bottom-left, left, top-left. An edge set uses the four sides only (positions 1, 3, 5 and 7 in that list); the corners stay 0. On each side, 0 means nothing is there, the wall colour means the wall continues that way, and the door colour means a door is next to it.

An excerpt of the starter set's `WA_Room_Builder.tsj`:

```json
{
  "wangsets": [
    {
      "name": "walls",
      "type": "edge",
      "tile": 104,
      "colors": [
        {"color": "#2b2f30", "name": "wall", "probability": 1, "tile": 104},
        {"color": "#edc489", "name": "door", "probability": 1, "tile": 64}
      ],
      "wangtiles": [
        {"tileid": 104, "wangid": [0, 0, 1, 0, 0, 0, 1, 0]},
        {"tileid": 63, "wangid": [0, 0, 2, 0, 0, 0, 1, 0]},
        {"tileid": 64, "wangid": [0, 0, 2, 0, 0, 0, 2, 0]}
      ]
    }
  ]
}
```

Here colour 1 is the wall and colour 2 the door, so `set.json` has `"wallColor": 1, "doorColor": 2`. Tile 104 is a horizontal wall (wall to the east and to the west), 63 the wall piece west of a door, and 64 the horizontal lintel.

### Coverage

A set must have a tile for each of the 21 patterns below, plus `isolatedWallTile`. Check the Wang set against this table before you test anything else. When one pattern has several tiles, the engine uses the first and still recognises the others as walls.

| Pattern (north, east, south, west) | wangid | Where it is used | Starter tile | In the test room |
|---|---|---|---|---|
| nothing on any side | not in the Wang set | `isolatedWallTile` | 106 | no |
| wall north | `[1,0,0,0,0,0,0,0]` | south end of a wall | 56 | no |
| wall east | `[0,0,1,0,0,0,0,0]` | west end of a wall | 58 | no |
| wall south | `[0,0,0,0,1,0,0,0]` | north end of a wall | 31 | no |
| wall west | `[0,0,0,0,0,0,1,0]` | east end of a wall | 59 | no |
| walls north and south | `[1,0,0,0,1,0,0,0]` | vertical wall | 102 | yes |
| walls east and west | `[0,0,1,0,0,0,1,0]` | horizontal wall | 104 | yes |
| walls east and south | `[0,0,1,0,1,0,0,0]` | north-west corner | 28 | yes |
| walls south and west | `[0,0,0,0,1,0,1,0]` | north-east corner | 29 | yes |
| walls north and east | `[1,0,1,0,0,0,0,0]` | south-west corner | 53 | yes |
| walls north and west | `[1,0,0,0,0,0,1,0]` | south-east corner | 54 | yes |
| walls east, south and west | `[0,0,1,0,1,0,1,0]` | top of a dividing wall | 160 | yes |
| walls north, east and west | `[1,0,1,0,0,0,1,0]` | bottom of a dividing wall | 110 | yes |
| walls north, east and south | `[1,0,1,0,1,0,0,0]` | west end of a dividing wall | 108 | yes |
| walls north, south and west | `[1,0,0,0,1,0,1,0]` | east end of a dividing wall | 158 | yes |
| walls on all sides | `[1,0,1,0,1,0,1,0]` | crossing | 137 | yes |
| door east, wall west | `[0,0,2,0,0,0,1,0]` | wall west of a horizontal door | 63 | yes |
| doors east and west | `[0,0,2,0,0,0,2,0]` | horizontal lintel | 64 | yes |
| wall east, door west | `[0,0,1,0,0,0,2,0]` | wall east of a horizontal door | 65 | yes |
| wall north, door south | `[1,0,0,0,2,0,0,0]` | wall above a vertical door | 11 | yes |
| doors north and south | `[2,0,0,0,2,0,0,0]` | vertical lintel | 36 | yes |
| door north, wall south | `[2,0,0,0,1,0,0,0]` | wall below a vertical door | 61 | yes |

Rooms never need the four wall ends or the isolated tile; only walls drawn by hand next to a build can. A pattern missing from the Wang set makes a build fail with `WALL_PIECE_MISSING`, naming the cell that needed it.

## Wall faces

Under every wall cell whose south side is open, the engine draws two rows of wall face, which collide. Inside a room the faces use the room's `wallStyle`; outside every room they use `exteriorStyle`, unless a face is already there. No faces go under a door.

Each face style has `row1`, the row right under the wall, and `row2`, the row below it. Each row has four variants:

| Variant | Used when |
|---|---|
| `mid` | The face continues on both sides. |
| `openW` | The cell to the west is open, so the face run ends there, for example beside the gap under a door. |
| `openE` | The cell to the east is open. |
| `openWE` | Both sides are open: a run one cell wide. |

A style may reuse one tile for several variants, as the starter set's `brick` style does with tile 310.

## Door lintels

A door is a gap in the wall with a lintel tile drawn over it on the `foreground1` layer, so players walk under it. The horizontal lintel is the Wang pattern with doors east and west, and the vertical lintel the one with doors north and south (64 and 36 in the starter set). List both in `doorLintelTiles` too, so the engine and the validator treat those cells as walkable doors.

## Floors, collisions and the start tile

- `floorStyles` maps each floor name to one tile. Choose plain tiles that repeat well; the engine fills a whole room with the one tile.
- `collisionTile` is drawn on the `collisions` layer, under the floor, so it never shows in WorkAdventure. The starter set uses tile 2 of `WA_Special_Zones`, whose `collides` property is `true`.
- `startTile` marks the spawn on the `start` layer. The starter set uses tile 1 of `WA_Special_Zones`.

## Prefabs (.tmj)

A prefab is a small Tiled map that the engine stamps into a map. Its rules:

- Orthogonal, finite, 32 × 32 px tiles, and exactly the `width` × `height` of its `set.json` entry.
- Tile layers only, each the size of the prefab, with these names:

  | Layer | Drawn | Holds |
  |---|---|---|
  | `furniture1` | under the avatar | The furniture itself. |
  | `furniture2`, `furniture3` | under the avatar, on top of `furniture1` | Items on the furniture, such as a monitor on a desk. |
  | `foreground1`, `foreground2` | over the avatar | The parts a player walks behind: plant crowns, the top of a tall cabinet, a sofa back. |
  | `collisions` | never | Solid cells: any non-zero tile collides. |

- Tilesets refer to the set's `.tsj` files with a `source` relative to the prefab, such as `../tilesets/WA_Seats.tsj`, or are embedded under the same name. Tiles from other tilesets fail with `PREFAB_INVALID`.
- Map properties: `category` (`talks`, `work`, `social`, `logistics`, `fun` or `phone`), `placement` (`free` or `north-wall`), `faceRow` (`upper`, `lower` or `either`, for north-wall prefabs only), `use` (one line on what it is for), and optionally `credit` and `license` for arrangements adapted from someone else's map. They must equal the prefab's `set.json` entry, or loading fails with `PREFAB_INVALID`.
- A `free` prefab stands on floor below the face rows. A `north-wall` prefab hangs on the face rows: its top row sits on the upper face row (`upper`), the lower one (`lower`), or either.
- Flipped tiles are kept as Tiled stores them.

The starter set's `prefabs/phone-pod-2x2.tmj`, a free 2 × 2 phone nook:

```json
{
  "compressionlevel": -1,
  "height": 2,
  "infinite": false,
  "layers": [
    {"data": [0, 0, 0, 3], "height": 2, "id": 1, "name": "collisions", "opacity": 1, "type": "tilelayer", "visible": true, "width": 2, "x": 0, "y": 0},
    {"data": [95, 0, 108, 335], "height": 2, "id": 2, "name": "furniture1", "opacity": 1, "type": "tilelayer", "visible": true, "width": 2, "x": 0, "y": 0}
  ],
  "nextlayerid": 3,
  "nextobjectid": 1,
  "orientation": "orthogonal",
  "properties": [
    {"name": "category", "type": "string", "value": "phone"},
    {"name": "credit", "type": "string", "value": "Arrangement adapted from the WorkAdventure map-starter-kit conference.tmj (https://github.com/workadventure/map-starter-kit), licensed CC-BY-SA 3.0 (https://creativecommons.org/licenses/by-sa/3.0/)"},
    {"name": "license", "type": "string", "value": "CC-BY-SA-3.0 (https://creativecommons.org/licenses/by-sa/3.0/)"},
    {"name": "placement", "type": "string", "value": "free"},
    {"name": "use", "type": "string", "value": "Phone or 1:1 call nook: high-back armchair and side table"}
  ],
  "renderorder": "right-down",
  "tiledversion": "1.12.2",
  "tileheight": 32,
  "tilesets": [
    {"firstgid": 1, "source": "../tilesets/WA_Special_Zones.tsj"},
    {"firstgid": 13, "source": "../tilesets/WA_Seats.tsj"},
    {"firstgid": 195, "source": "../tilesets/WA_Tables.tsj"}
  ],
  "tilewidth": 32,
  "type": "map",
  "version": "1.11",
  "width": 2
}
```

Its `collisions` layer makes the bottom-right cell solid (any tile works; this one is the collision tile). `furniture1` holds the armchair from `WA_Seats` and the side table from `WA_Tables`: tile ids 95 and 108 fall in `WA_Seats` (from `firstgid` 13), and 335 in `WA_Tables` (from `firstgid` 195). Nothing needs `foreground1`, because the nook has no part a player walks behind.
