/**
 * Compact, versioned (`v=1`) serialisation of the view state into the URL hash. Only values that
 * differ from the defaults are written. Unknown keys are ignored when parsing.
 */
import { COLORMAP_NAMES, type ColormapName } from '../color/colormaps';
import type { ColumnRef } from '../h5ad/types';
import { LAYOUT_MODES, type LayoutMode } from '../render/sections';
import { defaultState, type AlignmentState, type ViewerState } from './viewerState';

export const URL_STATE_VERSION = 1;

const num = (v: number, digits = 4): string => {
  const s = Number(v.toFixed(digits));
  return String(s);
};

/** "0-3,7,9-10" ↔ [0,1,2,3,7,9,10] */
export function encodeIndexList(list: number[]): string {
  const sorted = [...new Set(list)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(
      j > i + 1
        ? `${sorted[i]}-${sorted[j]}`
        : j === i + 1
          ? `${sorted[i]},${sorted[j]}`
          : `${sorted[i]}`,
    );
    i = j + 1;
  }
  return parts.join(',');
}

export function decodeIndexList(s: string): number[] {
  const out: number[] = [];
  for (const part of s.split(',')) {
    if (part === '') continue;
    const m = /^(\d+)-(\d+)$/.exec(part);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      for (let i = a; i <= b && i - a < 100000; i++) out.push(i);
    } else if (/^\d+$/.test(part)) out.push(Number(part));
  }
  return out;
}

function encodeRef(r: ColumnRef | null): string | null {
  if (!r) return null;
  return r.column === null ? r.path : `${r.path}:${r.column}`;
}

function decodeRef(s: string | null): ColumnRef | null {
  if (!s) return null;
  const m = /^(.*):(\d+)$/.exec(s);
  return m ? { path: m[1], column: Number(m[2]) } : { path: s, column: null };
}

const nums = (s: string | null, n: number): number[] | null => {
  if (!s) return null;
  const v = s.split(',').map(Number);
  return v.length === n && v.every(Number.isFinite) ? v : null;
};

