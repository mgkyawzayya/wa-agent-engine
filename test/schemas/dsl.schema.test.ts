import { describe, expect, test } from 'vitest';
import { DslShape, parseDsl, type Rect } from '../../src/schemas/dsl.schema.js';

const room = (id: string, bounds: Rect, extra: Record<string, unknown> = {}) => ({ id, bounds, ...extra });
const dsl = (rooms: unknown[], extra: Record<string, unknown> = {}) => ({
  mapWidth: 40,
  mapHeight: 30,
  assetSet: 'wa-starter-office',
  rooms,
  ...extra,
});

const codeOf = (input: unknown): string | undefined => {
  try {
    parseDsl(input);
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
};

describe('valid layouts', () => {
  test('rooms sharing walls, with doors in both orientations, parse cleanly', () => {
    const parsed = parseDsl(
      dsl([
        room('talk', { x: 0, y: 0, width: 10, height: 8 }, { doors: [{ wall: 'south', offset: 3, width: 2 }] }),
        room('lounge', { x: 9, y: 0, width: 10, height: 8 }, { doors: [{ wall: 'west', offset: 3 }] }),
        room('hall', { x: 0, y: 7, width: 19, height: 8 }),
      ]),
    );
    expect(parsed.tileSize).toBe(32);
    expect(parsed.rooms[1]!.doors[0]!.width).toBe(1);
    expect(parsed.variables).toEqual([]);
  });

  test('variables default to NPC-only writes', () => {
    const parsed = parseDsl(dsl([], { variables: [{ name: 'agenda', default: [] }, { name: 'open', default: true, writableBy: 'admin' }] }));
    expect(parsed.variables.map((v) => v.writableBy)).toEqual(['wa-agent-engine', 'admin']);
  });

  test('a shared door declared from both rooms merges, and doors 2 cells apart are fine', () => {
    expect(
      codeOf(
        dsl([
          room('a', { x: 0, y: 0, width: 12, height: 6 }, { doors: [{ wall: 'south', offset: 3, width: 2 }, { wall: 'south', offset: 7 }] }),
          room('b', { x: 0, y: 5, width: 12, height: 6 }, { doors: [{ wall: 'north', offset: 3, width: 2 }] }),
        ]),
      ),
    ).toBeUndefined();
  });

  test('an exit door on a map-edge wall parses', () => {
    expect(codeOf(dsl([room('a', { x: 0, y: 0, width: 8, height: 6 }, { doors: [{ wall: 'north', offset: 3, exit: true }] })]))).toBeUndefined();
  });

  test('a 2x2 grid meeting at a cross parses', () => {
    expect(
      codeOf(
        dsl([
          room('a', { x: 0, y: 0, width: 6, height: 6 }),
          room('b', { x: 5, y: 0, width: 6, height: 6 }),
          room('c', { x: 0, y: 5, width: 6, height: 6 }),
          room('d', { x: 5, y: 5, width: 6, height: 6 }),
        ]),
      ),
    ).toBeUndefined();
  });
});

describe('coded geometry errors', () => {
  const cases: [string, unknown, string][] = [
    ['overlapping interiors', dsl([room('a', { x: 0, y: 0, width: 8, height: 8 }), room('b', { x: 4, y: 4, width: 8, height: 8 })]), 'ROOM_OVERLAP'],
    ['parallel walls side by side', dsl([room('a', { x: 0, y: 0, width: 6, height: 6 }), room('b', { x: 6, y: 0, width: 6, height: 6 })]), 'THICK_WALL'],
    ['interior of 2 rows', dsl([room('a', { x: 0, y: 0, width: 6, height: 4 })]), 'ROOM_TOO_SMALL'],
    ['vertical door at offset 2', dsl([room('a', { x: 0, y: 0, width: 6, height: 10 }, { doors: [{ wall: 'east', offset: 2 }] })]), 'DOOR_BLOCKED_BY_FACE'],
    ['map over 500 tiles', dsl([], { mapWidth: 501 }), 'MAP_TOO_LARGE'],
    ['door next to a corner', dsl([room('a', { x: 0, y: 0, width: 8, height: 6 }, { doors: [{ wall: 'north', offset: 1 }] })]), 'DOOR_AT_CORNER'],
    ['door past the wall end', dsl([room('a', { x: 0, y: 0, width: 8, height: 6 }, { doors: [{ wall: 'south', offset: 6, width: 3 }] })]), 'DOOR_OUT_OF_WALL'],
    ['room outside the map', dsl([room('a', { x: 36, y: 0, width: 6, height: 6 })]), 'ROOM_OUT_OF_BOUNDS'],
    ['duplicate room id', dsl([room('a', { x: 0, y: 0, width: 6, height: 6 }), room('a', { x: 5, y: 0, width: 6, height: 6 })]), 'DUPLICATE_ROOM_ID'],
    [
      'vertical door onto the neighbour face rows',
      dsl([
        room('a', { x: 0, y: 0, width: 6, height: 12 }, { doors: [{ wall: 'east', offset: 5 }] }),
        room('b', { x: 5, y: 4, width: 6, height: 8 }),
      ]),
      'DOOR_BLOCKED_BY_FACE',
    ],
    ['non-https modal origin', dsl([], { modalOrigins: ['http://example.org'] }), 'BAD_URL'],
    ['modal origin with a path', dsl([], { modalOrigins: ['https://example.org/app'] }), 'BAD_URL'],
    ['shape error', { mapWidth: 'wide' }, 'INVALID_INPUT'],
    ['exit door away from the map edge', dsl([room('a', { x: 2, y: 2, width: 8, height: 6 }, { doors: [{ wall: 'south', offset: 3, exit: true }] })]), 'EXIT_NOT_AT_MAP_EDGE'],
    [
      'two doors 1 cell apart',
      dsl([room('a', { x: 0, y: 0, width: 12, height: 6 }, { doors: [{ wall: 'south', offset: 2 }, { wall: 'south', offset: 4 }] })]),
      'DOOR_TOO_CLOSE',
    ],
    [
      'overlapping doors',
      dsl([room('a', { x: 0, y: 0, width: 12, height: 6 }, { doors: [{ wall: 'south', offset: 2, width: 3 }, { wall: 'south', offset: 3 }] })]),
      'DOOR_TOO_CLOSE',
    ],
    [
      'doors from both sides of a shared wall, 1 cell apart',
      dsl([
        room('a', { x: 0, y: 0, width: 12, height: 6 }, { doors: [{ wall: 'south', offset: 3 }] }),
        room('b', { x: 0, y: 5, width: 12, height: 6 }, { doors: [{ wall: 'north', offset: 5 }] }),
      ]),
      'DOOR_TOO_CLOSE',
    ],
    ['furniture outside the map', dsl([room('a', { x: 0, y: 0, width: 6, height: 6 }, { furniture: [{ prefabId: 'lectern-1x1', x: 40, y: 1 }] })]), 'FURNITURE_OUT_OF_BOUNDS'],
    [
      'duplicate variable',
      dsl([], { variables: [{ name: 'phase', default: 1 }, { name: 'phase', default: 2 }] }),
      'DUPLICATE_VARIABLE',
    ],
  ];

  test.each(cases)('%s', (_name, input, code) => {
    expect(codeOf(input)).toBe(code);
  });

  test('unknown keys and path-like asset sets are shape errors, not silently dropped', () => {
    expect(codeOf(dsl([room('a', { x: 0, y: 0, width: 6, height: 6 }, { door: [{ wall: 'south', offset: 2 }] })]))).toBe(
      'INVALID_INPUT',
    );
    expect(codeOf(dsl([], { assetSet: '../../tilesets' }))).toBe('INVALID_INPUT');
    expect(codeOf(dsl([], { extra: true }))).toBe('INVALID_INPUT');
  });

  test('a variable default nested absurdly deep is a coded error, not a crash', () => {
    let deep: unknown = 0;
    for (let i = 0; i < 50_000; i++) deep = [deep];
    expect(codeOf(dsl([], { variables: [{ name: 'deep', default: deep }] }))).toBe('INVALID_INPUT');
  });

  test('DslShape alone accepts every input that only fails geometry', () => {
    for (const [, input, code] of cases) {
      if (code === 'INVALID_INPUT') continue;
      expect(DslShape.safeParse(input).success).toBe(true);
    }
  });
});
