import { describe, expect, it } from 'vitest';
import {
  COLORMAP_NAMES,
  colormapColor,
  colormapLUT,
  hexToRgb,
  rgbToHex,
} from '../../src/color/colormaps';
import { generatedPalette, minPairwiseDistance, paletteFor } from '../../src/color/palettes';

describe('colormaps', () => {
  it('builds 256-entry opaque LUTs for every colormap', () => {
    for (const name of COLORMAP_NAMES) {
      const lut = colormapLUT(name);
      expect(lut.length).toBe(1024);
      for (let i = 0; i < 256; i++) expect(lut[i * 4 + 3]).toBe(255);
    }
  });
  it('has the expected endpoints', () => {
    // polynomial fits are accurate to a few 8-bit steps
    const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 5);
    expect(near(colormapColor('viridis', 0), [68, 1, 84])).toBe(true);
    expect(near(colormapColor('viridis', 1), [253, 231, 37])).toBe(true);
    expect(near(colormapColor('magma', 1), [252, 253, 191])).toBe(true);
    expect(near(colormapColor('inferno', 0), [0, 0, 4])).toBe(true);
    expect(colormapColor('greys', 0)).toEqual([0, 0, 0]);
    expect(colormapColor('greys', 1)).toEqual([255, 255, 255]);
    expect(colormapColor('coolwarm', 0.5)).toEqual([221, 221, 221]);
    const [r, , b] = colormapColor('turbo', 0.5);
    expect(r).toBeGreaterThan(100);
    expect(b).toBeLessThan(110);
  });
  it('reversed flips the endpoints', () => {
    expect(colormapColor('plasma', 0, true)).toEqual(colormapColor('plasma', 1));
    expect(colormapLUT('magma', true).slice(0, 3)).toEqual(
      colormapLUT('magma').slice(255 * 4, 255 * 4 + 3),
    );
  });
  it('hex round-trips', () => {
    expect(rgbToHex(hexToRgb('#1f77b4'))).toBe('#1f77b4');
    expect(hexToRgb('#fff')).toEqual([255, 255, 255]);
  });
});

describe('palettes', () => {
  it('uses file colors only when the count matches', () => {
    expect(paletteFor(3, ['#ff0000', '#00ff00', '#0000ff'])).toEqual([
      '#ff0000',
      '#00ff00',
      '#0000ff',
    ]);
    expect(paletteFor(3, ['#ff0000'])).toHaveLength(3);
  });
  it('tiers: ≤10 muted, ≤20 muted+light, generated beyond', () => {
    expect(paletteFor(10)[0]).toBe('#cc6677');
    expect(paletteFor(20)).toHaveLength(20);
    expect(new Set(paletteFor(20)).size).toBe(20);
    const big = paletteFor(74);
    expect(big).toHaveLength(74);
    expect(new Set(big).size).toBe(74);
  });
  it('generated palettes stay distinct and deterministic', () => {
    expect(generatedPalette(50)).toEqual(generatedPalette(50));
    expect(minPairwiseDistance(generatedPalette(25))).toBeGreaterThan(25);
    expect(minPairwiseDistance(generatedPalette(74))).toBeGreaterThan(8);
    expect(minPairwiseDistance(paletteFor(10))).toBeGreaterThan(50);
    expect(minPairwiseDistance(paletteFor(20))).toBeGreaterThan(25);
  });
});
