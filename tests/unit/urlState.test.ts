import { describe, expect, it } from 'vitest';
import {
  decodeIndexList,
  encodeIndexList,
  parseState,
  serializeState,
} from '../../src/state/urlState';
import { defaultState } from '../../src/state/viewerState';

describe('url state', () => {
  it('encodes index lists compactly and round-trips', () => {
    expect(encodeIndexList([0, 1, 2, 3, 7, 9, 10])).toBe('0-3,7,9,10');
    expect(encodeIndexList([5, 4, 4])).toBe('4,5');
    expect(decodeIndexList('0-3,7,9,10')).toEqual([0, 1, 2, 3, 7, 9, 10]);
    expect(decodeIndexList('')).toEqual([]);
    expect(decodeIndexList('x,3')).toEqual([3]);
  });

  it('writes only non-default values and is versioned', () => {
    const s = defaultState();
    s.dataset.id = 'demo';
    const hash = serializeState(s);
    expect(hash).toBe('v=1&dataset=demo');
  });

  it('round-trips a fully customised state', () => {
    const s = defaultState();
    s.dataset.url = 'https://example.org/a b.h5ad';
    s.coords.x = { path: 'obsm/spatial', column: 0 };
    s.coords.y = { path: 'obsm/spatial', column: 1 };
    s.coords.z = { path: 'obs/Bregma', column: null };
    s.coords.libraryKey = 'obs/slice';
    s.coords.flipY = true;
    s.coords.swapYZ = true;
    s.coords.zScale = 2.5;
    s.layout = {
      mode: 'tile',
      spacing: 0.2,
      uniformSpacing: true,
      gap: 0.1,
      explode: 1.5,
      current: 3,
      hidden: [1, 2, 3, 8],
      dimOthers: true,
      playing: false,
      playFps: 2,
      alignment: {
        0: { dx: 12.5, dy: -3, rot: 90, fx: true, fy: false },
        4: { dx: 0, dy: 1, rot: 0, fx: false, fy: true },
      },
      crossfade: false,
    };
    s.graph = {
      enabled: true,
      key: 'spatial_connectivities',
      color: '#ff00ff',
      opacity: 0.5,
      maxEdges: 20000,
    };
    s.images = { enabled: false, opacity: 0.5, resolution: 'lowres', grayscale: true };
    s.color = {
      ...s.color,
      source: 'gene',
      key: 'Itpr1',
      matrix: 'layers/counts',
      log1p: true,
      colormap: 'magma',
      reversed: true,
      rangeMode: 'absolute',
      vmin: 0.5,
      vmax: 3.25,
      nanColor: '#123456',
      hiddenCategories: [0, 4, 5, 6],
      geneNameColumn: 'gene_symbols',
      gene2: 'Pbx3',
      blendColors: ['#ff8800', '#0088ff'],
    };
    s.filter = {
      zRange: [320, 498],
      clipX: [0.1, 0.9],
      clipY: [0, 0.75],
      inTissueOnly: false,
      subsample: 50000,
    };
    s.appearance = {
      pointSize: 4.5,
      sizeMode: 'world',
      trueSize: true,
      opacity: 0.8,
      shape: 'square',
      background: 'light',
      axes: false,
      bbox: true,
      grid: true,
      ortho: true,
      turntable: false,
    };
    s.ui.camera = { ortho: true, position: [1, -2, 3], target: [0.1, 0.2, 0.3], zoom: 2 };
    s.ui.sidebar = false;
    const hash = serializeState(s);
    const { state: back, version } = parseState(`#${hash}`);
    expect(version).toBe(1);
    expect(back.dataset.url).toBe(s.dataset.url);
    expect(back.coords).toEqual(s.coords);
    expect(back.layout).toEqual(s.layout);
    expect(back.images).toEqual(s.images);
    expect(back.color).toEqual(s.color);
    expect(back.filter).toEqual(s.filter);
    expect(back.appearance).toEqual(s.appearance);
    expect(back.graph).toEqual(s.graph);
    expect(back.ui.camera).toEqual(s.ui.camera);
    expect(back.ui.sidebar).toBe(false);
    // serialising again is stable
    expect(serializeState(back)).toBe(hash);
  });

  it('percentile ranges round-trip and unknown keys are ignored', () => {
    const s = defaultState();
    s.color.pLo = 1;
    s.color.pHi = 98;
    const { state } = parseState(`${serializeState(s)}&bogus=1&lm=nonsense&cm=nope`);
    expect(state.color.pLo).toBe(1);
    expect(state.color.pHi).toBe(98);
    expect(state.layout.mode).toBe('stack');
    expect(state.color.colormap).toBe('viridis');
  });

  it('local files serialise view state only', () => {
    const s = defaultState();
    s.dataset.local = true;
    s.dataset.id = 'ignored';
    expect(serializeState(s)).toBe('v=1&local=1');
    expect(parseState('v=1&local=1').state.dataset.local).toBe(true);
  });
});
