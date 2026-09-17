/**
 * The h5wasm worker. Owns the Emscripten virtual filesystem, the open file and the reader caches;
 * answers `RpcRequest`s from `client.ts` sequentially and streams `progress` events. h5wasm is
 * imported statically here so the whole engine (JS + embedded WASM, ~4 MB) lives in this lazily
 * created worker chunk and never in the initial page payload.
 */
import h5wasm from 'h5wasm';
import type { File as H5File } from 'h5wasm';
import { installPlugin, pluginNameForFilter } from './plugins';
import {
  ReaderError,
  createMatrixCache,
  defaultCoordinateSpec,
  readCategoryColors,
  readColumn,
  readGeneVector,
  readGraphEdges,
  readImage,
  readIndex,
  readIndexRows,
  readMoranI,
  readSpatialData,
  readStringArray,
  readSummary,
  refineLibraryWithDiscreteZ,
  unsupportedFilters,
  type MatrixCache,
} from './reader';
import {
  collectTransferables,
  type LoadMode,
  type OpenResult,
  type OpenSource,
  type RpcMethods,
  type WorkerInbound,
  type WorkerOutbound,
} from './rpc';
import { H5wasmSource } from './source';
import type { ColumnData, CoordinateSpec, ProgressEvent, Summary } from './types';

/** The subset of Emscripten's FS we use, typed locally so we do not depend on h5wasm's ambient types. */
interface EmFS {
  mkdir(path: string): void;
  mkdirTree(path: string): void;
  mount(type: unknown, opts: unknown, mountpoint: string): void;
  unmount(mountpoint: string): void;
  writeFile(path: string, data: Uint8Array): void;
  unlink(path: string): void;
  rmdir(path: string): void;
  analyzePath(path: string): { exists: boolean };
  createLazyFile(
    parent: string,
    name: string,
    url: string,
    canRead: boolean,
    canWrite: boolean,
  ): unknown;
  lookupPath(path: string): {
    node: { contents?: { chunks?: unknown[]; chunkSize?: number; length?: number } };
  };
  filesystems: { WORKERFS?: unknown; MEMFS?: unknown };
}

interface Engine {
  Module: Awaited<typeof h5wasm.ready> & {
    activate_throwing_error_handler(): number;
    HEAPU8: Uint8Array;
    get_plugin_search_paths(): string[];
  };
  FS: EmFS;
}

const ctx = self as unknown as {
  postMessage(msg: WorkerOutbound, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerInbound>) => void) | null;
};

let engine: Engine | null = null;
let enginePromise: Promise<Engine> | null = null;

interface OpenState {
  file: H5File;
  src: H5wasmSource;
  summary: Summary;
  path: string;
  mountpoint: string | null;
  loadMode: LoadMode;
  bytesTotal: number | null;
  cache: MatrixCache;
  columns: Map<string, ColumnData>;
}

let state: OpenState | null = null;
const cancelled = new Set<number>();
let queue: Promise<unknown> = Promise.resolve();

function post(msg: WorkerOutbound, transfer?: Transferable[]): void {
  ctx.postMessage(msg, transfer);
}

function progressFor(id: number) {
  return (p: ProgressEvent) => post({ event: 'progress', id, progress: p });
}

async function getEngine(id: number): Promise<Engine> {
  if (engine) return engine;
  if (!enginePromise) {
    enginePromise = (async () => {
      progressFor(id)({ stage: 'engine', done: 0, total: 1, message: 'Starting HDF5 engine' });
      const Module = (await h5wasm.ready) as Engine['Module'];
      Module.activate_throwing_error_handler();
      engine = { Module, FS: Module.FS as unknown as EmFS };
      progressFor(id)({ stage: 'engine', done: 1, total: 1 });
      return engine;
    })();
  }
  return enginePromise;
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_') || 'dataset.h5ad';
}

const HDF5_MAGIC = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Async pre-flight so a bad URL never reaches Emscripten's sync XHR (which would abort the WASM):
 * a HEAD for size/range support, then a ranged GET of the first 8 bytes to confirm the HDF5
 * signature (this also catches 404 fallback pages served with status 200) and byte serving.
 */
