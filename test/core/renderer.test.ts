import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { encodeGid } from '../../src/core/gid.js';
import { createEmptyMap, readMap, serializeMap, sha256Hex } from '../../src/core/map-io.js';
import { decodePng, encodePng, readPngHeader, readPngInfo, toRgba8, type Rgba8 } from '../../src/core/png.js';
import { composeMap, loadSheets, previewName, renderMap } from '../../src/core/renderer.js';
import type { TiledEmbeddedTileset, TiledMap } from '../../src/schemas/tiled.schema.js';
import { makeFullProject, type TempProject } from '../helpers/project.js';

const HASHES = fileURLToPath(new URL('./renderer.hashes.json', import.meta.url));
const OUTPUT = fileURLToPath(new URL('../../.cache/test-output/', import.meta.url));

let project: TempProject;
beforeEach(async () => {
  project = await makeFullProject(['conference.tmj', 'office.tmj']);
});
afterEach(() => project.cleanup());

// Golden hashes only: a rendered image is derived from licensed art and is never committed.
// On a mismatch the actual image goes to the gitignored .cache/test-output/ for inspection.
async function expectGolden(name: string, image: Rgba8): Promise<void> {
  const golden = JSON.parse(await readFile(HASHES, 'utf8')) as Record<string, { rgba: string; png: string }>;
  const png = encodePng(image);
  const actual = { rgba: sha256Hex(new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength)), png: sha256Hex(png) };
  if (golden[name]?.rgba !== actual.rgba || golden[name]?.png !== actual.png) {
    await mkdir(OUTPUT, { recursive: true });
    await writeFile(join(OUTPUT, `${name}.actual.png`), png);
    expect.fail(`golden ${name} differs; actual ${JSON.stringify(actual)} written to ${join(OUTPUT, `${name}.actual.png`)}`);
  }
}

// A PNG written chunk by chunk, for images fast-png cannot encode (colour keys, lying headers).
function rawPng(header: { width: number; height: number; depth?: number; colorType: number }, extra: [string, Buffer][], idat: Buffer): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(header.width, 0);
  ihdr.writeUInt32BE(header.height, 4);
  ihdr[8] = header.depth ?? 8;
  ihdr[9] = header.colorType;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk('IHDR', ihdr), ...extra.map(([t, d]) => chunk(t, d)), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

