import { createInflate } from 'node:zlib';
import { convertIndexedToRgb, decode, encode, type DecodedPng } from 'fast-png';
import { WaEngineError } from './errors.js';

// PNG in and out, always as 8-bit RGBA. fast-png is pure JS with fixed deflate settings and
// no timestamps, so encoding the same pixels always gives the same bytes.

export interface Rgba8 {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface PngInfo {
  width: number;
  height: number;
  // Bytes the image data inflates to, which the header fixes exactly.
  inflatedBytes: number;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// Samples per pixel for each PNG colour type.
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
// Adam7 passes: x start, y start, x step, y step.
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const;

const notPng = (): WaEngineError => new WaEngineError('INVALID_INPUT', 'not a PNG image');
// The most pixels decodePng accepts; fast-png allocates the declared size before it decodes.
export const MAX_DECODE_PIXELS = 8192 * 8192;

// Size and data size from the IHDR chunk, read before any decoding.
export function readPngInfo(bytes: Uint8Array): PngInfo {
  const valid = bytes.length >= 29 && SIGNATURE.every((b, i) => bytes[i] === b) && String.fromCharCode(...bytes.subarray(12, 16)) === 'IHDR';
  if (!valid) throw notPng();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const depth = bytes[24]!;
  const channels = CHANNELS[bytes[25]!];
  if (channels === undefined || ![1, 2, 4, 8, 16].includes(depth)) throw new WaEngineError('INVALID_INPUT', 'PNG has an unknown colour type or bit depth');
  // Every row starts with a filter byte; an interlaced image stores its 7 passes in turn.
  const rowBytes = (w: number): number => 1 + Math.ceil((w * channels * depth) / 8);
  const passes = bytes[28] === 1 ? ADAM7 : [[0, 0, 1, 1] as const];
  let inflatedBytes = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const w = Math.ceil((width - x0) / dx);
    const h = Math.ceil((height - y0) / dy);
    if (w > 0 && h > 0) inflatedBytes += h * rowBytes(w);
  }
  return { width, height, inflatedBytes };
}

export function readPngHeader(bytes: Uint8Array): { width: number; height: number } {
  const { width, height } = readPngInfo(bytes);
  return { width, height };
}

// fast-png inflates the image data with no limit, so a small file could expand to gigabytes.
// The data is inflated here first, as a stream that is dropped as it goes, and refused as
// soon as it holds more than its header says.
async function checkInflatedSize(bytes: Uint8Array, info: PngInfo): Promise<void> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idat: Uint8Array[] = [];
  for (let at = 8; at + 12 <= bytes.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (at + 12 + length > bytes.length || type === 'IEND') break;
    if (type === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  await new Promise<void>((resolve, reject) => {
    const inflate = createInflate();
    let total = 0;
    inflate.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > info.inflatedBytes) inflate.destroy(new Error('too much image data'));
    });
    const mismatch = (): WaEngineError => new WaEngineError('INVALID_INPUT', 'the PNG image data does not match its header');
    inflate.on('error', () => reject(mismatch()));
    inflate.on('end', () => (total === info.inflatedBytes ? resolve() : reject(mismatch())));
    inflate.end(Buffer.concat(idat));
  });
}

function sample(data: DecodedPng['data'], index: number, depth: number): number {
  const v = data[index] ?? 0;
  // 16-bit samples keep their high byte.
  return depth === 16 ? v >> 8 : v;
}

// Normalises any decoded PNG (grey, grey+alpha, RGB, RGBA, 16-bit, palette) to RGBA8. A tRNS
// colour key on a grey or RGB image makes the pixels of exactly that colour transparent.
export function toRgba8(png: DecodedPng): Rgba8 {
  const { width, height } = png;
  if (png.palette !== undefined) {
    const out = new Uint8ClampedArray(width * height * 4);
    const rgb = convertIndexedToRgb(png);
    const channels = rgb.length / (width * height);
    for (let i = 0; i < width * height; i++) {
      out[i * 4] = rgb[i * channels]!;
      out[i * 4 + 1] = rgb[i * channels + 1]!;
      out[i * 4 + 2] = rgb[i * channels + 2]!;
      out[i * 4 + 3] = channels === 4 ? rgb[i * channels + 3]! : 255;
    }
    return { width, height, data: out };
  }
  if (png.depth !== 8 && png.depth !== 16) {
    throw new WaEngineError('INVALID_INPUT', `PNG bit depth ${png.depth} is not supported for tileset images`);
  }
  const { channels, depth, data } = png;
  // 8-bit RGBA is already the target layout: use fast-png's buffer as it is.
  if (channels === 4 && depth === 8) return { width, height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
  const out = new Uint8ClampedArray(width * height * 4);
  const key = channels === 1 || channels === 3 ? png.transparency : undefined;
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const grey = channels <= 2;
    const keyed = key !== undefined && (grey ? data[s] === key[0] : data[s] === key[0] && data[s + 1] === key[1] && data[s + 2] === key[2]);
    const r = sample(data, s, depth);
    out[i * 4] = r;
    out[i * 4 + 1] = grey ? r : sample(data, s + 1, depth);
    out[i * 4 + 2] = grey ? r : sample(data, s + 2, depth);
    out[i * 4 + 3] = keyed ? 0 : channels === 2 ? sample(data, s + 1, depth) : channels === 4 ? sample(data, s + 3, depth) : 255;
  }
  return { width, height, data: out };
}

export async function decodePng(bytes: Uint8Array): Promise<Rgba8> {
  const info = readPngInfo(bytes);
  if (info.width < 1 || info.height < 1) throw new WaEngineError('INVALID_INPUT', 'the PNG image has no pixels');
  if (info.width * info.height > MAX_DECODE_PIXELS) {
    throw new WaEngineError('IMAGE_TOO_LARGE', `a ${info.width}x${info.height} PNG is more than ${MAX_DECODE_PIXELS} pixels`);
  }
  await checkInflatedSize(bytes, info);
  try {
    return toRgba8(decode(bytes));
  } catch (err) {
    if (err instanceof WaEngineError) throw err;
    throw new WaEngineError('INVALID_INPUT', 'the PNG image could not be decoded');
  }
}

export function encodePng(image: Rgba8): Uint8Array {
  return encode({
    width: image.width,
    height: image.height,
    data: new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength),
    channels: 4,
    depth: 8,
  });
}
