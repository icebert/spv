/**
 * Spatial graph overlay: `LineSegments` whose vertex shader repeats the point transform for both
 * endpoints of every edge, so an edge disappears whenever either endpoint is hidden (section, clip
 * plane, category mask, user filter). Shares the point cloud's uniform objects.
 *
 * Drawn in batches of `EDGE_BATCH` edges (65,536 vertices) with separate vertex buffers, all under
 * 1 MiB, for the same reason as the point cloud: Safari on Metal misreads vertex buffers past 1 MiB.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  GLSL3,
  Group,
  LineSegments,
  ShaderMaterial,
  Sphere,
  Vector3,
  type IUniform,
} from 'three';

const EDGE_VERTEX = /* glsl */ `
in float aSection;
in float aVisible;
in float aCode;
in vec3 aOtherPos;
in float aOtherSection;
in float aOtherVisible;
in float aOtherCode;

uniform sampler2D uSectionTex;
uniform float uSectionCount;
uniform float uNativeZ;
uniform float uZScale;
uniform float uExplode;
uniform float uExplodeCenter;
uniform vec3 uFlip;
uniform float uSwapYZ;
uniform vec3 uClipMin;
uniform vec3 uClipMax;
uniform int uColorMode;
uniform sampler2D uPalette;
uniform vec2 uPaletteDims;

out float vAlpha;

vec4 sectionTexel(float s, float row) {
  return texture(uSectionTex, vec2((s + 0.5) / uSectionCount, (row + 0.5) / 3.0));
}

float paletteAlpha(float code) {
  vec2 uv = vec2((mod(code, uPaletteDims.x) + 0.5) / uPaletteDims.x, (floor(code / uPaletteDims.x) + 0.5) / uPaletteDims.y);
  return texture(uPalette, uv).a;
}

// Returns the transformed position; writes the section alpha (0 when hidden) to alpha.
vec3 transformPoint(vec3 raw, float section, float visible, float code, out float alpha) {
  vec3 p = raw * uFlip;
  if (uSwapYZ > 0.5) p = p.xzy;
  bool clipped = any(lessThan(p, uClipMin)) || any(greaterThan(p, uClipMax));
  alpha = 1.0;
  vec3 q = p;
  if (section < 65534.5 && uSectionCount > 0.5) {
    vec4 t0 = sectionTexel(section, 0.0);
    vec4 t1 = sectionTexel(section, 1.0);
    vec4 t2 = sectionTexel(section, 2.0);
    vec2 r = (p.xy - t2.xy) * t1.zw;
    r = vec2(r.x * t1.x - r.y * t1.y, r.x * t1.y + r.y * t1.x);
    q.xy = r + t2.xy + t0.xy;
    q.z = p.z * uNativeZ * uZScale + t0.z;
    alpha = t0.w;
  } else {
    q.z = p.z * uZScale;
  }
  q.z = uExplodeCenter + (q.z - uExplodeCenter) * uExplode;
  bool masked = uColorMode == 1 && code >= -0.5 && paletteAlpha(code) < 0.5;
  if (visible < 0.5 || clipped || masked) alpha = 0.0;
  return q;
}

void main() {
  float a0;
  float a1;
  vec3 q = transformPoint(position, aSection, aVisible, aCode, a0);
  transformPoint(aOtherPos, aOtherSection, aOtherVisible, aOtherCode, a1);
  float alpha = min(a0, a1);
  if (alpha <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0;
    return;
  }
  vAlpha = alpha;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(q, 1.0);
}
`;

const EDGE_FRAGMENT = /* glsl */ `
in float vAlpha;
uniform vec3 uEdgeColor;
uniform float uEdgeOpacity;
out vec4 fragColor;
void main() {
  float a = uEdgeOpacity * vAlpha;
  if (a < 0.01) discard;
  fragColor = vec4(uEdgeColor, a);
}
`;

const NO_SECTION = 0xffff;

/** Edges per draw call: 2 vertices each, 65,536 vertices × 12 bytes stays under 1 MiB. */
export const EDGE_BATCH = 32768;

interface EdgeArrays {
  position: Float32Array;
  aOtherPos: Float32Array;
  aSection: Uint16Array;
  aOtherSection: Uint16Array;
  aVisible: Uint8Array;
  aOtherVisible: Uint8Array;
  aCode: Float32Array;
  aOtherCode: Float32Array;
}
type EdgeAttribute = keyof EdgeArrays;
const ITEM_SIZE: Record<EdgeAttribute, number> = {
  position: 3,
  aOtherPos: 3,
  aSection: 1,
  aOtherSection: 1,
  aVisible: 1,
  aOtherVisible: 1,
  aCode: 1,
  aOtherCode: 1,
};

export class EdgeCloud {
  /** All batches; add this to the scene. */
  readonly object = new Group();
  readonly material: ShaderMaterial;
  private batches: { lines: LineSegments; geometry: BufferGeometry }[] = [];
  private arrays: EdgeArrays | null = null;
  private i = new Uint32Array(0);
  private j = new Uint32Array(0);
  private valid: Uint8Array = new Uint8Array(0);
  nEdges = 0;

