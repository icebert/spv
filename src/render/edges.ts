/**
 * Spatial graph overlay: one `LineSegments` whose vertex shader repeats the point transform for
 * both endpoints of every edge, so an edge disappears whenever either endpoint is hidden (section,
 * clip plane, category mask, user filter). Shares the point cloud's uniform objects.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  GLSL3,
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

export class EdgeCloud {
  readonly object: LineSegments;
  readonly geometry = new BufferGeometry();
  readonly material: ShaderMaterial;
  private i = new Uint32Array(0);
  private j = new Uint32Array(0);
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
    this.geometry.boundingSphere = new Sphere(new Vector3(), 4);
    this.object = new LineSegments(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 5; // after image planes, before points
    this.object.name = 'spv-edges';
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
    const pos = new Float32Array(nv * 3);
    const other = new Float32Array(nv * 3);
    const sec = new Uint16Array(nv);
    const osec = new Uint16Array(nv);
    const vis = new Uint8Array(nv);
    const ovis = new Uint8Array(nv);
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
        pos[v * 3] = xyz[self * 3];
        pos[v * 3 + 1] = xyz[self * 3 + 1];
        pos[v * 3 + 2] = xyz[self * 3 + 2];
        other[v * 3] = xyz[partner * 3];
        other[v * 3 + 1] = xyz[partner * 3 + 1];
        other[v * 3 + 2] = xyz[partner * 3 + 2];
        sec[v] = sectionOf ? sectionOf[self] : NO_SECTION;
        osec[v] = sectionOf ? sectionOf[partner] : NO_SECTION;
        vis[v] = valid[self];
        ovis[v] = valid[partner];
      }
    }
    const g = this.geometry;
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aOtherPos', new BufferAttribute(other, 3));
    g.setAttribute('aSection', new BufferAttribute(sec, 1));
    g.setAttribute('aOtherSection', new BufferAttribute(osec, 1));
    g.setAttribute('aVisible', new BufferAttribute(vis, 1));
    g.setAttribute('aOtherVisible', new BufferAttribute(ovis, 1));
    g.setAttribute('aCode', new BufferAttribute(new Float32Array(nv).fill(-1), 1));
    g.setAttribute('aOtherCode', new BufferAttribute(new Float32Array(nv).fill(-1), 1));
    this.valid = valid;
  }

  private valid: Uint8Array = new Uint8Array(0);

  /** Category codes of the endpoints (from the current categorical colouring), or null. */
  setCodes(codes: ArrayLike<number> | null): void {
    const a = this.geometry.getAttribute('aCode') as BufferAttribute | undefined;
    const b = this.geometry.getAttribute('aOtherCode') as BufferAttribute | undefined;
    if (!a || !b) return;
    const ca = a.array as Float32Array;
    const cb = b.array as Float32Array;
    for (let e = 0; e < this.nEdges; e++) {
      const ci = codes ? codes[this.i[e]] : -1;
      const cj = codes ? codes[this.j[e]] : -1;
      ca[2 * e] = ci;
      cb[2 * e] = cj;
      ca[2 * e + 1] = cj;
      cb[2 * e + 1] = ci;
    }
    a.needsUpdate = true;
    b.needsUpdate = true;
  }

  /** User filter mask (subsample, in_tissue) combined with coordinate validity. */
  setUserMask(mask: Uint8Array | null): void {
    const a = this.geometry.getAttribute('aVisible') as BufferAttribute | undefined;
    const b = this.geometry.getAttribute('aOtherVisible') as BufferAttribute | undefined;
    if (!a || !b) return;
    const va = a.array as Uint8Array;
    const vb = b.array as Uint8Array;
    const ok = (k: number) => (this.valid[k] && (!mask || mask[k]) ? 1 : 0);
    for (let e = 0; e < this.nEdges; e++) {
      const vi = ok(this.i[e]);
      const vj = ok(this.j[e]);
      va[2 * e] = vi;
      vb[2 * e] = vj;
      va[2 * e + 1] = vj;
      vb[2 * e + 1] = vi;
    }
    a.needsUpdate = true;
    b.needsUpdate = true;
  }

  setStyle(color: string, opacity: number): void {
    (this.material.uniforms.uEdgeColor.value as Color).set(color);
    this.material.uniforms.uEdgeOpacity.value = opacity;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