async function probeUrl(
  url: string,
): Promise<{ size: number | null; ranges: boolean; gzip: boolean }> {
  let head: Response;
  try {
    head = await fetch(url, { method: 'HEAD' });
  } catch (err) {
    throw new ReaderError(
      `Could not reach ${url}: ${(err as Error).message}. If the file is on another host it must allow CORS.`,
      'missing',
    );
  }
  if (head.status === 404) throw new ReaderError(`File not found (HTTP 404): ${url}`, 'missing');
  let res: Response;
  try {
    res = await fetch(url, { headers: { Range: 'bytes=0-7' } });
  } catch (err) {
    throw new ReaderError(`Could not fetch ${url}: ${(err as Error).message}`, 'missing');
  }
  if (!res.ok) throw new ReaderError(`HTTP ${res.status} ${res.statusText} for ${url}`, 'missing');
  const type = res.headers.get('Content-Type') ?? head.headers.get('Content-Type') ?? '';
  let first: Uint8Array;
  if (res.body) {
    const reader = res.body.getReader();
    const { value } = await reader.read();
    first = value ?? new Uint8Array(0);
    await reader.cancel().catch(() => undefined);
  } else {
    first = new Uint8Array(await res.arrayBuffer());
  }
  const isHdf5 = first.length >= 8 && HDF5_MAGIC.every((b, i) => first[i] === b);
  if (!isHdf5) {
    const hint = /text\/html/i.test(type)
      ? 'the server returned an HTML page (the file was probably not found)'
      : `content type ${type || 'unknown'}`;
    throw new ReaderError(`${url} is not an HDF5 file: ${hint}.`, 'not-hdf5');
  }
  const contentRange = res.headers.get('Content-Range');
  let size: number | null = null;
  if (res.status === 206 && contentRange) {
    const m = /\/(\d+)$/.exec(contentRange);
    if (m) size = Number(m[1]);
  }
  if (size === null) {
    const len =
      head.headers.get('Content-Length') ??
      (res.status === 200 ? res.headers.get('Content-Length') : null);
    size = len ? Number(len) : null;
  }
  const ranges = res.status === 206 || head.headers.get('Accept-Ranges') === 'bytes';
  const gzip = (head.headers.get('Content-Encoding') ?? '').includes('gzip');
  return { size, ranges, gzip };
}

async function fetchFull(url: string, id: number, expected: number | null): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new ReaderError(`HTTP ${res.status} ${res.statusText} for ${url}`, 'missing');
  const total = expected ?? Number(res.headers.get('Content-Length') ?? 0);
  const report = progressFor(id);
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    report({ stage: 'download', done: buf.length, total: buf.length });
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    report({ stage: 'download', done: received, total: Math.max(total, received) });
    if (cancelled.has(id)) {
      await reader.cancel();
      throw new ReaderError('cancelled', 'cancelled');
    }
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function closeCurrent(): void {
  if (!state || !engine) {
    state = null;
    return;
  }
  const { FS } = engine;
  try {
    state.src.close();
  } catch {
    /* already closed */
  }
  try {
    if (state.mountpoint) {
      FS.unmount(state.mountpoint);
      FS.rmdir(state.mountpoint);
    } else if (FS.analyzePath(state.path).exists) {
      FS.unlink(state.path);
    }
  } catch (err) {
    post({ event: 'log', level: 'warn', message: `cleanup: ${(err as Error).message}` });
  }
  state = null;
}