export function serializeState(s: ViewerState): string {
  const d = defaultState();
  const p = new URLSearchParams();
  p.set('v', String(URL_STATE_VERSION));
  if (s.dataset.local) p.set('local', '1');
  else if (s.dataset.id) p.set('dataset', s.dataset.id);
  else if (s.dataset.url) p.set('url', s.dataset.url);
  // coordinates
  const c = s.coords;
  if (c.x) p.set('cx', encodeRef(c.x)!);
  if (c.y) p.set('cy', encodeRef(c.y)!);
  if (c.z) p.set('cz', encodeRef(c.z)!);
  if (c.zNone) p.set('cz', 'none');
  if (c.libraryKey) p.set('lib', c.libraryKey);
  if (c.libraryNone) p.set('lib', 'none');
  const flips = `${c.flipX ? 'x' : ''}${c.flipY ? 'y' : ''}${c.flipZ ? 'z' : ''}${c.swapYZ ? 's' : ''}`;
  if (flips) p.set('flip', flips);
  if (c.zScale !== d.coords.zScale) p.set('zs', num(c.zScale));
  // layout
  const l = s.layout;
  if (l.mode !== d.layout.mode) p.set('lm', l.mode);
  if (l.spacing !== d.layout.spacing) p.set('sp', num(l.spacing));
  if (l.uniformSpacing) p.set('us', '1');
  if (l.gap !== d.layout.gap) p.set('gap', num(l.gap));
  if (l.explode !== d.layout.explode) p.set('ex', num(l.explode));
  if (l.current !== d.layout.current) p.set('cur', String(l.current));
  if (l.hidden.length) p.set('hs', encodeIndexList(l.hidden));
  if (l.dimOthers) p.set('dim', '1');
  if (!l.crossfade) p.set('cf', '0');
  const al = Object.entries(l.alignment)
    .filter(([, a]) => a.dx !== 0 || a.dy !== 0 || a.dz !== 0 || a.rot !== 0 || a.fx || a.fy)
    .map(
      ([k, a]) =>
        `${k}:${num(a.dx)},${num(a.dy)},${num(a.rot, 2)},${a.fx ? 'x' : ''}${a.fy ? 'y' : ''}${a.dz !== 0 ? `,${num(a.dz)}` : ''}`,
    );
  if (al.length) p.set('al', al.join(';'));
  // graph overlay
  const g = s.graph;
  if (g.enabled) p.set('gr', g.key ?? '*');
  if (g.color !== d.graph.color) p.set('gc', g.color.replace('#', ''));
  if (g.opacity !== d.graph.opacity) p.set('go', num(g.opacity, 2));
  if (g.maxEdges !== d.graph.maxEdges) p.set('ge', String(g.maxEdges));
  // images
  const im = s.images;
  if (!im.enabled) p.set('img', '0');
  if (im.opacity !== d.images.opacity) p.set('io', num(im.opacity, 2));
  if (im.resolution !== d.images.resolution) p.set('ir', im.resolution);
  if (im.grayscale) p.set('ig', '1');
  // colour
  const col = s.color;
  if (col.source !== 'none' && col.key) {
    p.set('c', `${col.source}:${col.key}`);
    if (col.source === 'gene' && col.matrix !== 'X') p.set('mat', col.matrix);
    if (col.log1p) p.set('log', '1');
    if (col.source === 'gene' && col.gene2) p.set('c2', col.gene2);
  }
  if (
    col.blendColors[0] !== d.color.blendColors[0] ||
    col.blendColors[1] !== d.color.blendColors[1]
  ) {
    p.set('bc', col.blendColors.map((c) => c.replace('#', '')).join(','));
  }
  if (col.colormap !== d.color.colormap) p.set('cm', col.colormap);
  if (col.reversed) p.set('cmr', '1');
  if (col.rangeMode === 'absolute' && col.vmin !== null && col.vmax !== null)
    p.set('rng', `${num(col.vmin)},${num(col.vmax)}`);
  else if (col.pLo !== d.color.pLo || col.pHi !== d.color.pHi)
    p.set('pct', `${num(col.pLo, 2)},${num(col.pHi, 2)}`);
  if (col.nanColor !== d.color.nanColor) p.set('nan', col.nanColor.replace('#', ''));
  if (col.hiddenCategories.length) p.set('hc', encodeIndexList(col.hiddenCategories));
  if (col.geneNameColumn) p.set('gn', col.geneNameColumn);
  // filter
  const f = s.filter;
  if (f.zRange) p.set('zr', `${num(f.zRange[0])},${num(f.zRange[1])}`);
  if (f.clipX[0] !== 0 || f.clipX[1] !== 1)
    p.set('clx', `${num(f.clipX[0], 3)},${num(f.clipX[1], 3)}`);
  if (f.clipY[0] !== 0 || f.clipY[1] !== 1)
    p.set('cly', `${num(f.clipY[0], 3)},${num(f.clipY[1], 3)}`);
  if (!f.inTissueOnly) p.set('tissue', '0');
  if (f.subsample) p.set('sub', String(f.subsample));
  // appearance
  const a = s.appearance;
  if (a.pointSize !== d.appearance.pointSize) p.set('ps', num(a.pointSize, 2));
  if (a.trueSize) p.set('ts', '1');
  else if (a.sizeMode !== d.appearance.sizeMode) p.set('sm', a.sizeMode);
  if (a.opacity !== d.appearance.opacity) p.set('op', num(a.opacity, 2));
  if (a.shape !== d.appearance.shape) p.set('sh', a.shape);
  if (a.background !== d.appearance.background) p.set('bg', a.background);
  const helpers = `${a.axes ? 'a' : ''}${a.bbox ? 'b' : ''}${a.grid ? 'g' : ''}`;
  if (helpers !== 'a') p.set('hl', helpers || '-');
  if (a.ortho) p.set('ortho', '1');
  // camera
  const cam = s.ui.camera;
  if (cam) {
    p.set('cam', [...cam.position, ...cam.target].map((v) => num(v, 4)).join(','));
    if (cam.ortho && cam.zoom !== 1) p.set('zoom', num(cam.zoom, 4));
  }
  if (!s.ui.sidebar) p.set('sb', '0');
  return p.toString();
}

