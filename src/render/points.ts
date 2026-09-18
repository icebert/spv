/**
 * The point cloud: per-point attributes uploaded once per dataset (and once per colour variable),
 * plus small textures/uniforms for everything that changes interactively.
 *
 * The cloud is drawn in batches of at most `BATCH_SIZE` points, each `THREE.Points` with its own
 * vertex buffers, all under 1 MiB. Safari (WebGL on Metal, seen on an AMD iMac) fetched a position
 * buffer wrongly past its first 1 MiB: every point from row 87,381 (= 1 MiB / 12 bytes) on was
 * drawn with another row's coordinates, so a slice appeared twice. Batches sidestep that at the
 * cost of one draw call per 65,536 points. Ids stay global: the shader adds `uIdOffset`.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  GLSL3,
  Group,
  LinearFilter,
  NearestFilter,
  NoBlending,
  Points,
  RGBAFormat,
  ShaderMaterial,
  Sphere,
  UnsignedByteType,
  Vector2,
  Vector3,
  type IUniform,
} from 'three';
import { colormapLUT, hexToRgb, type ColormapName } from '../color/colormaps';
import { POINTS_FRAGMENT, POINTS_VERTEX } from './pointsMaterial.glsl';
import type { SectionTable } from './sections';

export type ColorMode = 'scalar' | 'category' | 'uniform' | 'blend';
export type SizeMode = 'screen' | 'attenuated' | 'world';
export type SpriteShape = 'round' | 'square';

export interface PointCloudSource {
  n: number;
  xyz: Float32Array;
  sectionOf: Uint16Array | null;
  valid: Uint8Array;
}

/** Points per draw call; keeps every vertex buffer (12 bytes per point at most) under 1 MiB. */
export const BATCH_SIZE = 65536;

const NO_SECTION = 0xffff;

interface MasterArrays {
  position: Float32Array;
  aSection: Uint16Array;
  aScalar: Float32Array;
  aCode: Float32Array;
  aVisible: Uint8Array;
  aScalar2: Float32Array;
  aSelected: Uint8Array;
}
type AttributeName = keyof MasterArrays;
const ITEM_SIZE: Record<AttributeName, number> = {
  position: 3,
  aSection: 1,
  aScalar: 1,
  aCode: 1,
  aVisible: 1,
  aScalar2: 1,
  aSelected: 1,
};

interface Batch {
  start: number;
  count: number;
  geometry: BufferGeometry;
  points: Points;
  material: ShaderMaterial;
  pickMaterial: ShaderMaterial;
}

