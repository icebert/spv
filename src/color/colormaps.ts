/**
 * 256-entry RGBA lookup tables for continuous colormaps, no dependencies.
 * viridis / plasma / magma / inferno use the degree-6 polynomial fits by Matt Zucker
 * (https://www.shadertoy.com/view/WlfXRN), turbo uses Google's polynomial approximation,
 * the others are piecewise-linear in sRGB through a few control points.
 */
export const COLORMAP_NAMES = [
  'viridis',
  'plasma',
  'inferno',
  'magma',
  'cividis',
  'turbo',
  'coolwarm',
  'greys',
] as const;
export type ColormapName = (typeof COLORMAP_NAMES)[number];

type RGB = [number, number, number];
type Poly = RGB[]; // c0..c6

const POLY: Record<'viridis' | 'plasma' | 'magma' | 'inferno', Poly> = {
  viridis: [
    [0.2777273272234177, 0.005407344544966578, 0.3340998053353061],
    [0.1050930431085774, 1.404613529898575, 1.384590162594685],
    [-0.3308618287255563, 0.214847559468213, 0.09509516302823659],
    [-4.634230498983486, -5.799100973351585, -19.33244095627987],
    [6.228269936347081, 14.17993336680509, 56.69055260068105],
    [4.776384997670288, -13.74514537774601, -65.35303263337234],
    [-5.435455855934631, 4.645852612178535, 26.3124352495832],
  ],
  plasma: [
    [0.05873234392399702, 0.02333670892565664, 0.5433401826748754],
    [2.176514634195958, 0.2383834171260182, 0.7539604599784036],
    [-2.689460476458034, -7.455851135738909, 3.110799939717086],
    [6.130348345893603, 42.3461881477227, -28.51885465332158],
    [-11.10743619062271, -82.66631109428045, 60.13984767418263],
    [10.02306557647065, 71.41361770095349, -54.07218655560067],
    [-3.658713842777788, -22.93153465461149, 18.19190778539828],
  ],
  magma: [
    [-0.002136485053939582, -0.000749655052795221, -0.005386127855323933],
    [0.2516605407371642, 0.6775232436837668, 2.494026599312351],
    [8.353717279216625, -3.577719514958484, 0.3144679030132573],
    [-27.66873308576866, 14.26473078096533, -13.64921318813922],
    [52.17613981234068, -27.94360607168351, 12.94416944238394],
    [-50.76852536473588, 29.04658282127291, 4.23415299384598],
    [18.65570506591883, -11.48977351997711, -5.601961508734096],
  ],
  inferno: [
    [0.0002189403691192265, 0.001651004631001012, -0.01948089843709184],
    [0.1065134194856116, 0.5639564367884091, 3.932712388889277],
    [11.60249308247187, -3.972853965665698, -15.9423941062914],
    [-41.70399613139459, 17.43639888205313, 44.35414519872813],
    [77.162935699427, -33.40235894210092, -81.80730925738993],
    [-71.31942824499214, 32.62606426397723, 73.20951985803202],
    [25.13112622477341, -12.24266895238567, -23.07032500287172],
  ],
};

function evalPoly(c: Poly, t: number): RGB {
  const out: RGB = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    let acc = c[6][ch];
    for (let k = 5; k >= 0; k--) acc = acc * t + c[k][ch];
    out[ch] = acc;
  }
  return out;
}

function turbo(t: number): RGB {
  const x = Math.min(1, Math.max(0, t));
  const v4 = [1, x, x * x, x * x * x];
  const v2 = [x * x * x * x, x * x * x * x * x];
  const dot = (a: number[], b: number[]) => a.reduce((s, ai, i) => s + ai * b[i], 0);
  return [
    dot(v4, [0.13572138, 4.6153926, -42.66032258, 132.13108234]) +
      dot(v2, [-152.94239396, 59.28637943]),
    dot(v4, [0.09140261, 2.19418839, 4.84296658, -14.18503333]) + dot(v2, [4.27729857, 2.82956604]),
    dot(v4, [0.1066733, 12.64194608, -60.58204836, 110.36276771]) +
      dot(v2, [-89.90310912, 27.34824973]),
  ];
}

const STOPS: Record<'cividis' | 'coolwarm' | 'greys', string[]> = {
  cividis: [
    '#00204d',
    '#00306f',
    '#2a406c',
    '#48526b',
    '#5e626e',
    '#737475',
    '#8a8779',
    '#a29b74',
    '#bcaf6f',
    '#d8c560',
    '#ffea46',
  ],
  coolwarm: [
    '#3b4cc0',
    '#5977e3',
    '#7b9ff9',
    '#9ebeff',
    '#c0d4f5',
    '#dddddd',
    '#f2cbb7',
    '#f7ac8e',
    '#ee8468',
    '#d65244',
    '#b40426',
  ],
  greys: ['#000000', '#ffffff'],
};

export function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: RGB): string {
  return (
    '#' +
    [r, g, b]
      .map((v) =>
        Math.round(Math.min(255, Math.max(0, v)))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

function stops(colors: string[], t: number): RGB {
  const pos = Math.min(1, Math.max(0, t)) * (colors.length - 1);
  const i = Math.min(colors.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = hexToRgb(colors[i]);
  const b = hexToRgb(colors[i + 1]);
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Color at t ∈ [0, 1] as 0–255 RGB. */
export function colormapColor(name: ColormapName, t: number, reversed = false): RGB {
  const u = reversed ? 1 - t : t;
  const x = Math.min(1, Math.max(0, u));
  let c: RGB;
  if (name === 'turbo') c = turbo(x);
  else if (name in POLY) c = evalPoly(POLY[name as keyof typeof POLY], x);
  else c = stops(STOPS[name as keyof typeof STOPS], x).map((v) => v / 255) as RGB;
  return c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)) as RGB;
}

const cache = new Map<string, Uint8Array>();

/** 256 × RGBA bytes, suitable for a `DataTexture`. */
export function colormapLUT(name: ColormapName, reversed = false): Uint8Array {
  const key = `${name}${reversed ? ':r' : ''}`;
  let lut = cache.get(key);
  if (!lut) {
    lut = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const [r, g, b] = colormapColor(name, i / 255, reversed);
      lut[i * 4] = r;
      lut[i * 4 + 1] = g;
      lut[i * 4 + 2] = b;
      lut[i * 4 + 3] = 255;
    }
    cache.set(key, lut);
  }
  return lut;
}

/** CSS gradient (left = low) for colorbars. */
export function colormapCss(name: ColormapName, reversed = false, steps = 16): string {
  const parts: string[] = [];
  for (let i = 0; i <= steps; i++) parts.push(rgbToHex(colormapColor(name, i / steps, reversed)));
  return `linear-gradient(to right, ${parts.join(', ')})`;
}