/** Parse a hash (with or without '#'); returns a full state with unknown keys ignored. */
export function parseState(hash: string): { state: ViewerState; version: number | null } {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const p = new URLSearchParams(raw);
  const s = defaultState();
  const version = p.has('v') ? Number(p.get('v')) : null;
  if (p.get('local') === '1') s.dataset.local = true;
  s.dataset.id = p.get('dataset');
  s.dataset.url = p.get('url');
  const cz = p.get('cz');
  s.coords.x = decodeRef(p.get('cx'));
  s.coords.y = decodeRef(p.get('cy'));
  s.coords.z = cz === 'none' ? null : decodeRef(cz);
  s.coords.zNone = cz === 'none';
  const lib = p.get('lib');
  s.coords.libraryKey = lib && lib !== 'none' ? lib : null;
  s.coords.libraryNone = lib === 'none';
  const flip = p.get('flip') ?? '';
  s.coords.flipX = flip.includes('x');
  s.coords.flipY = flip.includes('y');
  s.coords.flipZ = flip.includes('z');
  s.coords.swapYZ = flip.includes('s');
  if (p.has('zs')) s.coords.zScale = Number(p.get('zs')) || 1;
  const lm = p.get('lm');
  if (lm && (LAYOUT_MODES as string[]).includes(lm)) s.layout.mode = lm as LayoutMode;
  if (p.has('sp')) s.layout.spacing = Number(p.get('sp'));
  s.layout.uniformSpacing = p.get('us') === '1';
  if (p.has('gap')) s.layout.gap = Number(p.get('gap'));
  if (p.has('ex')) s.layout.explode = Number(p.get('ex'));
  if (p.has('cur')) s.layout.current = Math.max(0, Number(p.get('cur')) || 0);
  if (p.has('hs')) s.layout.hidden = decodeIndexList(p.get('hs')!);
  s.layout.dimOthers = p.get('dim') === '1';
  s.layout.crossfade = p.get('cf') !== '0';
  if (p.has('al')) {
    const alignment: Record<number, AlignmentState> = {};
    for (const part of p.get('al')!.split(';')) {
      const m = /^(\d+):(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),([xy]*)(?:,(-?[\d.]+))?$/.exec(part);
      if (!m) continue;
      alignment[Number(m[1])] = {
        dx: Number(m[2]),
        dy: Number(m[3]),
        dz: m[6] ? Number(m[6]) : 0,
        rot: Number(m[4]),
        fx: m[5].includes('x'),
        fy: m[5].includes('y'),
      };
    }
    s.layout.alignment = alignment;
  }
  if (p.has('gr')) {
    s.graph.enabled = true;
    s.graph.key = p.get('gr') === '*' ? null : p.get('gr');
  }
  if (p.has('gc') && /^[0-9a-f]{6}$/i.test(p.get('gc')!)) s.graph.color = `#${p.get('gc')}`;
  if (p.has('go')) s.graph.opacity = Number(p.get('go'));
  if (p.has('ge')) s.graph.maxEdges = Number(p.get('ge')) || s.graph.maxEdges;
  if (p.get('img') === '0') s.images.enabled = false;
  if (p.has('io')) s.images.opacity = Number(p.get('io'));
  const ir = p.get('ir');
  if (ir === 'hires' || ir === 'lowres' || ir === 'auto') s.images.resolution = ir;
  s.images.grayscale = p.get('ig') === '1';
  const c = p.get('c');
  if (c) {
    const i = c.indexOf(':');
    const src = c.slice(0, i);
    if ((src === 'obs' || src === 'gene') && i > 0) {
      s.color.source = src;
      s.color.key = c.slice(i + 1);
    }
  }
  if (p.has('mat')) s.color.matrix = p.get('mat')!;
  if (p.has('c2') && s.color.source === 'gene') s.color.gene2 = p.get('c2');
  const bc = p.get('bc')?.split(',');
  if (bc && bc.length === 2 && bc.every((c) => /^[0-9a-f]{6}$/i.test(c)))
    s.color.blendColors = [`#${bc[0]}`, `#${bc[1]}`];
  s.color.log1p = p.get('log') === '1';
  const cm = p.get('cm');
  if (cm && (COLORMAP_NAMES as readonly string[]).includes(cm))
    s.color.colormap = cm as ColormapName;
  s.color.reversed = p.get('cmr') === '1';
  const rng = nums(p.get('rng'), 2);
  if (rng) {
    s.color.rangeMode = 'absolute';
    s.color.vmin = rng[0];
    s.color.vmax = rng[1];
  }
  const pct = nums(p.get('pct'), 2);
  if (pct) {
    s.color.pLo = pct[0];
    s.color.pHi = pct[1];
  }
  if (p.has('nan') && /^[0-9a-f]{6}$/i.test(p.get('nan')!)) s.color.nanColor = `#${p.get('nan')}`;
  if (p.has('hc')) s.color.hiddenCategories = decodeIndexList(p.get('hc')!);
  s.color.geneNameColumn = p.get('gn');
  const zr = nums(p.get('zr'), 2);
  if (zr) s.filter.zRange = [zr[0], zr[1]];
  const clx = nums(p.get('clx'), 2);
  if (clx) s.filter.clipX = [clx[0], clx[1]];
  const cly = nums(p.get('cly'), 2);
  if (cly) s.filter.clipY = [cly[0], cly[1]];
  if (p.get('tissue') === '0') s.filter.inTissueOnly = false;
  if (p.has('sub')) s.filter.subsample = Number(p.get('sub')) || null;
  if (p.has('ps')) s.appearance.pointSize = Number(p.get('ps'));
  if (p.get('ts') === '1') {
    s.appearance.trueSize = true;
    s.appearance.sizeMode = 'world';
  } else if (p.get('sm') === 'attenuated' || p.get('sm') === 'screen' || p.get('sm') === 'world')
    s.appearance.sizeMode = p.get('sm') as typeof s.appearance.sizeMode;
  if (p.has('op')) s.appearance.opacity = Number(p.get('op'));
  if (p.get('sh') === 'square') s.appearance.shape = 'square';
  if (p.get('bg') === 'light') s.appearance.background = 'light';
  if (p.has('hl')) {
    const h = p.get('hl')!;
    s.appearance.axes = h.includes('a');
    s.appearance.bbox = h.includes('b');
    s.appearance.grid = h.includes('g');
  }
  s.appearance.ortho = p.get('ortho') === '1';
  const cam = nums(p.get('cam'), 6);
  if (cam) {
    s.ui.camera = {
      ortho: s.appearance.ortho,
      position: [cam[0], cam[1], cam[2]],
      target: [cam[3], cam[4], cam[5]],
      zoom: Number(p.get('zoom')) || 1,
    };
  }
  if (p.get('sb') === '0') s.ui.sidebar = false;
  return { state: s, version };
}
