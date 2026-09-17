// Phase 3 bootstrap: loads a dataset through the worker and renders it with the point-cloud core.
// Keyboard: L cycle layout, ←/→ step sections, R reset view, 1/2/3 top/front/side, 4 iso,
// O orthographic, G colour by a gene, C colour by cluster, A auto-rotate.
// Exposes `window.__spv` for the E2E tests. The full UI arrives in Phase 4.
import { colormapLUT } from './color/colormaps';
import { paletteFor } from './color/palettes';
import { H5adClient } from './h5ad/client';
import { defaultColorColumn } from './h5ad/reader';
import type { OpenSource } from './h5ad/rpc';
import type { ProgressEvent, SpatialData, Summary } from './h5ad/types';
import { PointCloud } from './render/points';
import { Viewer } from './render/scene';
import {
  DEFAULT_LAYOUT,
  LAYOUT_MODES,
  SectionTable,
  defaultSpacing,
  sectionGeoms,
  type LayoutMode,
  type LayoutParams,
} from './render/sections';

void colormapLUT;

const app = document.getElementById('app')!;
app.style.cssText =
  'position:fixed;inset:0;overflow:hidden;background:#0f1115;color:#e5e7eb;font:13px system-ui,sans-serif';
const canvasHost = document.createElement('div');
canvasHost.style.cssText = 'position:absolute;inset:0';
app.appendChild(canvasHost);
const status = document.createElement('div');
status.style.cssText =
  'position:absolute;left:12px;top:12px;padding:8px 12px;background:rgba(15,17,21,.8);border-radius:8px;max-width:60ch;white-space:pre-wrap;pointer-events:none';
app.appendChild(status);
const say = (s: string) => (status.textContent = s);

interface Debug {
  ready: boolean;
  error: string | null;
  summary: Summary | null;
  spatial: Omit<SpatialData, 'xyz' | 'valid' | 'sectionOf'> | null;
  layout: LayoutParams | null;
  setLayout: (mode: LayoutMode) => void;
  step: (delta: number) => void;
  colorByGene: (name: string) => Promise<void>;
  colorByColumn: (name: string) => Promise<void>;
  info: () => unknown;
  viewer: Viewer | null;
  timings: Record<string, number>;
}
const dbg: Debug = {
  ready: false,
  error: null,
  summary: null,
  spatial: null,
  layout: null,
  setLayout: () => {},
  step: () => {},
  colorByGene: async () => {},
  colorByColumn: async () => {},
  info: () => null,
  viewer: null,
  timings: {},
};
(window as unknown as { __spv: Debug }).__spv = dbg;

