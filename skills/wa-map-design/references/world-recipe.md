# Worlds: buildings in a landscape

A venue does not have to be one block of rooms. With `ground`, `paths`, `water` and `scatter` in the DSL, the map becomes a world: separate buildings on grass, joined by roads and plazas, with rivers, bridges, forests and outdoor seating. Use a world when the user asks for a campus, a park, a village, a "world", or a venue that should feel open and outdoors; use one building when they ask for an office or a single hall.

## What the build draws

| DSL field | What it does |
|---|---|
| `ground` | A floor style for every tile no room covers, for example `"grass"`. It goes only where the floor is empty, so floors drawn by hand stay. |
| `paths` | Roads, paths and plazas on the ground: a line of `points` with a `width`, or a `rect`. Each has a floor `style`, for example `"cobble"`. |
| `water` | Rivers (`points` and `width`) and ponds (`rect`). Water blocks walking. Where a path crosses water it becomes a bridge, walkable, by itself. |
| `scatter` | An `area` filled with `count` prefabs picked at random from `prefabs`, for example trees and flowers. They keep off rooms, paths, water, the fronts of doors, the spawn and the tiles around it, prefabs placed with `place_prefab`, and each other; a spot that would still cut a door off is skipped, and so is a prefab larger than the area. The same `seed` gives the same arrangement; change it for another. At most 500 per area and 5,000 over all areas. |

Every build redraws all of it from the DSL, like the rooms. The cells it draws belong to the build like room floors do: a later build replaces hand edits on ground, paths and water, so make lasting changes in the DSL. Points, rectangles and scatter areas must lie inside the map, and the points of a line must go straight across or straight down from one to the next; turns are fine. Ground, path and water never cover rooms or their wall faces, so draw the world around them.

**Bridges.** Every water tile a path covers becomes bridge deck, running the way the path runs there. A path laid along a river therefore makes one long deck, a path that turns on the water mixes deck directions, a path that ends in the water makes a pier, and a plaza `rect` over a pond decks the whole overlap. Cross water straight, and turn on land.

## Plan the world

1. **Buildings.** Group the rooms into buildings: a main hall with its side rooms, a session wing, a food court, an organizer house. Rooms of one building share walls as usual; buildings stand apart.
2. **Space.** Leave 6–12 tiles of ground between buildings, and 6 or more at the map edges for forest. A world with 8–10 buildings is about 100 × 75 tiles; check it fits the 500 × 500 limit and render it at `"scale": 0.25`.
3. **Entrances.** Give each building a door in an outer wall, usually the south one, facing a path. A south door leaves a gap in the two wall-face rows under the wall, and it must reach at least 4 walkable tiles past that gap, or the build fails with `DOOR_UNREACHABLE`. `scatter` keeps the front of every door free: one tile wider than the door on each side, 3 tiles deep, and under a south door 3 rows past the faces. Keep water and furniture out of it too.
4. **Roads.** A main road 3–4 wide from the entrance plaza to every building; 2-wide paths to smaller houses. End each path at the cells in front of a door.
5. **Plazas.** A `rect` path in front of the main hall and at crossings, with a fountain or seating on it: place them with `place_prefab` after the build, on the plaza. They stay through later builds, and `scatter` keeps off them.
6. **Water.** A river 3–4 wide across the map, crossed by the roads (the bridges come by themselves), or a pond beside the plaza. Keep water out of the fronts of doors: a door that opens onto water fails with `DOOR_UNREACHABLE`.
7. **Nature.** Forests along the map edges: `scatter` areas with trees and forest blocks and a high `count`. Meadows between buildings: flowers, bushes and a few trees. Outdoor seating near the food court.
8. **Spawn.** On the entrance plaza or the main road, with a `start` zone around it. Scatter keeps off the spawn and the tiles around it; water over it gives the build warning `START_TILE_BLOCKED`.

The outdoor prefabs (trees, forest blocks, bushes, rocks, hedges, flowers, a fountain, crates, barrels) are in the catalog's outdoor group, and the ground and path styles with the other floor styles: [prefab-catalog.md](prefab-catalog.md).

## Example

A small world: a hall and a café on grass, a road with a bridge over a river, a plaza, trees.

```json
{
  "mapWidth": 40,
  "mapHeight": 30,
  "assetSet": "wa-starter-office",
  "ground": "grass",
  "rooms": [
    {"id": "hall", "name": "Main Hall", "details": "Keynotes 10:00", "bounds": {"x": 4, "y": 4, "width": 14, "height": 10},
     "doors": [{"wall": "south", "offset": 6, "width": 2}]},
    {"id": "cafe", "name": "Café", "details": "Coffee and snacks", "bounds": {"x": 24, "y": 4, "width": 10, "height": 8},
     "doors": [{"wall": "south", "offset": 4, "width": 2}]}
  ],
  "paths": [
    {"points": [[10, 14], [10, 22], [28, 22], [28, 12]], "width": 2, "style": "cobble"},
    {"rect": {"x": 7, "y": 22, "width": 8, "height": 5}, "style": "cobble"}
  ],
  "water": [{"points": [[20, 0], [20, 29]], "width": 3}],
  "scatter": [
    {"area": {"x": 0, "y": 0, "width": 40, "height": 4}, "prefabs": ["forest-pine-4x4", "forest-oak-4x4", "tree-pine-2x3"], "count": 10, "seed": 1},
    {"area": {"x": 0, "y": 15, "width": 6, "height": 15}, "prefabs": ["tree-oak-2x3", "bush-round-2x1", "flowers-yellow-3x3", "flowers-pink-2x2"], "count": 10, "seed": 2}
  ]
}
```

Forest blocks (`forest-oak-4x4`, `forest-pine-4x4`) join side by side and nobody can walk into them: use them for thick woods at the edges, and single trees, bushes and flowers for meadows. Each block is two kinds of tree, 2 tiles wide each, side by side: plain oak and blossom oak, or dark pine and emerald pine. Put a `fountain-2x2` on a `cobble` plaza; it is drawn with cobble around it.

## Check it

- `build_room_from_dsl` warns `SCATTER_INCOMPLETE` when an area had less free ground than `count` asked for (lower the count or widen the area), and `START_TILE_BLOCKED` when water covers the spawn.
- `validate_wa_map` has no errors.
- In the preview: every building reachable by a path, every door with free ground in front, bridges where roads cross water, no building pressed against another, forest at the edges, and no large bare stretch of grass in the middle.
