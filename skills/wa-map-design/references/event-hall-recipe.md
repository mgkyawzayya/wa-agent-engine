# Event halls: furnishing a VarCamp venue

A venue looks real when every room says what it is and is furnished for what happens in it. This page gives layouts for the rooms of a VarCamp venue, with sizes, furniture and zones.

Each layout lists the built-in `wa-starter-office` prefab first. When the project has a prop set (a `.wa-asset-sets/<id>/set.json` with `extends`, made with `import_prop_set`), use its event furniture where it has some: use that set's id as the DSL `assetSet`, and read its prefab ids from the `set.json`, or from the `import_prop_set` result. The examples in brackets are the ids of the VarCamp prop set, for example `stage`, `projector-screen` and `audience-chairs-v2`; check them against the set before you use them.

## The venue checklist

A VarCamp venue needs these spaces. Larger events repeat the session rooms and add halls.

| Space | Purpose |
|---|---|
| Lobby with registration and the help desk | Where people arrive (the spawn and `start` zone), get help, and read the schedule and topic boards |
| Main hall | Opening, keynotes and closing |
| Session rooms | Talks proposed on the day (the "unconference" grid) |
| Q&A rooms | Follow-up questions with a speaker after a talk |
| Workshop rooms | Hands-on sessions at tables |
| Organizer room | Where the organizers coordinate; staff only by convention |
| Sponsor row | Sponsor booths along a hall wall |
| Food court | Tea, water, snacks and café tables |
| Games and chill area | Games, beanbags and sofas between sessions |
| Phone booths | One-to-one calls |

Name and describe every room (`name` and `details`): the label is how people find their way. Good details say what happens and when: "Keynotes 10:00 and 16:30", "Q&A with the speaker after each talk", "Ask the organizers anything".

## Layouts

Sizes include walls. Rows below are counted from the room's first walkable row, under the two face rows.

### Main hall (about 24 × 22 or larger)

- A screen centred on the north wall: `wall-screen-3x2` hangs on the face rows; a free-standing prop-set screen such as [`projector-screen`] stands on the first floor row under the face. A prop-set prefab with `"placement": "north-wall"` in its `set.json` entry hangs on the face rows like `wall-screen-3x2`.
- Below it, centred: a stage (`stage-light-4x3`, or [`stage`]) with a lectern beside it (`lectern-1x1`, or [`podium`], [`mic-stand-a`]).
- Banners on both sides of the stage ([`rollup-banner`]), plants in the corners (`plant-palm-3x3`, `plant-tree-1x2`, or [`plant`]).
- Audience: 4 to 8 rows facing the stage, two blocks with a 2-tile aisle in the middle, one empty row between rows (`audience-row-6x1`, or [`audience-chairs-v2`] side by side).
- At the back: a schedule display (`info-screen-stand-1x3`, or [`schedule-board-a`]), a water point ([`water-dispenser`]).
- Zone: a meeting room for the stage, for example `waProperties: {"jitsiRoom": "Main Hall"}`.

### Lobby (about 20 × 14)

- The spawn tile and a `start` zone near the entrance.
- Registration and help desk facing the entrance (`registration-desk-4x3`, or [`registration-desk-v3`]) with an info sign (`info-sign-1x3`, or [`signpost`]).
- Schedule board and topic board side by side on a free wall or stand (`notice-board-3x1` on the north wall, `whiteboard-easel-3x3`, or [`schedule-board-a`], [`topic-board`], [`notice-board`]); a website zone over them with the schedule URL (`openWebsite`) helps people read it.
- A balloon arch or banners at the doors to the halls ([`balloon-arch`], [`rollup-banner`]), plants, and a few seats.

### Session room (about 12 × 12)

- A screen on the north wall, a small stage or a lectern, 3 to 4 audience rows with an aisle.
- A topic or session board near the door ([`topic-board`], `whiteboard-easel-3x3`), a room sign ([`room-sign-a`]).
- Zone: a meeting room named after the room.

### Q&A room (about 10 × 9)

- A circle of seats or a meeting table (`glass-table-4x6`, `table-long-4x5`, or [`conf-table`] with [`office-chair`]).
- A whiteboard for questions (`whiteboard-easel-3x3`, or [`whiteboard`]).
- Zone: a meeting room; details such as "Q&A with the speaker after each talk".

### Workshop room (about 14 × 12)

- Two to four work tables (`table-long-6x3`, `table-long-4x3`, `coworking-pod-4x5`) with a gap of two tiles around each.
- A whiteboard and a screen; a meeting zone.

### Organizer room (about 10 × 9)

- Desks (`executive-desk-chair-3x3`, `executive-desk-3x2`), a notice board, a whiteboard.
- Details such as "Organizers: ask us anything"; a meeting zone so organizers can talk.

### Sponsor row

- Along the north wall of a hall: `sponsor-booth-4x4` side by side with one tile between, or [`rollup-banner`] pairs with a table between them.
- A plant between booths.

### Food court (about 14 × 10)