async function open(id: number, source: OpenSource): Promise<OpenResult> {
  const t0 = performance.now();
  const { Module, FS } = await getEngine(id);
  const t1 = performance.now();
  closeCurrent();
  let path: string;
  let mountpoint: string | null = null;
  let loadMode: LoadMode;
  let bytesTotal: number | null;
  const report = progressFor(id);
  if (source.kind === 'url') {
    const name = safeName(
      source.name ?? source.url.split('/').pop()?.split('?')[0] ?? 'remote.h5ad',
    );
    path = `/${name}`;
    if (FS.analyzePath(path).exists) FS.unlink(path);
    report({ stage: 'download', done: 0, total: 1, message: 'Checking file' });
    const probe = await probeUrl(source.url);
    bytesTotal = probe.size;
    const wantLazy = (source.mode ?? 'auto') !== 'full';
    if (wantLazy && probe.ranges && probe.size && !probe.gzip) {
      FS.createLazyFile('/', name, source.url, true, false);
      loadMode = 'lazy';
      report({
        stage: 'download',
        done: 0,
        total: probe.size,
        message: 'Reading on demand (HTTP range requests)',
      });
    } else {
      if (source.mode === 'lazy') {
        post({
          event: 'log',
          level: 'warn',
          message: 'Server does not support byte ranges; downloading the whole file',
        });
      }
      const bytes = await fetchFull(source.url, id, probe.size);
      bytesTotal = bytes.length;
      FS.writeFile(path, bytes);
      loadMode = 'full';
    }
  } else if (source.kind === 'file') {
    const name = safeName(source.file.name);
    bytesTotal = source.file.size;
    if (FS.filesystems.WORKERFS) {
      mountpoint = '/work';
      if (!FS.analyzePath(mountpoint).exists) FS.mkdir(mountpoint);
      FS.mount(FS.filesystems.WORKERFS, { files: [source.file] }, mountpoint);
      path = `${mountpoint}/${source.file.name}`;
      loadMode = 'workerfs';
    } else {
      report({
        stage: 'download',
        done: 0,
        total: source.file.size,
        message: 'Reading file into memory',
      });
      const buf = new Uint8Array(await source.file.arrayBuffer());
      path = `/${name}`;
      FS.writeFile(path, buf);
      loadMode = 'memfs';
    }
  } else {
    path = `/${safeName(source.name)}`;
    bytesTotal = source.buffer.byteLength;
    FS.writeFile(path, new Uint8Array(source.buffer));
    loadMode = 'memfs';
  }
  report({ stage: 'open', done: 0, total: 1 });
  const t2 = performance.now();
  let file: H5File;
  try {
    file = new h5wasm.File(path, 'r');
  } catch (err) {
    cleanupPath(FS, path, mountpoint);
    throw new ReaderError(
      `Not a readable HDF5 file (${summarizeHdf5Error((err as Error).message)})`,
      'not-hdf5',
    );
  }
  if (file.file_id < 0n) {
    cleanupPath(FS, path, mountpoint);
    throw new ReaderError(
      'Not an HDF5 file (signature not found). SPV reads AnnData .h5ad files.',
      'not-hdf5',
    );
  }
  const src = new H5wasmSource(file);
  let summary: Summary;
  try {
    summary = readSummary(src);
  } catch (err) {
    src.close();
    cleanupPath(FS, path, mountpoint);
    throw err;
  }
  const pluginsInstalled: string[] = [];
  for (const f of unsupportedFilters(summary.filtersUsed)) {
    const name = pluginNameForFilter(f.id);
    if (!name) {
      summary.flags.push(
        `compression filter ${f.id} has no available plugin; prepare_h5ad.py --compression gzip will fix it`,
      );
      continue;
    }
    report({ stage: 'open', done: 0, total: 1, message: `Loading ${name} compression plugin` });
    try {
      await installPlugin(Module as unknown as Parameters<typeof installPlugin>[0], name);
      pluginsInstalled.push(name);
    } catch (err) {
      summary.flags.push(`could not load the ${name} plugin: ${(err as Error).message}`);
    }
  }
  state = {
    file,
    src,
    summary,
    path,
    mountpoint,
    loadMode,
    bytesTotal,
    cache: createMatrixCache(),
    columns: new Map(),
  };
  const t3 = performance.now();
  return {
    summary,
    loadMode,
    bytesTotal,
    timings: { engineMs: t1 - t0, loadMs: t2 - t1, summaryMs: t3 - t2 },
    pluginsInstalled,
  };
}

function cleanupPath(FS: EmFS, path: string, mountpoint: string | null): void {
  try {
    if (mountpoint) {
      FS.unmount(mountpoint);
      FS.rmdir(mountpoint);
    } else if (FS.analyzePath(path).exists) FS.unlink(path);
  } catch {
    /* ignore */
  }
}

function requireState(): OpenState {
  if (!state) throw new ReaderError('No dataset is open', 'missing');
  return state;
}

function getColumn(st: OpenState, name: string): ColumnData {
  let col = st.columns.get(name);
  if (!col) {
    col = readColumn(st.src, st.summary.obs, name);
    st.columns.set(name, col);
  }
  return col;
}

