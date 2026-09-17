// Phase 2 verification page: opens a dataset through the worker and exposes the results on
// `window.__spv` so a headless browser can compare them with data/demo.meta.json.
// Replaced by the real viewer bootstrap in Phase 3/4.
import { H5adClient } from './h5ad/client';
import type { OpenSource } from './h5ad/rpc';
import type { ColumnData, GeneVector, ProgressEvent, SpatialData, Summary } from './h5ad/types';

interface DebugState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  progress: ProgressEvent[];
  open: unknown;
  summary: Summary | null;
  spatial: Omit<SpatialData, 'xyz' | 'valid' | 'sectionOf'> | null;
  xyzChecksum: [number, number, number] | null;
  column: { name: string; nCategories: number; counts: Record<string, number> } | null;
  gene: {
    name: string;
    index: number;
    nnz: number;
    sum: number;
    max: number;
    firstNonzero: [number, number][];
  } | null;
  varNames: number;
  timings: Record<string, number>;
  loadStats: unknown;
  client: H5adClient | null;
  run: (src: OpenSource, genes?: string[]) => Promise<void>;
}

const dbg: DebugState = {
  status: 'idle',
  error: null,
  progress: [],
  open: null,
  summary: null,
  spatial: null,
  xyzChecksum: null,
  column: null,
  gene: null,
  varNames: 0,
  timings: {},
  loadStats: null,
  client: null,
  run: async () => {},
};
(window as unknown as { __spv: DebugState }).__spv = dbg;

const app = document.getElementById('app')!;
app.innerHTML = `
  <main style="font-family: system-ui, sans-serif; padding: 1.5rem; max-width: 60rem;">
    <h1 style="margin:0"><span class="spv-wordmark">SPV</span> <small style="font-weight:normal;opacity:.7">Spatial Viewer</small></h1>
    <p>Phase 2 reader check. <input id="spv-file" type="file" accept=".h5ad,.h5" /></p>
    <pre id="spv-log" style="white-space:pre-wrap;font-size:12px"></pre>
  </main>`;
const logEl = document.getElementById('spv-log')!;
const log = (s: string) => {
  logEl.textContent += s + '\n';
};

dbg.run = async (source: OpenSource, genes: string[] = []) => {
  dbg.status = 'loading';
  dbg.error = null;
  dbg.progress = [];
  const client = dbg.client ?? new H5adClient();
  dbg.client = client;
  client.onLog = (level, message) => log(`[${level}] ${message}`);
  const onProgress = (p: ProgressEvent) => {
    dbg.progress.push(p);
    if (p.done === p.total || p.message)
      log(`progress ${p.stage} ${p.done}/${p.total} ${p.message ?? ''}`);
  };
  try {
    let t = performance.now();
    const opened = await client.call('open', source, { onProgress });
    dbg.timings.open = performance.now() - t;
    dbg.open = {
      loadMode: opened.loadMode,
      bytesTotal: opened.bytesTotal,
      timings: opened.timings,
      plugins: opened.pluginsInstalled,
    };
    dbg.summary = opened.summary;
    log(
      `opened (${opened.loadMode}) n_obs=${opened.summary.nObs} n_vars=${opened.summary.nVars} in ${dbg.timings.open.toFixed(0)} ms`,
    );
    for (const f of opened.summary.flags) log(`  ! ${f}`);
    t = performance.now();
    const spatial = await client.call('getSpatial', null, { onProgress });
    dbg.timings.spatial = performance.now() - t;
    const { xyz, valid, sectionOf, ...rest } = spatial;
    void valid;
    void sectionOf;
    dbg.spatial = rest;
    const sums: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < spatial.n; i++)
      for (let a = 0; a < 3; a++) sums[a] += xyz[i * 3 + a] / spatial.scale + spatial.center[a];
    dbg.xyzChecksum = sums;
    log(
      `spatial ${spatial.ndim}-D, ${spatial.sections.length} sections (${spatial.orderSource}), dropped ${spatial.nDropped}, ${dbg.timings.spatial.toFixed(0)} ms`,
    );
    t = performance.now();
    const names = await client.call('getVarNames', null);
    dbg.varNames = names.length;
    dbg.timings.varNames = performance.now() - t;
    const libCol = opened.summary.library.column;
    if (libCol) {
      t = performance.now();
      const col: ColumnData = await client.call('getObsColumn', libCol);
      dbg.timings.column = performance.now() - t;
      if (col.kind === 'categorical') {
        const counts: Record<string, number> = {};
        for (let i = 0; i < col.codes.length; i++) {
          const c = col.codes[i];
          const k = c < 0 ? 'NA' : col.categories[c];
          counts[k] = (counts[k] ?? 0) + 1;
        }
        dbg.column = { name: libCol, nCategories: col.categories.length, counts };
      }
    }
    for (const g of genes) {
      const j = names.indexOf(g);
      if (j < 0) continue;
      t = performance.now();
      const gv: GeneVector = await client.call(
        'getGeneVector',
        { matrix: 'X', index: j },
        { onProgress },
      );
      dbg.timings[`gene:${g}`] = performance.now() - t;
      let sum = 0;
      const first: [number, number][] = [];
      for (let i = 0; i < gv.values.length; i++) {
        const v = gv.values[i];
        if (v !== 0) {
          sum += v;
          if (first.length < 5) first.push([i, v]);
        }
      }
      dbg.gene = { name: g, index: j, nnz: gv.nnz, sum, max: gv.max, firstNonzero: first };
      log(
        `gene ${g} (col ${j}) nnz=${gv.nnz} sum=${sum.toFixed(3)} max=${gv.max.toFixed(4)} in ${dbg.timings[`gene:${g}`].toFixed(0)} ms`,
      );
    }
    dbg.loadStats = await client.call('getLoadStats', null);
    log(`load stats ${JSON.stringify(dbg.loadStats)}`);
    dbg.status = 'ready';
  } catch (err) {
    dbg.status = 'error';
    dbg.error = (err as Error).message;
    log(`ERROR ${(err as Error).name}: ${(err as Error).message}`);
  }
};

document.getElementById('spv-file')!.addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) void dbg.run({ kind: 'file', file }, ['Itpr1']);
});

const hash = new URLSearchParams(location.hash.slice(1));
const ds = hash.get('dataset');
const url = hash.get('url');
if (ds || url) {
  const base = import.meta.env.BASE_URL;
  const target = url ?? `${base}data/${ds}.h5ad`;
  const mode = (hash.get('mode') as 'auto' | 'lazy' | 'full' | null) ?? 'auto';
  void dbg.run({ kind: 'url', url: target, mode }, (hash.get('genes') ?? 'Itpr1').split(','));
}