describe('PNG decoding', () => {
  const base = { width: 2, height: 1, text: {}, resolution: undefined, iccEmbeddedProfile: undefined };
  test.each([
    ['grey', { channels: 1, depth: 8, data: new Uint8Array([10, 200]) }, [10, 10, 10, 255, 200, 200, 200, 255]],
    ['grey + alpha', { channels: 2, depth: 8, data: new Uint8Array([10, 0, 200, 128]) }, [10, 10, 10, 0, 200, 200, 200, 128]],
    ['RGB', { channels: 3, depth: 8, data: new Uint8Array([1, 2, 3, 4, 5, 6]) }, [1, 2, 3, 255, 4, 5, 6, 255]],
    ['RGBA', { channels: 4, depth: 8, data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }, [1, 2, 3, 4, 5, 6, 7, 8]],
    ['16-bit RGBA', { channels: 4, depth: 16, data: new Uint16Array([0x0100, 0x02ff, 0x0300, 0xffff, 0, 0, 0, 0]) }, [1, 2, 3, 255, 0, 0, 0, 0]],
    [
      // fast-png 8 decodes a tRNS chunk into 4-component palette entries.
      'palette with transparency',
      { channels: 1, depth: 8, data: new Uint8Array([0, 1]), palette: [[255, 0, 0, 255], [0, 0, 255, 0]] },
      [255, 0, 0, 255, 0, 0, 255, 0],
    ],
    ['grey colour key', { channels: 1, depth: 8, data: new Uint8Array([7, 9]), transparency: new Uint16Array([7]) }, [7, 7, 7, 0, 9, 9, 9, 255]],
    ['RGB colour key', { channels: 3, depth: 8, data: new Uint8Array([0, 0, 255, 0, 0, 254]), transparency: new Uint16Array([0, 0, 255]) }, [0, 0, 255, 0, 0, 0, 254, 255]],
    ['16-bit grey colour key', { channels: 1, depth: 16, data: new Uint16Array([0x0700, 0x0701]), transparency: new Uint16Array([0x0700]) }, [7, 7, 7, 0, 7, 7, 7, 255]],
  ])('%s', (_name, png, expected) => {
    const out = toRgba8({ ...base, ...png } as unknown as Parameters<typeof toRgba8>[0]);
    expect([...out.data]).toEqual(expected);
  });

  test('a PNG round-trips and its header is read without decoding', async () => {
    const image: Rgba8 = { width: 3, height: 2, data: new Uint8ClampedArray(24).map((_, i) => i * 10) };
    const bytes = encodePng(image);
    expect(readPngHeader(bytes)).toEqual({ width: 3, height: 2 });
    expect(readPngInfo(bytes).inflatedBytes).toBe(2 * (1 + 3 * 4));
    expect([...(await decodePng(bytes)).data]).toEqual([...image.data]);
  });

  test('a colour-keyed RGB file decodes with that colour transparent', async () => {
    const bytes = rawPng({ width: 4, height: 1, colorType: 2 }, [['tRNS', Buffer.from([0, 0, 0, 0, 0, 255])]], deflateSync(Buffer.from([0, 0, 0, 255, 9, 9, 9, 0, 0, 255, 1, 2, 3])));
    expect([...(await decodePng(bytes)).data]).toEqual([0, 0, 255, 0, 9, 9, 9, 255, 0, 0, 255, 0, 1, 2, 3, 255]);
  });

  test('image data that inflates past its header is refused without inflating it all', async () => {
    // Declares 64x64 RGBA (16,448 bytes of data) but inflates to 64 MB.
    const bomb = rawPng({ width: 64, height: 64, colorType: 6 }, [], deflateSync(Buffer.alloc(64 * 1024 * 1024)));
    expect(bomb.length).toBeLessThan(200_000);
    const before = process.memoryUsage().rss;
    await expect(decodePng(bomb)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(process.memoryUsage().rss - before).toBeLessThan(48 * 1024 * 1024);
  });

  test('interlaced data sizes follow the seven Adam7 passes', () => {
    const header = rawPng({ width: 3, height: 3, colorType: 6 }, [], Buffer.alloc(0));
    header[28] = 1;
    // Passes 2 and 3 start past a 3 px image and are empty. Pass 1 and 4 hold one 1 px row,
    // pass 5 one 2 px row, pass 6 two 1 px rows, and pass 7 one 3 px row: 9 pixels in all.
    expect(readPngInfo(header).inflatedBytes).toBe(5 + 5 + 9 + 2 * 5 + 13);
  });
});

// A tiny map with 2x2 px tiles: one tile with four distinct pixels A B / C D.
const A = [255, 0, 0, 255];
const B = [0, 255, 0, 255];
const C = [0, 0, 255, 255];
const D = [255, 255, 0, 255];

function tileset(extra: Partial<TiledEmbeddedTileset> = {}): TiledEmbeddedTileset {
  return { columns: 1, firstgid: 1, image: 't.png', imageheight: 2, imagewidth: 2, name: 'T', tilecount: 1, tileheight: 2, tilewidth: 2, ...extra };
}

function solid(size: number, rgba: number[]): Rgba8 {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) data.set(rgba, i * 4);
  return { width: size, height: size, data };
}

function tinyMap(width: number, height: number, layers: { data: number[] }[], tilesets: TiledEmbeddedTileset[]): TiledMap {
  const map = createEmptyMap(width, height);
  map.tilewidth = 2;
  map.tileheight = 2;
  map.tilesets = tilesets;
  map.layers = layers.map((l, i) => ({ data: l.data, height, id: i + 1, name: `l${i}`, opacity: 1, type: 'tilelayer' as const, visible: true, width, x: 0, y: 0 }));
  return map;
}

const pixel = (image: Rgba8, x: number, y: number): number[] => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];

