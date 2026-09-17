/**
 * GLSL 3 shaders for the point cloud. All layout and filter logic is here so that switching
 * layouts, stepping sections, changing colormaps or toggling categories never re-uploads
 * per-point data — only small textures/uniforms change.
 *
 * Per-section transform table (`uSectionTex`, RGBA32F, width = nSections, 3 rows):
 *   row 0: (dx, dy, dz, alpha)           offsets in unit-cube space; alpha 0 = hidden, <1 = dimmed
 *   row 1: (cos θ, sin θ, flipX, flipY)  manual alignment about the section centre
 *   row 2: (cx, cy, 0, 0)                section centre (pivot) in unit-cube space
 * `uNativeZ` = 1 keeps the data z (native 3-D stacks), 0 replaces it by the table's dz.
 */
export const POINTS_VERTEX = /* glsl */ `

in float aSection;
in float aScalar;
in float aCode;
in float aVisible;
in float aScalar2;
in float aSelected;

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
uniform float uPointSize;
uniform int uSizeMode;       // 0 screen px, 1 perspective-attenuated px, 2 world units
uniform float uWorldSize;    // point diameter in unit-cube units (mode 2)
uniform float uViewportHeight;
uniform float uPixelRatio;
uniform float uHighlightId;
uniform float uHoverId;
uniform int uColorMode;      // 0 scalar, 1 category, 2 uniform, 3 two-gene blend
uniform sampler2D uPalette;
uniform vec2 uPaletteDims;
uniform float uSelectionActive;

out float vScalar;
out float vScalar2;
out float vCode;
out float vAlpha;
out float vHighlight;
flat out int vId;

vec4 sectionTexel(float s, float row) {
  return texture(uSectionTex, vec2((s + 0.5) / uSectionCount, (row + 0.5) / 3.0));
}

float paletteAlpha(float code) {
  vec2 uv = vec2((mod(code, uPaletteDims.x) + 0.5) / uPaletteDims.x, (floor(code / uPaletteDims.x) + 0.5) / uPaletteDims.y);
  return texture(uPalette, uv).a;
}

void main() {
  vId = gl_VertexID;
  vScalar = aScalar;
  vScalar2 = aScalar2;
  vCode = aCode;
  vec3 p = position * uFlip;
  if (uSwapYZ > 0.5) p = p.xzy;
  bool clipped = any(lessThan(p, uClipMin)) || any(greaterThan(p, uClipMax));
  float alpha = 1.0;
  vec3 q = p;
  if (aSection < 65534.5 && uSectionCount > 0.5) {
    vec4 t0 = sectionTexel(aSection, 0.0);
    vec4 t1 = sectionTexel(aSection, 1.0);
    vec4 t2 = sectionTexel(aSection, 2.0);
    vec2 r = (p.xy - t2.xy) * t1.zw;
    r = vec2(r.x * t1.x - r.y * t1.y, r.x * t1.y + r.y * t1.x);
    q.xy = r + t2.xy + t0.xy;
    q.z = p.z * uNativeZ * uZScale + t0.z;
    alpha = t0.w;
  } else {
    q.z = p.z * uZScale;
  }
  q.z = uExplodeCenter + (q.z - uExplodeCenter) * uExplode;
  bool masked = uColorMode == 1 && aCode >= -0.5 && paletteAlpha(aCode) < 0.5;
  if (aVisible < 0.5 || alpha <= 0.0 || clipped || masked) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vAlpha = 0.0;
    vHighlight = 0.0;
    return;
  }
  vAlpha = alpha * ((uSelectionActive > 0.5 && aSelected < 0.5) ? 0.12 : 1.0);
  vec4 mv = modelViewMatrix * vec4(q, 1.0);
  gl_Position = projectionMatrix * mv;
  bool perspective = projectionMatrix[2][3] == -1.0;
  float size;
  if (uSizeMode == 2) {
    float proj = projectionMatrix[1][1] * uViewportHeight * 0.5;
    size = uWorldSize * proj / (perspective ? -mv.z : 1.0);
  } else if (uSizeMode == 1) {
    size = uPointSize * (perspective ? (1.5 / -mv.z) : 1.0);
  } else {
    size = uPointSize;
  }
  float id = float(gl_VertexID);
  vHighlight = (abs(id - uHighlightId) < 0.5) ? 1.0 : ((abs(id - uHoverId) < 0.5) ? 0.5 : 0.0);
  if (vHighlight > 0.9) size = max(size * 1.8, size + 6.0);
  else if (vHighlight > 0.4) size = max(size * 1.4, size + 3.0);
  gl_PointSize = max(size, 1.0) * uPixelRatio;
}
`;

export const POINTS_FRAGMENT = /* glsl */ `

in float vScalar;
in float vScalar2;
in float vCode;
in float vAlpha;
in float vHighlight;
flat in int vId;

uniform int uColorMode;
uniform sampler2D uColormap;
uniform vec2 uRange;
uniform vec2 uRange2;
uniform vec3 uBlendA;
uniform vec3 uBlendB;
uniform sampler2D uPalette;
uniform vec2 uPaletteDims;
uniform vec3 uNanColor;
uniform vec3 uUniformColor;
uniform vec3 uHighlightColor;
uniform float uOpacity;
uniform int uShape;          // 0 round, 1 square
uniform int uPicking;

// Three.js does not alias gl_FragColor for explicit GLSL3 materials.
out vec4 fragColor;

void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (uShape == 0 && r2 > 1.0) discard;
  if (uPicking == 1) {
    int id = vId + 1;
    fragColor = vec4(float(id & 255) / 255.0, float((id >> 8) & 255) / 255.0, float((id >> 16) & 255) / 255.0, 1.0);
    return;
  }
  vec3 color;
  if (uColorMode == 0) {
    if (isnan(vScalar) || isinf(vScalar)) {
      color = uNanColor;
    } else {
      float t = (vScalar - uRange.x) / max(uRange.y - uRange.x, 1e-30);
      t = clamp(t, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0;
      color = texture(uColormap, vec2(t, 0.5)).rgb;
    }
  } else if (uColorMode == 1) {
    if (vCode < -0.5) {
      color = uNanColor;
    } else {
      vec2 uv = vec2((mod(vCode, uPaletteDims.x) + 0.5) / uPaletteDims.x, (floor(vCode / uPaletteDims.x) + 0.5) / uPaletteDims.y);
      color = texture(uPalette, uv).rgb;
    }
  } else if (uColorMode == 3) {
    float tA = clamp((vScalar - uRange.x) / max(uRange.y - uRange.x, 1e-30), 0.0, 1.0);
    float tB = clamp((vScalar2 - uRange2.x) / max(uRange2.y - uRange2.x, 1e-30), 0.0, 1.0);
    if (isnan(vScalar)) tA = 0.0;
    if (isnan(vScalar2)) tB = 0.0;
    color = max(clamp(uBlendA * tA + uBlendB * tB, 0.0, 1.0), vec3(0.09));
  } else {
    color = uUniformColor;
  }
  float edge = (uShape == 0) ? (1.0 - smoothstep(0.72, 1.0, r2)) : 1.0;
  if (vHighlight > 0.4) {
    float ring = (vHighlight > 0.9) ? 0.5 : 0.62;
    if (r2 > ring) color = uHighlightColor;
    edge = (uShape == 0) ? (1.0 - smoothstep(0.9, 1.0, r2)) : 1.0;
  }
  float a = uOpacity * vAlpha * edge;
  if (a < 0.01) discard;
  fragColor = vec4(color, a);
}
`;