- On the north wall: `snack-bar-5x3`; along the west wall: `kitchen-counter-2x5`.
- Tea and water points ([`tea-station-v2`], [`water-dispenser`], [`vending-machine-a`]).
- Café tables spread over the floor (`cafe-table-3x2`) with plants.

### Games and chill area (about 14 × 12)

- Games: `game-circle-3x3`, `pouf-row-4x1`, or [`pingpong-table-a`], [`foosball-table-a`], [`pool-table-a`], [`chess-table-a`], [`arcade-cabinet-a`].
- Chill: `lounge-sofa-set-4x4`, `conversation-pit-3x4`, or rugs with beanbags ([`rug-blue`] with [`beanbag-red`] and friends next to it, not on it).
- Party touches: `party-balloons-1x1`, [`prize-wheel`], [`trophy`].

### Phone booths

See "Phone booths" in the skill: walled rooms 5 wide, or `phone-pod-2x2` nooks.

### Zodiac room (a hall about 20 × 22 with a wing of 12 × 22 on each side)

For zodiac-themed venues, with a prop set that has zodiac props. The ids in brackets are those of the VarCamp zodiac props; `<sign>` is the sign in lowercase (`aries`, `taurus`, …). Check them against the set.

- **Hall:** `carpet-navy` floor. Name it after the sign ("Aries") with its element and dates as details ("Fire sign, March 21 to April 19"), and give it a meeting zone.
- **North wall (face rows):** wall props have `"placement": "north-wall"`; put their top-left cell on the first face row (room `y + 1`):
  - [`wall-monitor`] at both ends;
  - the sign's plaque [`plaque-<sign>`] and constellation chart [`chart-<sign>`] in the middle.
  - Leave a run of at least 5 free face cells for the label.
- **Centre:**
  - the sign's monument [`beacon-<sign>`] (4 × 3), centred on floor rows 3 to 5;
  - tall crystals [`crystal-tall-blue`] on both sides, small ones [`crystal-blue`] below them;
  - holo screens [`holo-screen`] near the side walls;
  - the floor symbol [`floor-<sign>`] (2 × 2) centred under the monument.
- **Star path:** [`path-v`] tiles in the two middle columns, from under the floor symbol down to a 2-wide south door under them. They are walkable.
- **Sides and door:**
  - terminal desks [`terminal-desk`] left and right halfway down;
  - star lamps [`star-lamp`] in the bottom corners;
  - the element's decor flanking the door (see below).
- **Wings:** `wood-light` floor, joined to the hall by 2-wide doors in the shared walls about halfway down. One wing is a lounge (`lounge-sofa-set-4x4`, `conversation-pit-3x4`, a rug, `low-shelf-2x2`, plants), the other a study (`executive-desk-chair-3x3`, [`whiteboard`], `low-shelf-2x2`, [`conf-table`] with [`office-chair`]). Name them after the sign ("Aries Lounge", "Aries Study"), and hang the element's wall decor on their face rows.

| Element | Signs | Decor |
|---|---|---|
| Fire | Aries, Leo, Sagittarius | [`brazier-fire`], [`flame-banner-fire`], [`wall-torch-fire`] (north wall) |
| Earth | Taurus, Virgo, Capricorn | [`bonsai-earth`], [`stone-planter-earth`], [`geode-earth`] |
| Air | Gemini, Libra, Aquarius | [`windchime-air`], [`cloud-pouf-air`], [`kite-air`] (north wall) |
| Water | Cancer, Scorpio, Pisces | [`aquarium-water`], [`fountain-water`], [`jelly-lamp-water`] |

Dates for the details: Aries March 21 to April 19, Taurus April 20 to May 20, Gemini May 21 to June 20, Cancer June 21 to July 22, Leo July 23 to August 22, Virgo August 23 to September 22, Libra September 23 to October 22, Scorpio October 23 to November 21, Sagittarius November 22 to December 21, Capricorn December 22 to January 19, Aquarius January 20 to February 18, Pisces February 19 to March 20.

A venue with all twelve signs groups them by element into four districts of three rooms each. In a world map ([world-recipe.md](world-recipe.md)), each district is a building or a row of buildings, with its element's decor outside too.

## Big venues (30 rooms or more)

- Use two or three large halls as hubs (main hall, lobby, a second hall for sponsors or food), with rows of session, Q&A and workshop rooms along them; every room opens onto a hall or a corridor room.
- Vary the floors: carpets for talk rooms, wood for the lobby and lounges, tiles for food.
- Give rooms of the same kind numbered names ("Session Room 3", "Q&A Room 2") and details that differ.
- Make the map exactly as large as the layout: leftover map area shows as empty void.

## Before you finish

Render the map and look at it:

- every room shows its name on its top wall, and `validate_wa_map` has no `LABEL_TOO_LONG`;
- no hall has an empty stretch of floor wider than about 6 tiles: add seating, plants, boards or stands there;
- every door has free cells in front of it, and the spawn tile is clear.
