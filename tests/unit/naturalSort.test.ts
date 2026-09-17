import { describe, expect, it } from 'vitest';
import { compareNatural, naturalSort } from '../../src/util/naturalSort';

describe('naturalSort', () => {
  it('orders embedded integers numerically', () => {
    expect(naturalSort(['slice10', 'slice2', 'slice1'])).toEqual(['slice1', 'slice2', 'slice10']);
    expect(naturalSort(['S12', 'S1', 'S3'])).toEqual(['S1', 'S3', 'S12']);
  });
  it('orders negative decimals (Bregma) numerically', () => {
    expect(naturalSort(['Bregma_-0.04', 'Bregma_-0.29', 'Bregma_0.26', 'Bregma_-0.19'])).toEqual([
      'Bregma_-0.29',
      'Bregma_-0.19',
      'Bregma_-0.04',
      'Bregma_0.26',
    ]);
  });
  it('is case-insensitive and stable for equal keys', () => {
    expect(compareNatural('abc', 'ABC')).toBe(0);
    expect(naturalSort(['b', 'A', 'c'])).toEqual(['A', 'b', 'c']);
  });
  it('keeps the demo slice order', () => {
    const stored = Array.from({ length: 16 }, (_, i) => `slice${i + 1}`);
    expect(naturalSort([...stored].reverse())).toEqual(stored);
  });
});
