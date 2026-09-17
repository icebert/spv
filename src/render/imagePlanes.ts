/**
 * Tissue image planes: one textured quad per section, positioned with the same per-section
 * transform as the points (computed on the CPU from the layout result) so the image follows its
 * spots in every layout mode. Extent and origin follow Squidpy/Visium conventions: the image spans
 * `(W / scalef) × (H / scalef)` raw units with its top-left corner at raw (0, 0), y pointing down.
 */
import {
  DataTexture,
  DoubleSide,
  GLSL3,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  PlaneGeometry,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
} from 'three';
import type { DecodedImage, SectionInfo } from '../h5ad/types';
import {
  toDisplay,
  type DisplayFrame,
  type LayoutParams,
  type LayoutResult,
  type SectionGeom,
} from './sections';

export const IMAGE_TEXTURE_BUDGET = 256 * 1024 * 1024;
const Z_EPSILON = 0.0015;

const PLANE_VERTEX = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const PLANE_FRAGMENT = /* glsl */ `
in vec2 vUv;
uniform sampler2D uMap;
uniform float uOpacity;
uniform float uGrayscale;
out vec4 fragColor;
void main() {
  vec4 c = texture(uMap, vUv);
  float g = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  c.rgb = mix(c.rgb, vec3(g), uGrayscale);
  fragColor = vec4(c.rgb, c.a * uOpacity);
}`;

export interface PlanePlacement {
  /** centre of the image in unit-cube display coordinates, before the section offset */
  center: [number, number, number];
  /** plane width/height in unit-cube units (unsigned) */
  size: [number, number];
  /** sign flips from the display frame */
  sign: [number, number];
}

/** Pure placement math (unit-tested): where an image of `w × h` pixels at `scalef` sits. */
export function planePlacement(
  section: SectionInfo,
  imageW: number,
  imageH: number,
  scalef: number,
  center: [number, number, number],
  scale: number,
  frame: DisplayFrame,
): PlanePlacement {
  const rawW = imageW / scalef;
  const rawH = imageH / scalef;
  const z = section.z ?? section.bbox?.min[2] ?? center[2];
  const c = toDisplay([rawW / 2, rawH / 2, z], center, scale, frame);
  return {
    center: c,
    size: [rawW * scale, rawH * scale],
    sign: [frame.flipX ? -1 : 1, frame.flipY ? -1 : 1],
  };
}

export interface PlaneEntry {
  ordinal: number;
  library: string;
  key: string;
  mesh: Mesh;
  texture: DataTexture;
  material: ShaderMaterial;
  bytes: number;
  placement: PlanePlacement;
}

export class ImagePlanes {
  readonly group = new Group();
  private readonly entries = new Map<number, PlaneEntry>();
  private readonly geometry = new PlaneGeometry(1, 1);
  private anisotropy = 1;

  constructor(
    private center: [number, number, number],
    private scale: number,
    private frame: DisplayFrame,
  ) {
    this.group.name = 'spv-image-planes';
    this.group.renderOrder = 0;
  }

  setAnisotropy(v: number): void {
    this.anisotropy = v;
  }

  setFrame(center: [number, number, number], scale: number, frame: DisplayFrame): void {
    this.center = center;
    this.scale = scale;
    this.frame = frame;
  }

  has(ordinal: number): boolean {
    return this.entries.has(ordinal);
  }

  get(ordinal: number): PlaneEntry | undefined {
    return this.entries.get(ordinal);
  }

  totalBytes(): number {
    let b = 0;
    for (const e of this.entries.values()) b += e.bytes;
    return b;
  }

  /** Create or replace the plane for one section from a decoded RGBA image. */
  setImage(section: SectionInfo, key: string, img: DecodedImage, scalef: number): PlaneEntry {
    this.remove(section.ordinal);
    const texture = new DataTexture(img.data, img.width, img.height, RGBAFormat, UnsignedByteType);
    texture.flipY = false; // data row 0 = raw y 0 (top of the image, smallest y)
    texture.generateMipmaps = true;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.anisotropy = this.anisotropy;
    texture.needsUpdate = true;
    const material = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: PLANE_VERTEX,
      fragmentShader: PLANE_FRAGMENT,
      uniforms: { uMap: { value: texture }, uOpacity: { value: 1 }, uGrayscale: { value: 0 } },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: DoubleSide,
    });
    const mesh = new Mesh(this.geometry, material);
    mesh.renderOrder = 0;
    mesh.frustumCulled = false;
    // The image spans the full-resolution pixel space; `img.sourceShape` is the stored image and
    // `scalef` maps stored pixels → full-res pixels, independent of our downscale factor.
    const placement = planePlacement(
      section,
      img.sourceShape[1],
      img.sourceShape[0],
      scalef,
      this.center,
      this.scale,
      this.frame,
    );
    const entry: PlaneEntry = {
      ordinal: section.ordinal,
      library: section.id,
      key,
      mesh,
      texture,
      material,
      bytes: img.width * img.height * 4,
      placement,
    };
    this.entries.set(section.ordinal, entry);
    this.group.add(mesh);
    return entry;
  }

  remove(ordinal: number): void {
    const e = this.entries.get(ordinal);
    if (!e) return;
    this.group.remove(e.mesh);
    e.texture.dispose();
    e.material.dispose();
    this.entries.delete(ordinal);
  }

  /** Re-place every plane for the current layout (mirrors the vertex shader math). */
  update(
    layout: LayoutResult,
    params: LayoutParams,
    geoms: SectionGeom[],
    opts: {
      visible: boolean;
      opacity: number;
      grayscale: boolean;
      explodeCenter: number;
      hiddenSections: ReadonlySet<number>;
    },
  ): void {
    for (const e of this.entries.values()) {
      const off = layout.offsets[e.ordinal];
      const g = geoms[e.ordinal];
      if (!off || !g) {
        e.mesh.visible = false;
        continue;
      }
      const visible = opts.visible && off.alpha > 0 && !opts.hiddenSections.has(e.ordinal);
      e.mesh.visible = visible;
      if (!visible) continue;
      const a = params.alignment.get(e.ordinal);
      const rot = a?.rotation ?? 0;
      const fx = a?.flipX ? -1 : 1;
      const fy = a?.flipY ? -1 : 1;
      const p = e.placement.center;
      // r = R · (F · (p − c)) + c + d   (same as the shader)
      let rx = (p[0] - g.center[0]) * fx;
      let ry = (p[1] - g.center[1]) * fy;
      const cs = Math.cos(rot);
      const sn = Math.sin(rot);
      [rx, ry] = [rx * cs - ry * sn, rx * sn + ry * cs];
      const x = rx + g.center[0] + off.dx;
      const y = ry + g.center[1] + off.dy;
      let z = p[2] * layout.nativeZ * params.zScale + off.dz;
      z = opts.explodeCenter + (z - opts.explodeCenter) * params.explode;
      e.mesh.position.set(x, y, z - Z_EPSILON);
      e.mesh.rotation.set(0, 0, rot);
      e.mesh.scale.set(
        e.placement.size[0] * e.placement.sign[0] * fx,
        e.placement.size[1] * e.placement.sign[1] * fy,
        1,
      );
      e.material.uniforms.uOpacity.value =
        opts.opacity *
        Math.min(1, off.alpha / Math.max(off.alpha, 1e-6)) *
        (off.alpha < 1 ? off.alpha : 1);
      e.material.uniforms.uGrayscale.value = opts.grayscale ? 1 : 0;
    }
  }

  dispose(): void {
    for (const o of [...this.entries.keys()]) this.remove(o);
    this.geometry.dispose();
  }
}