function libraryColumnData(
  st: OpenState,
  key: string | null,
): { codes: Int32Array; categories: string[] } | null {
  if (!key) return null;
  const name = key.replace(/^obs\//, '');
  const col = getColumn(st, name);
  if (col.kind !== 'categorical')
    throw new ReaderError(`obs/${name} is numeric and cannot be a section column`, 'unsupported');
  return { codes: col.codes, categories: col.categories };
}

function matrixByPath(st: OpenState, path: string) {
  const s = st.summary;
  if (path === 'X' && s.X) return s.X;
  if (path === 'raw/X' && s.raw?.X) return s.raw.X;
  const layer = path.replace(/^layers\//, '');
  if (s.layers[layer]) return s.layers[layer];
  throw new ReaderError(`No expression matrix at ${path}`, 'missing');
}

const handlers: {
  [M in keyof RpcMethods]: (
    id: number,
    args: Parameters<RpcMethods[M]>[0],
  ) => Promise<ReturnType<RpcMethods[M]>> | ReturnType<RpcMethods[M]>;
} = {
  open: (id, src) => open(id, src),
  getSummary: () => requireState().summary,
  getSpatial: (id, spec) => {
    const st = requireState();
    const resolved: CoordinateSpec | null = spec ?? defaultCoordinateSpec(st.summary);
    if (!resolved) {
      throw new ReaderError(
        'No spatial coordinates were detected. Choose X/Y sources in the Coordinates panel.',
        'missing',
      );
    }
    progressFor(id)({ stage: 'coordinates', done: 0, total: 1 });
    let libKey = resolved.libraryKey;
    let matches =
      st.summary.library.matchesUnsSpatial === true && libKey === st.summary.library.key;
    let data = readSpatialData(
      st.src,
      resolved,
      st.summary.nObs,
      libraryColumnData(st, libKey),
      st.summary.uns.spatial,
      matches,
    );
    if (!libKey && spec === null && data.ndim === 3 && data.zLevels && data.zLevels.length > 1) {
      // Native 3-D with discrete z: look for a categorical column aligned with the z levels.
      const z = new Float64Array(data.n);
      for (let i = 0; i < data.n; i++) z[i] = data.xyz[i * 3 + 2];
      const refined = refineLibraryWithDiscreteZ(st.src, st.summary, z);
      if (refined.key) {
        st.summary.library = refined;
        libKey = refined.key;
        matches = false;
        data = readSpatialData(
          st.src,
          { ...resolved, libraryKey: libKey },
          st.summary.nObs,
          libraryColumnData(st, libKey),
          st.summary.uns.spatial,
          matches,
        );
      }
    }
    progressFor(id)({ stage: 'coordinates', done: 1, total: 1 });
    return data;
  },
  getObsColumn: (_id, name) => {
    const st = requireState();
    const col = getColumn(st, name);
    // Return a copy so transferring the buffer does not detach the cached column.
    return col.kind === 'categorical'
      ? { ...col, codes: col.codes.slice() }
      : { ...col, values: col.values.slice(), quantiles: col.quantiles.slice() };
  },
  getVarNames: (_id, column) => {
    const st = requireState();
    if (!column) return readIndex(st.src, st.summary.var);
    const desc = st.summary.var.columns.find((c) => c.name === column);
    if (!desc) throw new ReaderError(`var has no column ${column}`, 'missing');
    if (desc.kind === 'categorical') {
      const col = readColumn(st.src, st.summary.var, column);
      if (col.kind === 'categorical')
        return Array.from(col.codes, (c) => (c < 0 ? '' : col.categories[c]));
    }
    return readStringArray(st.src, desc.path);
  },
  getGeneVector: async (id, req) => {
    const st = requireState();
    const m = matrixByPath(st, req.matrix);
    return readGeneVector(st.src, m, req.index, st.cache, {
      onProgress: progressFor(id),
      shouldCancel: () => cancelled.has(id) || state !== st,
    });
  },
  getImage: (id, req) => {
    const st = requireState();
    const lib = st.summary.uns.spatial?.find((l) => l.id === req.library);
    const info = lib?.images.find((im) => im.key === req.key);
    if (!info) throw new ReaderError(`No image ${req.key} for section ${req.library}`, 'missing');
    progressFor(id)({ stage: 'image', done: 0, total: 1, message: `${req.library}/${req.key}` });
    return readImage(st.src, info, req.maxSide);
  },
  getGraphEdges: async (id, req) => {
    const st = requireState();
    const m = st.summary.obsp[req.key];
    if (!m) throw new ReaderError(`obsp/${req.key} is missing or not a sparse matrix`, 'missing');
    return readGraphEdges(st.src, m, {
      maxEdges: req.maxEdges,
      onProgress: progressFor(id),
      shouldCancel: () => cancelled.has(id) || state !== st,
    });
  },
  getMoranI: () => readMoranI(requireState().src),
  getCategoryColors: (_id, req) => readCategoryColors(requireState().src, req.column, req.n),
  getObsIndex: (_id, rows) => {
    const st = requireState();
    return readIndexRows(st.src, st.summary.obs, rows);
  },
  getLoadStats: () => {
    const st = state;
    const heapBytes = engine?.Module.HEAPU8.length ?? 0;
    let bytesDownloaded: number | null = st?.bytesTotal ?? null;
    if (st && engine && st.loadMode === 'lazy') {
      try {
        const contents = engine.FS.lookupPath(st.path).node.contents;
        const chunks = contents?.chunks ?? [];
        const chunkSize = contents?.chunkSize ?? 0;
        let n = 0;
        for (let i = 0; i < chunks.length; i++) if (chunks[i] !== undefined) n++;
        bytesDownloaded = Math.min(n * chunkSize, st.bytesTotal ?? Infinity);
      } catch {
        bytesDownloaded = null;
      }
    }
    let csrIndexBytes = 0;
    if (st)
      for (const idx of st.cache.csrIndex.values())
        csrIndexBytes += idx.rows.byteLength + idx.data.byteLength + idx.colPtr.byteLength;
    return {
      loadMode: st?.loadMode ?? null,
      bytesTotal: st?.bytesTotal ?? null,
      bytesDownloaded,
      heapBytes,
      csrIndexBytes,
    };
  },
  close: () => {
    closeCurrent();
  },
};

/** Reduce an HDF5-DIAG stack trace to its most specific message (the deepest `#NNN:` line). */
export function summarizeHdf5Error(message: string): string {
  const lines = message.split('\n').map((l) => l.trim());
  const detail = lines.filter((l) => /^#\d+:/.test(l)).pop();
  if (detail) {
    const m = /\):\s*(.*)$/.exec(detail);
    if (m) return m[1];
  }
  return lines[0] ?? message;
}

function serializeError(err: unknown) {
  if (err instanceof ReaderError) return { message: err.message, code: err.code, name: err.name };
  if (err instanceof Error) {
    const detail = summarizeHdf5Error(err.message);
    const isFilter = /filter|plugin|Can't read data|decompress|inflate/i.test(err.message);
    const isMemory = /allocation|memory/i.test(err.message);
    const code = isFilter ? 'filter' : isMemory ? 'memory' : null;
    return {
      message: isFilter
        ? `HDF5 could not decode a compressed dataset (${detail}). The file may use a compression filter without a plugin; re-save it with prepare_h5ad.py --compression gzip.`
        : detail,
      code,
      name: err.name,
    };
  }
  return { message: String(err), code: null, name: 'Error' };
}

ctx.onmessage = (e: MessageEvent<WorkerInbound>) => {
  const msg = e.data;
  if ('cancel' in msg) {
    cancelled.add(msg.cancel);
    return;
  }
  const { id, method, args } = msg;
  queue = queue.then(async () => {
    if (cancelled.has(id)) {
      cancelled.delete(id);
      post({
        id,
        ok: false,
        error: { message: 'cancelled', code: 'cancelled', name: 'ReaderError' },
      });
      return;
    }
    try {
      const handler = handlers[method] as (id: number, args: unknown) => unknown;
      if (!handler) throw new ReaderError(`Unknown method ${String(method)}`, 'unsupported');
      const result = await handler(id, args);
      post({ id, ok: true, result }, collectTransferables(result));
    } catch (err) {
      post({ id, ok: false, error: serializeError(err) });
    } finally {
      cancelled.delete(id);
    }
  });
};

post({ event: 'ready' });
