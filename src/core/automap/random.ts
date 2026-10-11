import { WaEngineError } from '../errors.js';

// Seeded randomness for automapping. Tiled draws from unseeded generators; the engine uses
// mulberry32 so the same map, rules and seed always give the same output on every platform.

export type Random = () => number;

// Uniform numbers in [0, 1) from a 32-bit seed.
export function createRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Tiled keeps two generators: one for rule `Probability` checks and one for picking an output
// index. Two streams keep the same independence.
export interface AutomapRandom {
  skip: Random;
  pick: Random;
}

export function createAutomapRandom(seed: number): AutomapRandom {
  return { skip: createRandom(seed), pick: createRandom((seed ^ 0x9e3779b9) >>> 0) };
}

// Tiled's RandomPicker: entries with a weight of 0 or less are never chosen; a single entry is
// returned without drawing; otherwise the first cumulative threshold not below the draw wins.
export class RandomPicker<T> {
  private readonly thresholds: { at: number; value: T }[] = [];
  private sum = 0;

  add(value: T, weight: number): void {
    if (weight > 0) {
      this.sum += weight;
      this.thresholds.push({ at: this.sum, value });
    }
  }

  get size(): number {
    return this.thresholds.length;
  }

  pick(random: Random): T {
    const only = this.thresholds[0];
    if (only === undefined) throw new WaEngineError('INTERNAL', 'RandomPicker is empty');
    if (this.thresholds.length === 1) return only.value;
    const draw = random() * this.sum;
    const found = this.thresholds.find((t) => t.at >= draw) ?? this.thresholds[this.thresholds.length - 1]!;
    return found.value;
  }
}
