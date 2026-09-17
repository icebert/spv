/**
 * Section model on the render side: per-section geometry in unit-cube space, the four layout
 * modes, and the per-section transform table texture read by the vertex shader. `layoutOffsets`
 * is pure and unit-tested; `SectionTable` owns the `DataTexture`.
 */
import { DataTexture, FloatType, NearestFilter, RGBAFormat } from 'three';
import type { SectionInfo } from '../h5ad/types';

export type LayoutMode = 'stack' | 'stack-normalized' | 'tile' | 'single';
export const LAYOUT_MODES: LayoutMode[] = ['stack', 'stack-normalized', 'tile', 'single'];

export interface SectionAlignment {
  dx: number;
  dy: number;
  /** radians */
  rotation: number;
  flipX: boolean;
  flipY: boolean;
}

export interface SectionGeom {
  ordinal: number;
  name: string;
  min: [number, number, number];
  max: [number, number, number];
  center: [number, number, number];
  /** unit-cube z when the section is planar, else null */
  z: number | null;
  nCells: number;
}

export interface LayoutParams {
  mode: LayoutMode;
  /** z step between sections in unit-cube units (uniform spacing) */
  spacing: number;
  /** ignore native z and use `spacing` even when the data has a z */
  uniformSpacing: boolean;
  /** gap between tiles, unit-cube units */
  gap: number;
  /** z explode factor about the stack centre (1 = none) */
  explode: number;
  zScale: number;
  current: number;
  dimOthers: boolean;
  dimAlpha: number;
  hidden: ReadonlySet<number>;
  alignment: ReadonlyMap<number, SectionAlignment>;
}

export interface SectionOffset {
  dx: number;
  dy: number;
  dz: number;
  alpha: number;
}

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface LayoutResult {
  offsets: SectionOffset[];
  /** 1 → keep the data z in the shader, 0 → z comes from the table */
  nativeZ: 0 | 1;
  bounds: Bounds;
  /** true when the layout is a flat top-down arrangement (tile / single) */
  planar: boolean;
}

export const DEFAULT_LAYOUT: LayoutParams = {
  mode: 'stack',
  spacing: 0.15,
  uniformSpacing: false,
  gap: 0.05,
  explode: 1,
  zScale: 1,
  current: 0,
  dimOthers: false,
  dimAlpha: 0.12,
  hidden: new Set(),
  alignment: new Map(),
};

/** Convert raw-unit section bboxes to unit-cube space using the worker's centre/scale. */
export function sectionGeoms(
  sections: SectionInfo[],
  center: [number, number, number],
  scale: number,
): SectionGeom[] {
  return sections.map((s) => {
    const bb = s.bbox ?? { min: center, max: center };
    const min = bb.min.map((v, i) => (v - center[i]) * scale) as [number, number, number];
    const max = bb.max.map((v, i) => (v - center[i]) * scale) as [number, number, number];
    return {
      ordinal: s.ordinal,
      name: s.name,
      min,
      max,
      center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
      z: s.z === null ? null : (s.z - center[2]) * scale,
      nCells: s.nCells,
    };
  });
}

/** Spec default: 15 % of the larger XY extent of the whole dataset. */
export function defaultSpacing(geoms: SectionGeom[]): number {
  if (geoms.length === 0) return 0.15;
  const minX = Math.min(...geoms.map((g) => g.min[0]));
  const maxX = Math.max(...geoms.map((g) => g.max[0]));
  const minY = Math.min(...geoms.map((g) => g.min[1]));
  const maxY = Math.max(...geoms.map((g) => g.max[1]));
  return 0.15 * Math.max(maxX - minX, maxY - minY, 1e-6);
}

export function hasNativeZ(geoms: SectionGeom[]): boolean {
  const zs = geoms.map((g) => g.z).filter((z): z is number => z !== null);
  return zs.length === geoms.length && new Set(zs).size > 1;
}

