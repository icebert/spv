/**
 * The application controller: owns the worker client, the viewer and the render objects, applies
 * store changes to the GPU side, and exposes actions for the UI (open datasets, colour, step
 * sections, pick, screenshot, share). Panels only talk to the store and to this class.
 */
import { versionLine } from './version';
import { csvCell } from './util/csv';
import { unsafeUrlReason } from './util/safeUrl';
import { manifestEntries, type ManifestEntry } from './state/manifest';
import { recentErrors, recordError } from './util/errorLog';
import type { ColormapName } from './color/colormaps';
import { paletteFor } from './color/palettes';
import { H5adClient } from './h5ad/client';
import { defaultColorColumn } from './h5ad/reader';
import type { OpenSource } from './h5ad/rpc';
import type {
  ColumnData,
  CoordinateSpec,
  GeneVector,
  MoranI,
  ProgressEvent,
  SectionInfo,
  SpatialData,
  Summary,
} from './h5ad/types';
import { EdgeCloud } from './render/edges';
import { ImagePlanes, IMAGE_TEXTURE_BUDGET } from './render/imagePlanes';
import { PointCloud } from './render/points';
import { Viewer, type ViewerGlOptions } from './render/scene';
import {
  DEFAULT_LAYOUT,
  SectionTable,
  defaultSpacing,
  sectionGeoms,
  toDisplay,
  type DisplayFrame,
  type LayoutParams,
  type LayoutResult,
  type SectionAlignment,
  type SectionGeom,
} from './render/sections';
import { Matrix4 } from 'three';
import { Store } from './state/store';
import { parseState, serializeState } from './state/urlState';
import { defaultState, type ViewerState } from './state/viewerState';

export interface LegendModel {
  key: string;
  categories: string[];
  counts: number[];
  colors: string[];
  hidden: Set<number>;
  source: 'categorical' | 'string' | 'boolean';
}

export interface ColorbarModel {
  label: string;
  vmin: number;
  vmax: number;
  colormap: ColormapName;
  reversed: boolean;
  nanColor: string;
  quantiles: Float64Array | null;
  /** two-gene blend: second variable */
  blend: {
    nameA: string;
    colorA: string;
    nameB: string;
    colorB: string;
    vminB: number;
    vmaxB: number;
  } | null;
}

export interface TooltipInfo {
  id: number;
  index: string | null;
  section: string | null;
  colorLabel: string | null;
  colorValue: string | null;
  fields: [string, string][];
  x: number;
  y: number;
}

export interface ImageStatus {
  state: 'none' | 'queued' | 'loading' | 'loaded' | 'error' | 'unplaced';
  message?: string;
  width?: number;
  height?: number;
  key?: string;
}

export type AppEvent =
  | { type: 'status' }
  | { type: 'progress'; progress: ProgressEvent | null }
  | { type: 'dataset' }
  | { type: 'legend' }
  | { type: 'colorbar' }
  | { type: 'sections' }
  | { type: 'images'; ordinal: number | null }
  | { type: 'hover'; info: TooltipInfo | null }
  | { type: 'pin'; info: TooltipInfo | null }
  | { type: 'notice'; message: string; kind: 'error' | 'warn' | 'info' }
  | { type: 'counts' }
  | { type: 'selection' };

export type AppStatus = 'idle' | 'loading' | 'ready' | 'error';

const GENE_CACHE_SIZE = 20;
const DIM_ALPHA = 0.12;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function formatValue(v: number): string {
  if (!Number.isFinite(v)) return 'NA';
  if (Number.isInteger(v)) return v.toLocaleString('en-US');
  return Math.abs(v) >= 100 ? v.toFixed(1) : v.toPrecision(4);
}

/** 64-bin histogram of the finite values in [lo, hi]. */
export function histogramOf(
  values: ArrayLike<number>,
  lo: number,
  hi: number,
  nBins: number,
): { bins: Float64Array; lo: number; hi: number; max: number } {
  const bins = new Float64Array(nBins);
  if (!(hi > lo)) hi = lo + 1;
  const scale = nBins / (hi - lo);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    let b = Math.floor((v - lo) * scale);
    if (b < 0) b = 0;
    if (b >= nBins) b = nBins - 1;
    bins[b]++;
  }
  let max = 0;
  for (let i = 0; i < nBins; i++) if (bins[i] > max) max = bins[i];
  return { bins, lo, hi, max };
}

export class App {
  readonly store = new Store<ViewerState>(defaultState());
  readonly viewer: Viewer;
  client: H5adClient | null = null;
  summary: Summary | null = null;
  spatial: SpatialData | null = null;
  pc: PointCloud | null = null;
  table: SectionTable | null = null;
  geoms: SectionGeom[] = [];
  planes: ImagePlanes | null = null;
  layoutResult: LayoutResult | null = null;
  layoutParams: LayoutParams | null = null;
  varNames: string[] = [];
  /** Display names (duplicates suffixed) aligned with `varNames`. */
  varDisplay: string[] = [];
  legend: LegendModel | null = null;
  colorbar: ColorbarModel | null = null;
  manifest: ManifestEntry[] = [];
  currentEntry: ManifestEntry | null = null;
  status: AppStatus = 'idle';
  statusMessage = '';
  errorMessage: string | null = null;
  lastProgress: ProgressEvent | null = null;
  loadInfo: {
    loadMode: string;
    bytesTotal: number | null;
    timings: Record<string, number>;
    plugins: string[];
  } | null = null;
  imageStatus = new Map<number, ImageStatus>();
  hoverId = -1;
  pinnedId = -1;
  readonly base: string;
  private readonly geneCache = new Map<string, GeneVector>();
  private readonly columnCache = new Map<string, Promise<ColumnData>>();
  private readonly indexCache = new Map<number, string>();
  private readonly listeners = new Set<(e: AppEvent) => void>();
  private abort: AbortController | null = null;
  private colorToken = 0;
  private imageToken = 0;
  private openToken = 0;
  private playTimer = 0;
  private savedCamera: ReturnType<Viewer['rig']['getState']> | null = null;
  private prevPlanar = false;
  private applyingUrl = false;
  private urlHadFlip = false;
  private urlHadAlignment = false;
  private urlTimer = 0;
  private scalarValues: Float32Array | null = null;
  private scalarQuantiles: Float64Array | null = null;
  private scalarLabel = '';
  private scalarValues2: Float32Array | null = null;
  private scalarQuantiles2: Float64Array | null = null;
  histogram: { bins: Float64Array; lo: number; hi: number; max: number } | null = null;
  selection: Uint8Array | null = null;
  selectionCount = 0;
  private selectModeOn = false;
  private frame: DisplayFrame = { flipX: false, flipY: false, flipZ: false, swapYZ: false };
  edges: EdgeCloud | null = null;
  graphStatus: { key: string; nEdges: number; nTotal: number; subsampled: boolean } | null = null;
  private graphToken = 0;
  private currentCodes: Int32Array | null = null;
  private lastCurrent = -1;
  private lastMode: string | null = null;
  private fadeToken = 0;
  private moranPromise: Promise<MoranI | null> | null = null;

  constructor(viewport: HTMLElement, base: string, gl: ViewerGlOptions = {}) {
    this.base = base;
    this.viewer = new Viewer(viewport, gl);
    this.viewer.onContextLost = () =>
      this.notice(
        'The WebGL context was lost. The view recovers when the browser restores it; reload if it does not.',
        'warn',
      );
    this.viewer.rig.controls.addEventListener('end', () =>
      this.store.update('ui', { camera: this.viewer.rig.getState() }),
    );
    const s = this.store;
    s.on('layout', (v, prev) => {
      this.applyLayout(v.mode !== prev.mode);
      if (v.playing !== prev.playing || v.playFps !== prev.playFps) this.syncPlay();
    });
    s.on('appearance', () => this.applyAppearance());
    s.on('color', (v, prev) => {
      const sameData =
        v.source === prev.source &&
        v.key === prev.key &&
        v.matrix === prev.matrix &&
        v.log1p === prev.log1p &&
        v.gene2 === prev.gene2;
      const styleSame =
        v.colormap === prev.colormap &&
        v.reversed === prev.reversed &&
        v.rangeMode === prev.rangeMode &&
        v.pLo === prev.pLo &&
        v.pHi === prev.pHi &&
        v.vmin === prev.vmin &&
        v.vmax === prev.vmax &&
        v.nanColor === prev.nanColor &&
        v.blendColors === prev.blendColors;
      if (sameData && styleSame && v.hiddenCategories !== prev.hiddenCategories)
        this.applyCategoryMask();
      else if (sameData && v.geneNameColumn === prev.geneNameColumn) this.applyColorStyle();
      else if (!sameData) void this.applyColor();
      if (v.geneNameColumn !== prev.geneNameColumn) void this.loadVarNames();
    });
    s.on('filter', () => this.applyFilter());
    s.on('graph', () => void this.applyGraph());
    s.on('images', (v, prev) => {
      if (v.resolution !== prev.resolution) this.resetImages();
      this.applyImages();
    });
    s.on('coords', (v, prev) => {
      const frameOnly =
        v.x === prev.x &&
        v.y === prev.y &&
        v.z === prev.z &&
        v.zNone === prev.zNone &&
        v.libraryKey === prev.libraryKey &&
        v.libraryNone === prev.libraryNone;
      if (frameOnly) this.rebuildFrame();
      else void this.reloadSpatial();
    });
    s.onAny(() => this.scheduleUrlWrite());
    window.addEventListener('hashchange', () => this.onHashChange());
  }

