/**
 * The application controller: owns the worker client, the viewer and the render objects, applies
 * store changes to the GPU side, and exposes actions for the UI (open datasets, colour, step
 * sections, pick, screenshot, share). Panels only talk to the store and to this class.
 */
import type { ColormapName } from './color/colormaps';
import { paletteFor } from './color/palettes';
import { H5adClient } from './h5ad/client';
import { defaultColorColumn } from './h5ad/reader';
import type { OpenSource } from './h5ad/rpc';
import type {
  ColumnData,
  CoordinateSpec,
  GeneVector,
  ProgressEvent,
  SectionInfo,
  SpatialData,
  Summary,
} from './h5ad/types';
import { ImagePlanes, IMAGE_TEXTURE_BUDGET } from './render/imagePlanes';
import { PointCloud } from './render/points';
import { Viewer } from './render/scene';
import {
  DEFAULT_LAYOUT,
  SectionTable,
  defaultSpacing,
  sectionGeoms,
  toDisplay,
  type DisplayFrame,
  type LayoutParams,
  type LayoutResult,
  type SectionGeom,
} from './render/sections';
import { Store } from './state/store';
import { parseState, serializeState } from './state/urlState';
import { defaultState, type ViewerState } from './state/viewerState';

export interface ManifestEntry {
  id: string;
  name: string;
  description?: string;
  url: string;
  size_bytes?: number;
  spatial_key?: string;
  library_key?: string;
  default_color_by?: { type: string; key: string };
  default_tooltip_fields?: string[];
  example_genes?: string[];
}

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
  | { type: 'counts' };

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
  private urlTimer = 0;
  private scalarValues: Float32Array | null = null;
  private scalarQuantiles: Float64Array | null = null;
  private scalarLabel = '';
  private frame: DisplayFrame = { flipX: false, flipY: false, flipZ: false, swapYZ: false };

  constructor(viewport: HTMLElement, base: string) {
    this.base = base;
    this.viewer = new Viewer(viewport);
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
        v.log1p === prev.log1p;
      const styleSame =
        v.colormap === prev.colormap &&
        v.reversed === prev.reversed &&
        v.rangeMode === prev.rangeMode &&
        v.pLo === prev.pLo &&
        v.pHi === prev.pHi &&
        v.vmin === prev.vmin &&
        v.vmax === prev.vmax &&
        v.nanColor === prev.nanColor;
      if (sameData && styleSame && v.hiddenCategories !== prev.hiddenCategories)
        this.applyCategoryMask();
      else if (sameData && v.geneNameColumn === prev.geneNameColumn) this.applyColorStyle();
      else if (!sameData) void this.applyColor();
      if (v.geneNameColumn !== prev.geneNameColumn) void this.loadVarNames();
    });
    s.on('filter', () => this.applyFilter());
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
      const json = (await res.json()) as { datasets: ManifestEntry[] };
      this.manifest = json.datasets ?? [];
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
    if (/^(https?:)?\/\//.test(url) || url.startsWith('blob:') || url.startsWith('/')) return url;
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
      alignment: new Map(),
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
      if (c.source === 'none' || !c.key) {
        pc.setColorMode('uniform');
        this.legend = null;
        this.colorbar = null;
        this.scalarValues = null;
        this.scalarQuantiles = null;
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
    this.scalarLabel = label;
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
    pc.setColormap(c.colormap, c.reversed);
    pc.setRange(vmin, vmax);
    pc.setColorMode('scalar');
    this.colorbar = {
      label: this.scalarLabel,
      vmin,
      vmax: vmax > vmin ? vmax : vmin,
      colormap: c.colormap,
      reversed: c.reversed,
      nanColor: c.nanColor,
      quantiles: q,
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
        colorValue = formatValue(this.scalarValues[id]);
      }
    }
    const fields: [string, string][] = [];
    for (const f of this.store.slice('ui').tooltipFields) {
      if (f === colorLabel) continue;
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
