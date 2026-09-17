import { describe, expect, it } from 'vitest';
import { planePlacement } from '../../src/render/imagePlanes';
import { IDENTITY_FRAME, sectionGeoms, toDisplay } from '../../src/render/sections';
import type { SectionInfo } from '../../src/h5ad/types';

const section: SectionInfo = {
  id: 'A',
  name: 'A',
  ordinal: 0,
  code: 0,
  nCells: 8,
  z: 0,
  bbox: { min: [32, 32, 0], max: [224, 224, 0] },
  hasImage: true,
  imageKeys: ['hires'],
  imageShapes: { hires: [64, 64, 3] },
  spotDiameter: 40,
  hiresScalef: 0.25,
  lowresScalef: null,
  placementKnown: true,
};

describe('image plane placement', () => {
  it('spans W/scalef × H/scalef raw units with its top-left at raw (0,0)', () => {
    const center: [number, number, number] = [128, 128, 0];
    const scale = 1 / 256;
    const p = planePlacement(section, 64, 64, 0.25, center, scale, IDENTITY_FRAME);
    // image covers raw [0, 256] in x and y → centred on the data centre → unit-cube (0, 0)
    expect(p.center[0]).toBeCloseTo(0, 9);
    expect(p.center[1]).toBeCloseTo(0, 9);
    expect(p.size).toEqual([1, 1]);
    // a spot at the centre of the top-left bright square (image px 8,8 → raw 32,32) lands at −0.375
    expect(toDisplay([32, 32, 0], center, scale, IDENTITY_FRAME)).toEqual([-0.375, -0.375, 0]);
    // the plane's −y edge is raw y = 0 = image row 0, i.e. the same side as that spot
    expect(p.center[1] - p.size[1] / 2).toBeCloseTo(-0.5, 9);
  });
  it('non-square images and flipped frames keep spots on their squares', () => {
    const center: [number, number, number] = [40, 50, 0];
    const scale = 1 / 100;
    const frame = { ...IDENTITY_FRAME, flipY: true };
    const p = planePlacement(section, 8, 10, 0.1, center, scale, frame); // 80 × 100 raw
    expect(p.size).toEqual([0.8, 1]);
    expect(p.sign).toEqual([1, -1]);
    // raw centre (40, 50) → (0, 0); flipped y keeps it centred
    expect(p.center[0]).toBeCloseTo(0, 9);
    expect(p.center[1]).toBeCloseTo(0, 9);
    // a spot at raw y = 10 (near the image top) is above centre after the flip, like the plane's row 0
    const spot = toDisplay([40, 10, 0], center, scale, frame);
    expect(spot[1]).toBeCloseTo(0.4, 9);
  });
  it('sectionGeoms follows the display frame (flip + swap)', () => {
    const g = sectionGeoms([section], [128, 128, 0], 1 / 256, {
      flipX: true,
      flipY: false,
      flipZ: false,
      swapYZ: true,
    })[0];
    expect(g.min[0]).toBeCloseTo(-0.375, 9);
    expect(g.max[0]).toBeCloseTo(0.375, 9);
    // after the swap the section is planar in y (z takes the old y range)
    expect(g.z).toBeNull();
    expect(g.min[2]).toBeCloseTo(-0.375, 9);
    const flat = sectionGeoms([section], [128, 128, 0], 1 / 256)[0];
    expect(flat.z).toBe(0);
  });
});