function emptyBounds(): Bounds {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

function extend(b: Bounds, p: [number, number, number]): void {
  for (let i = 0; i < 3; i++) {
    if (p[i] < b.min[i]) b.min[i] = p[i];
    if (p[i] > b.max[i]) b.max[i] = p[i];
  }
}

/** Pure layout math: where each section goes and how visible it is. */
export function layoutOffsets(geoms: SectionGeom[], p: LayoutParams): LayoutResult {
  const n = geoms.length;
  const offsets: SectionOffset[] = [];
  const bounds = emptyBounds();
  const nativeZ: 0 | 1 =
    p.mode.startsWith('stack') && !p.uniformSpacing && hasNativeZ(geoms) ? 1 : 0;
  const planar = p.mode === 'tile' || p.mode === 'single';
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.max(1, Math.ceil(n / cols));
  const cellW = Math.max(...geoms.map((g) => g.max[0] - g.min[0]), 1e-6) + p.gap;
  const cellH = Math.max(...geoms.map((g) => g.max[1] - g.min[1]), 1e-6) + p.gap;
  for (let i = 0; i < n; i++) {
    const g = geoms[i];
    let dx = 0;
    let dy = 0;
    let dz = 0;
    let alpha = 1;
    switch (p.mode) {
      case 'stack':
        dz = nativeZ ? 0 : (i - (n - 1) / 2) * p.spacing;
        break;
      case 'stack-normalized':
        dx = -g.center[0];
        dy = -g.center[1];
        dz = nativeZ ? 0 : (i - (n - 1) / 2) * p.spacing;
        break;
      case 'tile': {
        const c = i % cols;
        const r = Math.floor(i / cols);
        dx = (c - (cols - 1) / 2) * cellW - g.center[0];
        dy = -(r - (rows - 1) / 2) * cellH - g.center[1];
        break;
      }
      case 'single':
        dx = -g.center[0];
        dy = -g.center[1];
        if (i !== p.current) alpha = 0;
        break;
    }
    const a = p.alignment.get(i);
    if (a) {
      dx += a.dx;
      dy += a.dy;
    }
    if (p.hidden.has(i)) alpha = 0;
    else if (p.dimOthers && p.mode !== 'single' && i !== p.current)
      alpha = Math.min(alpha, p.dimAlpha);
    offsets.push({ dx, dy, dz, alpha });
    if (alpha > 0) {
      const zMin = nativeZ ? g.min[2] * p.zScale : 0;
      const zMax = nativeZ ? g.max[2] * p.zScale : 0;
      // rotation-safe XY bounds: use the half-diagonal when the section is rotated
      const rot = a && Math.abs(a.rotation) > 1e-6;
      const hw = (g.max[0] - g.min[0]) / 2;
      const hh = (g.max[1] - g.min[1]) / 2;
      const hr = rot ? Math.hypot(hw, hh) : 0;
      const cx = g.center[0] + dx;
      const cy = g.center[1] + dy;
      extend(bounds, [rot ? cx - hr : g.min[0] + dx, rot ? cy - hr : g.min[1] + dy, zMin + dz]);
      extend(bounds, [rot ? cx + hr : g.max[0] + dx, rot ? cy + hr : g.max[1] + dy, zMax + dz]);
    }
  }
  if (!Number.isFinite(bounds.min[0])) {
    bounds.min = [-0.5, -0.5, -0.5];
    bounds.max = [0.5, 0.5, 0.5];
  }
  // explode about the z centre of the layout
  const zc = (bounds.min[2] + bounds.max[2]) / 2;
  bounds.min[2] = zc + (bounds.min[2] - zc) * p.explode;
  bounds.max[2] = zc + (bounds.max[2] - zc) * p.explode;
  return { offsets, nativeZ, bounds, planar };
}

/** The GPU-side transform table. */
export class SectionTable {
  readonly texture: DataTexture;
  readonly data: Float32Array;
  readonly n: number;
  readonly geoms: SectionGeom[];
  lastResult: LayoutResult | null = null;

  constructor(geoms: SectionGeom[]) {
    this.geoms = geoms;
    this.n = Math.max(1, geoms.length);
    this.data = new Float32Array(this.n * 3 * 4);
    this.texture = new DataTexture(this.data, this.n, 3, RGBAFormat, FloatType);
    this.texture.minFilter = NearestFilter;
    this.texture.magFilter = NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  apply(params: LayoutParams): LayoutResult {
    const res = layoutOffsets(this.geoms, params);
    const d = this.data;
    const n = this.n;
    for (let i = 0; i < this.geoms.length; i++) {
      const o = res.offsets[i];
      const g = this.geoms[i];
      const a = params.alignment.get(i);
      const row0 = i * 4;
      const row1 = (n + i) * 4;
      const row2 = (2 * n + i) * 4;
      d[row0] = o.dx;
      d[row0 + 1] = o.dy;
      d[row0 + 2] = o.dz;
      d[row0 + 3] = o.alpha;
      d[row1] = Math.cos(a?.rotation ?? 0);
      d[row1 + 1] = Math.sin(a?.rotation ?? 0);
      d[row1 + 2] = a?.flipX ? -1 : 1;
      d[row1 + 3] = a?.flipY ? -1 : 1;
      d[row2] = g.center[0];
      d[row2 + 1] = g.center[1];
      d[row2 + 2] = 0;
      d[row2 + 3] = 0;
    }
    this.texture.needsUpdate = true;
    this.lastResult = res;
    return res;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