function flipMap(): { map: TiledMap; sheets: Map<TiledEmbeddedTileset, Rgba8> } {
  const image: Rgba8 = { width: 2, height: 2, data: new Uint8ClampedArray([...A, ...B, ...C, ...D]) };
  const ts = tileset();
  const combos = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const map = tinyMap(8, 1, [{ data: combos.map(([h, v, d]) => encodeGid({ gid: 1, h: h === 1, v: v === 1, d: d === 1 })) }], [ts]);
  return { map, sheets: new Map([[ts, image]]) };
}

describe('flip flags', () => {
  test('all 8 combinations draw like Tiled', () => {
    const { map, sheets } = flipMap();
    const out = composeMap(map, sheets);
    const name = (r: number, g: number, b: number): string => (r && g ? 'D' : r ? 'A' : g ? 'B' : b ? 'C' : '?');
    const cell = (i: number): string => {
      const px = (x: number, y: number) => {
        const o = (y * out.width + i * 2 + x) * 4;
        return name(out.data[o]!, out.data[o + 1]!, out.data[o + 2]!);
      };
      return `${px(0, 0)}${px(1, 0)}/${px(0, 1)}${px(1, 1)}`;
    };
    // none, H, V, HV, D (transpose), D+H (90° clockwise), D+V (90° anticlockwise), D+H+V
    expect(Array.from({ length: 8 }, (_, i) => cell(i))).toEqual(['AB/CD', 'BA/DC', 'CD/AB', 'DC/BA', 'AC/BD', 'CA/DB', 'BD/AC', 'DB/CA']);
  });

  test('hidden layers are skipped and layer opacity applies', () => {
    const { map, sheets } = flipMap();
    const layer = map.layers[0] as { opacity: number; visible: boolean };
    layer.opacity = 0.5;
    expect(composeMap(map, sheets).data[3]).toBe(128);
    layer.visible = false;
    expect(composeMap(map, sheets).data.every((v) => v === 0)).toBe(true);
  });
});