function makeColormapTexture(lut: Uint8Array): DataTexture {
  const tex = new DataTexture(new Uint8Array(lut), 256, 1, RGBAFormat, UnsignedByteType);
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export class PointCloud {
  /** All batches; add this to the scene. */
  readonly object = new Group();
  readonly uniforms: Record<string, IUniform>;
  readonly n: number;
  private readonly batches: Batch[] = [];
  /** Whole-dataset arrays; each batch's attributes are `subarray` views into these. */
  private readonly arrays: MasterArrays;
  private readonly valid: Uint8Array;
  private userMask: Uint8Array | null = null;
  private readonly colormapTex: DataTexture;
  private paletteTex: DataTexture;
  private paletteData: Uint8Array;
  private paletteN = 0;
  private picking = false;
  private disposed = false;

  constructor(src: PointCloudSource, sectionTable: SectionTable) {
    this.n = src.n;
    this.valid = src.valid;
    this.arrays = {
      position: src.xyz,
      aSection: src.sectionOf ?? new Uint16Array(src.n).fill(NO_SECTION),
      aScalar: new Float32Array(src.n).fill(NaN),
      aCode: new Float32Array(src.n).fill(-1),
      aVisible: new Uint8Array(src.valid),
      aScalar2: new Float32Array(src.n).fill(NaN),
      aSelected: new Uint8Array(src.n),
    };

    this.colormapTex = makeColormapTexture(colormapLUT('viridis'));
    this.paletteData = new Uint8Array(4).fill(255);
    this.paletteTex = new DataTexture(this.paletteData, 1, 1, RGBAFormat, UnsignedByteType);
    this.paletteTex.minFilter = NearestFilter;
    this.paletteTex.magFilter = NearestFilter;
    this.paletteTex.generateMipmaps = false;
    this.paletteTex.needsUpdate = true;

    this.uniforms = {
      uSectionTex: { value: sectionTable.texture },
      uSectionCount: { value: sectionTable.geoms.length },
      uNativeZ: { value: 1 },
      uZScale: { value: 1 },
      uExplode: { value: 1 },
      uExplodeCenter: { value: 0 },
      uFlip: { value: new Vector3(1, 1, 1) },
      uSwapYZ: { value: 0 },
      uClipMin: { value: new Vector3(-1e9, -1e9, -1e9) },
      uClipMax: { value: new Vector3(1e9, 1e9, 1e9) },
      uPointSize: { value: 3 },
      uSizeMode: { value: 0 },
      uWorldSize: { value: 0.005 },
      uViewportHeight: { value: 1000 },
      uPixelRatio: { value: 1 },
      uHighlightId: { value: -1 },
      uHoverId: { value: -1 },
      uColorMode: { value: 2 },
      uColormap: { value: this.colormapTex },
      uRange: { value: new Vector2(0, 1) },
      uRange2: { value: new Vector2(0, 1) },
      uBlendA: { value: new Color(1, 0, 1) },
      uBlendB: { value: new Color(0, 1, 0) },
      uSelectionActive: { value: 0 },
      uPalette: { value: this.paletteTex },
      uPaletteDims: { value: new Vector2(1, 1) },
      uNanColor: { value: new Color(0.45, 0.45, 0.45) },
      uUniformColor: { value: new Color(0.55, 0.75, 0.95) },
      uHighlightColor: { value: new Color(1, 1, 1) },
      uOpacity: { value: 1 },
      uShape: { value: 0 },
      uPicking: { value: 0 },
    };
    const common = {
      glslVersion: GLSL3,
      vertexShader: POINTS_VERTEX,
      fragmentShader: POINTS_FRAGMENT,
    };
    this.object.name = 'spv-points';
    for (let start = 0; start < src.n; start += BATCH_SIZE) {
      const count = Math.min(BATCH_SIZE, src.n - start);
      const geometry = new BufferGeometry();
      for (const name of Object.keys(this.arrays) as AttributeName[]) {
        const k = ITEM_SIZE[name];
        geometry.setAttribute(
          name,
          new BufferAttribute(this.arrays[name].subarray(start * k, (start + count) * k), k),
        );
      }
      // Positions live in a unit cube; a fixed bounding sphere avoids NaN-sensitive recomputation.
      geometry.boundingSphere = new Sphere(new Vector3(), 4);
      // Uniform objects are shared with every other batch except the two that differ per batch.
      const material = new ShaderMaterial({
        ...common,
        uniforms: { ...this.uniforms, uIdOffset: { value: start } },
        transparent: true,
        depthTest: true,
        depthWrite: true,
      });
      const pickMaterial = new ShaderMaterial({
        ...common,
        uniforms: { ...this.uniforms, uIdOffset: { value: start }, uPicking: { value: 1 } },
        transparent: false,
        blending: NoBlending,
        depthTest: true,
        depthWrite: true,
      });
      const points = new Points(geometry, material);
      points.frustumCulled = false;
      points.renderOrder = 10;
      points.name = `spv-points-${start}`;
      this.object.add(points);
      this.batches.push({ start, count, geometry, points, material, pickMaterial });
    }
  }

  get batchCount(): number {
    return this.batches.length;
  }

  /** Swap every batch to the id-encoding material (GPU picking, pixel census) or back. */
  setPicking(on: boolean): void {
    if (this.picking === on) return;
    this.picking = on;
    for (const b of this.batches) b.points.material = on ? b.pickMaterial : b.material;
  }

  private touch(name: AttributeName): void {
    for (const b of this.batches)
      (b.geometry.getAttribute(name) as BufferAttribute).needsUpdate = true;
  }

  /** Diagnostic: mark every vertex attribute for re-upload from its CPU array. */
  reupload(): void {
    for (const name of Object.keys(this.arrays) as AttributeName[]) this.touch(name);
  }

  /** Continuous values (NaN allowed) driving the colormap. `null` clears. */
  setScalar(values: ArrayLike<number> | null): void {
    const arr = this.arrays.aScalar;
    if (values) arr.set(values);
    else arr.fill(NaN);
    this.touch('aScalar');
  }

  /** Category codes (-1 = missing). Float32 storage handles > 65535 categories. */
  setCodes(codes: ArrayLike<number> | null): void {
    const arr = this.arrays.aCode;
    if (codes) for (let i = 0; i < arr.length; i++) arr[i] = codes[i];
    else arr.fill(-1);
    this.touch('aCode');
  }

  /** User filter mask (subsampling, in_tissue…); combined with coordinate validity. */
  setUserMask(mask: Uint8Array | null): void {
    this.userMask = mask;
    const arr = this.arrays.aVisible;
    for (let i = 0; i < arr.length; i++) arr[i] = this.valid[i] && (!mask || mask[i]) ? 1 : 0;
    this.touch('aVisible');
  }

  get visibleCount(): number {
    let c = 0;
    const arr = this.arrays.aVisible;
    for (let i = 0; i < arr.length; i++) c += arr[i];
    return c;
  }

  getUserMask(): Uint8Array | null {
    return this.userMask;
  }

  setColorMode(mode: ColorMode): void {
    this.uniforms.uColorMode.value =
      mode === 'scalar' ? 0 : mode === 'category' ? 1 : mode === 'blend' ? 3 : 2;
  }

  /** Second continuous variable for two-gene blending. */
  setScalar2(values: ArrayLike<number> | null): void {
    const arr = this.arrays.aScalar2;
    if (values) arr.set(values);
    else arr.fill(NaN);
    this.touch('aScalar2');
  }

  setRange2(min: number, max: number): void {
    if (!(max > min)) max = min + 1;
    (this.uniforms.uRange2.value as Vector2).set(min, max);
  }

  setBlendColors(a: string, b: string): void {
    (this.uniforms.uBlendA.value as Color).set(a);
    (this.uniforms.uBlendB.value as Color).set(b);
  }

  /** Selection mask (1 = selected); null clears and turns dimming off. */
  setSelection(mask: Uint8Array | null): void {
    const arr = this.arrays.aSelected;
    if (mask) arr.set(mask);
    else arr.fill(0);
    this.touch('aSelected');
    this.uniforms.uSelectionActive.value = mask ? 1 : 0;
  }

  setColormap(name: ColormapName, reversed = false): void {
    (this.colormapTex.image.data as Uint8Array).set(colormapLUT(name, reversed));
    this.colormapTex.needsUpdate = true;
  }

  setRange(min: number, max: number): void {
    // Zero-variance data: keep a non-degenerate range so everything maps to the low colour.
    if (!(max > min)) max = min + 1;
    (this.uniforms.uRange.value as Vector2).set(min, max);
  }

  /** Palette colours (hex) + visibility mask; rebuilds the palette texture when the size changes. */
  setPalette(colors: string[], visible?: ArrayLike<number> | null): void {
    const n = Math.max(1, colors.length);
    const w = Math.min(256, n);
    const h = Math.ceil(n / 256);
    if (n !== this.paletteN) {
      this.paletteTex.dispose();
      this.paletteData = new Uint8Array(w * h * 4);
      this.paletteTex = new DataTexture(this.paletteData, w, h, RGBAFormat, UnsignedByteType);
      this.paletteTex.minFilter = NearestFilter;
      this.paletteTex.magFilter = NearestFilter;
      this.paletteTex.generateMipmaps = false;
      this.uniforms.uPalette.value = this.paletteTex;
      (this.uniforms.uPaletteDims.value as Vector2).set(w, h);
      this.paletteN = n;
    }
    for (let i = 0; i < colors.length; i++) {
      const [r, g, b] = hexToRgb(colors[i]);
      this.paletteData[i * 4] = r;
      this.paletteData[i * 4 + 1] = g;
      this.paletteData[i * 4 + 2] = b;
      this.paletteData[i * 4 + 3] = visible ? (visible[i] ? 255 : 0) : 255;
    }
    this.paletteTex.needsUpdate = true;
  }

  /** O(1) legend toggle: only the alpha byte of one palette texel changes. */
  setCategoryVisible(index: number, visible: boolean): void {
    if (index < 0 || index >= this.paletteN) return;
    this.paletteData[index * 4 + 3] = visible ? 255 : 0;
    this.paletteTex.needsUpdate = true;
  }

  setCategoryMask(visible: ArrayLike<number>): void {
    for (let i = 0; i < this.paletteN; i++) this.paletteData[i * 4 + 3] = visible[i] ? 255 : 0;
    this.paletteTex.needsUpdate = true;
  }

  setPointSize(px: number): void {
    this.uniforms.uPointSize.value = px;
  }

  setSizeMode(mode: SizeMode): void {
    this.uniforms.uSizeMode.value = mode === 'screen' ? 0 : mode === 'attenuated' ? 1 : 2;
  }

  /** Point diameter in unit-cube units for the "true spot size" mode. */
  setWorldSize(diameter: number): void {
    this.uniforms.uWorldSize.value = diameter;
  }

  setOpacity(alpha: number): void {
    this.uniforms.uOpacity.value = alpha;
    for (const b of this.batches) b.material.depthWrite = alpha >= 0.99;
  }

  setShape(shape: SpriteShape): void {
    this.uniforms.uShape.value = shape === 'round' ? 0 : 1;
  }

  setNanColor(hex: string): void {
    (this.uniforms.uNanColor.value as Color).set(hex);
  }

  setUniformColor(hex: string): void {
    (this.uniforms.uUniformColor.value as Color).set(hex);
  }

  setHighlightColor(hex: string): void {
    (this.uniforms.uHighlightColor.value as Color).set(hex);
  }

  /** Clip box in the native (pre-layout, unit-cube) frame; pass ±Infinity to disable an axis. */
  setClip(min: [number, number, number], max: [number, number, number]): void {
    (this.uniforms.uClipMin.value as Vector3).set(
      ...(min.map((v) => (Number.isFinite(v) ? v : -1e9)) as [number, number, number]),
    );
    (this.uniforms.uClipMax.value as Vector3).set(
      ...(max.map((v) => (Number.isFinite(v) ? v : 1e9)) as [number, number, number]),
    );
  }

  setHighlight(pointId: number | null): void {
    this.uniforms.uHighlightId.value = pointId ?? -1;
  }

  setHover(pointId: number | null): void {
    this.uniforms.uHoverId.value = pointId ?? -1;
  }

  setFlip(x: boolean, y: boolean, z: boolean): void {
    (this.uniforms.uFlip.value as Vector3).set(x ? -1 : 1, y ? -1 : 1, z ? -1 : 1);
  }

  setSwapYZ(on: boolean): void {
    this.uniforms.uSwapYZ.value = on ? 1 : 0;
  }

  setZScale(s: number): void {
    this.uniforms.uZScale.value = s;
  }

  setNativeZ(on: 0 | 1): void {
    this.uniforms.uNativeZ.value = on;
  }

  setExplode(factor: number, center = 0): void {
    this.uniforms.uExplode.value = factor;
    this.uniforms.uExplodeCenter.value = center;
  }

  setViewport(heightPx: number, pixelRatio: number): void {
    this.uniforms.uViewportHeight.value = heightPx;
    this.uniforms.uPixelRatio.value = pixelRatio;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const b of this.batches) {
      b.geometry.dispose();
      b.material.dispose();
      b.pickMaterial.dispose();
    }
    this.colormapTex.dispose();
    this.paletteTex.dispose();
  }
}
