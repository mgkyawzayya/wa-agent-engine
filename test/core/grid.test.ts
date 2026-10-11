import { expect, test } from 'vitest';
import { CellSet } from '../../src/core/grid.js';

test('cells outside 0..65535 are refused on add and simply absent on lookup', () => {
  const cells = new CellSet([{ x: 0, y: 0 }, { x: 65535, y: 2 }]);
  expect(cells.has(65535, 2)).toBe(true);
  expect(() => cells.add(-1, 0)).toThrow(RangeError);
  expect(() => cells.add(65536, 0)).toThrow(RangeError);
  expect(() => cells.add(1.5, 0)).toThrow(RangeError);
  expect([cells.has(-1, 0), cells.has(65536, 0), cells.delete(-1, 0)]).toEqual([false, false, false]);
  expect(cells.sorted()).toEqual([{ x: 0, y: 0 }, { x: 65535, y: 2 }]);
});
