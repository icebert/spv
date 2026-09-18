/**
 * The point cloud: one `THREE.Points` with per-point attributes uploaded once per dataset (and once
 * per colour variable), plus small textures/uniforms for everything that changes interactively.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  GLSL3,
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

const NO_SECTION = 0xffff;

function makeColormapTexture(lut: Uint8Array): DataTexture {
  const tex = new DataTexture(new Uint8Array(lut), 256, 1, RGBAFormat, UnsignedByteType);
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export class PointCloud {
  readonly object: Points;
  readonly geometry: BufferGeometry;
  readonly material: ShaderMaterial;
  readonly pickMaterial: ShaderMaterial;
  readonly uniforms: Record<string, IUniform>;
  readonly n: number;
  private readonly valid: Uint8Array;
  private userMask: Uint8Array | null = null;
  private readonly colormapTex: DataTexture;
  private paletteTex: DataTexture;
  private paletteData: Uint8Array;
  private paletteN = 0;
  private disposed = false;

  constructor(src: PointCloudSource, sectionTable: SectionTable) {
    this.n = src.n;
    this.valid = src.valid;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(src.xyz, 3));
    const sec = src.sectionOf ?? new Uint16Array(src.n).fill(NO_SECTION);
    g.setAttribute('aSection', new BufferAttribute(sec, 1));
    g.setAttribute('aScalar', new BufferAttribute(new Float32Array(src.n).fill(NaN), 1));
    g.setAttribute('aCode', new BufferAttribute(new Float32Array(src.n).fill(-1), 1));
    g.setAttribute('aVisible', new BufferAttribute(new Uint8Array(src.valid), 1));
    g.setAttribute('aScalar2', new BufferAttribute(new Float32Array(src.n).fill(NaN), 1));
    g.setAttribute('aSelected', new BufferAttribute(new Uint8Array(src.n), 1));
    // Positions live in a unit cube; a fixed bounding sphere avoids NaN-sensitive recomputation.
    g.boundingSphere = new Sphere(new Vector3(), 4);
    this.geometry = g;

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
    this.material = new ShaderMaterial({
      ...common,
      uniforms: this.uniforms,
      transparent: true,
      depthTest: true,
      depthWrite: true,
    });
    this.pickMaterial = new ShaderMaterial({
      ...common,
      uniforms: { ...this.uniforms, uPicking: { value: 1 } },
      transparent: false,
      blending: NoBlending,
      depthTest: true,
      depthWrite: true,
    });
    this.object = new Points(g, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 10;
    this.object.name = 'spv-points';
  }

  private attr(name: string): BufferAttribute {
    return this.geometry.getAttribute(name) as BufferAttribute;
  }

  /** Diagnostic: mark every vertex attribute for re-upload from its CPU array. */
  reupload(): void {
    for (const name of Object.keys(this.geometry.attributes)) this.attr(name).needsUpdate = true;
  }

  /** Continuous values (NaN allowed) driving the colormap. `null` clears. */
  setScalar(values: ArrayLike<number> | null): void {
    const a = this.attr('aScalar');
    const arr = a.array as Float32Array;
    if (values) arr.set(values as ArrayLike<number>);
    else arr.fill(NaN);
    a.needsUpdate = true;
  }

  /** Category codes (-1 = missing). Float32 storage handles > 65535 categories. */
  setCodes(codes: ArrayLike<number> | null): void {
    const a = this.attr('aCode');
    const arr = a.array as Float32Array;
    if (codes) for (let i = 0; i < arr.length; i++) arr[i] = codes[i];
    else arr.fill(-1);
    a.needsUpdate = true;
  }

  /** User filter mask (subsampling, in_tissue…); combined with coordinate validity. */
  setUserMask(mask: Uint8Array | null): void {
    this.userMask = mask;
    const a = this.attr('aVisible');
    const arr = a.array as Uint8Array;
    for (let i = 0; i < arr.length; i++) arr[i] = this.valid[i] && (!mask || mask[i]) ? 1 : 0;
    a.needsUpdate = true;
  }

  get visibleCount(): number {
    let c = 0;
    const arr = this.attr('aVisible').array as Uint8Array;
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
    const a = this.attr('aScalar2');
    const arr = a.array as Float32Array;
    if (values) arr.set(values as ArrayLike<number>);
    else arr.fill(NaN);
    a.needsUpdate = true;
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
    const a = this.attr('aSelected');
    const arr = a.array as Uint8Array;
    if (mask) arr.set(mask);
    else arr.fill(0);
    a.needsUpdate = true;
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
    this.material.depthWrite = alpha >= 0.99;
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
    this.geometry.dispose();
    this.material.dispose();
    this.pickMaterial.dispose();
    this.colormapTex.dispose();
    this.paletteTex.dispose();
  }
}
