import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYOUT,
  defaultSpacing,
  hasNativeZ,
  layoutOffsets,
  sectionGeoms,
} from '../../src/render/sections';
import type { SectionInfo } from '../../src/h5ad/types';

function section(ordinal: number, z: number | null, bbox: [number, number]): SectionInfo {
  return {
    id: `s${ordinal}`,
    name: `s${ordinal}`,
    ordinal,
    code: ordinal,
    nCells: 10,
    z,
    bbox: { min: [bbox[0], bbox[0], z ?? 0], max: [bbox[1], bbox[1], z ?? 0] },
    hasImage: false,
    imageKeys: [],
    imageShapes: {},
    spotDiameter: null,
    hiresScalef: null,
    lowresScalef: null,
    placementKnown: false,
  };
}

const center: [number, number, number] = [50, 50, 20];
const scale = 1 / 100;
// four planar sections at z = 0, 10, 30, 40 with drifting XY frames
const sections = [
  section(0, 0, [0, 40]),
  section(1, 10, [20, 60]),
  section(2, 30, [40, 80]),
  section(3, 40, [60, 100]),
];
const geoms = sectionGeoms(sections, center, scale);

describe('section layouts', () => {
  it('converts to unit-cube space and detects native z', () => {
    expect(geoms[0].min).toEqual([-0.5, -0.5, -0.2]);
    expect(geoms[3].z).toBeCloseTo(0.2, 9);
    expect(hasNativeZ(geoms)).toBe(true);
    expect(defaultSpacing(geoms)).toBeCloseTo(0.15, 9);
  });
  it('stack keeps native z (no offsets) unless uniform spacing is requested', () => {
    const r = layoutOffsets(geoms, DEFAULT_LAYOUT);
    expect(r.nativeZ).toBe(1);
    expect(r.offsets.every((o) => o.dx === 0 && o.dy === 0 && o.dz === 0 && o.alpha === 1)).toBe(
      true,
    );
    expect(r.bounds.min[2]).toBeCloseTo(-0.2, 9);
    expect(r.bounds.max[2]).toBeCloseTo(0.2, 9);
    const u = layoutOffsets(geoms, { ...DEFAULT_LAYOUT, uniformSpacing: true, spacing: 0.1 });
    expect(u.nativeZ).toBe(0);
    [-0.15, -0.05, 0.05, 0.15].forEach((z, i) => expect(u.offsets[i].dz).toBeCloseTo(z, 9));
  });
  it('2-D sections (no z) always stack uniformly', () => {
    const flat = sectionGeoms(
      sections.map((s) => ({ ...s, z: null })),
      center,
      scale,
    );
    const r = layoutOffsets(flat, DEFAULT_LAYOUT);
    expect(r.nativeZ).toBe(0);
    expect(r.offsets[3].dz - r.offsets[2].dz).toBeCloseTo(0.15, 9);
  });
  it('stack-normalized recentres every section on its own XY centre', () => {
    const r = layoutOffsets(geoms, { ...DEFAULT_LAYOUT, mode: 'stack-normalized' });
    for (let i = 0; i < 4; i++) {
      expect(geoms[i].center[0] + r.offsets[i].dx).toBeCloseTo(0, 9);
      expect(geoms[i].center[1] + r.offsets[i].dy).toBeCloseTo(0, 9);
    }
    expect(r.bounds.max[0]).toBeCloseTo(0.2, 9);
  });
  it('tile lays sections out on a centred grid at z = 0 with the gap', () => {
    const r = layoutOffsets(geoms, { ...DEFAULT_LAYOUT, mode: 'tile', gap: 0.1 });
    expect(r.nativeZ).toBe(0);
    expect(r.planar).toBe(true);
    const cell = 0.4 + 0.1;
    const centers = r.offsets.map((o, i) => [geoms[i].center[0] + o.dx, geoms[i].center[1] + o.dy]);
    expect(centers[0][0]).toBeCloseTo(-cell / 2, 9);
    expect(centers[1][0]).toBeCloseTo(cell / 2, 9);
    expect(centers[0][1]).toBeCloseTo(cell / 2, 9);
    expect(centers[2][1]).toBeCloseTo(-cell / 2, 9);
    expect(r.offsets.every((o) => o.dz === 0)).toBe(true);
    expect(r.bounds.min[2]).toBe(0);
  });
  it('single shows only the current section, centred', () => {
    const r = layoutOffsets(geoms, { ...DEFAULT_LAYOUT, mode: 'single', current: 2 });
    expect(r.offsets.map((o) => o.alpha)).toEqual([0, 0, 1, 0]);
    expect(geoms[2].center[0] + r.offsets[2].dx).toBeCloseTo(0, 9);
    expect(r.bounds.min[0]).toBeCloseTo(-0.2, 9);
  });
  it('hidden sections and dimming feed the alpha column; explode stretches z bounds', () => {
    const r = layoutOffsets(geoms, {
      ...DEFAULT_LAYOUT,
      hidden: new Set([1]),
      dimOthers: true,
      current: 0,
      dimAlpha: 0.2,
    });
    expect(r.offsets.map((o) => o.alpha)).toEqual([1, 0, 0.2, 0.2]);
    const e = layoutOffsets(geoms, { ...DEFAULT_LAYOUT, explode: 2 });
    expect(e.bounds.max[2]).toBeCloseTo(0.4, 9);
    expect(e.bounds.min[2]).toBeCloseTo(-0.4, 9);
  });
  it('alignment offsets shift sections and rotation widens the bounds', () => {
    const r = layoutOffsets(geoms, {
      ...DEFAULT_LAYOUT,
      alignment: new Map([[0, { dx: 0.3, dy: 0, rotation: 0, flipX: false, flipY: false }]]),
    });
    expect(r.offsets[0].dx).toBe(0.3);
    const rot = layoutOffsets(geoms, {
      ...DEFAULT_LAYOUT,
      alignment: new Map([
        [3, { dx: 0, dy: 0, rotation: Math.PI / 4, flipX: false, flipY: false }],
      ]),
    });
    expect(rot.bounds.max[0]).toBeGreaterThan(r.bounds.max[0]);
  });
});
