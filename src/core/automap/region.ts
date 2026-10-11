// A set of tile cells kept like Qt's QRegion: each row holds sorted, disjoint, non-touching
// runs, and rects() returns the y-x banded rectangles with vertically identical rows merged.
// Tiled scans rules rectangle by rectangle, and its ModX/ModY phase depends on each
// rectangle's corner, so the decomposition has to match Qt's.

export interface RegionRect {
  left: number;
  top: number;
  right: number; // inclusive
  bottom: number; // inclusive
}

type Run = [number, number]; // inclusive [start, end]

function mergeRuns(runs: Run[]): Run[] {
  runs.sort((a, b) => a[0] - b[0]);
  const out: Run[] = [];
  for (const [s, e] of runs) {
    const last = out[out.length - 1];
    if (last !== undefined && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export class Region {
  private readonly rows = new Map<number, Run[]>();

  static fromRect(left: number, top: number, width: number, height: number): Region {
    const region = new Region();
    if (width > 0 && height > 0) region.addRect({ left, top, right: left + width - 1, bottom: top + height - 1 });
    return region;
  }

  static fromCells(cells: Iterable<readonly [number, number]>): Region {
    const byRow = new Map<number, Run[]>();
    for (const [x, y] of cells) {
      const runs = byRow.get(y) ?? [];
      runs.push([x, x]);
      byRow.set(y, runs);
    }
    const region = new Region();
    for (const [y, runs] of byRow) region.rows.set(y, mergeRuns(runs));
    return region;
  }

  clone(): Region {
    const copy = new Region();
    for (const [y, runs] of this.rows) copy.rows.set(y, runs.map(([s, e]) => [s, e] as Run));
    return copy;
  }

  isEmpty(): boolean {
    return this.rows.size === 0;
  }

  addRect(r: RegionRect): void {
    if (r.right < r.left || r.bottom < r.top) return;
    for (let y = r.top; y <= r.bottom; y++) {
      this.rows.set(y, mergeRuns([...(this.rows.get(y) ?? []).map(([s, e]) => [s, e] as Run), [r.left, r.right]]));
    }
  }

  unite(other: Region): void {
    for (const [y, runs] of other.rows) {
      this.rows.set(y, mergeRuns([...(this.rows.get(y) ?? []), ...runs.map(([s, e]) => [s, e] as Run)]));
    }
  }

  // Keeps only the cells inside the rectangle.
  intersectRect(r: RegionRect): void {
    for (const [y, runs] of [...this.rows]) {
      if (y < r.top || y > r.bottom) {
        this.rows.delete(y);
        continue;
      }
      const clipped = runs
        .map(([s, e]) => [Math.max(s, r.left), Math.min(e, r.right)] as Run)
        .filter(([s, e]) => s <= e);
      if (clipped.length === 0) this.rows.delete(y);
      else this.rows.set(y, clipped);
    }
  }

  intersect(other: Region): void {
    for (const [y, runs] of [...this.rows]) {
      const theirs = other.rows.get(y);
      const kept: Run[] = [];
      if (theirs !== undefined) {
        for (const [s, e] of runs) {
          for (const [ts, te] of theirs) {
            const a = Math.max(s, ts);
            const b = Math.min(e, te);
            if (a <= b) kept.push([a, b]);
          }
        }
      }
      if (kept.length === 0) this.rows.delete(y);
      else this.rows.set(y, mergeRuns(kept));
    }
  }

  intersects(other: Region): boolean {
    for (const [y, runs] of this.rows) {
      const theirs = other.rows.get(y);
      if (theirs === undefined) continue;
      for (const [s, e] of runs) for (const [ts, te] of theirs) if (Math.max(s, ts) <= Math.min(e, te)) return true;
    }
    return false;
  }

  contains(x: number, y: number): boolean {
    return (this.rows.get(y) ?? []).some(([s, e]) => x >= s && x <= e);
  }

  // Whether every cell of the rectangle is in the region.
  coversRect(r: RegionRect): boolean {
    for (let y = r.top; y <= r.bottom; y++) {
      if (!(this.rows.get(y) ?? []).some(([s, e]) => s <= r.left && e >= r.right)) return false;
    }
    return true;
  }

  // Qt's banded rectangles: top to bottom, left to right, identical adjacent rows merged.
  rects(): RegionRect[] {
    const ys = [...this.rows.keys()].sort((a, b) => a - b);
    const out: RegionRect[] = [];
    let band: { top: number; bottom: number; runs: Run[] } | undefined;
    const flush = (): void => {
      if (band === undefined) return;
      for (const [s, e] of band.runs) out.push({ left: s, top: band.top, right: e, bottom: band.bottom });
    };
    for (const y of ys) {
      const runs = this.rows.get(y)!;
      if (
        band !== undefined &&
        band.bottom === y - 1 &&
        band.runs.length === runs.length &&
        band.runs.every(([s, e], i) => s === runs[i]![0] && e === runs[i]![1])
      ) {
        band.bottom = y;
        continue;
      }
      flush();
      band = { top: y, bottom: y, runs };
    }
    flush();
    return out;
  }

  boundingRect(): RegionRect | undefined {
    let box: RegionRect | undefined;
    for (const [y, runs] of this.rows) {
      for (const [s, e] of runs) {
        if (box === undefined) box = { left: s, top: y, right: e, bottom: y };
        else {
          box.left = Math.min(box.left, s);
          box.right = Math.max(box.right, e);
          box.top = Math.min(box.top, y);
          box.bottom = Math.max(box.bottom, y);
        }
      }
    }
    return box;
  }

  *cells(): Generator<[number, number]> {
    for (const r of this.rects()) {
      for (let y = r.top; y <= r.bottom; y++) for (let x = r.left; x <= r.right; x++) yield [x, y];
    }
  }

  // Every rectangle grown by the given amounts, united (QRect::adjusted on each rect).
  adjusted(dl: number, dt: number, dr: number, db: number): Region {
    const out = new Region();
    for (const r of this.rects()) out.addRect({ left: r.left + dl, top: r.top + dt, right: r.right + dr, bottom: r.bottom + db });
    return out;
  }
}

// Tiled's coherentRegions followed by its rule sort: regions are grown from the region's last
// rectangle, adding any rectangle within one cell (8 directions) until none is left, then
// sorted by their bounding boxes' top-left corners (y, then x). The sort is stable, which is
// what Tiled's std::sort does in practice for the few rules a rule map holds.
export function coherentRegions(region: Region): Region[] {
  const rects = region.rects();
  const groups: { region: Region; box: RegionRect }[] = [];
  const near = (r: RegionRect, box: RegionRect): boolean =>
    r.left - 1 <= box.right && r.right + 1 >= box.left && r.top - 1 <= box.bottom && r.bottom + 1 >= box.top;
  while (rects.length > 0) {
    const first = rects.pop()!;
    const group = new Region();
    group.addRect(first);
    const box = { ...first };
    let found = true;
    while (found) {
      found = false;
      for (let i = rects.length - 1; i >= 0; i--) {
        const r = rects[i]!;
        if (!near(r, box)) continue;
        const grown = { left: r.left - 1, top: r.top - 1, right: r.right + 1, bottom: r.bottom + 1 };
        const probe = new Region();
        probe.addRect(grown);
        if (!group.intersects(probe)) continue;
        group.addRect(r);
        box.left = Math.min(box.left, r.left);
        box.top = Math.min(box.top, r.top);
        box.right = Math.max(box.right, r.right);
        box.bottom = Math.max(box.bottom, r.bottom);
        rects.splice(i, 1);
        found = true;
      }
    }
    groups.push({ region: group, box });
  }
  groups.sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left);
  return groups.map((g) => g.region);
}
