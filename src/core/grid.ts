import type { Rect } from '../schemas/dsl.schema.js';

export interface Cell {
  x: number;
  y: number;
}

// Map cells are at most 1000 tiles per side, so x and y pack into one number.
const STRIDE = 65536;

function checkCell(x: number, y: number): void {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= STRIDE || y >= STRIDE) {
    throw new RangeError(`cell (${x},${y}) is outside 0..${STRIDE - 1}`);
  }
}

export class CellSet implements Iterable<Cell> {
  readonly #keys = new Set<number>();

  constructor(cells: Iterable<Cell> = []) {
    for (const c of cells) this.add(c.x, c.y);
  }

  add(x: number, y: number): this {
    checkCell(x, y);
    this.#keys.add(y * STRIDE + x);
    return this;
  }

  has(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < STRIDE && this.#keys.has(y * STRIDE + x);
  }

  delete(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < STRIDE && this.#keys.delete(y * STRIDE + x);
  }

  get size(): number {
    return this.#keys.size;
  }

  *[Symbol.iterator](): Iterator<Cell> {
    for (const key of this.#keys) yield { x: key % STRIDE, y: Math.floor(key / STRIDE) };
  }

  // Cells in row-major order, for deterministic output.
  sorted(): Cell[] {
    return [...this.#keys].sort((a, b) => a - b).map((key) => ({ x: key % STRIDE, y: Math.floor(key / STRIDE) }));
  }
}

// N, E, S, W.
export const DIRECTIONS4 = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
] as const;

export function inBounds(x: number, y: number, width: number, height: number): boolean {
  return x >= 0 && y >= 0 && x < width && y < height;
}

export function rectCells(r: Rect): Cell[] {
  const cells: Cell[] = [];
  for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) cells.push({ x, y });
  return cells;
}

export function perimeterCells(r: Rect): Cell[] {
  return rectCells(r).filter((c) => c.x === r.x || c.y === r.y || c.x === r.x + r.width - 1 || c.y === r.y + r.height - 1);
}

export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
}