describe('tiles that do not match the map grid', () => {
  test('a larger tile is anchored at the bottom-left of its cell and clipped, never wrapped', () => {
    const big = tileset({ name: 'Big', tilewidth: 4, tileheight: 4, imagewidth: 4, imageheight: 4 });
    // Cell (1,1) of a 3x2 map of 2 px cells: bottom-left corner at (2,4), so the 4 px tile
    // covers x 2..5 and y 0..3. In the last column it runs past the edge and is clipped.
    const map = tinyMap(3, 2, [{ data: [0, 0, 0, 0, 1, 1] }], [big]);
    const out = composeMap(map, new Map([[big, solid(4, A)]]));
    expect(pixel(out, 2, 0)).toEqual(A);
    expect(pixel(out, 5, 3)).toEqual(A);
    expect(pixel(out, 1, 3)).toEqual([0, 0, 0, 0]);
    // Nothing from the clipped tile wraps into the next row's start.
    expect(pixel(out, 0, 1)).toEqual([0, 0, 0, 0]);
  });

  test('a smaller tile sits in the bottom-left corner of its cell, and tileoffset shifts it', () => {
    const small = tileset({ name: 'Small', tilewidth: 1, tileheight: 1, imagewidth: 1, imageheight: 1 });
    const map = tinyMap(2, 2, [{ data: [0, 0, 0, 1] }], [small]);
    const out = composeMap(map, new Map([[small, solid(1, B)]]));
    expect(pixel(out, 2, 3)).toEqual(B);
    expect([pixel(out, 3, 3), pixel(out, 2, 2)]).toEqual([[0, 0, 0, 0], [0, 0, 0, 0]]);
    const shifted = { ...small, tileoffset: { x: 1, y: -1 } } as TiledEmbeddedTileset;
    map.tilesets = [shifted];
    expect(pixel(composeMap(map, new Map([[shifted, solid(1, B)]])), 3, 2)).toEqual(B);
  });

  test('a tile id past the real image draws nothing and keeps what is underneath', () => {
    // The tileset claims 4 columns, but its image holds one 2x2 tile.
    const ts = tileset({ columns: 4, tilecount: 8, imagewidth: 8 });
    const map = tinyMap(1, 1, [{ data: [1] }, { data: [3] }], [ts]);
    expect(pixel(composeMap(map, new Map([[ts, solid(2, A)]])), 0, 0)).toEqual(A);
  });

  test('two tilesets with the same name each draw their own image', () => {
    const first = tileset();
    const second = tileset({ firstgid: 2 });
    const map = tinyMap(2, 1, [{ data: [1, 2] }], [first, second]);
    const out = composeMap(map, new Map([[first, solid(2, A)], [second, solid(2, D)]]));
    expect([pixel(out, 0, 0), pixel(out, 2, 0)]).toEqual([A, D]);
  });

  test('a map with no whole-pixel preview is refused with a code', () => {
    const { sheets } = flipMap();
    const odd = createEmptyMap(2, 2);
    odd.tilewidth = 30;
    odd.tileheight = 30;
    expect(() => composeMap(odd, sheets, { scale: 0.25 })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => composeMap(createEmptyMap(0, 0), sheets)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});

describe('golden renders', () => {
  test('WA conference.tmj, rendered in full, is stable', async () => {
    const mapAbs = join(project.dir, 'conference.tmj');
    const { map } = await readMap(mapAbs);
    const sheets = await loadSheets(project.dir, mapAbs, map);
    const first = composeMap(map, sheets);
    expect(composeMap(map, sheets).data).toEqual(first.data);
    await expectGolden('conference', first);
  });

  test('a synthetic map with all flips and a zone overlay is stable', async () => {
    const office = (await readMap(join(project.dir, 'office.tmj'))).map;
    const map = createEmptyMap(8, 3);
    map.tilesets = office.tilesets;
    const rb = (office.tilesets.find((t) => t.name === 'WA_Room_Builder') as { firstgid: number }).firstgid;
    const row = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => encodeGid({ gid: rb + 63, h: (i & 1) === 1, v: (i & 2) === 2, d: (i & 4) === 4 }));
    map.layers = [
      { data: [...new Array(8).fill(rb + 350), ...row, ...new Array(8).fill(rb + 104)], height: 3, id: 1, name: 'floor', opacity: 1, type: 'tilelayer', visible: true, width: 8, x: 0, y: 0 },
      { draworder: 'topdown', id: 2, name: 'zones', objects: [{ height: 64, id: 1, name: 'talk', properties: [{ name: 'jitsiRoom', type: 'string', value: 'T' }], rotation: 0, type: 'area', visible: true, width: 96, x: 32, y: 0 }], opacity: 1, type: 'objectgroup', visible: true, x: 0, y: 0 },
    ];
    await writeFile(join(project.dir, 'synthetic.tmj'), serializeMap(map));
    const sheets = await loadSheets(project.dir, join(project.dir, 'synthetic.tmj'), map);
    const image = composeMap(map, sheets, { overlays: ['zones'] });
    // The zone outline is drawn on top: its corner pixel is the meeting colour.
    expect(pixel(image, 32, 0)).toEqual([40, 110, 255, 255]);
    await expectGolden('synthetic-flips-zones', image);
  });
});

describe('renderMap', () => {
  test('writes the preview atomically under .wa-preview/ at each scale and returns its bytes', async () => {
    for (const scale of [0.25, 0.5, 1, 2] as const) {
      const result = await renderMap({ projectDir: project.dir, mapPath: 'conference.tmj', scale });
      expect(result).toMatchObject({ width: 768 * scale, height: 448 * scale });
      expect(result.pngPath).toBe(join(project.dir, '.wa-preview', `conference@${scale}x.png`));
      const bytes = await readFile(result.pngPath);
      expect(sha256Hex(bytes)).toBe(result.sha256);
      expect(Buffer.from(result.png).equals(bytes)).toBe(true);
      expect(readPngHeader(bytes)).toEqual({ width: 768 * scale, height: 448 * scale });
    }
    expect((await readdir(join(project.dir, '.wa-preview'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  test('every pixel at scale 2 and 0.5 is the nearest 1x pixel', async () => {
    const at = async (scale: 0.5 | 1 | 2) => decodePng((await renderMap({ projectDir: project.dir, mapPath: 'conference.tmj', scale })).png);
    const [one, two, half] = [await at(1), await at(2), await at(0.5)];
    for (const [scaled, s] of [[two, 2], [half, 0.5]] as const) {
      for (let y = 0; y < scaled.height; y++) {
        for (let x = 0; x < scaled.width; x++) {
          const a = (Math.floor(y / s) * one.width + Math.floor(x / s)) * 4;
          const b = (y * scaled.width + x) * 4;
          if (scaled.data[b] !== one.data[a] || scaled.data[b + 3] !== one.data[a + 3]) expect.fail(`scale ${s}: pixel (${x},${y}) differs`);
        }
      }
    }
  });

  test('maps in different folders get different preview files', async () => {
    const map = (await readMap(join(project.dir, 'conference.tmj'))).map;
    // The tileset images are two folders up from the copies.
    for (const ts of map.tilesets) if ('image' in ts && ts.image !== undefined) ts.image = `../../${ts.image}`;
    for (const folder of ['a', 'b']) {
      await mkdir(join(project.dir, 'maps', folder), { recursive: true });
      await writeFile(join(project.dir, 'maps', folder, 'venue.tmj'), serializeMap(map));
    }
    const a = await renderMap({ projectDir: project.dir, mapPath: 'maps/a/venue.tmj', scale: 0.25 });
    const b = await renderMap({ projectDir: project.dir, mapPath: 'maps/b/venue.tmj', scale: 0.25 });
    expect([a.pngPath, b.pngPath]).toEqual([join(project.dir, '.wa-preview', 'maps__a__venue@0.25x.png'), join(project.dir, '.wa-preview', 'maps__b__venue@0.25x.png')]);
  });

  test('preview names keep letters of any script, and changed names get a path hash', () => {
    expect(previewName('/p', '/p/maps/café.tmj', 1)).toBe('maps__café@1x.png');
    const spaced = previewName('/p', '/p/my map.tmj', 1);
    expect(spaced).toMatch(/^my_map-[0-9a-f]{8}@1x\.png$/);
    expect(previewName('/p', '/p/my_map.tmj', 1)).toBe('my_map@1x.png');
    expect(previewName('/p', '/p/a__b/x.tmj', 1)).not.toBe(previewName('/p', '/p/a/b/x.tmj', 1));
  });

  test('a preview over 4096 px is refused before any image is read', async () => {
    const map = createEmptyMap(157, 157);
    map.tilesets = [{ columns: 1, firstgid: 1, image: 'tilesets/missing.png', imageheight: 32, imagewidth: 32, name: 'gone', tilecount: 1, tileheight: 32, tilewidth: 32 }];
    map.layers = [{ data: new Array<number>(157 * 157).fill(1), height: 157, id: 1, name: 'floor', opacity: 1, type: 'tilelayer', visible: true, width: 157, x: 0, y: 0 }];
    await writeFile(join(project.dir, 'huge.tmj'), serializeMap(map));
    await expect(renderMap({ projectDir: project.dir, mapPath: 'huge.tmj' })).rejects.toMatchObject({ code: 'PREVIEW_TOO_LARGE' });
    await expect(renderMap({ projectDir: project.dir, mapPath: 'huge.tmj', scale: 0.5 })).rejects.toMatchObject({ code: 'TILESET_IMAGE_MISSING' });
  });

  test('an oversized image header is refused without decoding', async () => {
    const header = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x23, 0x28, 0, 0, 0x23, 0x28, 8, 6, 0, 0, 0]);
    await writeFile(join(project.dir, 'tilesets', 'WA_Room_Builder.png'), header);
    await expect(renderMap({ projectDir: project.dir, mapPath: 'conference.tmj' })).rejects.toMatchObject({
      code: 'IMAGE_TOO_LARGE',
      details: { tileset: 'WA_Room_Builder' },
    });
  });

  test('the decode budget is summed from every header before anything is decoded', async () => {
    // Two header-only images of 8000x8000: each fits the budget alone, not both together.
    const header = rawPng({ width: 8000, height: 8000, colorType: 6 }, [], Buffer.alloc(0));
    const map = (await readMap(join(project.dir, 'conference.tmj'))).map;
    const [first, second] = map.tilesets.filter((t) => 'image' in t) as { image: string }[];
    await writeFile(join(project.dir, 'tilesets', 'big1.png'), header);
    await writeFile(join(project.dir, 'tilesets', 'big2.png'), header);
    first!.image = 'tilesets/big1.png';
    second!.image = 'tilesets/big2.png';
    await writeFile(join(project.dir, 'budget.tmj'), serializeMap(map));
    await expect(renderMap({ projectDir: project.dir, mapPath: 'budget.tmj', scale: 0.25 })).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' });
  });

  test('image files over 32 MB, FIFOs and paths out of the project are refused', async () => {
    const map = (await readMap(join(project.dir, 'conference.tmj'))).map;
    const seats = map.tilesets.find((t) => t.name === 'WA_Seats') as { image: string };
    const attempt = async (image: string) => {
      seats.image = image;
      await writeFile(join(project.dir, 'probe.tmj'), serializeMap(map));
      return renderMap({ projectDir: project.dir, mapPath: 'probe.tmj', scale: 0.25 });
    };
    await writeFile(join(project.dir, 'tilesets', 'huge.png'), encodePng(solid(1, A)));
    await truncate(join(project.dir, 'tilesets', 'huge.png'), 33 * 1024 * 1024);
    await expect(attempt('tilesets/huge.png')).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE', details: { tileset: 'WA_Seats' } });
    execFileSync('mkfifo', [join(project.dir, 'tilesets', 'pipe.png')]);
    await expect(attempt('tilesets/pipe.png')).rejects.toMatchObject({ code: 'TILESET_IMAGE_MISSING' });
    await expect(attempt('../outside.png')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' });
    await expect(attempt('/etc/hosts.png')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' });
    await expect(attempt('tilesets/WA_Seats.jpg')).rejects.toMatchObject({ code: 'PATH_BAD_EXTENSION' });
  });

  test('external and image-collection tilesets are refused with the tileset named', async () => {
    const map = (await readMap(join(project.dir, 'conference.tmj'))).map;
    const index = map.tilesets.findIndex((t) => t.name === 'WA_Seats');
    const seats = map.tilesets[index] as TiledEmbeddedTileset;
    map.tilesets[index] = { firstgid: seats.firstgid, source: 'tilesets/WA_Seats.tsj' };
    await writeFile(join(project.dir, 'external.tmj'), serializeMap(map));
    await expect(renderMap({ projectDir: project.dir, mapPath: 'external.tmj', scale: 0.25 })).rejects.toMatchObject({
      code: 'EXTERNAL_TILESET_UNRESOLVED',
      details: { tileset: 'tilesets/WA_Seats.tsj' },
    });
    const { image: _image, ...collection } = seats;
    map.tilesets[index] = collection as TiledEmbeddedTileset;
    await writeFile(join(project.dir, 'collection.tmj'), serializeMap(map));
    await expect(renderMap({ projectDir: project.dir, mapPath: 'collection.tmj', scale: 0.25 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      details: { tileset: 'WA_Seats' },
    });
  });

  test('a missing tileset image is reported by name', async () => {
    const map = (await readMap(join(project.dir, 'conference.tmj'))).map;
    (map.tilesets.find((t) => t.name === 'WA_Seats') as { image: string }).image = 'tilesets/gone.png';
    await writeFile(join(project.dir, 'broken.tmj'), serializeMap(map));
    await expect(renderMap({ projectDir: project.dir, mapPath: 'broken.tmj' })).rejects.toMatchObject({
      code: 'TILESET_IMAGE_MISSING',
      details: { tileset: 'WA_Seats' },
    });
  });

  test('scales outside 0.25, 0.5, 1, 2 are refused', async () => {
    await expect(renderMap({ projectDir: project.dir, mapPath: 'conference.tmj', scale: 3 as 1 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('hostile or unusual inputs', () => {
  async function conferenceWith(change: (map: TiledMap) => void, name = 'probe.tmj'): Promise<string> {
    const map = (await readMap(join(project.dir, 'conference.tmj'))).map;
    change(map);
    await writeFile(join(project.dir, name), serializeMap(map));
    return name;
  }
  const seatsOf = (map: TiledMap) => map.tilesets.find((t) => t.name === 'WA_Seats') as TiledEmbeddedTileset & Record<string, unknown>;

  test('negative margins, stretched tiles and tiles far larger than the grid are refused, naming the tileset', async () => {
    for (const change of [
      (ts: Record<string, unknown>) => { ts['margin'] = -4; },
      (ts: Record<string, unknown>) => { ts['spacing'] = -1; },
      (ts: Record<string, unknown>) => { ts['tilerendersize'] = 'grid'; },
      (ts: Record<string, unknown>) => { ts['tilewidth'] = 512; ts['tileheight'] = 512; },
    ]) {
      const mapPath = await conferenceWith((m) => change(seatsOf(m)));
      await expect(renderMap({ projectDir: project.dir, mapPath, scale: 0.25 })).rejects.toMatchObject({ code: 'INVALID_INPUT', details: { tileset: 'WA_Seats' } });
    }
  });

  test('a map whose tiles would take too long to draw is refused before any image is read', async () => {
    const map = createEmptyMap(60, 60);
    map.tilesets = [{ columns: 1, firstgid: 1, image: 'tilesets/missing.png', imageheight: 256, imagewidth: 256, name: 'huge', tilecount: 1, tileheight: 256, tilewidth: 256 }];
    map.layers = [{ data: new Array<number>(3600).fill(1), height: 60, id: 1, name: 'floor', opacity: 1, type: 'tilelayer', visible: true, width: 60, x: 0, y: 0 }];
    await writeFile(join(project.dir, 'heavy.tmj'), serializeMap(map));
    await expect(renderMap({ projectDir: project.dir, mapPath: 'heavy.tmj' })).rejects.toMatchObject({ code: 'PREVIEW_TOO_LARGE' });
  });

  test('an image path out of the project names its tileset', async () => {
    const mapPath = await conferenceWith((m) => { seatsOf(m)['image'] = '../outside.png'; });
    await expect(renderMap({ projectDir: project.dir, mapPath, scale: 0.25 })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT', details: { tileset: 'WA_Seats' } });
  });

  test('a preview that cannot be written is IO_ERROR, without absolute paths', async () => {
    await mkdir(join(project.dir, '.wa-preview'));
    await chmod(join(project.dir, '.wa-preview'), 0o555);
    try {
      const err = await renderMap({ projectDir: project.dir, mapPath: 'conference.tmj', scale: 0.25 }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'IO_ERROR', details: { errno: 'EACCES' } });
      expect(JSON.stringify(err)).not.toContain(project.dir);
    } finally {
      await chmod(join(project.dir, '.wa-preview'), 0o755);
    }
  });

  test('preview names never collide, keep combining marks, and stay short', () => {
    const name = (path: string) => previewName('/p', `/p/${path}`, 1);
    expect(name('a_/b.tmj')).not.toBe(name('a/_b.tmj'));
    expect(name('x.TMJ')).not.toBe(name('x.tmj'));
    expect(name('မြန်မာ.tmj')).toBe('မြန်မာ@1x.png');
    const long = name(`${'ဗ'.repeat(120)}/${'ဗ'.repeat(120)}.tmj`);
    expect(Buffer.byteLength(long)).toBeLessThan(200);
    expect(long).toMatch(/-[0-9a-f]{8}@1x\.png$/);
  });

  test('renders called together each finish with their own result', async () => {
    const [a, b] = await Promise.all([
      renderMap({ projectDir: project.dir, mapPath: 'conference.tmj', scale: 0.25 }),
      renderMap({ projectDir: project.dir, mapPath: 'office.tmj', scale: 0.25 }),
    ]);
    expect([a.pngPath, b.pngPath]).toEqual([join(project.dir, '.wa-preview', 'conference@0.25x.png'), join(project.dir, '.wa-preview', 'office@0.25x.png')]);
  });

  test('decodePng refuses a huge declared size and image data one byte short', async () => {
    const huge = rawPng({ width: 1 << 30, height: 4, colorType: 6 }, [], deflateSync(Buffer.alloc(10)));
    await expect(decodePng(huge)).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' });
    const short = rawPng({ width: 2, height: 2, colorType: 6 }, [], deflateSync(Buffer.alloc(2 * (1 + 8) - 1)));
    await expect(decodePng(short)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
