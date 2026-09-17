/**
 * Qualitative palettes: Paul Tol's colour-blind-safe "muted" (≤ 10) and "muted + light" (≤ 20)
 * schemes, then a generated golden-angle palette with alternating lightness/saturation tiers.
 */
import { hexToRgb, rgbToHex } from './colormaps';

export const TOL_MUTED = [
  '#cc6677',
  '#332288',
  '#ddcc77',
  '#117733',
  '#88ccee',
  '#882255',
  '#44aa99',
  '#999933',
  '#aa4499',
  '#dddddd',
];
export const TOL_LIGHT = [
  '#77aadd',
  '#99ddff',
  '#bbcc33',
  '#aaaa00',
  '#eedd88',
  '#ee8866',
  '#ffaabb',
  '#bbbbbb',
  '#0077bb',
];
// Tol light without '#44bb99' (a near duplicate of muted '#44aa99'), plus two extra distinct hues.
export const PALETTE_20 = [...TOL_MUTED, ...TOL_LIGHT, '#ff7f0e'];

export function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r: number;
  let g: number;
  let b: number;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return rgbToHex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}

const TIERS: [number, number][] = [
  [0.7, 0.58],
  [0.62, 0.4],
  [0.85, 0.74],
];

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * Deterministic palette of `n` colours: hues evenly spaced around the wheel, lightness/saturation
 * tier assigned by hue slot (so hue-adjacent colours always differ in lightness), and the output
 * order permuted with a coprime stride so consecutive categories get far-apart hues.
 */
export function generatedPalette(n: number): string[] {
  if (n <= 0) return [];
  let stride = Math.max(1, Math.round(n * 0.618));
  while (n > 1 && gcd(stride, n) !== 1) stride++;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const slot = (i * stride) % n;
    const [s, l] = TIERS[slot % TIERS.length];
    out.push(hslToHex(20 + (slot * 360) / n, s, l));
  }
  return out;
}

/** Palette for `n` categories: file colors when valid, else the tiered default. */
export function paletteFor(n: number, fileColors: string[] | null = null): string[] {
  if (fileColors && fileColors.length === n) return fileColors.map(normalizeHex);
  if (n <= TOL_MUTED.length) return TOL_MUTED.slice(0, n);
  if (n <= PALETTE_20.length) return PALETTE_20.slice(0, n);
  return generatedPalette(n);
}

export function normalizeHex(c: string): string {
  return rgbToHex(hexToRgb(c));
}

/** Minimum pairwise RGB distance (0–441); a rough distinctness score used in tests. */
export function minPairwiseDistance(colors: string[]): number {
  let best = Infinity;
  const rgb = colors.map(hexToRgb);
  for (let i = 0; i < rgb.length; i++) {
    for (let j = i + 1; j < rgb.length; j++) {
      const d = Math.hypot(rgb[i][0] - rgb[j][0], rgb[i][1] - rgb[j][1], rgb[i][2] - rgb[j][2]);
      if (d < best) best = d;
    }
  }
  return best;
}