  // --- events ------------------------------------------------------------------------------------
  on(listener: (e: AppEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: AppEvent): void {
    for (const l of this.listeners) l(e);
  }

  notice(message: string, kind: 'error' | 'warn' | 'info' = 'info'): void {
    if (kind === 'error') recordError('notice', message);
    this.emit({ type: 'notice', message, kind });
  }

  private setStatus(status: AppStatus, message = ''): void {
    this.status = status;
    this.statusMessage = message;
    this.emit({ type: 'status' });
  }

  // --- manifest + opening ------------------------------------------------------------------------
  async loadManifest(): Promise<ManifestEntry[]> {
    try {
      const res = await fetch(`${this.base}data/datasets.json`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { entries, skipped } = manifestEntries(await res.json());
      this.manifest = entries;
      if (skipped > 0)
        this.notice(
          `${skipped} ${skipped === 1 ? 'entry' : 'entries'} in data/datasets.json ${skipped === 1 ? 'lacks' : 'lack'} an id, name or url and ${skipped === 1 ? 'was' : 'were'} skipped.`,
          'warn',
        );
    } catch (err) {
      this.manifest = [];
      this.notice(
        `Could not load the dataset manifest (data/datasets.json): ${(err as Error).message}`,
        'warn',
      );
    }
    this.emit({ type: 'dataset' });
    return this.manifest;
  }

  /** Manifest URLs are relative to the site base; absolute URLs and root-absolute paths are kept. */
  resolveUrl(url: string): string {
    if (/^(https?:)?\/\//.test(url) || url.startsWith('/')) return url;
    return `${this.base}${url}`;
  }

  async openFromManifest(id: string): Promise<void> {
    const entry = this.manifest.find((d) => d.id === id);
    if (!entry) {
      this.notice(`Dataset "${id}" is not in the manifest.`, 'error');
      return;
    }
    this.store.update('dataset', { id, url: null, local: false, name: entry.name });
    await this.open({ kind: 'url', url: this.resolveUrl(entry.url), name: `${id}.h5ad` }, entry);
  }

  async openUrl(url: string): Promise<void> {
    // Checked on the raw input, before resolveUrl() could turn "javascript:…" into a site path.
    const reason = unsafeUrlReason(url);
    if (reason) {
      this.errorMessage = reason;
      this.setStatus('error', reason);
      this.notice(reason, 'error');
      return;
    }
    const entry = this.manifest.find((d) => this.resolveUrl(d.url) === url || d.url === url);
    this.store.update('dataset', {
      id: entry?.id ?? null,
      url: entry ? null : url,
      local: false,
      name: entry?.name ?? url.split('/').pop() ?? url,
    });
    await this.open({ kind: 'url', url: this.resolveUrl(url) }, entry ?? null);
  }

  async openFile(file: File): Promise<void> {
    this.store.update('dataset', { id: null, url: null, local: true, name: file.name });
    if (file.size > 1.5e9) {
      this.notice(
        `This file is ${(file.size / 1e9).toFixed(1)} GB. Browser tabs often cap near 2–4 GB; loading may fail.`,
        'warn',
      );
    } else if (file.size > 5e8) {
      this.notice(
        `Large file (${(file.size / 1e6).toFixed(0)} MB). It is read in place via the File API (not copied), but indexing the expression matrix can still need a few hundred MB.`,
        'info',
      );
    }
    await this.open({ kind: 'file', file }, null);
  }

  cancelLoad(): void {
    this.abort?.abort();
    this.openToken++;
    this.setStatus('idle', 'Cancelled');
    this.emit({ type: 'progress', progress: null });
  }

  /** Full teardown of the previous dataset: GPU buffers, textures, worker state, caches. */
  private teardown(): void {
    this.imageToken++;
    this.colorToken++;
    this.stopPlay();
    if (this.planes) {
      this.viewer.scene.remove(this.planes.group);
      this.planes.dispose();
      this.planes = null;
    }
    this.disposeEdges();
    this.graphToken++;
    this.fadeToken++;
    this.currentCodes = null;
    this.lastCurrent = -1;
    this.lastMode = null;
    this.moranPromise = null;
    this.viewer.setPointCloud(null);
    this.pc = null;
    this.table?.dispose();
    this.table = null;
    this.geoms = [];
    this.layoutResult = null;
    this.summary = null;
    this.spatial = null;
    this.legend = null;
    this.colorbar = null;
    this.scalarValues = null;
    this.scalarQuantiles = null;
    this.scalarValues2 = null;
    this.scalarQuantiles2 = null;
    this.histogram = null;
    this.selection = null;
    this.selectionCount = 0;
    this.emit({ type: 'selection' });
    this.geneCache.clear();
    this.columnCache.clear();
    this.indexCache.clear();
    this.imageStatus.clear();
    this.hoverId = -1;
    this.pinnedId = -1;
    this.varNames = [];
    this.varDisplay = [];
    this.emit({ type: 'hover', info: null });
    this.emit({ type: 'pin', info: null });
  }

  private async open(source: OpenSource, entry: ManifestEntry | null): Promise<void> {
    const token = ++this.openToken;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.teardown();
    this.currentEntry = entry;
    this.errorMessage = null;
    this.setStatus('loading', 'Opening dataset');
    const onProgress = (p: ProgressEvent) => {
      if (token !== this.openToken) return;
      this.lastProgress = p;
      this.emit({ type: 'progress', progress: p });
    };
    try {
      if (source.kind === 'url') {
        // #url= comes from whoever sent the link: only http(s) targets are fetched.
        const reason = unsafeUrlReason(source.url);
        if (reason) throw Object.assign(new Error(reason), { code: 'url' });
      }
      if (this.client?.dead) {
        // The worker crashed (uncaught error or WASM abort); only a fresh one can read again.
        this.client.terminate();
        this.client = null;
      }
      if (!this.client) {
        this.client = new H5adClient();
        this.client.onLog = (level, msg) => {
          if (level !== 'info') this.notice(msg, level);
        };
      } else {
        await this.client.call('close', null).catch(() => undefined);
      }
      const opened = await this.client.call('open', source, { onProgress, signal: abort.signal });
      if (token !== this.openToken) return;
      this.summary = opened.summary;
      this.loadInfo = {
        loadMode: opened.loadMode,
        bytesTotal: opened.bytesTotal,
        timings: opened.timings as unknown as Record<string, number>,
        plugins: opened.pluginsInstalled,
      };
      for (const f of opened.summary.flags) {
        if (/unsupported|could not|no available plugin|mismatch/i.test(f)) this.notice(f, 'warn');
      }
      // Frame defaults: Visium image space has y pointing down → flip Y when images exist.
      if (!this.applyingUrl || !this.urlHadFlip) {
        this.store.update('coords', {
          flipY: opened.summary.spatial.flipYDefault,
          flipX: false,
          flipZ: false,
          swapYZ: false,
        });
      }
      onProgress({ stage: 'coordinates', done: 0, total: 1, message: 'Reading coordinates' });
      await this.loadSpatial(token, abort.signal);
      if (token !== this.openToken) return;
      if (entry?.section_alignment && !(this.applyingUrl && this.urlHadAlignment))
        this.applyManifestAlignment(entry.section_alignment);
      await this.loadVarNames();
      if (token !== this.openToken) return;
      const c = this.store.slice('color');
      if (c.source === 'none' || !this.colorKeyExists(c)) {
        const wanted = entry?.default_color_by?.key;
        const def =
          wanted && this.summary.obs.columns.some((col) => col.name === wanted)
            ? wanted
            : defaultColorColumn(this.summary.obs, this.summary.library.column);
        this.store.update(
          'color',
          def ? { source: 'obs', key: def, hiddenCategories: [] } : { source: 'none', key: null },
        );
      } else {
        void this.applyColor();
      }
      if (this.store.slice('ui').tooltipFields.length === 0) {
        const candidates = entry?.default_tooltip_fields ?? [
          this.summary.library.column,
          defaultColorColumn(this.summary.obs, this.summary.library.column),
        ];
        const fields = candidates.filter(
          (f): f is string => Boolean(f) && this.summary!.obs.columns.some((col) => col.name === f),
        );
        this.store.update('ui', { tooltipFields: [...new Set(fields)].slice(0, 6) });
      }
      this.applyAppearance();
      this.applyFilter();
      this.applyImages();
      this.setStatus('ready');
      this.emit({ type: 'progress', progress: null });
      this.emit({ type: 'dataset' });
      this.emit({ type: 'counts' });
      const cam = this.store.slice('ui').camera;
      if (cam && this.applyingUrl) this.viewer.rig.setState(cam);
      this.viewer.requestRender();
    } catch (err) {
      if (token !== this.openToken) return;
      const e = err as Error & { code?: string | null };
      if (e.code === 'cancelled') {
        this.setStatus('idle', 'Cancelled');
        return;
      }
      this.errorMessage = this.describeError(e);
      if (e.code === 'worker' || /\bAborted\(|out of memory|RuntimeError/i.test(e.message)) {
        // The WASM runtime is not usable after an abort or trap; the next open gets a new worker.
        this.client?.terminate();
        this.client = null;
      }
      this.setStatus('error', this.errorMessage);
      this.notice(this.errorMessage, 'error');
      this.emit({ type: 'progress', progress: null });
      this.emit({ type: 'dataset' });
    } finally {
      this.applyingUrl = false;
    }
  }

  private colorKeyExists(c: ViewerState['color']): boolean {
    if (!this.summary || !c.key) return false;
    if (c.source === 'obs')
      return this.summary.obs.columns.some(
        (col) => col.name === c.key && col.kind !== 'unsupported',
      );
    if (c.source === 'gene')
      return this.varNames.includes(c.key) || this.varDisplay.includes(c.key);
    return false;
  }

  describeError(e: Error & { code?: string | null }): string {
    switch (e.code) {
      case 'not-hdf5':
        return `${e.message} SPV needs an AnnData .h5ad (HDF5) file.`;
      case 'not-anndata':
        return `${e.message} The file is HDF5 but does not follow the AnnData layout.`;
      case 'missing':
        return /CORS|reach|fetch/i.test(e.message)
          ? `${e.message} Remote hosts must send Access-Control-Allow-Origin (and ideally Accept-Ranges: bytes).`
          : e.message;
      case 'memory':
        return `${e.message} The file is too large for this browser tab; shrink it with scripts/prepare_h5ad.py (fewer cells/genes, --drop, --downscale-images).`;
      case 'shape-mismatch':
        return `${e.message} Choose different coordinate sources in the Coordinates panel.`;
      case 'worker':
        return `${e.message} The HDF5 worker crashed (out of memory?). Reload the page.`;
      default:
        return e.message;
    }
  }

  // --- coordinates / sections ----------------------------------------------------------------------
  private coordinateSpec(): CoordinateSpec | null {
    if (!this.summary) return null;
    const c = this.store.slice('coords');
    const refs = this.summary.spatial.refs;
    const x = c.x ?? refs?.x ?? null;
    const y = c.y ?? refs?.y ?? null;
    if (!x || !y) return null;
    const z = c.zNone ? null : (c.z ?? refs?.z ?? null);
    const libraryKey = c.libraryNone ? null : (c.libraryKey ?? this.summary.library.key);
    return { x, y, z, libraryKey };
  }

  get frameState(): DisplayFrame {
    return this.frame;
  }

  private async loadSpatial(token: number, signal?: AbortSignal): Promise<void> {
    if (!this.client || !this.summary) return;
    const coords = this.store.slice('coords');
    const useDefaults =
      !coords.x &&
      !coords.y &&
      !coords.z &&
      !coords.zNone &&
      !coords.libraryKey &&
      !coords.libraryNone;
    const spec = this.coordinateSpec();
    if (!spec && !this.summary.spatial.refs) {
      this.spatial = null;
      this.notice(
        'No spatial coordinates were detected in this file. Pick X/Y sources in the Coordinates panel.',
        'warn',
      );
      this.emit({ type: 'dataset' });
      return;
    }
    if (!spec) return;
    const spatial = await this.client.call('getSpatial', useDefaults ? null : spec, {
      signal,
      onProgress: (p) => this.emit({ type: 'progress', progress: p }),
    });
    if (token !== this.openToken) return;
    this.spatial = spatial;
    if (spatial.nDropped > 0)
      this.notice(
        `${spatial.nDropped.toLocaleString()} cells have NaN/inf coordinates and are hidden.`,
        'warn',
      );
    if (spatial.nWithoutSection > 0) {
      this.notice(
        `${spatial.nWithoutSection.toLocaleString()} cells have no section value; they are drawn without section transforms.`,
        'info',
      );
    }
    this.frame = {
      flipX: coords.flipX,
      flipY: coords.flipY,
      flipZ: coords.flipZ,
      swapYZ: coords.swapYZ,
    };
    this.buildRenderObjects();
  }

  private buildRenderObjects(): void {
    const spatial = this.spatial;
    if (!spatial) return;
    const layout = this.store.slice('layout');
    this.geoms = sectionGeoms(spatial.sections, spatial.center, spatial.scale, this.frame);
    this.table?.dispose();
    this.table = new SectionTable(this.geoms);
    if (!this.applyingUrl || layout.spacing === DEFAULT_LAYOUT.spacing) {
      this.store.update('layout', {
        spacing: Number(defaultSpacing(this.geoms).toFixed(4)),
        current: Math.min(layout.current, Math.max(0, spatial.sections.length - 1)),
      });
    }
    if (this.planes) {
      this.viewer.scene.remove(this.planes.group);
      this.planes.dispose();
    }
    this.planes = new ImagePlanes(spatial.center, spatial.scale, this.frame);
    this.planes.setAnisotropy(this.viewer.renderer.capabilities.getMaxAnisotropy());
    this.viewer.scene.add(this.planes.group);
    const pc = new PointCloud(
      { n: spatial.n, xyz: spatial.xyz, valid: spatial.valid, sectionOf: spatial.sectionOf },
      this.table,
    );
    pc.setFlip(this.frame.flipX, this.frame.flipY, this.frame.flipZ);
    pc.setSwapYZ(this.frame.swapYZ);
    this.viewer.setPointCloud(pc);
    this.pc = pc;
    this.prevPlanar = false;
    this.applyLayout(true);
    this.emit({ type: 'sections' });
    void this.applyGraph();
  }

  private async reloadSpatial(): Promise<void> {
    if (!this.client || !this.summary) return;
    const token = this.openToken;
    this.setStatus('loading', 'Reading coordinates');
    try {
      await this.loadSpatial(token);
      if (token !== this.openToken) return;
      await this.applyColor();
      this.applyAppearance();
      this.applyFilter();
      this.applyImages();
      this.setStatus('ready');
      this.emit({ type: 'dataset' });
    } catch (err) {
      this.setStatus('ready');
      this.notice(this.describeError(err as Error), 'error');
    }
  }

  /** Flips / swap changed: rebuild the display-frame geometry without re-reading data. */
  private rebuildFrame(): void {
    const c = this.store.slice('coords');
    this.frame = { flipX: c.flipX, flipY: c.flipY, flipZ: c.flipZ, swapYZ: c.swapYZ };
    if (!this.spatial || !this.pc || !this.table) return;
    this.geoms = sectionGeoms(
      this.spatial.sections,
      this.spatial.center,
      this.spatial.scale,
      this.frame,
    );
    this.table.dispose();
    this.table = new SectionTable(this.geoms);
    this.pc.uniforms.uSectionTex.value = this.table.texture;
    this.pc.setFlip(this.frame.flipX, this.frame.flipY, this.frame.flipZ);
    this.pc.setSwapYZ(this.frame.swapYZ);
    this.planes?.setFrame(this.spatial.center, this.spatial.scale, this.frame);
    this.resetImages();
    this.applyLayout(true);
    this.applyFilter();
    this.applyImages();
  }

  private buildLayoutParams(): LayoutParams {
    const l = this.store.slice('layout');
    const c = this.store.slice('coords');
    return {
      mode: l.mode,
      spacing: l.spacing,
      uniformSpacing: l.uniformSpacing,
      gap: l.gap,
      explode: l.explode,
      zScale: c.zScale,
      current: l.current,
      dimOthers: l.dimOthers && l.mode !== 'single',
      dimAlpha: DIM_ALPHA,
      hidden: new Set(l.hidden),
      alignment: this.alignmentMap(l.alignment),
    };
  }

  applyLayout(fit: boolean): void {
    if (!this.pc || !this.table) return;
    const params = this.buildLayoutParams();
    const res = this.table.apply(params);
    this.layoutResult = res;
    this.layoutParams = params;
    const zc = (res.bounds.min[2] + res.bounds.max[2]) / 2;
    this.pc.setNativeZ(res.nativeZ);
    this.pc.setZScale(params.zScale);
    this.pc.setExplode(params.explode, zc);
    this.pc.uniforms.uSectionTex.value = this.table.texture;
    this.pc.uniforms.uSectionCount.value = this.geoms.length;
    const rig = this.viewer.rig;
    if (res.planar && !this.prevPlanar) {
      this.savedCamera = rig.getState();
      rig.setOrthographic(true);
      fit = true;
    } else if (!res.planar && this.prevPlanar) {
      rig.setOrthographic(this.store.slice('appearance').ortho);
      if (this.savedCamera) {
        rig.setState({ ...this.savedCamera, ortho: this.store.slice('appearance').ortho });
        fit = false;
      } else fit = true;
    }
    this.prevPlanar = res.planar;
    this.viewer.setBounds(res.bounds, fit, res.planar ? 'top' : 'iso', res.planar);
    const l = this.store.slice('layout');
    if (
      l.mode === 'single' &&
      this.lastMode === 'single' &&
      l.crossfade &&
      this.lastCurrent >= 0 &&
      this.lastCurrent !== l.current &&
      !l.hidden.includes(this.lastCurrent)
    ) {
      this.startCrossfade(this.lastCurrent, l.current);
    } else {
      this.fadeToken++;
    }
    this.lastCurrent = l.current;
    this.lastMode = l.mode;
    this.updatePlanes();
    this.emit({ type: 'sections' });
    this.emit({ type: 'counts' });
  }

  private updatePlanes(): void {
    if (!this.planes || !this.layoutResult || !this.layoutParams) return;
    const im = this.store.slice('images');
    const zc = (this.layoutResult.bounds.min[2] + this.layoutResult.bounds.max[2]) / 2;
    this.planes.update(this.layoutResult, this.layoutParams, this.geoms, {
      visible: im.enabled,
      opacity: im.opacity,
      grayscale: im.grayscale,
      explodeCenter: zc,
      hiddenSections: this.layoutParams.hidden,
    });
    this.viewer.requestRender();
  }

  get sections(): SectionInfo[] {
    return this.spatial?.sections ?? [];
  }

  get currentSection(): SectionInfo | null {
    return this.sections[this.store.slice('layout').current] ?? null;
  }

  stepSection(delta: number): void {
    const n = this.sections.length;
    if (n === 0) return;
    const l = this.store.slice('layout');
    this.store.update('layout', {
      current: (l.current + delta + n) % n,
      dimOthers: l.mode === 'single' ? l.dimOthers : true,
    });
  }

  setCurrentSection(i: number): void {
    const l = this.store.slice('layout');
    this.store.update('layout', {
      current: i,
      dimOthers: l.mode === 'single' ? l.dimOthers : true,
    });
  }

  toggleSection(i: number, visible: boolean): void {
    const hidden = new Set(this.store.slice('layout').hidden);
    if (visible) hidden.delete(i);
    else hidden.add(i);
    this.store.update('layout', { hidden: [...hidden].sort((a, b) => a - b) });
  }

  soloSection(i: number): void {
    const hidden = this.sections.map((s) => s.ordinal).filter((o) => o !== i);
    this.store.update('layout', { hidden, current: i });
  }

  showAllSections(): void {
    this.store.update('layout', { hidden: [], dimOthers: false });
  }

  hideAllSections(): void {
    this.store.update('layout', { hidden: this.sections.map((s) => s.ordinal) });
  }

  private syncPlay(): void {
    const l = this.store.slice('layout');
    this.stopPlay();
    if (l.playing && this.sections.length > 1) {
      this.playTimer = window.setInterval(
        () => this.stepSection(1),
        1000 / Math.max(0.2, l.playFps),
      );
    }
  }

  private stopPlay(): void {
    if (this.playTimer) window.clearInterval(this.playTimer);
    this.playTimer = 0;
  }

  // --- appearance ---------------------------------------------------------------------------------
  applyAppearance(): void {
    const a = this.store.slice('appearance');
    document.documentElement.dataset.theme = a.background;
    this.viewer.setBackground(a.background === 'dark');
    this.viewer.setHelpers({ axes: a.axes, bbox: a.bbox, grid: a.grid });
    if (!this.layoutResult?.planar) this.viewer.rig.setOrthographic(a.ortho);
    this.viewer.rig.autoRotate = a.turntable;
    if (this.pc && this.spatial) {
      this.pc.setPointSize(a.pointSize);
      this.pc.setOpacity(a.opacity);
      this.pc.setShape(a.shape);
      this.pc.setHighlightColor(a.background === 'dark' ? '#ffffff' : '#111111');
      const spot = this.spotDiameterRaw();
      if (a.trueSize && spot) {
        this.pc.setSizeMode('world');
        this.pc.setWorldSize(spot * this.spatial.scale);
      } else {
        this.pc.setSizeMode(a.sizeMode === 'world' ? 'screen' : a.sizeMode);
      }
    }
    this.viewer.requestRender();
  }

  /** Median `spot_diameter_fullres` over sections that have one (raw units). */
  spotDiameterRaw(): number | null {
    const d = this.sections
      .map((s) => s.spotDiameter)
      .filter((v): v is number => v !== null && v > 0)
      .sort((a, b) => a - b);
    return d.length ? d[Math.floor(d.length / 2)] : null;
  }

  // --- colour -------------------------------------------------------------------------------------
  async column(name: string): Promise<ColumnData> {
    let p = this.columnCache.get(name);
    if (!p) {
      if (!this.client) throw new Error('no dataset');
      p = this.client.call('getObsColumn', name);
      this.columnCache.set(name, p);
      p.catch(() => this.columnCache.delete(name));
    }
    return p;
  }

  async gene(
    matrix: string,
    name: string,
    onProgress?: (p: ProgressEvent) => void,
  ): Promise<GeneVector> {
    const key = `${matrix}::${name}`;
    const cached = this.geneCache.get(key);
    if (cached) {
      this.geneCache.delete(key);
      this.geneCache.set(key, cached);
      return cached;
    }
    if (!this.client) throw new Error('no dataset');
    let index = this.varDisplay.indexOf(name);
    if (index < 0) index = this.varNames.indexOf(name);
    if (index < 0) throw new Error(`Gene "${name}" not found`);
    if (matrix === 'raw/X' && this.summary?.raw?.varNamesDiffer) {
      // raw has its own var: map by name
      const rawNames = await this.rawVarNames();
      const j = rawNames.indexOf(this.varNames[index]);
      if (j < 0) throw new Error(`Gene "${name}" is not in raw.var`);
      index = j;
    }
    const gv = await this.client.call('getGeneVector', { matrix, index }, { onProgress });
    this.geneCache.set(key, gv);
    while (this.geneCache.size > GENE_CACHE_SIZE)
      this.geneCache.delete(this.geneCache.keys().next().value!);
    return gv;
  }

  private rawNamesPromise: Promise<string[]> | null = null;

  private rawVarNames(): Promise<string[]> {
    if (!this.rawNamesPromise) {
      this.rawNamesPromise = this.client!.call('getVarNames', '__raw__').catch(() => this.varNames);
    }
    return this.rawNamesPromise;
  }

  async loadVarNames(): Promise<void> {
    if (!this.client || !this.summary) return;
    const col = this.store.slice('color').geneNameColumn;
    const names = await this.client.call(
      'getVarNames',
      col && this.summary.geneNameColumns.includes(col) ? col : null,
    );
    this.varNames = names;
    // Duplicate names get a suffix in the UI; the true column index is kept internally.
    const seen = new Map<string, number>();
    this.varDisplay = names.map((n) => {
      const k = seen.get(n) ?? 0;
      seen.set(n, k + 1);
      return k === 0 ? n : `${n} (${k + 1})`;
    });
    this.rawNamesPromise = null;
    this.emit({ type: 'dataset' });
  }

  /** Search var names: prefix matches first, then substring matches. */
  searchGenes(query: string, limit = 50): { index: number; name: string }[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const prefix: { index: number; name: string }[] = [];
    const contains: { index: number; name: string }[] = [];
    for (let i = 0; i < this.varDisplay.length && prefix.length < limit; i++) {
      const n = this.varDisplay[i];
      const l = n.toLowerCase();
      if (l.startsWith(q)) prefix.push({ index: i, name: n });
      else if (contains.length < limit && l.includes(q)) contains.push({ index: i, name: n });
    }
    return [...prefix, ...contains].slice(0, limit);
  }

  private async applyColor(): Promise<void> {
    const token = ++this.colorToken;
    const c = this.store.slice('color');
    const pc = this.pc;
    if (!pc || !this.summary) return;
    try {
      if (c.source !== 'obs' || !c.key) {
        this.currentCodes = null;
        this.edges?.setCodes(null);
      }
      if (c.source === 'none' || !c.key) {
        pc.setColorMode('uniform');
        this.legend = null;
        this.colorbar = null;
        this.scalarValues = null;
        this.scalarQuantiles = null;
        this.scalarValues2 = null;
        this.histogram = null;
      } else if (c.source === 'obs') {
        const col = await this.column(c.key);
        if (token !== this.colorToken) return;
        if (col.kind === 'categorical') {
          const fileColors = await this.client!.call('getCategoryColors', {
            column: c.key,
            n: col.categories.length,
          });
          if (token !== this.colorToken) return;
          const colors = paletteFor(col.categories.length, fileColors);
          const counts = new Array<number>(col.categories.length).fill(0);
          let na = 0;
          for (let i = 0; i < col.codes.length; i++) {
            const k = col.codes[i];
            if (k >= 0) counts[k]++;
            else na++;
          }
          const hidden = new Set(c.hiddenCategories.filter((i) => i < col.categories.length));
          this.legend = {
            key: c.key,
            categories: na ? [...col.categories, 'NA'] : col.categories,
            counts: na ? [...counts, na] : counts,
            colors: na ? [...colors, c.nanColor] : colors,
            hidden,
            source: col.source,
          };
          this.colorbar = null;
          this.scalarValues = null;
          this.scalarQuantiles = null;
          this.scalarValues2 = null;
          this.histogram = null;
          this.currentCodes = col.codes;
          this.edges?.setCodes(col.codes);
          pc.setCodes(col.codes);
          pc.setPalette(
            colors,
            colors.map((_, i) => (hidden.has(i) ? 0 : 1)),
          );
          pc.setNanColor(c.nanColor);
          pc.setColorMode('category');
        } else {
          this.legend = null;
          const values =
            col.values instanceof Float32Array
              ? col.values
              : Float32Array.from(col.values as ArrayLike<number>);
          this.setScalar(values, col.quantiles, c.key);
        }
      } else if (c.gene2) {
        const [ga, gb] = await Promise.all([
          this.gene(c.matrix, c.key, (p) => this.emit({ type: 'progress', progress: p })),
          this.gene(c.matrix, c.gene2),
        ]);
        if (token !== this.colorToken) return;
        this.emit({ type: 'progress', progress: null });
        this.legend = null;
        const tf = (v: Float32Array) =>
          c.log1p ? Float32Array.from(v, (x) => Math.log1p(Math.max(0, x))) : v;
        const tq = (q: Float64Array) =>
          c.log1p ? Float64Array.from(q, (x) => Math.log1p(Math.max(0, x))) : q;
        this.scalarValues = tf(ga.values);
        this.scalarQuantiles = tq(ga.quantiles);
        this.scalarValues2 = tf(gb.values);
        this.scalarQuantiles2 = tq(gb.quantiles);
        this.scalarLabel = `${c.key} + ${c.gene2}${c.log1p ? ' (log1p)' : ''}`;
        this.histogram = null;
        pc.setScalar(this.scalarValues);
        pc.setScalar2(this.scalarValues2);
        this.applyColorStyle();
      } else {
        const gv = await this.gene(c.matrix, c.key, (p) =>
          this.emit({ type: 'progress', progress: p }),
        );
        if (token !== this.colorToken) return;
        this.emit({ type: 'progress', progress: null });
        this.legend = null;
        let values = gv.values;
        let quantiles = gv.quantiles;
        if (c.log1p) {
          values = Float32Array.from(values, (v) => Math.log1p(Math.max(0, v)));
          quantiles = Float64Array.from(quantiles, (v) => Math.log1p(Math.max(0, v)));
        }
        const label = `${c.key}${c.log1p ? ' (log1p)' : ''}${c.matrix !== 'X' ? ` · ${c.matrix}` : ''}`;
        this.setScalar(values, quantiles, label);
      }
      this.emit({ type: 'legend' });
      this.emit({ type: 'colorbar' });
      this.viewer.requestRender();
    } catch (err) {
      if (token !== this.colorToken) return;
      this.emit({ type: 'progress', progress: null });
      this.notice(`Could not colour by ${c.key}: ${this.describeError(err as Error)}`, 'error');
    }
  }

  private setScalar(values: Float32Array, quantiles: Float64Array, label: string): void {
    this.scalarValues = values;
    this.scalarQuantiles = quantiles;
    this.scalarValues2 = null;
    this.scalarQuantiles2 = null;
    this.scalarLabel = label;
    this.histogram = histogramOf(values, quantiles[0], quantiles[1000], 64);
    this.pc?.setScalar(values);
    this.applyColorStyle();
  }

  /** Colormap / range / NaN colour: texture + uniform updates only. */
  private applyColorStyle(): void {
    const c = this.store.slice('color');
    const pc = this.pc;
    if (!pc) return;
    pc.setNanColor(c.nanColor);
    if (this.legend && this.legend.categories.at(-1) === 'NA') {
      this.legend.colors[this.legend.colors.length - 1] = c.nanColor;
      this.emit({ type: 'legend' });
    }
    if (!this.scalarValues || !this.scalarQuantiles) {
      this.viewer.requestRender();
      return;
    }
    const q = this.scalarQuantiles;
    const qAt = (p: number) => q[Math.max(0, Math.min(1000, Math.round(p * 10)))];
    let vmin: number;
    let vmax: number;
    if (c.rangeMode === 'absolute' && c.vmin !== null && c.vmax !== null) {
      vmin = c.vmin;
      vmax = c.vmax;
    } else {
      vmin = qAt(c.pLo);
      vmax = qAt(c.pHi);
    }
    if (!Number.isFinite(vmin) || !Number.isFinite(vmax)) {
      vmin = 0;
      vmax = 1;
    }
    let blend: ColorbarModel['blend'] = null;
    if (this.scalarValues2 && this.scalarQuantiles2 && c.gene2) {
      const q2 = this.scalarQuantiles2;
      const q2At = (p: number) => q2[Math.max(0, Math.min(1000, Math.round(p * 10)))];
      const vmin2 = c.rangeMode === 'absolute' && c.vmin !== null ? c.vmin : q2At(c.pLo);
      const vmax2 = c.rangeMode === 'absolute' && c.vmax !== null ? c.vmax : q2At(c.pHi);
      pc.setRange2(vmin2, vmax2);
      pc.setBlendColors(c.blendColors[0], c.blendColors[1]);
      blend = {
        nameA: c.key ?? '',
        colorA: c.blendColors[0],
        nameB: c.gene2,
        colorB: c.blendColors[1],
        vminB: vmin2,
        vmaxB: vmax2 > vmin2 ? vmax2 : vmin2,
      };
    }
    pc.setColormap(c.colormap, c.reversed);
    pc.setRange(vmin, vmax);
    pc.setColorMode(blend ? 'blend' : 'scalar');
    this.colorbar = {
      label: this.scalarLabel,
      vmin,
      vmax: vmax > vmin ? vmax : vmin,
      colormap: c.colormap,
      reversed: c.reversed,
      nanColor: c.nanColor,
      quantiles: q,
      blend,
    };
    this.emit({ type: 'colorbar' });
    this.viewer.requestRender();
  }

  private applyCategoryMask(): void {
    if (!this.pc || !this.legend) return;
    const c = this.store.slice('color');
    const n = this.legend.categories.length - (this.legend.categories.at(-1) === 'NA' ? 1 : 0);
    this.legend.hidden = new Set(c.hiddenCategories.filter((i) => i < n));
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = this.legend.hidden.has(i) ? 0 : 1;
    this.pc.setCategoryMask(mask);
    this.emit({ type: 'legend' });
    this.emit({ type: 'counts' });
    this.viewer.requestRender();
  }

  toggleCategory(i: number): void {
    const hidden = new Set(this.store.slice('color').hiddenCategories);
    if (hidden.has(i)) hidden.delete(i);
    else hidden.add(i);
    this.store.update('color', { hiddenCategories: [...hidden].sort((a, b) => a - b) });
  }

  soloCategory(i: number): void {
    const n = this.legend?.categories.length ?? 0;
    const hidden: number[] = [];
    for (let k = 0; k < n; k++) if (k !== i) hidden.push(k);
    this.store.update('color', { hiddenCategories: hidden });
  }

  setAllCategories(visible: boolean): void {
    const n = this.legend?.categories.length ?? 0;
    this.store.update('color', {
      hiddenCategories: visible ? [] : Array.from({ length: n }, (_, i) => i),
    });
  }

  invertCategories(): void {
    const n = this.legend?.categories.length ?? 0;
    const hidden = new Set(this.store.slice('color').hiddenCategories);
    const next: number[] = [];
    for (let k = 0; k < n; k++) if (!hidden.has(k)) next.push(k);
    this.store.update('color', { hiddenCategories: next });
  }

  colorByGene(name: string): void {
    this.store.update('color', { source: 'gene', key: name, hiddenCategories: [] });
  }

  colorByColumn(name: string): void {
    this.store.update('color', { source: 'obs', key: name, hiddenCategories: [] });
  }

  // --- filter -------------------------------------------------------------------------------------
  hasInTissue(): boolean {
    return Boolean(
      this.summary?.obs.columns.some((c) => c.name === 'in_tissue' && c.kind !== 'unsupported'),
    );
  }

  applyFilter(): void {
    const pc = this.pc;
    const sp = this.spatial;
    if (!pc || !sp) return;
    const f = this.store.slice('filter');
    void this.buildMask(f).then((mask) => {
      if (this.pc !== pc) return;
      pc.setUserMask(mask);
      this.edges?.setUserMask(mask);
      this.emit({ type: 'counts' });
      this.viewer.requestRender();
    });
    // clip planes in the display frame
    const lo = toDisplay(sp.rawMin, sp.center, sp.scale, this.frame);
    const hi = toDisplay(sp.rawMax, sp.center, sp.scale, this.frame);
    const min = [Math.min(lo[0], hi[0]), Math.min(lo[1], hi[1]), Math.min(lo[2], hi[2])];
    const max = [Math.max(lo[0], hi[0]), Math.max(lo[1], hi[1]), Math.max(lo[2], hi[2])];
    const cx = [min[0] + f.clipX[0] * (max[0] - min[0]), min[0] + f.clipX[1] * (max[0] - min[0])];
    const cy = [min[1] + f.clipY[0] * (max[1] - min[1]), min[1] + f.clipY[1] * (max[1] - min[1])];
    let cz: [number, number] = [-Infinity, Infinity];
    if (f.zRange && sp.ndim === 3) {
      const axis = this.frame.swapYZ ? 1 : 2;
      const a = toDisplay(
        [sp.center[0], sp.center[1], f.zRange[0]],
        sp.center,
        sp.scale,
        this.frame,
      )[axis];
      const b = toDisplay(
        [sp.center[0], sp.center[1], f.zRange[1]],
        sp.center,
        sp.scale,
        this.frame,
      )[axis];
      cz = [Math.min(a, b) - 1e-6, Math.max(a, b) + 1e-6];
    }
    pc.setClip(
      [f.clipX[0] > 0 ? cx[0] : -Infinity, f.clipY[0] > 0 ? cy[0] : -Infinity, cz[0]],
      [f.clipX[1] < 1 ? cx[1] : Infinity, f.clipY[1] < 1 ? cy[1] : Infinity, cz[1]],
    );
    this.viewer.requestRender();
  }

  private async buildMask(f: ViewerState['filter']): Promise<Uint8Array | null> {
    const n = this.spatial?.n ?? 0;
    let mask: Uint8Array | null = null;
    if (f.inTissueOnly && this.hasInTissue()) {
      const col = await this.column('in_tissue');
      mask = new Uint8Array(n);
      if (col.kind === 'numeric') {
        for (let i = 0; i < n; i++) mask[i] = col.values[i] === 1 ? 1 : 0;
      } else {
        const yes = new Set(
          col.categories
            .map((c, i) => [c.toLowerCase(), i] as const)
            .filter(([c]) => c === '1' || c === 'true')
            .map(([, i]) => i),
        );
        for (let i = 0; i < n; i++) mask[i] = yes.has(col.codes[i]) ? 1 : 0;
      }
    }
    if (f.subsample && f.subsample < n) {
      const rnd = mulberry32(12345);
      const keep = f.subsample / n;
      mask ??= new Uint8Array(n).fill(1);
      for (let i = 0; i < n; i++) if (mask[i] && rnd() > keep) mask[i] = 0;
    }
    return mask;
  }

  visibleCount(): number {
    return this.pc?.visibleCount ?? 0;
  }

  // --- images -------------------------------------------------------------------------------------
  private resetImages(): void {
    this.imageToken++;
    if (this.planes) for (const s of this.sections) this.planes.remove(s.ordinal);
    this.imageStatus.clear();
  }

  /** Which stored resolution to load, honouring the texture budget. */
  chooseResolution(section: SectionInfo): { key: string; scalef: number; maxSide: number } | null {
    const im = this.store.slice('images');
    const n = this.sections.length;
    const many = n > 8;
    const maxSide = many ? 1024 : 2048;
    const has = (k: string) => section.imageKeys.includes(k);
    const scalefFor = (k: string) =>
      k === 'lowres'
        ? section.lowresScalef
        : k === 'hires'
          ? section.hiresScalef
          : (section.hiresScalef ?? section.lowresScalef);
    let key: string | null;
    if (im.resolution === 'hires' && has('hires')) key = 'hires';
    else if (im.resolution === 'lowres' && has('lowres')) key = 'lowres';
    else {
      const shape = section.imageShapes['hires'] ?? [0, 0];
      const hiresBytes =
        Math.min(shape[0] ?? 0, maxSide) * Math.min(shape[1] ?? 0, maxSide) * 4 * n;
      if (has('lowres') && (many || hiresBytes > IMAGE_TEXTURE_BUDGET || !has('hires')))
        key = 'lowres';
      else if (has('hires')) key = 'hires';
      else key = section.imageKeys[0] ?? null;
    }
    if (!key) return null;
    const scalef = scalefFor(key);
    if (!scalef) return null;
    return { key, scalef, maxSide };
  }

  applyImages(): void {
    if (!this.planes || !this.spatial) return;
    const im = this.store.slice('images');
    this.updatePlanes();
    if (!im.enabled) return;
    const token = ++this.imageToken;
    const hidden = new Set(this.store.slice('layout').hidden);
    const queue = this.sections.filter(
      (s) =>
        s.hasImage &&
        !hidden.has(s.ordinal) &&
        !this.planes!.has(s.ordinal) &&
        this.imageStatus.get(s.ordinal)?.state !== 'error',
    );
    for (const s of queue) {
      if (!s.placementKnown) {
        this.imageStatus.set(s.ordinal, {
          state: 'unplaced',
          message: 'image present, placement unknown (no tissue_*_scalef)',
        });
      } else this.imageStatus.set(s.ordinal, { state: 'queued' });
    }
    this.emit({ type: 'images', ordinal: null });
    void this.loadImagesSequentially(
      queue.filter((s) => s.placementKnown),
      token,
    );
  }

  private async loadImagesSequentially(queue: SectionInfo[], token: number): Promise<void> {
    for (const s of queue) {
      if (token !== this.imageToken || !this.client || !this.planes) return;
      const choice = this.chooseResolution(s);
      if (!choice) {
        this.imageStatus.set(s.ordinal, { state: 'unplaced', message: 'no usable scale factor' });
        this.emit({ type: 'images', ordinal: s.ordinal });
        continue;
      }
      if (this.planes.totalBytes() > IMAGE_TEXTURE_BUDGET) {
        this.imageStatus.set(s.ordinal, {
          state: 'error',
          message: 'texture budget (256 MB) exhausted; switch to lowres',
        });
        this.emit({ type: 'images', ordinal: s.ordinal });
        continue;
      }
      this.imageStatus.set(s.ordinal, { state: 'loading', key: choice.key });
      this.emit({ type: 'images', ordinal: s.ordinal });
      try {
        const img = await this.client.call('getImage', {
          library: s.id,
          key: choice.key,
          maxSide: choice.maxSide,
        });
        if (token !== this.imageToken || !this.planes) return;
        this.planes.setImage(s, choice.key, img, choice.scalef);
        this.imageStatus.set(s.ordinal, {
          state: 'loaded',
          key: choice.key,
          width: img.width,
          height: img.height,
        });
        this.updatePlanes();
      } catch (err) {
        if (token !== this.imageToken) return;
        this.imageStatus.set(s.ordinal, { state: 'error', message: (err as Error).message });
        this.notice(
          `Image for ${s.name} could not be decoded (${(err as Error).message}); showing points only.`,
          'warn',
        );
      }
      this.emit({ type: 'images', ordinal: s.ordinal });
    }
  }

  // --- alignment / crossfade / graph / moranI (nice-to-haves) -------------------------------------------
  /** Raw-unit alignment state → unit-cube display-frame alignment for the section table. */
  private alignmentMap(al: ViewerState['layout']['alignment']): Map<number, SectionAlignment> {
    const m = new Map<number, SectionAlignment>();
    const scale = this.spatial?.scale ?? 1;
    const sx = this.frame.flipX ? -1 : 1;
    const sy = this.frame.flipY ? -1 : 1;
    const sz = this.frame.flipZ ? -1 : 1;
    for (const [k, a] of Object.entries(al)) {
      const dz = a.dz ?? 0;
      if (a.dx === 0 && a.dy === 0 && dz === 0 && a.rot === 0 && !a.fx && !a.fy) continue;
      m.set(Number(k), {
        dx: a.dx * scale * sx,
        dy: a.dy * scale * sy,
        dz: dz * scale * sz,
        rotation: (a.rot * Math.PI) / 180,
        flipX: a.fx,
        flipY: a.fy,
      });
    }
    return m;
  }

  setAlignment(ordinal: number, patch: Partial<ViewerState['layout']['alignment'][number]>): void {
    const cur = this.store.slice('layout').alignment;
    const prev = cur[ordinal] ?? { dx: 0, dy: 0, dz: 0, rot: 0, fx: false, fy: false };
    this.store.update('layout', { alignment: { ...cur, [ordinal]: { ...prev, ...patch } } });
  }

  /** Manifest default: section-name keyed alignment → ordinal keyed store state. */
  private applyManifestAlignment(byName: NonNullable<ManifestEntry['section_alignment']>): void {
    const alignment: ViewerState['layout']['alignment'] = {};
    for (const s of this.sections) {
      const a = byName[s.name];
      if (a)
        alignment[s.ordinal] = {
          dx: a.dx ?? 0,
          dy: a.dy ?? 0,
          dz: a.dz ?? 0,
          rot: a.rot ?? 0,
          fx: a.fx ?? false,
          fy: a.fy ?? false,
        };
    }
    if (Object.keys(alignment).length) this.store.update('layout', { alignment });
  }

  /** Section z as displayed: the file's z plus the manual z offset (raw units), or null for 2-D data. */
  sectionZ(ordinal: number): number | null {
    const s = this.sections[ordinal];
    if (!s || s.z === null) return null;
    return s.z + (this.store.slice('layout').alignment[ordinal]?.dz ?? 0);
  }

  resetAlignment(ordinal?: number): void {
    if (ordinal === undefined) {
      this.store.update('layout', { alignment: {} });
      return;
    }
    const next = { ...this.store.slice('layout').alignment };
    delete next[ordinal];
    this.store.update('layout', { alignment: next });
  }

  /** Short opacity blend between consecutive sections in Single mode (flip-book feel). */
  private startCrossfade(from: number, to: number, ms = 220): void {
    const token = ++this.fadeToken;
    const table = this.table;
    if (!table) return;
    const t0 = performance.now();
    const tick = () => {
      if (token !== this.fadeToken || this.table !== table) return;
      const t = Math.min(1, (performance.now() - t0) / ms);
      const e = t * t * (3 - 2 * t);
      table.setAlpha(from, 1 - e);
      table.setAlpha(to, e);
      this.updatePlanes();
      this.viewer.requestRender();
      if (t < 1) requestAnimationFrame(tick);
    };
    tick();
  }

  private disposeEdges(): void {
    if (!this.edges) return;
    this.viewer.scene.remove(this.edges.object);
    this.edges.dispose();
    this.edges = null;
    this.graphStatus = null;
  }

  graphKeys(): string[] {
    return Object.entries(this.summary?.obsp ?? {})
      .filter(([k, m]) => m && k.endsWith('_connectivities'))
      .map(([k]) => k);
  }

  async applyGraph(): Promise<void> {
    const g = this.store.slice('graph');
    const token = ++this.graphToken;
    if (!g.enabled || !this.pc || !this.spatial || !this.client) {
      this.disposeEdges();
      this.emit({ type: 'sections' });
      return;
    }
    const keys = this.graphKeys();
    const key = g.key && keys.includes(g.key) ? g.key : keys[0];
    if (!key) {
      this.disposeEdges();
      this.notice('This file has no obsp/*_connectivities graph.', 'info');
      return;
    }
    if (
      this.edges &&
      this.graphStatus?.key === key &&
      this.graphStatus.nEdges === Math.min(this.graphStatus.nTotal, g.maxEdges)
    ) {
      this.edges.setStyle(g.color, g.opacity);
      this.viewer.requestRender();
      return;
    }
    try {
      const res = await this.client.call(
        'getGraphEdges',
        { key, maxEdges: g.maxEdges },
        { onProgress: (p) => this.emit({ type: 'progress', progress: p }) },
      );
      this.emit({ type: 'progress', progress: null });
      if (token !== this.graphToken || !this.pc || !this.spatial) return;
      if (!this.edges) {
        this.edges = new EdgeCloud(this.pc.uniforms);
        this.viewer.scene.add(this.edges.object);
      }
      this.edges.setEdges(
        res.pairs,
        res.nEdges,
        this.spatial.xyz,
        this.spatial.sectionOf,
        this.spatial.valid,
      );
      this.edges.setCodes(this.currentCodes);
      this.edges.setUserMask(this.pc.getUserMask());
      this.edges.setStyle(g.color, g.opacity);
      this.graphStatus = {
        key,
        nEdges: res.nEdges,
        nTotal: res.nTotal,
        subsampled: res.subsampled,
      };
      this.viewer.requestRender();
      this.emit({ type: 'sections' });
    } catch (err) {
      if (token !== this.graphToken) return;
      this.emit({ type: 'progress', progress: null });
      this.notice(`Could not load the spatial graph: ${this.describeError(err as Error)}`, 'error');
    }
  }

  /** `uns/moranI` sorted by I (descending), or null. Cached per dataset. */
  moranI(): Promise<{ name: string; I: number }[] | null> {
    if (!this.client || !this.summary?.uns.moranI) return Promise.resolve(null);
    this.moranPromise ??= this.client.call('getMoranI', null);
    return this.moranPromise.then((m) => {
      if (!m) return null;
      const names = new Set(this.varDisplay);
      return m.genes
        .map((name, i) => ({ name, I: m.I[i] }))
        .filter((g) => Number.isFinite(g.I) && names.has(g.name))
        .sort((a, b) => b.I - a.I);
    });
  }

  blendWithGene(name: string | null): void {
    this.store.update('color', { gene2: name });
  }

  // --- selection (lasso / box) -------------------------------------------------------------------------
  get selectMode(): boolean {
    return this.selectModeOn;
  }

  setSelectMode(on: boolean): void {
    this.selectModeOn = on;
    this.viewer.rig.controls.enabled = !on;
    this.viewer.renderer.domElement.style.cursor = on ? 'crosshair' : '';
    this.emit({ type: 'selection' });
  }

  /** Clip box in display coordinates (same as applyFilter, z ignored). */
  private clipBox(): { min: number[]; max: number[] } {
    const sp = this.spatial!;
    const f = this.store.slice('filter');
    const lo = toDisplay(sp.rawMin, sp.center, sp.scale, this.frame);
    const hi = toDisplay(sp.rawMax, sp.center, sp.scale, this.frame);
    const min = [Math.min(lo[0], hi[0]), Math.min(lo[1], hi[1])];
    const max = [Math.max(lo[0], hi[0]), Math.max(lo[1], hi[1])];
    const cx = [min[0] + f.clipX[0] * (max[0] - min[0]), min[0] + f.clipX[1] * (max[0] - min[0])];
    const cy = [min[1] + f.clipY[0] * (max[1] - min[1]), min[1] + f.clipY[1] * (max[1] - min[1])];
    return {
      min: [f.clipX[0] > 0 ? cx[0] : -Infinity, f.clipY[0] > 0 ? cy[0] : -Infinity],
      max: [f.clipX[1] < 1 ? cx[1] : Infinity, f.clipY[1] < 1 ? cy[1] : Infinity],
    };
  }

  /**
   * Screen-space (CSS px) positions of every currently visible point, computed with the same
   * math as the vertex shader; hidden points get NaN.
   */
  projectPoints(): Float32Array {
    const sp = this.spatial;
    const res = this.layoutResult;
    const params = this.layoutParams;
    const pc = this.pc;
    const n = sp?.n ?? 0;
    const out = new Float32Array(n * 2).fill(NaN);
    if (!sp || !res || !params || !pc) return out;
    const mask = pc.getUserMask();
    const hiddenCats =
      this.legend && this.store.slice('color').source === 'obs' ? this.legend.hidden : null;
    const codes = hiddenCats && hiddenCats.size ? this.currentCodes : null;
    const clip = this.clipBox();
    const zc = (res.bounds.min[2] + res.bounds.max[2]) / 2;
    const cam = this.viewer.rig.camera;
    cam.updateMatrixWorld();
    const e = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
    const { width, height } = this.viewer.getSize();
    const fx = this.frame.flipX ? -1 : 1;
    const fy = this.frame.flipY ? -1 : 1;
    const fz = this.frame.flipZ ? -1 : 1;
    const xyz = sp.xyz;
    for (let i = 0; i < n; i++) {
      if (!sp.valid[i] || (mask && !mask[i])) continue;
      if (codes && hiddenCats!.has(codes[i])) continue;
      let x = xyz[i * 3] * fx;
      let y = xyz[i * 3 + 1] * fy;
      let z = xyz[i * 3 + 2] * fz;
      if (this.frame.swapYZ) [y, z] = [z, y];
      if (x < clip.min[0] || x > clip.max[0] || y < clip.min[1] || y > clip.max[1]) continue;
      const sec = sp.sectionOf ? sp.sectionOf[i] : 0xffff;
      if (sec !== 0xffff && res.offsets[sec]) {
        const o = res.offsets[sec];
        if (o.alpha <= 0) continue;
        const g = this.geoms[sec];
        const a = params.alignment.get(sec);
        let rx = (x - g.center[0]) * (a?.flipX ? -1 : 1);
        let ry = (y - g.center[1]) * (a?.flipY ? -1 : 1);
        if (a && a.rotation) {
          const cs = Math.cos(a.rotation);
          const sn = Math.sin(a.rotation);
          [rx, ry] = [rx * cs - ry * sn, rx * sn + ry * cs];
        }
        x = rx + g.center[0] + o.dx;
        y = ry + g.center[1] + o.dy;
        z = z * res.nativeZ * params.zScale + o.dz;
      } else {
        z = z * params.zScale;
      }
      z = zc + (z - zc) * params.explode;
      const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (cw <= 0) continue;
      const ndcX = (e[0] * x + e[4] * y + e[8] * z + e[12]) / cw;
      const ndcY = (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw;
      out[i * 2] = ((ndcX + 1) / 2) * width;
      out[i * 2 + 1] = ((1 - ndcY) / 2) * height;
    }
    return out;
  }

  /** Select the visible points inside a screen-space polygon (CSS px). Returns the count. */
  selectByPolygon(poly: [number, number][]): number {
    if (!this.pc || !this.spatial) return 0;
    const pts = this.projectPoints();
    const n = this.spatial.n;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of poly) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const sel = new Uint8Array(n);
    let count = 0;
    const m = poly.length;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2];
      const y = pts[i * 2 + 1];
      if (!(x >= minX && x <= maxX && y >= minY && y <= maxY)) continue;
      let inside = false;
      for (let a = 0, b = m - 1; a < m; b = a++) {
        const [xa, ya] = poly[a];
        const [xb, yb] = poly[b];
        if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside;
      }
      if (inside) {
        sel[i] = 1;
        count++;
      }
    }
    this.selection = count ? sel : null;
    this.selectionCount = count;
    this.pc.setSelection(this.selection);
    this.viewer.requestRender();
    this.emit({ type: 'selection' });
    return count;
  }

  clearSelection(): void {
    if (!this.selection && !this.selectionCount) return;
    this.selection = null;
    this.selectionCount = 0;
    this.pc?.setSelection(null);
    this.viewer.requestRender();
    this.emit({ type: 'selection' });
  }

  /** Download the selected cells as CSV/TSV: index, row, section, tooltip fields and colour values. */
  async exportSelection(format: 'csv' | 'tsv'): Promise<void> {
    if (!this.selection || !this.client || !this.spatial) return;
    const rows: number[] = [];
    for (let i = 0; i < this.selection.length; i++) if (this.selection[i]) rows.push(i);
    const names = await this.client.call('getObsIndex', rows);
    const fields = this.store.slice('ui').tooltipFields;
    const cols: ColumnData[] = [];
    for (const f of fields) {
      try {
        cols.push(await this.column(f));
      } catch {
        /* skip unsupported columns */
      }
    }
    const c = this.store.slice('color');
    const geneCols =
      c.source === 'gene' && c.key && this.scalarValues
        ? [c.key, ...(c.gene2 && this.scalarValues2 ? [c.gene2] : [])]
        : [];
    const sep = format === 'csv' ? ',' : '\t';
    const quote = (v: string) => csvCell(v, sep);
    const lines = [
      ['cell_index', 'row', 'section', ...cols.map((col) => col.name), ...geneCols].join(sep),
    ];
    const sp = this.spatial;
    for (let k = 0; k < rows.length; k++) {
      const i = rows[k];
      const sec =
        sp.sectionOf && sp.sectionOf[i] !== 0xffff
          ? (sp.sections[sp.sectionOf[i]]?.name ?? '')
          : '';
      const vals = [quote(names[k] ?? String(i)), String(i), quote(sec)];
      for (const col of cols) {
        vals.push(
          col.kind === 'categorical'
            ? quote(col.codes[i] >= 0 ? col.categories[col.codes[i]] : 'NA')
            : String(col.values[i]),
        );
      }
      if (geneCols.length && this.scalarValues) {
        vals.push(String(this.scalarValues[i]));
        if (geneCols.length > 1 && this.scalarValues2) vals.push(String(this.scalarValues2[i]));
      }
      lines.push(vals.join(sep));
    }
    const blob = new Blob([lines.join('\n') + '\n'], {
      type: format === 'csv' ? 'text/csv' : 'text/tab-separated-values',
    });
    const d = this.store.slice('dataset');
    const name = (d.id ?? d.name ?? 'dataset')
      .replace(/\.h5ad$/i, '')
      .replace(/[^A-Za-z0-9_-]+/g, '-');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `spv-${name}-selection.${format}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // --- picking / tooltip ------------------------------------------------------------------------------
  async hover(x: number, y: number, clientX: number, clientY: number): Promise<void> {
    if (!this.pc || this.status !== 'ready') return;
    const id = await this.viewer.pick(x, y);
    if (id === -2) return; // picker busy; the next move retries
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.pc.setHover(id >= 0 ? id : null);
    this.viewer.requestRender();
    if (id < 0) {
      this.emit({ type: 'hover', info: null });
      return;
    }
    const info = await this.tooltipInfo(id, clientX, clientY);
    if (this.hoverId === id) this.emit({ type: 'hover', info });
  }

  clearHover(): void {
    if (this.hoverId === -1) return;
    this.hoverId = -1;
    this.pc?.setHover(null);
    this.viewer.requestRender();
    this.emit({ type: 'hover', info: null });
  }

  async pin(x: number, y: number, clientX: number, clientY: number): Promise<void> {
    if (!this.pc || this.status !== 'ready') return;
    const id = await this.viewer.pick(x, y);
    if (id < 0) {
      this.clearPin();
      return;
    }
    this.pinnedId = id;
    this.pc.setHighlight(id);
    this.viewer.requestRender();
    this.emit({ type: 'pin', info: await this.tooltipInfo(id, clientX, clientY) });
  }

  clearPin(): void {
    if (this.pinnedId === -1) return;
    this.pinnedId = -1;
    this.pc?.setHighlight(null);
    this.viewer.requestRender();
    this.emit({ type: 'pin', info: null });
  }

  async tooltipInfo(id: number, x: number, y: number): Promise<TooltipInfo> {
    const sp = this.spatial;
    const c = this.store.slice('color');
    let index: string | null = this.indexCache.get(id) ?? null;
    if (index === null && this.client) {
      try {
        index = (await this.client.call('getObsIndex', [id]))[0] ?? null;
        if (index !== null) this.indexCache.set(id, index);
      } catch {
        index = null;
      }
    }
    const secOrd = sp?.sectionOf ? sp.sectionOf[id] : 0xffff;
    const section = secOrd !== 0xffff && sp ? (sp.sections[secOrd]?.name ?? null) : null;
    let colorLabel: string | null = null;
    let colorValue: string | null = null;
    if (c.source !== 'none' && c.key) {
      colorLabel = c.key;
      if (this.legend && c.source === 'obs') {
        const col = await this.column(c.key);
        if (col.kind === 'categorical') {
          const k = col.codes[id];
          colorValue = k >= 0 ? col.categories[k] : 'NA';
        }
      } else if (this.scalarValues) {
        colorValue = this.scalarValues2
          ? `${formatValue(this.scalarValues[id])} / ${formatValue(this.scalarValues2[id])}`
          : formatValue(this.scalarValues[id]);
      }
    }
    const fields: [string, string][] = [];
    const libraryColumn = this.summary?.library.column ?? null;
    for (const f of this.store.slice('ui').tooltipFields) {
      // the colour value and the section name already have their own rows
      if (f === colorLabel || (f === libraryColumn && section !== null)) continue;
      try {
        const col = await this.column(f);
        if (col.kind === 'categorical') {
          const k = col.codes[id];
          fields.push([f, k >= 0 ? col.categories[k] : 'NA']);
        } else fields.push([f, formatValue(col.values[id])]);
      } catch {
        /* unsupported column */
      }
    }
    return { id, index, section, colorLabel, colorValue, fields, x, y };
  }

  /** Diagnostic (key D): which sections the GPU rasterised for the current view vs. what the table says. */
  /**
   * Diagnostic report (D key). Every line answers a different question: what the GPU actually
   * drew (pixel census, offscreen and on the real canvas), where it drew it versus where the CPU
   * projects the visible cells, how many draw calls and vertices a frame takes, which context
   * attributes the browser granted, and whether the coordinate buffer matches the file.
   */
  drawnSectionsReport(): string {
    const sp = this.spatial;
    const table = this.table;
    if (!sp || !table) return `No dataset loaded. ${versionLine()}; ${navigator.userAgent}`;
    const viewer = this.viewer;
    const gl = viewer.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));
    const attrs = viewer.contextAttributes();
    const attrText = attrs
      ? `antialias ${attrs.antialias}, alpha ${attrs.alpha}, preserveDrawingBuffer ${attrs.preserveDrawingBuffer}`
      : 'unknown';
    const stats = viewer.frameStats();
    const sectionName = (ord: number) =>
      ord === 0xffff ? 'no section' : (sp.sections[ord]?.name ?? `ordinal ${ord}`);
    const tally = (ids: Int32Array): string => {
      const per = new Map<number, number>();
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (id < 0) continue;
        const ord = sp.sectionOf ? sp.sectionOf[id] : 0xffff;
        per.set(ord, (per.get(ord) ?? 0) + 1);
      }
      return (
        [...per.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([ord, px]) => `${sectionName(ord)} (${px.toLocaleString()} px)`)
          .join(', ') || 'nothing'
      );
    };
    const off = viewer.censusIds('offscreen');
    const scr = viewer.censusIds('screen');
    // Footprint of everything drawn on the canvas, in CSS px (readPixels rows run bottom-up).
    let drawnBox = 'none';
    if (scr) {
      const dpr = viewer.renderer.getPixelRatio();
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let i = 0; i < scr.ids.length; i++) {
        if (scr.ids[i] < 0) continue;
        const col = i % scr.width;
        const row = (i - col) / scr.width;
        if (col < x0) x0 = col;
        if (col > x1) x1 = col;
        if (row < y0) y0 = row;
        if (row > y1) y1 = row;
      }
      if (x1 >= 0)
        drawnBox = `x ${Math.round(x0 / dpr)}–${Math.round(x1 / dpr)}, y ${Math.round((scr.height - 1 - y1) / dpr)}–${Math.round((scr.height - 1 - y0) / dpr)}`;
    }
    // The same footprint from the CPU: the projection the lasso selection uses, limited to the canvas.
    const pts = this.projectPoints();
    const { width, height } = viewer.getSize();
    let nVis = 0;
    let cx0 = Infinity;
    let cy0 = Infinity;
    let cx1 = -Infinity;
    let cy1 = -Infinity;
    for (let i = 0; i < sp.n; i++) {
      const x = pts[i * 2];
      const y = pts[i * 2 + 1];
      if (Number.isNaN(x) || x < 0 || y < 0 || x > width || y > height) continue;
      nVis++;
      if (x < cx0) cx0 = x;
      if (x > cx1) cx1 = x;
      if (y < cy0) cy0 = y;
      if (y > cy1) cy1 = y;
    }
    const cpuBox = nVis
      ? `x ${Math.round(cx0)}–${Math.round(cx1)}, y ${Math.round(cy0)}–${Math.round(cy1)}`
      : 'none';
    const expected = table.geoms.filter((_g, i) => table.data[i * 4 + 3] > 0).map((g) => g.name);
    // Buffer integrity: every cell of a visible single-z section must sit at that section's file
    // z. A split (e.g. 2,630 of 5,412 cells at another z) means the coordinate array was read
    // from the wrong bytes, not that the data has two slices.
    const zCheck: string[] = [];
    if (sp.sectionOf && sp.ndim === 3) {
      const tol = Math.max(1e-6, (sp.rawMax[2] - sp.rawMin[2]) * 1e-4);
      for (let ord = 0; ord < sp.sections.length; ord++) {
        const sec = sp.sections[ord];
        if (!(table.data[ord * 4 + 3] > 0) || sec.z === null || sec.z === undefined) continue;
        let total = 0;
        let offCount = 0;
        let example = NaN;
        for (let i = 0; i < sp.n; i++) {
          if (sp.sectionOf[i] !== ord || !sp.valid[i]) continue;
          total++;
          const z = sp.xyz[i * 3 + 2] / sp.scale + sp.center[2];
          if (Math.abs(z - sec.z) > tol) {
            offCount++;
            if (Number.isNaN(example)) example = z;
          }
        }
        zCheck.push(
          offCount
            ? `${sec.name}: ${offCount.toLocaleString()} of ${total.toLocaleString()} cells are NOT at z ${formatValue(sec.z)} (e.g. ${formatValue(example)}) — corrupt coordinate buffer`
            : `${sec.name}: ${total.toLocaleString()} cells all at z ${formatValue(sec.z)}`,
        );
      }
    }
    // Per-cell comparison: where the GPU drew each cell vs where the CPU projects it, at CSS
    // resolution in an exact (non-antialiased) offscreen render; then again after re-uploading
    // every vertex attribute from the CPU arrays.
    const before = this.displacementReport(width, height);
    this.pc?.reupload();
    viewer.render();
    const after = this.displacementReport(width, height);
    const flags = new URLSearchParams(location.search).get('gl') || 'none';
    const errs = recentErrors();
    return [
      `SPV diagnostic ${new Date().toISOString()}; ${versionLine()}; ${navigator.userAgent}`,
      `Renderer ${renderer}; DPR ${window.devicePixelRatio}; canvas ${width}×${height} CSS px; context: ${attrText}; gl flags: ${flags}; loaded ${this.loadInfo?.loadMode ?? 'n/a'}; layout ${this.store.slice('layout').mode}`,
      `Frame: ${stats.calls} draw calls, ${stats.points.toLocaleString()} point vertices, ${stats.lines} line segments, ${stats.triangles} triangles`,
      `Drawn: ${off ? tally(off.ids) : 'n/a'} [offscreen census]`,
      `Drawn on screen: ${scr ? tally(scr.ids) : 'n/a'}; footprint ${drawnBox}${attrs?.antialias ? ' (with antialiasing, edge pixels blend into neighbouring ids: small counts of other sections are expected)' : ''}`,
      `Expected footprint from the CPU projection of ${nVis.toLocaleString()} visible cells: ${cpuBox}`,
      `Visible per section table: ${expected.join(', ') || 'none'}`,
      zCheck.length ? `Buffer check — ${zCheck.join('; ')}` : '',
      `Displaced cells ${before}`,
      `After re-uploading all vertex attributes: displaced cells ${after}`,
      errs.length
        ? `Recent errors (${errs.length}): ${errs
            .slice(-5)
            .map((x) => `${x.at} [${x.source}] ${x.message}`)
            .join(' | ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * Render the ids at CSS resolution offscreen, take each drawn cell's pixel centroid and compare
   * it with the CPU projection of the same cell. Reports cells drawn although the CPU hides them
   * and cells drawn far from where the CPU puts them (with their id range, so a pattern such as
   * "every row after 65,536" or "rows after a chunk boundary" is visible).
   */
  private displacementReport(width: number, height: number): string {
    const sp = this.spatial;
    const census = this.viewer.censusIds('offscreen', Math.max(1, width), Math.max(1, height));
    if (!sp || !census) return 'n/a';
    const { ids, width: w, height: h } = census;
    const pts = this.projectPoints();
    const sum = new Map<number, [number, number, number]>();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (id < 0) continue;
      const col = i % w;
      const row = (i - col) / w;
      let a = sum.get(id);
      if (!a) {
        a = [0, 0, 0];
        sum.set(id, a);
      }
      a[0] += col + 0.5;
      a[1] += h - 1 - row + 0.5;
      a[2]++;
    }
    let hiddenDrawn = 0;
    let displaced = 0;
    let minId = Infinity;
    let maxId = -1;
    let sumDist = 0;
    const bySection = new Map<number, number>();
    const examples: string[] = [];
    for (const [id, [sx, sy, n]] of sum) {
      const cx = pts[id * 2];
      const cy = pts[id * 2 + 1];
      if (Number.isNaN(cx)) {
        hiddenDrawn++;
        continue;
      }
      const d = Math.hypot(sx / n - cx, sy / n - cy);
      if (d <= 24) continue;
      displaced++;
      sumDist += d;
      if (id < minId) minId = id;
      if (id > maxId) maxId = id;
      const ord = sp.sectionOf ? sp.sectionOf[id] : 0xffff;
      bySection.set(ord, (bySection.get(ord) ?? 0) + 1);
      if (examples.length < 3)
        examples.push(
          `#${id} drawn at (${Math.round(sx / n)}, ${Math.round(sy / n)}) vs CPU (${Math.round(cx)}, ${Math.round(cy)})`,
        );
    }
    const secName = (ord: number) =>
      ord === 0xffff ? 'no section' : (sp.sections[ord]?.name ?? `ordinal ${ord}`);
    const bySec = [...bySection.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([ord, c]) => `${secName(ord)} ${c.toLocaleString()}`)
      .join(', ');
    return (
      `(GPU centroid > 24 px from the CPU projection): ${displaced.toLocaleString()} of ${sum.size.toLocaleString()} drawn` +
      (displaced
        ? `; ids ${minId.toLocaleString()}–${maxId.toLocaleString()}; mean ${Math.round(sumDist / displaced)} px; by section: ${bySec}; e.g. ${examples.join('; ')}`
        : '') +
      `; drawn although the CPU hides them: ${hiddenDrawn.toLocaleString()}`
    );
  }

  // --- export / share -----------------------------------------------------------------------------------
  async screenshot(scale: 1 | 2, transparent: boolean): Promise<void> {
    const blob = await this.viewer.screenshot({ scale, transparent });
    const d = this.store.slice('dataset');
    const name = (d.id ?? d.name ?? 'dataset')
      .replace(/\.h5ad$/i, '')
      .replace(/[^A-Za-z0-9_-]+/g, '-');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `spv-${name}-${stamp}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  shareLink(): string {
    this.store.update('ui', { camera: this.viewer.rig.getState() });
    const hash = serializeState(this.store.get());
    return `${location.origin}${location.pathname}#${hash}`;
  }

  // --- URL state -----------------------------------------------------------------------------------------
  /** Parse the current hash into the store; returns the dataset selection it asked for. */
  applyUrlState(): { id: string | null; url: string | null; local: boolean } {
    const raw = location.hash.slice(1);
    if (!raw) return { id: null, url: null, local: false };
    const { state } = parseState(raw);
    this.applyingUrl = true;
    this.urlHadFlip = /(^|&)flip=/.test(raw);
    this.urlHadAlignment = /(^|&)al=/.test(raw);
    this.store.batch(() => {
      for (const key of Object.keys(state) as (keyof ViewerState)[])
        this.store.replace(key, state[key]);
    });
    return { id: state.dataset.id, url: state.dataset.url, local: state.dataset.local };
  }

  private scheduleUrlWrite(): void {
    if (this.applyingUrl) return;
    window.clearTimeout(this.urlTimer);
    this.urlTimer = window.setTimeout(() => {
      const hash = `#${serializeState(this.store.get())}`;
      if (location.hash !== hash) history.replaceState(null, '', hash);
    }, 300);
  }

  private onHashChange(): void {
    // Internal writes use replaceState (no event); this handles external navigation to another dataset.
    const { state } = parseState(location.hash.slice(1));
    const d = this.store.slice('dataset');
    if (state.dataset.id && state.dataset.id !== d.id) void this.openFromManifest(state.dataset.id);
    else if (state.dataset.url && state.dataset.url !== d.url) void this.openUrl(state.dataset.url);
  }

  dispose(): void {
    this.teardown();
    this.client?.terminate();
    this.client = null;
    this.viewer.dispose();
  }
}