async function main(): Promise<void> {
  const viewer = new Viewer(canvasHost);
  dbg.viewer = viewer;
  const client = new H5adClient();
  const hash = new URLSearchParams(location.hash.slice(1));
  const base = import.meta.env.BASE_URL;
  let source: OpenSource;
  if (hash.get('url')) source = { kind: 'url', url: hash.get('url')! };
  else {
    const manifest = (await (await fetch(`${base}data/datasets.json`)).json()) as {
      datasets: { id: string; url: string }[];
    };
    const id = hash.get('dataset') ?? manifest.datasets[0]?.id;
    const entry = manifest.datasets.find((d) => d.id === id);
    if (!entry) throw new Error(`Unknown dataset ${id}`);
    source = { kind: 'url', url: /^https?:/.test(entry.url) ? entry.url : `${base}${entry.url}` };
  }
  const onProgress = (p: ProgressEvent) =>
    say(`${p.stage} ${p.total ? Math.round((100 * p.done) / p.total) : ''}% ${p.message ?? ''}`);
  const t0 = performance.now();
  const opened = await client.call('open', source, { onProgress });
  dbg.summary = opened.summary;
  dbg.timings.open = performance.now() - t0;
  const spatial = await client.call('getSpatial', null, { onProgress });
  dbg.timings.spatial = performance.now() - t0;
  const { xyz, valid, sectionOf, ...rest } = spatial;
  dbg.spatial = rest;

  const geoms = sectionGeoms(spatial.sections, spatial.center, spatial.scale);
  const table = new SectionTable(geoms);
  const layout: LayoutParams = {
    ...DEFAULT_LAYOUT,
    spacing: defaultSpacing(geoms),
    hidden: new Set(),
    alignment: new Map(),
  };
  dbg.layout = layout;
  const pc = new PointCloud({ n: spatial.n, xyz, valid, sectionOf }, table);
  viewer.setPointCloud(pc);
  const applyLayout = (fit: boolean) => {
    const res = table.apply(layout);
    pc.setNativeZ(res.nativeZ);
    pc.setExplode(layout.explode, (res.bounds.min[2] + res.bounds.max[2]) / 2);
    if (res.planar) viewer.rig.setOrthographic(true);
    viewer.setBounds(res.bounds, fit, res.planar ? 'top' : 'iso', res.planar);
  };
  applyLayout(true);
  dbg.timings.firstRender = performance.now() - t0;

  const names = await client.call('getVarNames', null);
  dbg.colorByColumn = async (name: string) => {
    const col = await client.call('getObsColumn', name);
    if (col.kind === 'categorical') {
      const fileColors = await client.call('getCategoryColors', {
        column: name,
        n: col.categories.length,
      });
      pc.setCodes(col.codes);
      pc.setPalette(paletteFor(col.categories.length, fileColors));
      pc.setColorMode('category');
      say(
        `${opened.summary.nObs.toLocaleString()} cells · ${spatial.sections.length} sections · colour: ${name} (${col.categories.length} categories)`,
      );
    } else {
      pc.setScalar(col.values);
      pc.setColormap('viridis');
      pc.setRange(col.quantiles[0], col.quantiles[995]);
      pc.setColorMode('scalar');
      say(`colour: ${name} (numeric)`);
    }
    viewer.requestRender();
  };
  dbg.colorByGene = async (gene: string) => {
    const j = names.indexOf(gene);
    if (j < 0) {
      say(`gene ${gene} not found`);
      return;
    }
    const t = performance.now();
    const gv = await client.call('getGeneVector', { matrix: 'X', index: j }, { onProgress });
    pc.setScalar(gv.values);
    pc.setColormap('viridis');
    pc.setRange(gv.quantiles[0], gv.quantiles[995]);
    pc.setColorMode('scalar');
    viewer.requestRender();
    say(
      `colour: gene ${gene} (nnz ${gv.nnz.toLocaleString()}, ${(performance.now() - t).toFixed(0)} ms)`,
    );
  };
  const defaultCol = defaultColorColumn(opened.summary.obs, opened.summary.library.column);
  if (defaultCol) await dbg.colorByColumn(defaultCol);
  pc.setPointSize(2.5);

  dbg.setLayout = (mode) => {
    layout.mode = mode;
    layout.dimOthers = false;
    if (!(mode === 'tile' || mode === 'single')) viewer.rig.setOrthographic(false);
    applyLayout(true);
  };
  dbg.step = (delta) => {
    const n = spatial.sections.length;
    if (!n) return;
    layout.current = (layout.current + delta + n) % n;
    if (layout.mode !== 'single') layout.dimOthers = true;
    applyLayout(false);
    say(`section ${spatial.sections[layout.current].name} (${layout.current + 1}/${n})`);
  };
  dbg.info = () => ({
    ...viewer.info(),
    visible: pc.visibleCount,
    layout: layout.mode,
    current: layout.current,
  });
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    switch (e.key) {
      case 'l':
        dbg.setLayout(LAYOUT_MODES[(LAYOUT_MODES.indexOf(layout.mode) + 1) % LAYOUT_MODES.length]);
        break;
      case 'ArrowLeft':
        dbg.step(-1);
        break;
      case 'ArrowRight':
        dbg.step(1);
        break;
      case 'r':
        viewer.rig.reset();
        viewer.requestRender();
        break;
      case '1':
      case '2':
      case '3':
      case '4':
        viewer.rig.preset((['top', 'front', 'side', 'iso'] as const)[Number(e.key) - 1]);
        viewer.requestRender();
        break;
      case 'o':
        viewer.rig.setOrthographic(!viewer.rig.isOrthographic);
        viewer.requestRender();
        break;
      case 'g':
        void dbg.colorByGene(names[Math.floor(Math.random() * names.length)]);
        break;
      case 'c':
        if (defaultCol) void dbg.colorByColumn(defaultCol);
        break;
      case 'a':
        viewer.rig.autoRotate = !viewer.rig.autoRotate;
        viewer.requestRender();
        break;
    }
  });
  dbg.ready = true;
}

main().catch((err: Error) => {
  dbg.error = err.message;
  say(`Error: ${err.message}`);
  console.error(err);
});