  constructor(pointUniforms: Record<string, IUniform>) {
    this.material = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: EDGE_VERTEX,
      fragmentShader: EDGE_FRAGMENT,
      uniforms: {
        ...pointUniforms,
        uEdgeColor: { value: new Color('#9ca3af') },
        uEdgeOpacity: { value: 0.35 },
      },
      transparent: true,
      depthWrite: false,
    });
    this.object.name = 'spv-edges';
  }

  get batchCount(): number {
    return this.batches.length;
  }

  private clearBatches(): void {
    for (const b of this.batches) {
      this.object.remove(b.lines);
      b.geometry.dispose();
    }
    this.batches = [];
  }

  /** Build per-vertex attributes (two vertices per edge, each carrying its partner). */
  setEdges(
    pairs: Uint32Array,
    nEdges: number,
    xyz: Float32Array,
    sectionOf: Uint16Array | null,
    valid: Uint8Array,
  ): void {
    this.nEdges = nEdges;
    const nv = nEdges * 2;
    const arr: EdgeArrays = {
      position: new Float32Array(nv * 3),
      aOtherPos: new Float32Array(nv * 3),
      aSection: new Uint16Array(nv),
      aOtherSection: new Uint16Array(nv),
      aVisible: new Uint8Array(nv),
      aOtherVisible: new Uint8Array(nv),
      aCode: new Float32Array(nv).fill(-1),
      aOtherCode: new Float32Array(nv).fill(-1),
    };
    this.i = new Uint32Array(nEdges);
    this.j = new Uint32Array(nEdges);
    for (let e = 0; e < nEdges; e++) {
      const a = pairs[2 * e];
      const b = pairs[2 * e + 1];
      this.i[e] = a;
      this.j[e] = b;
      for (const [v, self, partner] of [
        [2 * e, a, b],
        [2 * e + 1, b, a],
      ] as const) {
        arr.position[v * 3] = xyz[self * 3];
        arr.position[v * 3 + 1] = xyz[self * 3 + 1];
        arr.position[v * 3 + 2] = xyz[self * 3 + 2];
        arr.aOtherPos[v * 3] = xyz[partner * 3];
        arr.aOtherPos[v * 3 + 1] = xyz[partner * 3 + 1];
        arr.aOtherPos[v * 3 + 2] = xyz[partner * 3 + 2];
        arr.aSection[v] = sectionOf ? sectionOf[self] : NO_SECTION;
        arr.aOtherSection[v] = sectionOf ? sectionOf[partner] : NO_SECTION;
        arr.aVisible[v] = valid[self];
        arr.aOtherVisible[v] = valid[partner];
      }
    }
    this.arrays = arr;
    this.valid = valid;
    this.clearBatches();
    for (let start = 0; start < nv; start += EDGE_BATCH * 2) {
      const count = Math.min(EDGE_BATCH * 2, nv - start);
      const geometry = new BufferGeometry();
      for (const name of Object.keys(arr) as EdgeAttribute[]) {
        const k = ITEM_SIZE[name];
        geometry.setAttribute(
          name,
          new BufferAttribute(arr[name].subarray(start * k, (start + count) * k), k),
        );
      }
      geometry.boundingSphere = new Sphere(new Vector3(), 4);
      const lines = new LineSegments(geometry, this.material);
      lines.frustumCulled = false;
      lines.renderOrder = 5; // after image planes, before points
      lines.name = `spv-edges-${start / 2}`;
      this.object.add(lines);
      this.batches.push({ lines, geometry });
    }
  }

  private touch(name: EdgeAttribute): void {
    for (const b of this.batches)
      (b.geometry.getAttribute(name) as BufferAttribute).needsUpdate = true;
  }

  /** Category codes of the endpoints (from the current categorical colouring), or null. */
  setCodes(codes: ArrayLike<number> | null): void {
    const arr = this.arrays;
    if (!arr) return;
    for (let e = 0; e < this.nEdges; e++) {
      const ci = codes ? codes[this.i[e]] : -1;
      const cj = codes ? codes[this.j[e]] : -1;
      arr.aCode[2 * e] = ci;
      arr.aOtherCode[2 * e] = cj;
      arr.aCode[2 * e + 1] = cj;
      arr.aOtherCode[2 * e + 1] = ci;
    }
    this.touch('aCode');
    this.touch('aOtherCode');
  }

  /** User filter mask (subsample, in_tissue) combined with coordinate validity. */
  setUserMask(mask: Uint8Array | null): void {
    const arr = this.arrays;
    if (!arr) return;
    const ok = (k: number) => (this.valid[k] && (!mask || mask[k]) ? 1 : 0);
    for (let e = 0; e < this.nEdges; e++) {
      const vi = ok(this.i[e]);
      const vj = ok(this.j[e]);
      arr.aVisible[2 * e] = vi;
      arr.aOtherVisible[2 * e] = vj;
      arr.aVisible[2 * e + 1] = vj;
      arr.aOtherVisible[2 * e + 1] = vi;
    }
    this.touch('aVisible');
    this.touch('aOtherVisible');
  }

  setStyle(color: string, opacity: number): void {
    (this.material.uniforms.uEdgeColor.value as Color).set(color);
    this.material.uniforms.uEdgeOpacity.value = opacity;
  }

  dispose(): void {
    this.clearBatches();
    this.material.dispose();
  }
}
