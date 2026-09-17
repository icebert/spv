/** The complete UI/view state of SPV, in slices. Everything here is serialisable. */
import type { ColormapName } from '../color/colormaps';
import type { ColumnRef } from '../h5ad/types';
import type { CameraState } from '../render/camera';
import type { SizeMode, SpriteShape } from '../render/points';
import type { LayoutMode } from '../render/sections';

export interface DatasetState {
  id: string | null;
  url: string | null;
  local: boolean;
  name: string;
}

export interface CoordsState {
  /** null = use the detected sources */
  x: ColumnRef | null;
  y: ColumnRef | null;
  z: ColumnRef | null;
  zNone: boolean;
  libraryKey: string | null;
  libraryNone: boolean;
  swapYZ: boolean;
  flipX: boolean;
  flipY: boolean;
  flipZ: boolean;
  zScale: number;
}

/** Manual per-section alignment in raw file units and degrees (nice-to-have §7.3-1). */
export interface AlignmentState {
  dx: number;
  dy: number;
  rot: number;
  fx: boolean;
  fy: boolean;
}

export interface LayoutState {
  mode: LayoutMode;
  spacing: number;
  uniformSpacing: boolean;
  gap: number;
  explode: number;
  current: number;
  hidden: number[];
  dimOthers: boolean;
  playing: boolean;
  playFps: number;
  /** ordinal → alignment */
  alignment: Record<number, AlignmentState>;
  crossfade: boolean;
}

export interface ImagesState {
  enabled: boolean;
  opacity: number;
  resolution: 'auto' | 'hires' | 'lowres';
  grayscale: boolean;
}

export type ColorSource = 'none' | 'obs' | 'gene';

export interface ColorState {
  source: ColorSource;
  key: string | null;
  matrix: string;
  log1p: boolean;
  colormap: ColormapName;
  reversed: boolean;
  rangeMode: 'percentile' | 'absolute';
  pLo: number;
  pHi: number;
  vmin: number | null;
  vmax: number | null;
  nanColor: string;
  hiddenCategories: number[];
  geneNameColumn: string | null;
  /** second gene for two-gene blending (source must be 'gene') */
  gene2: string | null;
  blendColors: [string, string];
}

export interface FilterState {
  /** raw-unit z range for native 3-D data (null = all) */
  zRange: [number, number] | null;
  /** fractions 0–1 of the native XY extent */
  clipX: [number, number];
  clipY: [number, number];
  inTissueOnly: boolean;
  subsample: number | null;
}

export interface AppearanceState {
  pointSize: number;
  sizeMode: SizeMode;
  trueSize: boolean;
  opacity: number;
  shape: SpriteShape;
  background: 'dark' | 'light';
  axes: boolean;
  bbox: boolean;
  grid: boolean;
  ortho: boolean;
  turntable: boolean;
}

export interface GraphState {
  enabled: boolean;
  /** obsp key, null = first *_connectivities */
  key: string | null;
  color: string;
  opacity: number;
  maxEdges: number;
}

export interface UiState {
  sidebar: boolean;
  tab: string;
  tooltipFields: string[];
  camera: CameraState | null;
}

export interface ViewerState extends Record<string, object> {
  dataset: DatasetState;
  coords: CoordsState;
  layout: LayoutState;
  images: ImagesState;
  color: ColorState;
  filter: FilterState;
  appearance: AppearanceState;
  graph: GraphState;
  ui: UiState;
}

export function defaultState(): ViewerState {
  return {
    dataset: { id: null, url: null, local: false, name: '' },
    coords: {
      x: null,
      y: null,
      z: null,
      zNone: false,
      libraryKey: null,
      libraryNone: false,
      swapYZ: false,
      flipX: false,
      flipY: false,
      flipZ: false,
      zScale: 1,
    },
    layout: {
      mode: 'stack',
      spacing: 0.15,
      uniformSpacing: false,
      gap: 0.05,
      explode: 1,
      current: 0,
      hidden: [],
      dimOthers: false,
      playing: false,
      playFps: 2,
      alignment: {},
      crossfade: true,
    },
    images: { enabled: true, opacity: 1, resolution: 'auto', grayscale: false },
    color: {
      source: 'none',
      key: null,
      matrix: 'X',
      log1p: false,
      colormap: 'viridis',
      reversed: false,
      rangeMode: 'percentile',
      pLo: 0,
      pHi: 99.5,
      vmin: null,
      vmax: null,
      nanColor: '#5b6470',
      hiddenCategories: [],
      geneNameColumn: null,
      gene2: null,
      blendColors: ['#ff00ff', '#00ff00'],
    },
    filter: { zRange: null, clipX: [0, 1], clipY: [0, 1], inTissueOnly: true, subsample: null },
    appearance: {
      pointSize: 3,
      sizeMode: 'screen',
      trueSize: false,
      opacity: 1,
      shape: 'round',
      background: 'dark',
      axes: true,
      bbox: false,
      grid: false,
      ortho: false,
      turntable: false,
    },
    graph: { enabled: false, key: null, color: '#9ca3af', opacity: 0.35, maxEdges: 1_000_000 },
    ui: { sidebar: true, tab: 'dataset', tooltipFields: [], camera: null },
  };
}
