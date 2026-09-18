// Self-hosted typeface (see the note at the top of style.css); no third-party requests.
import '@fontsource-variable/atkinson-hyperlegible-next/wght.css';
import './style.css';
import { App } from './app';
import { LAYOUT_MODES } from './render/sections';
import { createColorbar } from './ui/colorbar';
import { createLegendFloat } from './ui/legendFloat';
import { el, throttle } from './ui/dom';
import { openHelp } from './ui/help';
import { appearancePanel } from './ui/panels/appearance';
import { colorPanel } from './ui/panels/color';
import { coordinatesPanel } from './ui/panels/coordinates';
import { datasetPanel, progressText } from './ui/panels/dataset';
import { filterPanel } from './ui/panels/filter';
import { infoPanel } from './ui/panels/info';
import { sectionsPanel } from './ui/panels/sections';
import { createSelection } from './ui/selection';
import { createSidebar } from './ui/sidebar';
import { toast } from './ui/toast';
import { createTooltip } from './ui/tooltip';
import { createTopbar } from './ui/topbar';

interface Debug {
  app: App | null;
  ready: boolean;
  error: string | null;
  info(): unknown;
}

const root = document.getElementById('app')!;

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2'));
  } catch {
    return false;
  }
}

function fatal(title: string, message: string): void {
  root.replaceChildren(
    el(
      'div',
      'spv-fatal',
      el('h1', null, 'SPV — Spatial Viewer'),
      el('h2', null, title),
      el('p', null, message),
    ),
  );
}

function main(): void {
  const dbg: Debug = { app: null, ready: false, error: null, info: () => null };
  (window as unknown as { __spv: Debug }).__spv = dbg;
  if (!webglAvailable()) {
    fatal(
      'WebGL 2 is not available',
      'SPV renders with WebGL 2. Enable hardware acceleration or try a current version of Chrome, Firefox, Edge or Safari.',
    );
    return;
  }
  const base = import.meta.env.BASE_URL;
  const viewport = el('div', 'spv-viewport');
  // Page-URL (not hash) flags to create the WebGL context differently when a browser misdraws:
  // ?gl=noaa (no antialiasing), ?gl=opaque (no alpha), ?gl=preserve (preserveDrawingBuffer).
  const glFlags = new Set(
    (new URLSearchParams(location.search).get('gl') ?? '').split(',').filter(Boolean),
  );
  const app = new App(viewport, base, {
    antialias: !glFlags.has('noaa'),
    alpha: !glFlags.has('opaque'),
    preserveDrawingBuffer: glFlags.has('preserve'),
  });
  dbg.app = app;
  dbg.info = () => ({
    status: app.status,
    n: app.spatial?.n ?? 0,
    visible: app.visibleCount(),
    sections: app.sections.map((s) => s.name),
    layout: app.store.slice('layout').mode,
    current: app.store.slice('layout').current,
    hiddenSections: app.store.slice('layout').hidden,
    color: app.store.slice('color'),
    legend: app.legend
      ? { key: app.legend.key, n: app.legend.categories.length, hidden: [...app.legend.hidden] }
      : null,
    colorbar: app.colorbar
      ? { label: app.colorbar.label, vmin: app.colorbar.vmin, vmax: app.colorbar.vmax }
      : null,
    images: {
      enabled: app.store.slice('images').enabled,
      loaded: [...app.imageStatus.values()].filter((s) => s.state === 'loaded').length,
      total: app.sections.filter((s) => s.hasImage).length,
      bytes: app.planes?.totalBytes() ?? 0,
    },
    graph: app.graphStatus,
    selection: app.selectionCount,
    histogram: app.histogram
      ? { bins: Array.from(app.histogram.bins), lo: app.histogram.lo, hi: app.histogram.hi }
      : null,
    alignment: app.store.slice('layout').alignment,
    renderer: app.viewer.info(),
    loadInfo: app.loadInfo,
    summary: app.summary
      ? {
          nObs: app.summary.nObs,
          nVars: app.summary.nVars,
          library: app.summary.library.key,
          spatial: app.summary.spatial.key,
          flags: app.summary.flags,
        }
      : null,
  });

  const panels = [
    datasetPanel(app),
    sectionsPanel(app),
    colorPanel(app),
    filterPanel(app),
    coordinatesPanel(app),
    appearancePanel(app),
    infoPanel(app),
  ];
  root.append(createTopbar(app), createSidebar(app, panels), viewport);
  createTooltip(app);
  createColorbar(app, viewport);
  createLegendFloat(app, viewport);
  createSelection(app, viewport, app.viewer.renderer.domElement);
  const notice = el('div', { className: 'spv-overlay-notice', style: 'display:none' });
  viewport.appendChild(notice);
  const drop = el('div', 'spv-drop', el('span', null, 'Drop a .h5ad file to open it'));
  document.body.appendChild(drop);

  app.on((e) => {
    if (e.type === 'notice') toast(e.message, e.kind);
    if (e.type === 'status') {
      dbg.ready = app.status === 'ready';
      dbg.error = app.status === 'error' ? app.errorMessage : null;
      const show = app.status === 'loading' || (app.status === 'ready' && !app.spatial);
      notice.style.display = show ? 'block' : 'none';
      notice.textContent =
        app.status === 'loading'
          ? `${app.statusMessage || 'Loading…'}`
          : !app.spatial && app.status === 'ready'
            ? 'No 3-D coordinates were detected. Pick the X, Y and z sources in the Coordinates panel.'
            : '';
    }
    if (e.type === 'progress' && e.progress && app.status === 'loading') {
      notice.textContent = progressText(e.progress);
    }
  });
  app.store.on('ui', (v) => root.classList.toggle('spv-sidebar-hidden', !v.sidebar));

  // mouse → picking
  const canvas = app.viewer.renderer.domElement;
  const hover = throttle(
    (x: number, y: number, cx: number, cy: number) => void app.hover(x, y, cx, cy),
    33,
  );
  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons || app.selectMode) return;
    const r = canvas.getBoundingClientRect();
    hover(e.clientX - r.left, e.clientY - r.top, e.clientX, e.clientY);
  });
  canvas.addEventListener('pointerleave', () => app.clearHover());
  let downAt: [number, number] | null = null;
  canvas.addEventListener('pointerdown', (e) => (downAt = [e.clientX, e.clientY]));
  canvas.addEventListener('pointerup', (e) => {
    if (
      app.selectMode ||
      !downAt ||
      Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4 ||
      e.button !== 0
    )
      return;
    const r = canvas.getBoundingClientRect();
    void app.pin(e.clientX - r.left, e.clientY - r.top, e.clientX, e.clientY);
  });

  // drag & drop
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('spv-active');
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) drop.classList.remove('spv-active');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('spv-active');
    const f = e.dataTransfer?.files?.[0];
    if (f) void app.openFile(f);
  });

  // keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    const st = app.store;
    switch (e.key) {
      case 'r':
      case 'R':
        app.viewer.rig.reset();
        app.viewer.requestRender();
        break;
      case 'h':
      case 'H':
        st.update('ui', { sidebar: !st.slice('ui').sidebar });
        break;
      case 'f':
      case 'F':
        if (document.fullscreenElement) void document.exitFullscreen();
        else void root.requestFullscreen?.();
        break;
      case 's':
      case 'S':
        void app.screenshot(1, false).catch((err: Error) => toast(err.message, 'error'));
        break;
      case '1':
      case '2':
      case '3':
      case '4':
        app.viewer.rig.preset((['top', 'front', 'side', 'iso'] as const)[Number(e.key) - 1]);
        app.viewer.requestRender();
        break;
      case 'ArrowLeft':
        app.stepSection(-1);
        break;
      case 'ArrowRight':
        app.stepSection(1);
        break;
      case ' ':
        if (app.sections.length > 1) {
          e.preventDefault();
          st.update('layout', { playing: !st.slice('layout').playing });
        }
        break;
      case 'i':
      case 'I':
        st.update('images', { enabled: !st.slice('images').enabled });
        break;
      case 'l':
      case 'L':
        st.update('layout', {
          mode: LAYOUT_MODES[
            (LAYOUT_MODES.indexOf(st.slice('layout').mode) + 1) % LAYOUT_MODES.length
          ],
        });
        break;
      case 'o':
      case 'O':
        st.update('appearance', { ortho: !st.slice('appearance').ortho });
        break;
      case 'Escape':
        app.clearPin();
        if (app.selectionCount) app.clearSelection();
        else if (app.selectMode) app.setSelectMode(false);
        break;
      case 'x':
      case 'X':
        app.setSelectMode(!app.selectMode);
        break;
      case 'd':
      case 'D': {
        const report = app.drawnSectionsReport();
        console.info(report);
        const lines = report.split('\n');
        const brief = lines.slice(3, 5).join(' · ');
        const show = () => toast(report.replace(/\n/g, ' | '), 'info', 30000);
        if (navigator.clipboard?.writeText) {
          navigator.clipboard
            .writeText(report)
            .then(
              () =>
                toast(
                  `Diagnostic report copied to the clipboard (${lines.length} lines). Paste it with Cmd+V. ${brief}`,
                  'info',
                  20000,
                ),
              show,
            );
        } else show();
        break;
      }
      case '?':
        openHelp();
        break;
    }
  });

  // initial dataset from the URL hash, else the first manifest entry
  void (async () => {
    const wanted = app.applyUrlState();
    root.classList.toggle('spv-sidebar-hidden', !app.store.slice('ui').sidebar);
    await app.loadManifest();
    if (wanted.local) {
      toast(
        'This link was made from a local file. Open the same file (Dataset panel or drag & drop) to restore the view.',
        'info',
        12000,
      );
      app.store.update('dataset', { local: false });
    } else if (wanted.url) await app.openUrl(wanted.url);
    else if (wanted.id) await app.openFromManifest(wanted.id);
    else if (app.manifest[0]) await app.openFromManifest(app.manifest[0].id);
  })();
}

main();
