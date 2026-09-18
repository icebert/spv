/**
 * AnnData (.h5ad) schema logic on top of an `H5Source`. Pure and synchronous except for the
 * chunked scans, which are `async` so the worker can post progress and honour cancellation
 * between chunks. Nothing here touches the DOM or h5wasm directly.
 *
 * Schema references: anndata on-disk format (encoding-type / encoding-version attributes),
 * Squidpy storage conventions for `uns/spatial`, `obsp/*_connectivities` and `uns/moranI`.
 */
import { compareNatural } from '../util/naturalSort';
import type { H5Source } from './source';
import type {
  MatrixFormat,
  ColumnData,
  ColumnDescriptor,
  ColumnRef,
  CoordinateSpec,
  DataFrameInfo,
  DatasetMeta,
  DecodedImage,
  FilterInfo,
  GeneVector,
  GraphEdges,
  ImageInfo,
  LibraryDetection,
  MatrixInfo,
  MoranI,
  NumericTypedArray,
  ObsmInfo,
  ProgressFn,
  SectionInfo,
  SpatialData,
  SpatialDetection,
  Summary,
  UnsSpatialLibrary,
  UnsSummary,
} from './types';

// --- Conventions (mirrored in scripts/inspect_h5ad.py) ---------------------------------------
export const SPATIAL_KEYS_3D_ORDER = [
  'spatial3d',
  'spatial_3d',
  'X_spatial_3d',
  'spatial',
  'X_spatial',
];
export const Z_OBS_KEYS = ['z', 'Z', 'z_coord', 'z_um', 'depth', 'Bregma'];
export const LIBRARY_KEY_CANDIDATES = [
  'library_id',
  'library',
  'sample',
  'sample_id',
  'section',
  'slice',
  'slide',
  'fov',
  'z_index',
  'batch',
];
export const CLUSTER_PRIORITY = ['leiden', 'louvain', 'cluster', 'cell_type', 'celltype'];
export const GENE_NAME_COLUMNS = ['gene_symbols', 'gene_symbol', 'feature_name', 'symbol'];
export const SCALEFACTOR_KEYS = [
  'tissue_hires_scalef',
  'tissue_lowres_scalef',
  'spot_diameter_fullres',
  'fiducial_diameter_fullres',
];
/** Filters built into h5wasm (deflate, shuffle, fletcher32, szip, nbit, scaleoffset). */
const BUILTIN_FILTER_IDS = new Set([1, 2, 3, 4, 5, 6]);
const EAGER_CATEGORY_LIMIT = 5000;
export const MAX_CATEGORY_CODE = 0xffff;
const DISCRETE_Z_LIMIT = 512;
const N_QUANTILES = 1001;
const CHUNK_ENTRIES = 4_000_000;
/** Above this nnz a CSR matrix is scanned per gene instead of being transposed into memory. */
export const CSR_INDEX_MAX_NNZ = 25_000_000;
export const CSR_NNZ_WARN = 50_000_000;
export const DENSE_GRAPH_MAX_ELEMENTS = 1e8;

// --- Small helpers -----------------------------------------------------------------------------
export class ReaderError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'not-hdf5'
      | 'not-anndata'
      | 'shape-mismatch'
      | 'unsupported'
      | 'filter'
      | 'missing'
      | 'cancelled'
      | 'memory',
  ) {
    super(message);
    this.name = 'ReaderError';
  }
}

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function str(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length === 1 && typeof v[0] === 'string') return v[0];
  return null;
}

function stringList(v: unknown): string[] | null {
  if (Array.isArray(v)) return v.every((x) => typeof x === 'string') ? (v as string[]) : null;
  if (typeof v === 'string') return [v];
  return null;
}

function numberList(v: unknown): number[] | null {
  if (v instanceof Float64Array || Array.isArray(v)) {
    const out = Array.from(v as ArrayLike<unknown>, Number);
    return out.every((x) => Number.isFinite(x)) ? out : null;
  }
  return null;
}

function isTypedArray(v: unknown): v is NumericTypedArray {
  return ArrayBuffer.isView(v) && !(v instanceof DataView);
}

/** Convert any numeric h5wasm output into a Float64Array (copy). */
export function toFloat64(v: unknown): Float64Array {
  if (v instanceof Float64Array) return v;
  if (isTypedArray(v)) return Float64Array.from(v as ArrayLike<number>);
  if (Array.isArray(v)) return Float64Array.from(v, Number);
  if (typeof v === 'number') return Float64Array.of(v);
  throw new ReaderError(`Expected numeric data, got ${typeof v}`, 'unsupported');
}

export function toFloat32(v: unknown): Float32Array {
  if (v instanceof Float32Array) return v;
  if (isTypedArray(v)) return Float32Array.from(v as ArrayLike<number>);
  if (Array.isArray(v)) return Float32Array.from(v, Number);
  throw new ReaderError(`Expected numeric data, got ${typeof v}`, 'unsupported');
}

export function toInt32(v: unknown): Int32Array {
  if (v instanceof Int32Array) return v;
  if (isTypedArray(v)) return Int32Array.from(v as ArrayLike<number>);
  if (Array.isArray(v)) return Int32Array.from(v, Number);
  throw new ReaderError(`Expected integer data, got ${typeof v}`, 'unsupported');
}

/** Keep the natural width of a numeric column: int8/16/32 → Int32, float32 → Float32, else Float64. */
function toNumericColumn(v: unknown, meta: DatasetMeta | null): NumericTypedArray {
  if (v instanceof Float32Array || v instanceof Float64Array || v instanceof Int32Array) return v;
  if (
    v instanceof Int8Array ||
    v instanceof Int16Array ||
    v instanceof Uint8Array ||
    v instanceof Uint16Array
  ) {
    return Int32Array.from(v);
  }
  if (meta && meta.typeClass === 1 && meta.size === 4) return toFloat32(v);
  return toFloat64(v);
}

function joinPath(a: string, b: string): string {
  return a === '/' || a === '' ? b : `${a}/${b}`;
}

/** 1001 quantiles of the finite values (subsampled above 2 M values). */
export function computeQuantiles(values: ArrayLike<number>): Float64Array {
  let finite = Float64Array.from(values as ArrayLike<number>).filter((x) => Number.isFinite(x));
  if (finite.length > 2_000_000) {
    const stride = finite.length / 2_000_000;
    const sampled = new Float64Array(2_000_000);
    for (let i = 0; i < sampled.length; i++) sampled[i] = finite[Math.floor(i * stride)];
    finite = sampled;
  }
  finite.sort();
  const q = new Float64Array(N_QUANTILES);
  if (finite.length === 0) return q.fill(NaN);
  for (let i = 0; i < N_QUANTILES; i++) {
    const pos = (i / (N_QUANTILES - 1)) * (finite.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(finite.length - 1, lo + 1);
    q[i] = finite[lo] + (finite[hi] - finite[lo]) * (pos - lo);
  }
  return q;
}

// --- Strings -----------------------------------------------------------------------------------
/**
 * Read a 1-D string-like dataset or a `nullable-string-array` group (`values` + `mask`,
 * anndata ≥ 0.11) as `string[]`. Numeric datasets (numeric categories) are stringified.
 */
export function readStringArray(src: H5Source, path: string, naValue = 'NA'): string[] {
  const kind = src.kind(path);
  if (kind === 'group') {
    const attrs = src.attrs(path);
    const valuesPath = joinPath(path, 'values');
    if (src.kind(valuesPath) !== 'dataset') {
      throw new ReaderError(`Group ${path} is not a string array`, 'unsupported');
    }
    const values = readStringArray(src, valuesPath, naValue);
    const maskPath = joinPath(path, 'mask');
    if (src.kind(maskPath) === 'dataset') {
      const mask = src.read(maskPath) as ArrayLike<number>;
      const na = str(attrs['na-value']) ?? naValue;
      for (let i = 0; i < values.length; i++) if (mask[i]) values[i] = na;
    }
    return values;
  }
  if (kind !== 'dataset') throw new ReaderError(`Missing string dataset ${path}`, 'missing');
  const raw = src.read(path);
  if (Array.isArray(raw)) return raw.map((x) => (typeof x === 'string' ? x : String(x)));
  if (isTypedArray(raw)) return Array.from(raw as ArrayLike<number>, (x) => String(x));
  if (typeof raw === 'string') return [raw];
  throw new ReaderError(`Cannot decode ${path} as strings`, 'unsupported');
}

function stringLength(src: H5Source, path: string): number | null {
  const kind = src.kind(path);
  if (kind === 'dataset') return src.meta(path)?.shape[0] ?? null;
  if (kind === 'group') return src.meta(joinPath(path, 'values'))?.shape[0] ?? null;
  return null;
}

// --- Dataframes --------------------------------------------------------------------------------
function resolveIndexName(src: H5Source, path: string, attrs: Record<string, unknown>): string {
  const declared = str(attrs['_index']);
  for (const candidate of [declared, '_index', 'index']) {
    if (candidate && src.kind(joinPath(path, candidate))) return candidate;
  }
  return declared ?? '_index';
}

export function describeColumn(src: H5Source, dfPath: string, name: string): ColumnDescriptor {
  const path = joinPath(dfPath, name);
  const kind = src.kind(path);
  const attrs = src.attrs(path);
  const enc = str(attrs['encoding-type']);
  const base: ColumnDescriptor = {
    name,
    path,
    kind: 'unsupported',
    encoding: enc ?? 'unknown',
    dtype: null,
    n: null,
    nCategories: null,
    categories: null,
    ordered: Boolean(attrs['ordered']),
    nullable: false,
    reason: null,
  };
  try {
    if (kind === 'group') {
      const keys = new Set(src.keys(path));
      if (enc === 'categorical' || (keys.has('codes') && keys.has('categories'))) {
        return describeCategorical(
          src,
          base,
          joinPath(path, 'codes'),
          joinPath(path, 'categories'),
          'categorical',
        );
      }
      if (keys.has('values') && keys.has('mask')) {
        const vmeta = src.meta(joinPath(path, 'values'));
        if (!vmeta) return { ...base, reason: 'nullable group without values dataset' };
        if (enc === 'nullable-string-array' || vmeta.isString) {
          return {
            ...base,
            kind: 'string',
            encoding: enc ?? 'nullable-string-array',
            dtype: vmeta.dtype,
            n: vmeta.shape[0],
            nullable: true,
          };
        }
        if (enc === 'nullable-boolean' || vmeta.isBool) {
          return {
            ...base,
            kind: 'boolean',
            encoding: enc ?? 'nullable-boolean',
            dtype: vmeta.dtype,
            n: vmeta.shape[0],
            nullable: true,
          };
        }
        if (vmeta.typeClass === 0 || vmeta.typeClass === 1) {
          return {
            ...base,
            kind: 'numeric',
            encoding: enc ?? 'nullable-integer',
            dtype: vmeta.dtype,
            n: vmeta.shape[0],
            nullable: true,
          };
        }
      }
      return {
        ...base,
        reason: `group with encoding ${enc ?? 'none'} (keys: ${[...keys].join(', ')})`,
      };
    }
    if (kind !== 'dataset') return { ...base, reason: 'missing' };
    const meta = src.meta(path);
    if (!meta) return { ...base, reason: 'unreadable metadata' };
    if ('categories' in attrs) {
      // anndata < 0.8: int codes with an object reference to obs/__categories/<name>
      const target =
        src.dereference(path, attrs['categories']) ??
        (src.kind(joinPath(dfPath, `__categories/${name}`)) === 'dataset'
          ? joinPath(dfPath, `__categories/${name}`)
          : null);
      if (target) return describeCategorical(src, base, path, target, 'categorical-legacy');
    }
    if (meta.shape.length !== 1)
      return { ...base, dtype: meta.dtype, reason: `column with ${meta.shape.length} dimensions` };
    if (meta.isString)
      return {
        ...base,
        kind: 'string',
        encoding: enc ?? 'string-array',
        dtype: meta.dtype,
        n: meta.shape[0],
      };
    if (meta.isBool)
      return {
        ...base,
        kind: 'boolean',
        encoding: enc ?? 'array',
        dtype: meta.dtype,
        n: meta.shape[0],
      };
    if (meta.typeClass === 0 || meta.typeClass === 1) {
      return {
        ...base,
        kind: 'numeric',
        encoding: enc ?? 'array',
        dtype: meta.dtype,
        n: meta.shape[0],
      };
    }
    return { ...base, dtype: meta.dtype, reason: `unsupported HDF5 type class ${meta.typeClass}` };
  } catch (err) {
    return { ...base, reason: `decode error: ${(err as Error).message}` };
  }
}

function describeCategorical(
  src: H5Source,
  base: ColumnDescriptor,
  codesPath: string,
  categoriesPath: string,
  encoding: string,
): ColumnDescriptor {
  const cmeta = src.meta(codesPath);
  const nCategories = stringLength(src, categoriesPath);
  if (!cmeta || nCategories === null)
    return { ...base, reason: 'categorical without codes/categories' };
  const categories =
    nCategories <= EAGER_CATEGORY_LIMIT ? readStringArray(src, categoriesPath) : null;
  return {
    ...base,
    kind: 'categorical',
    encoding,
    dtype: cmeta.dtype,
    n: cmeta.shape[0],
    nCategories,
    categories,
  };
}

export function readDataFrameInfo(src: H5Source, path: string): DataFrameInfo {
  const attrs = src.attrs(path);
  const indexName = resolveIndexName(src, path, attrs);
  const indexPath = src.kind(joinPath(path, indexName)) ? joinPath(path, indexName) : null;
  const keys = src.keys(path);
  let order = stringList(attrs['column-order']);
  if (order === null) order = keys.filter((k) => k !== indexName && k !== '__categories');
  const columns = order.filter((c) => keys.includes(c)).map((c) => describeColumn(src, path, c));
  const n = indexPath
    ? (stringLength(src, indexPath) ?? 0)
    : (columns.find((c) => c.n !== null)?.n ?? 0);
  return {
    path,
    indexName,
    indexPath,
    n,
    columns,
    legacyCategories: keys.includes('__categories'),
  };
}

/** Read the dataframe index as strings (bytes/fixed-length strings are decoded by h5wasm). */
export function readIndex(src: H5Source, df: DataFrameInfo): string[] {
  if (!df.indexPath) return Array.from({ length: df.n }, (_, i) => String(i));
  return readStringArray(src, df.indexPath);
}

/** Read `rows` (sorted or not) of the index via small slices, for tooltips. */
export function readIndexRows(src: H5Source, df: DataFrameInfo, rows: number[]): string[] {
  if (!df.indexPath) return rows.map(String);
  const kind = src.kind(df.indexPath);
  const valuesPath = kind === 'group' ? joinPath(df.indexPath, 'values') : df.indexPath;
  return rows.map((r) => {
    const v = src.slice(valuesPath, [[r, r + 1]]);
    const s = Array.isArray(v) ? v[0] : isTypedArray(v) ? (v as ArrayLike<number>)[0] : v;
    return typeof s === 'string' ? s : String(s);
  });
}

function factorize(values: string[]): { codes: Int32Array; categories: string[] } {
  const categories = [...new Set(values)].sort(compareNatural);
  const index = new Map(categories.map((c, i) => [c, i]));
  const codes = new Int32Array(values.length);
  for (let i = 0; i < values.length; i++) codes[i] = index.get(values[i]) ?? -1;
  return { codes, categories };
}

/** Decode one obs/var column. String and boolean columns come back factorised as categoricals. */
export function readColumn(src: H5Source, df: DataFrameInfo, name: string): ColumnData {
  const desc = df.columns.find((c) => c.name === name) ?? describeColumn(src, df.path, name);
  const path = desc.path;
  switch (desc.kind) {
    case 'categorical': {
      const legacy = desc.encoding === 'categorical-legacy';
      const codesPath = legacy ? path : joinPath(path, 'codes');
      const categoriesPath = legacy
        ? (src.dereference(path, src.attrs(path)['categories']) ??
          joinPath(df.path, `__categories/${name}`))
        : joinPath(path, 'categories');
      const categories = desc.categories ?? readStringArray(src, categoriesPath);
      const codes = toInt32(src.read(codesPath));
      let nMissing = 0;
      for (let i = 0; i < codes.length; i++) {
        if (codes[i] < 0 || codes[i] >= categories.length) {
          codes[i] = -1;
          nMissing++;
        }
      }
      return { kind: 'categorical', name, codes, categories, nMissing, source: 'categorical' };
    }
    case 'boolean': {
      const valuesPath = desc.nullable ? joinPath(path, 'values') : path;
      const codes = toInt32(src.read(valuesPath));
      let nMissing = 0;
      if (desc.nullable) {
        const mask = src.read(joinPath(path, 'mask')) as ArrayLike<number>;
        for (let i = 0; i < codes.length; i++) {
          if (mask[i]) {
            codes[i] = -1;
            nMissing++;
          }
        }
      }
      for (let i = 0; i < codes.length; i++) if (codes[i] > 1) codes[i] = 1;
      return {
        kind: 'categorical',
        name,
        codes,
        categories: ['False', 'True'],
        nMissing,
        source: 'boolean',
      };
    }
    case 'string': {
      const values = readStringArray(src, path);
      const { codes, categories } = factorize(values);
      return { kind: 'categorical', name, codes, categories, nMissing: 0, source: 'string' };
    }
    case 'numeric': {
      const valuesPath = desc.nullable ? joinPath(path, 'values') : path;
      const meta = src.meta(valuesPath);
      let values = toNumericColumn(src.read(valuesPath), meta);
      let nMissing = 0;
      if (desc.nullable) {
        const mask = src.read(joinPath(path, 'mask')) as ArrayLike<number>;
        if (!(values instanceof Float32Array || values instanceof Float64Array))
          values = Float64Array.from(values);
        for (let i = 0; i < values.length; i++) {
          if (mask[i]) {
            values[i] = NaN;
            nMissing++;
          }
        }
      } else if (values instanceof Float32Array || values instanceof Float64Array) {
        for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i])) nMissing++;
      }
      return { kind: 'numeric', name, values, nMissing, quantiles: computeQuantiles(values) };
    }
    default:
      throw new ReaderError(
        `Column ${name} is unsupported: ${desc.reason ?? desc.encoding}`,
        'unsupported',
      );
  }
}

// --- Matrices ----------------------------------------------------------------------------------
export function readMatrixInfo(
  src: H5Source,
  path: string,
  fallbackShape?: [number, number],
): MatrixInfo | null {
  const kind = src.kind(path);
  if (kind === 'dataset') {
    const m = src.meta(path);
    if (!m || m.shape.length !== 2) return null;
    return {
      path,
      format: 'dense',
      shape: [m.shape[0], m.shape[1]],
      dtype: m.dtype,
      nnz: null,
      indexDtype: null,
      chunks: m.chunks,
      filters: m.filters,
    };
  }
  if (kind !== 'group') return null;
  const attrs = src.attrs(path);
  const keys = new Set(src.keys(path));
  if (!(keys.has('data') && keys.has('indices') && keys.has('indptr'))) return null;
  const enc = str(attrs['encoding-type']) ?? str(attrs['h5sparse_format']) ?? '';
  const format = enc.startsWith('csc') ? 'csc' : enc.startsWith('csr') ? 'csr' : null;
  const data = src.meta(joinPath(path, 'data'));
  const indices = src.meta(joinPath(path, 'indices'));
  const indptr = src.meta(joinPath(path, 'indptr'));
  if (!data || !indices || !indptr) return null;
  let shape = numberList(attrs['shape']) ?? numberList(attrs['h5sparse_shape']);
  let fmt: MatrixFormat | null = format;
  if (!shape && fallbackShape) shape = fallbackShape;
  if (!fmt) {
    // Legacy files without a format attribute: infer from indptr length.
    if (shape && indptr.shape[0] === shape[0] + 1) fmt = 'csr';
    else if (shape && indptr.shape[0] === shape[1] + 1) fmt = 'csc';
    else return null;
  }
  if (!shape || shape.length !== 2) return null;
  return {
    path,
    format: fmt,
    shape: [shape[0], shape[1]],
    dtype: data.dtype,
    nnz: data.shape[0],
    indexDtype: indices.dtype,
    chunks: data.chunks,
    filters: [...data.filters, ...indices.filters],
  };
}

/**
 * In-memory CSC view of a CSR matrix, built with two chunked passes over `indices`/`data`
 * (count, then fill). After that any gene column is an O(nnz_column) slice. Rows come out sorted.
 */
export class CsrColumnIndex {
  private constructor(
    readonly nRows: number,
    readonly nCols: number,
    readonly colPtr: Float64Array,
    readonly rows: Int32Array,
    readonly data: Float32Array,
  ) {}

  column(j: number): { rows: Int32Array; data: Float32Array } {
    const s = this.colPtr[j];
    const e = this.colPtr[j + 1];
    return { rows: this.rows.subarray(s, e), data: this.data.subarray(s, e) };
  }

  static async build(
    src: H5Source,
    m: MatrixInfo,
    indptr: Float64Array,
    opts: { onProgress?: ProgressFn; shouldCancel?: () => boolean; chunk?: number } = {},
  ): Promise<CsrColumnIndex> {
    const nnz = m.nnz ?? 0;
    const [nRows, nCols] = m.shape;
    const chunk = opts.chunk ?? CHUNK_ENTRIES;
    const counts = new Float64Array(nCols + 1);
    const indicesPath = joinPath(m.path, 'indices');
    const dataPath = joinPath(m.path, 'data');
    const total = 2 * nnz;
    for (let s = 0; s < nnz; s += chunk) {
      const e = Math.min(nnz, s + chunk);
      const ind = src.slice(indicesPath, [[s, e]]) as ArrayLike<number>;
      for (let k = 0; k < ind.length; k++) counts[ind[k] + 1]++;
      opts.onProgress?.({ stage: 'index', done: e, total });
      await yieldToEventLoop();
      if (opts.shouldCancel?.()) throw new ReaderError('cancelled', 'cancelled');
    }
    for (let j = 1; j <= nCols; j++) counts[j] += counts[j - 1];
    const colPtr = counts;
    const pos = Float64Array.from(colPtr);
    const rows = new Int32Array(nnz);
    const data = new Float32Array(nnz);
    let row = 0;
    for (let s = 0; s < nnz; s += chunk) {
      const e = Math.min(nnz, s + chunk);
      const ind = src.slice(indicesPath, [[s, e]]) as ArrayLike<number>;
      const dat = src.slice(dataPath, [[s, e]]) as ArrayLike<number>;
      for (let k = 0; k < ind.length; k++) {
        const p = s + k;
        while (row < nRows && p >= indptr[row + 1]) row++;
        const c = ind[k];
        const dst = pos[c]++;
        rows[dst] = row;
        data[dst] = Number(dat[k]);
      }
      opts.onProgress?.({ stage: 'index', done: nnz + e, total });
      await yieldToEventLoop();
      if (opts.shouldCancel?.()) throw new ReaderError('cancelled', 'cancelled');
    }
    return new CsrColumnIndex(nRows, nCols, colPtr, rows, data);
  }
}

export interface MatrixCache {
  indptr: Map<string, Float64Array>;
  csrIndex: Map<string, CsrColumnIndex>;
}

export function createMatrixCache(): MatrixCache {
  return { indptr: new Map(), csrIndex: new Map() };
}

function getIndptr(src: H5Source, m: MatrixInfo, cache: MatrixCache): Float64Array {
  let ip = cache.indptr.get(m.path);
  if (!ip) {
    ip = toFloat64(src.read(joinPath(m.path, 'indptr')));
    cache.indptr.set(m.path, ip);
  }
  return ip;
}

/** Extract one column (gene) of `X`, `layers/*` or `raw/X` as a dense Float32Array over all cells. */
export async function readGeneVector(
  src: H5Source,
  m: MatrixInfo,
  j: number,
  cache: MatrixCache,
  opts: {
    onProgress?: ProgressFn;
    shouldCancel?: () => boolean;
    allowIndex?: boolean;
    chunk?: number;
  } = {},
): Promise<GeneVector> {
  const [nRows, nCols] = m.shape;
  if (j < 0 || j >= nCols)
    throw new ReaderError(`Gene index ${j} out of range (${nCols})`, 'missing');
  const values = new Float32Array(nRows);
  let nnz = 0;
  if (m.format === 'dense') {
    const col = src.slice(m.path, [
      [0, nRows],
      [j, j + 1],
    ]) as ArrayLike<number>;
    for (let i = 0; i < nRows; i++) {
      const v = Number(col[i]);
      values[i] = v;
      if (v !== 0) nnz++;
    }
  } else if (m.format === 'csc') {
    const indptr = getIndptr(src, m, cache);
    const s = indptr[j];
    const e = indptr[j + 1];
    if (e > s) {
      const rows = src.slice(joinPath(m.path, 'indices'), [[s, e]]) as ArrayLike<number>;
      const dat = src.slice(joinPath(m.path, 'data'), [[s, e]]) as ArrayLike<number>;
      for (let k = 0; k < rows.length; k++) {
        values[rows[k]] = Number(dat[k]);
        nnz++;
      }
    }
  } else {
    const indptr = getIndptr(src, m, cache);
    const totalNnz = m.nnz ?? indptr[nRows];
    let index = cache.csrIndex.get(m.path);
    if (!index && (opts.allowIndex ?? true) && totalNnz <= CSR_INDEX_MAX_NNZ) {
      index = await CsrColumnIndex.build(src, m, indptr, opts);
      cache.csrIndex.set(m.path, index);
    }
    if (index) {
      const col = index.column(j);
      for (let k = 0; k < col.rows.length; k++) values[col.rows[k]] = col.data[k];
      nnz = col.rows.length;
    } else {
      // Chunked scan of the whole indices array for the requested column only.
      const chunk = opts.chunk ?? CHUNK_ENTRIES;
      const indicesPath = joinPath(m.path, 'indices');
      const dataPath = joinPath(m.path, 'data');
      let row = 0;
      for (let s = 0; s < totalNnz; s += chunk) {
        const e = Math.min(totalNnz, s + chunk);
        const ind = src.slice(indicesPath, [[s, e]]) as ArrayLike<number>;
        let dat: ArrayLike<number> | null = null;
        for (let k = 0; k < ind.length; k++) {
          if (ind[k] !== j) continue;
          const p = s + k;
          while (row < nRows && p >= indptr[row + 1]) row++;
          dat ??= src.slice(dataPath, [[s, e]]) as ArrayLike<number>;
          values[row] = Number(dat[k]);
          nnz++;
        }
        if (dat === null) {
          // still need to advance `row` past this chunk
          while (row < nRows && e > indptr[row + 1]) row++;
        }
        opts.onProgress?.({ stage: 'gene', done: e, total: totalNnz });
        await yieldToEventLoop();
        if (opts.shouldCancel?.()) throw new ReaderError('cancelled', 'cancelled');
      }
    }
  }
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < nRows; i++) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { matrix: m.path, index: j, values, nnz, min, max, quantiles: computeQuantiles(values) };
}

// --- obsm / uns ---------------------------------------------------------------------------------
export function readObsmInfo(src: H5Source): Record<string, ObsmInfo> {
  const out: Record<string, ObsmInfo> = {};
  if (src.kind('obsm') !== 'group') return out;
  for (const key of src.keys('obsm')) {
    const path = joinPath('obsm', key);
    const kind = src.kind(path);
    if (kind === 'dataset') {
      const m = src.meta(path);
      out[key] = {
        key,
        path,
        kind: 'array',
        shape: m?.shape ?? null,
        dtype: m?.dtype ?? null,
        columns: null,
      };
    } else if (kind === 'group') {
      const attrs = src.attrs(path);
      const isDf = str(attrs['encoding-type']) === 'dataframe';
      out[key] = {
        key,
        path,
        kind: isDf ? 'dataframe' : 'group',
        shape: null,
        dtype: null,
        columns: isDf ? (stringList(attrs['column-order']) ?? src.keys(path)) : src.keys(path),
      };
    }
  }
  return out;
}

function readScalarNumber(src: H5Source, path: string): number | null {
  if (src.kind(path) !== 'dataset') return null;
  const m = src.meta(path);
  if (!m || (m.typeClass !== 0 && m.typeClass !== 1)) return null;
  const v = src.read(path);
  if (typeof v === 'number') return v;
  if (isTypedArray(v) && (v as ArrayLike<number>).length === 1)
    return Number((v as ArrayLike<number>)[0]);
  return null;
}

function readScalarAny(src: H5Source, path: string): string | number | boolean | null {
  if (src.kind(path) !== 'dataset') return null;
  const m = src.meta(path);
  if (!m || m.shape.length > 1 || (m.shape.length === 1 && m.shape[0] > 1)) return null;
  const v = src.read(path);
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v) && v.length === 1) return v[0] as string | number;
  if (isTypedArray(v) && (v as ArrayLike<number>).length === 1)
    return Number((v as ArrayLike<number>)[0]);
  return null;
}

export function readUnsSpatial(src: H5Source): UnsSpatialLibrary[] | null {
  if (src.kind('uns/spatial') !== 'group') return null;
  const libs: UnsSpatialLibrary[] = [];
  for (const id of src.keys('uns/spatial')) {
    const path = joinPath('uns/spatial', id);
    if (src.kind(path) !== 'group') continue;
    const keys = src.keys(path);
    const images: ImageInfo[] = [];
    if (src.kind(joinPath(path, 'images')) === 'group') {
      for (const ik of src.keys(joinPath(path, 'images'))) {
        const ipath = joinPath(path, `images/${ik}`);
        const m = src.meta(ipath);
        if (!m || m.shape.length < 2) continue;
        images.push({
          key: ik,
          path: ipath,
          shape: m.shape,
          dtype: m.dtype,
          height: m.shape[0],
          width: m.shape[1],
          channels: m.shape.length === 3 ? m.shape[2] : 1,
        });
      }
    }
    const scalefactors: Record<string, number> = {};
    if (src.kind(joinPath(path, 'scalefactors')) === 'group') {
      for (const sk of src.keys(joinPath(path, 'scalefactors'))) {
        const v = readScalarNumber(src, joinPath(path, `scalefactors/${sk}`));
        if (v !== null) scalefactors[sk] = v;
      }
    }
    libs.push({
      id,
      path,
      images,
      scalefactors,
      hasScalef: 'tissue_hires_scalef' in scalefactors || 'tissue_lowres_scalef' in scalefactors,
      extraKeys: keys.filter((k) => k !== 'images' && k !== 'scalefactors'),
    });
  }
  return libs;
}

export function readUnsSummary(src: H5Source, obsColumns: ColumnDescriptor[]): UnsSummary {
  const out: UnsSummary = {
    present: src.kind('uns') === 'group',
    keys: [],
    spatial: null,
    colors: {},
    moranI: null,
    spatialNeighbors: null,
    squidpyResults: [],
  };
  if (!out.present) return out;
  out.keys = src.keys('uns');
  for (const k of out.keys) {
    const path = joinPath('uns', k);
    if (k.endsWith('_colors') && src.kind(path) === 'dataset') {
      const n = src.meta(path)?.shape[0] ?? 0;
      out.colors[k.slice(0, -'_colors'.length)] = { path, n };
    }
    for (const suffix of ['_nhood_enrichment', '_co_occurrence', '_centrality_scores']) {
      if (k.endsWith(suffix)) out.squidpyResults.push(k);
    }
    if (k.includes('_ripley_')) out.squidpyResults.push(k);
  }
  if (src.kind('uns/moranI') === 'group') {
    const df = readDataFrameInfo(src, 'uns/moranI');
    out.moranI = { path: 'uns/moranI', n: df.n, columns: df.columns.map((c) => c.name) };
  }
  if (src.kind('uns/spatial_neighbors/params') === 'group') {
    const params: Record<string, string | number | boolean | null> = {};
    for (const pk of src.keys('uns/spatial_neighbors/params')) {
      params[pk] = readScalarAny(src, joinPath('uns/spatial_neighbors/params', pk));
    }
    out.spatialNeighbors = params;
  }
  out.spatial = readUnsSpatial(src);
  void obsColumns;
  return out;
}

/** `uns/<column>_colors`, validated against the category count; null → use a generated palette. */
export function readCategoryColors(
  src: H5Source,
  column: string,
  nCategories: number,
): string[] | null {
  const path = joinPath('uns', `${column}_colors`);
  if (src.kind(path) !== 'dataset') return null;
  const colors = readStringArray(src, path);
  if (colors.length !== nCategories) return null;
  const hex = /^#([0-9a-f]{6}|[0-9a-f]{8}|[0-9a-f]{3})$/i;
  return colors.every((c) => hex.test(c)) ? colors : null;
}

export function readMoranI(src: H5Source): MoranI | null {
  if (src.kind('uns/moranI') !== 'group') return null;
  const df = readDataFrameInfo(src, 'uns/moranI');
  const genes = readIndex(src, df);
  const iCol = df.columns.find((c) => c.name === 'I');
  if (!iCol) return null;
  const I = toFloat64(src.read(iCol.path));
  return { genes, I, columns: df.columns.map((c) => c.name) };
}

// --- Spatial detection ---------------------------------------------------------------------------
export function detectSpatial(
  obsm: Record<string, ObsmInfo>,
  obsColumns: ColumnDescriptor[],
  hasImages: boolean,
): SpatialDetection {
  const arrays = Object.values(obsm).filter(
    (o) => o.kind === 'array' && o.shape && o.shape.length === 2,
  );
  const candidates = arrays.map((o) => ({ key: o.key, ncols: o.shape![1] }));
  const ordered = [
    ...SPATIAL_KEYS_3D_ORDER.filter((k) => obsm[k]),
    ...Object.keys(obsm)
      .filter((k) => !SPATIAL_KEYS_3D_ORDER.includes(k) && /spatial|xyz/i.test(k))
      .sort(),
  ];
  const result: SpatialDetection = {
    key: null,
    ndim: 0,
    method: 'none',
    zSource: null,
    refs: null,
    flipYDefault: hasImages,
    candidates,
  };
  let best2d: ObsmInfo | null = null;
  for (const k of ordered) {
    const o = obsm[k];
    if (o.kind !== 'array' || !o.shape || o.shape.length !== 2) continue;
    if (o.shape[1] === 3) {
      return {
        ...result,
        key: o.path,
        ndim: 3,
        method: 'native3d',
        refs: {
          x: { path: o.path, column: 0 },
          y: { path: o.path, column: 1 },
          z: { path: o.path, column: 2 },
        },
      };
    }
    if (o.shape[1] === 2 && !best2d) best2d = o;
  }
  if (best2d) {
    const p = best2d.path;
    const zCol = Z_OBS_KEYS.map((z) =>
      obsColumns.find((c) => c.name === z && c.kind === 'numeric'),
    ).find(Boolean);
    return {
      ...result,
      key: p,
      ndim: 2,
      method: zCol ? '2d+obs_z' : '2d',
      zSource: zCol ? zCol.path : null,
      refs: {
        x: { path: p, column: 0 },
        y: { path: p, column: 1 },
        z: zCol ? { path: zCol.path, column: null } : null,
      },
    };
  }
  return result;
}

export function detectLibrary(
  obsColumns: ColumnDescriptor[],
  unsSpatial: UnsSpatialLibrary[] | null,
  discreteZ: { categoriesMatch: (col: ColumnDescriptor) => boolean } | null,
): LibraryDetection {
  const cats = obsColumns.filter((c) => c.kind === 'categorical' && c.categories);
  const none: LibraryDetection = {
    key: null,
    column: null,
    method: 'none',
    matchesUnsSpatial: null,
    warning: null,
  };
  if (unsSpatial && unsSpatial.length > 0) {
    const ids = new Set(unsSpatial.map((l) => l.id));
    const exact = cats.find(
      (c) => c.categories!.length === ids.size && c.categories!.every((x) => ids.has(x)),
    );
    if (exact)
      return {
        key: exact.path,
        column: exact.name,
        method: 'uns_spatial_exact',
        matchesUnsSpatial: true,
        warning: null,
      };
    const partial = cats.find((c) => c.categories!.some((x) => ids.has(x)));
    if (partial) {
      return {
        key: partial.path,
        column: partial.name,
        method: 'uns_spatial_partial',
        matchesUnsSpatial: false,
        warning: `obs/${partial.name} only partially matches the uns/spatial keys; sections ordered by category name`,
      };
    }
    none.warning = 'uns/spatial exists but no obs column matches its keys';
  }
  for (const name of LIBRARY_KEY_CANDIDATES) {
    const c = obsColumns.find(
      (c) => c.name === name && (c.kind === 'categorical' || c.kind === 'string'),
    );
    if (c) return { ...none, key: c.path, column: c.name, method: 'candidate_name' };
  }
  if (discreteZ) {
    const c = cats.find((c) => discreteZ.categoriesMatch(c));
    if (c) return { ...none, key: c.path, column: c.name, method: 'discrete_z' };
  }
  return none;
}

// --- Coordinates + section model ---------------------------------------------------------------
function readColumnRef(src: H5Source, ref: ColumnRef, n: number): Float64Array {
  const meta = src.meta(ref.path);
  if (!meta) throw new ReaderError(`Coordinate source ${ref.path} not found`, 'missing');
  if (ref.column === null) {
    if (meta.shape.length !== 1)
      throw new ReaderError(`${ref.path} is not a 1-D column`, 'unsupported');
    if (meta.shape[0] !== n)
      throw new ReaderError(
        `${ref.path} has ${meta.shape[0]} rows, expected ${n}`,
        'shape-mismatch',
      );
    const kind = src.kind(ref.path);
    return toFloat64(src.read(kind === 'group' ? joinPath(ref.path, 'values') : ref.path));
  }
  if (meta.shape.length !== 2)
    throw new ReaderError(`${ref.path} is not a 2-D array`, 'unsupported');
  if (meta.shape[0] !== n) {
    throw new ReaderError(
      `${ref.path} has ${meta.shape[0]} rows but obs has ${n} — obsm/obs mismatch`,
      'shape-mismatch',
    );
  }
  if (ref.column >= meta.shape[1])
    throw new ReaderError(`${ref.path} has no column ${ref.column}`, 'missing');
  return toFloat64(
    src.slice(ref.path, [
      [0, n],
      [ref.column, ref.column + 1],
    ]),
  );
}

/** Read a coordinate spec; when all refs share one 2-D dataset it is read once and de-interleaved. */
export function readCoordinates(
  src: H5Source,
  spec: CoordinateSpec,
  n: number,
): { x: Float64Array; y: Float64Array; z: Float64Array | null } {
  const refs = [spec.x, spec.y, spec.z].filter((r): r is ColumnRef => r !== null);
  const samePath = refs.every((r) => r.path === spec.x.path && r.column !== null);
  const meta = src.meta(spec.x.path);
  if (samePath && meta && meta.shape.length === 2 && meta.shape[1] <= 4) {
    if (meta.shape[0] !== n) {
      throw new ReaderError(
        `${spec.x.path} has ${meta.shape[0]} rows but obs has ${n} — obsm/obs mismatch`,
        'shape-mismatch',
      );
    }
    const flat = toFloat64(src.read(spec.x.path));
    const ncol = meta.shape[1];
    const pick = (c: number) => {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = flat[i * ncol + c];
      return out;
    };
    return {
      x: pick(spec.x.column!),
      y: pick(spec.y.column!),
      z: spec.z ? pick(spec.z.column!) : null,
    };
  }
  return {
    x: readColumnRef(src, spec.x, n),
    y: readColumnRef(src, spec.y, n),
    z: spec.z ? readColumnRef(src, spec.z, n) : null,
  };
}

export function uniqueSorted(values: Float64Array, limit: number): number[] | null {
  const set = new Set<number>();
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    set.add(v);
    if (set.size > limit) return null;
  }
  return [...set].sort((a, b) => a - b);
}

export interface SectionSourceInfo {
  codes: Int32Array;
  categories: string[];
}

/**
 * Build the section model: order sections by `uns/spatial` key order when the categories match,
 * else by natural sort of the names; compute per-section counts, bboxes and discrete z.
 */
export function buildSections(
  lib: SectionSourceInfo | null,
  coords: { x: Float64Array; y: Float64Array; z: Float64Array | null },
  valid: Uint8Array,
  unsSpatial: UnsSpatialLibrary[] | null,
  matchesUnsSpatial: boolean,
): {
  sections: SectionInfo[];
  sectionOf: Uint16Array | null;
  orderSource: SpatialData['orderSource'];
  nWithoutSection: number;
} {
  const n = coords.x.length;
  if (!lib) return { sections: [], sectionOf: null, orderSource: 'none', nWithoutSection: 0 };
  const { codes, categories } = lib;
  let order: number[];
  let orderSource: SpatialData['orderSource'];
  if (unsSpatial && matchesUnsSpatial) {
    const byName = new Map(categories.map((c, i) => [c, i]));
    order = unsSpatial.map((l) => byName.get(l.id)).filter((i): i is number => i !== undefined);
    for (let i = 0; i < categories.length; i++) if (!order.includes(i)) order.push(i);
    orderSource = 'uns_spatial';
  } else {
    order = categories
      .map((_, i) => i)
      .sort((a, b) => compareNatural(categories[a], categories[b]));
    orderSource = 'natural';
  }
  const ordinalOfCode = new Int32Array(categories.length).fill(-1);
  order.forEach((code, ordinal) => (ordinalOfCode[code] = ordinal));
  const nSec = order.length;
  const counts = new Float64Array(nSec);
  const mins = Array.from({ length: nSec }, () => [Infinity, Infinity, Infinity]);
  const maxs = Array.from({ length: nSec }, () => [-Infinity, -Infinity, -Infinity]);
  const zSets: (Set<number> | null)[] = Array.from({ length: nSec }, () => new Set<number>());
  const sectionOf = new Uint16Array(n);
  let nWithoutSection = 0;
  for (let i = 0; i < n; i++) {
    const code = codes[i];
    const ord = code >= 0 && code < categories.length ? ordinalOfCode[code] : -1;
    if (ord < 0) {
      nWithoutSection++;
      sectionOf[i] = 0xffff;
      continue;
    }
    sectionOf[i] = ord;
    if (!valid[i]) continue;
    counts[ord]++;
    const x = coords.x[i];
    const y = coords.y[i];
    const z = coords.z ? coords.z[i] : 0;
    const mn = mins[ord];
    const mx = maxs[ord];
    if (x < mn[0]) mn[0] = x;
    if (y < mn[1]) mn[1] = y;
    if (z < mn[2]) mn[2] = z;
    if (x > mx[0]) mx[0] = x;
    if (y > mx[1]) mx[1] = y;
    if (z > mx[2]) mx[2] = z;
    const zs = zSets[ord];
    if (zs) {
      zs.add(z);
      if (zs.size > 8) zSets[ord] = null;
    }
  }
  const libById = new Map((unsSpatial ?? []).map((l) => [l.id, l]));
  const sections: SectionInfo[] = order.map((code, ordinal) => {
    const name = categories[code];
    const l = libById.get(name);
    const zs = zSets[ordinal];
    const sf = l?.scalefactors ?? {};
    return {
      id: name,
      name,
      ordinal,
      code,
      nCells: counts[ordinal],
      z: zs && zs.size === 1 ? [...zs][0] : null,
      bbox:
        counts[ordinal] > 0
          ? {
              min: mins[ordinal] as [number, number, number],
              max: maxs[ordinal] as [number, number, number],
            }
          : null,
      hasImage: Boolean(l && l.images.length > 0),
      imageKeys: l ? l.images.map((im) => im.key) : [],
      imageShapes: l ? Object.fromEntries(l.images.map((im) => [im.key, im.shape])) : {},
      spotDiameter: sf['spot_diameter_fullres'] ?? null,
      hiresScalef: sf['tissue_hires_scalef'] ?? null,
      lowresScalef: sf['tissue_lowres_scalef'] ?? null,
      placementKnown: Boolean(l?.hasScalef),
    };
  });
  return { sections, sectionOf, orderSource, nWithoutSection };
}

/**
 * Read coordinates for `spec`, drop non-finite rows, centre and scale to a unit cube in float64,
 * and attach the section model. `libraryColumn` is the decoded library column (or null).
 */
export function readSpatialData(
  src: H5Source,
  spec: CoordinateSpec,
  n: number,
  libraryColumn: SectionSourceInfo | null,
  unsSpatial: UnsSpatialLibrary[] | null,
  matchesUnsSpatial: boolean,
): SpatialData {
  const coords = readCoordinates(src, spec, n);
  const valid = new Uint8Array(n);
  let nDropped = 0;
  const rawMin: [number, number, number] = [Infinity, Infinity, Infinity];
  const rawMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const x = coords.x[i];
    const y = coords.y[i];
    const z = coords.z ? coords.z[i] : 0;
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      valid[i] = 1;
      if (x < rawMin[0]) rawMin[0] = x;
      if (y < rawMin[1]) rawMin[1] = y;
      if (z < rawMin[2]) rawMin[2] = z;
      if (x > rawMax[0]) rawMax[0] = x;
      if (y > rawMax[1]) rawMax[1] = y;
      if (z > rawMax[2]) rawMax[2] = z;
    } else {
      nDropped++;
    }
  }
  if (nDropped === n) {
    rawMin.fill(0);
    rawMax.fill(0);
  }
  const center: [number, number, number] = [
    (rawMin[0] + rawMax[0]) / 2,
    (rawMin[1] + rawMax[1]) / 2,
    (rawMin[2] + rawMax[2]) / 2,
  ];
  const extent = Math.max(rawMax[0] - rawMin[0], rawMax[1] - rawMin[1], rawMax[2] - rawMin[2]);
  const scale = extent > 0 ? 1 / extent : 1;
  const xyz = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    if (!valid[i]) continue;
    xyz[i * 3] = (coords.x[i] - center[0]) * scale;
    xyz[i * 3 + 1] = (coords.y[i] - center[1]) * scale;
    xyz[i * 3 + 2] = ((coords.z ? coords.z[i] : 0) - center[2]) * scale;
  }
  const { sections, sectionOf, orderSource, nWithoutSection } = buildSections(
    libraryColumn,
    coords,
    valid,
    unsSpatial,
    matchesUnsSpatial,
  );
  const zLevels = coords.z ? uniqueSorted(coords.z, DISCRETE_Z_LIMIT) : null;
  return {
    spec,
    n,
    ndim: coords.z ? 3 : 2,
    xyz,
    valid,
    nDropped,
    center,
    scale,
    rawMin,
    rawMax,
    sectionOf,
    sections,
    orderSource,
    nWithoutSection,
    zLevels,
  };
}

// --- Images ------------------------------------------------------------------------------------
/**
 * Read one tissue image and convert it to RGBA uint8, box-downscaling by an integer factor so the
 * longest side is ≤ `maxSide`. Float images are assumed to be in [0, 1] unless values exceed 1.
 */
/** Largest image read into memory: 512 M samples (about 13k × 13k RGB), checked before any allocation. */
export const MAX_IMAGE_SAMPLES = 512 * 1024 * 1024;

export function readImage(src: H5Source, info: ImageInfo, maxSide: number): DecodedImage {
  const samples = info.height * info.width * info.channels;
  if (!(info.height > 0 && info.width > 0 && info.channels > 0) || samples > MAX_IMAGE_SAMPLES) {
    throw new ReaderError(
      `Image ${info.path} is ${info.width}×${info.height}×${info.channels}, too large to decode in a browser tab; downscale it with scripts/prepare_h5ad.py --downscale-images`,
      'unsupported',
    );
  }
  const raw = src.read(info.path);
  if (!isTypedArray(raw)) throw new ReaderError(`Image ${info.path} is not numeric`, 'unsupported');
  const arr = raw as ArrayLike<number>;
  const H = info.height;
  const W = info.width;
  const C = info.channels;
  const meta = src.meta(info.path);
  let scale = 1;
  if (meta && meta.typeClass === 1) {
    let mx = 0;
    const step = Math.max(1, Math.floor(arr.length / 65536));
    for (let i = 0; i < arr.length; i += step) if (arr[i] > mx) mx = arr[i];
    scale = mx > 1.0001 ? 1 : 255;
  } else if (meta && meta.size === 2) {
    scale = 1 / 257;
  }
  const f = Math.max(1, Math.ceil(Math.max(H, W) / maxSide));
  const h = Math.ceil(H / f);
  const w = Math.ceil(W / f);
  const out = new Uint8ClampedArray(w * h * 4);
  const acc = new Float64Array(4);
  for (let oy = 0; oy < h; oy++) {
    for (let ox = 0; ox < w; ox++) {
      acc.fill(0);
      let count = 0;
      for (let dy = 0; dy < f; dy++) {
        const y = oy * f + dy;
        if (y >= H) break;
        for (let dx = 0; dx < f; dx++) {
          const x = ox * f + dx;
          if (x >= W) break;
          const p = (y * W + x) * C;
          if (C === 1) {
            const g = arr[p] * scale;
            acc[0] += g;
            acc[1] += g;
            acc[2] += g;
            acc[3] += 255;
          } else {
            acc[0] += arr[p] * scale;
            acc[1] += arr[p + 1] * scale;
            acc[2] += arr[p + 2] * scale;
            acc[3] += C >= 4 ? arr[p + 3] * scale : 255;
          }
          count++;
        }
      }
      const o = (oy * w + ox) * 4;
      out[o] = acc[0] / count;
      out[o + 1] = acc[1] / count;
      out[o + 2] = acc[2] / count;
      out[o + 3] = acc[3] / count;
    }
  }
  return { width: w, height: h, data: out, sourceShape: info.shape, downscale: f };
}

// --- Spatial graph -----------------------------------------------------------------------------
/** Edge pairs (i < j) of a sparse adjacency in `obsp`, uniformly subsampled above `maxEdges`. */
export async function readGraphEdges(
  src: H5Source,
  m: MatrixInfo,
  opts: {
    maxEdges?: number;
    onProgress?: ProgressFn;
    shouldCancel?: () => boolean;
    chunkRows?: number;
  } = {},
): Promise<GraphEdges> {
  const maxEdges = opts.maxEdges ?? 1_000_000;
  const [nRows, nCols] = m.shape;
  const push = (pairs: number[], i: number, j: number) => {
    if (i < j) pairs.push(i, j);
    else if (j < i) pairs.push(j, i);
  };
  const collected: number[] = [];
  if (m.format === 'dense') {
    if (nRows * nCols > DENSE_GRAPH_MAX_ELEMENTS) {
      throw new ReaderError(
        `Dense graph ${m.path} has ${nRows * nCols} elements; refusing to read`,
        'memory',
      );
    }
    const flat = src.read(m.path) as ArrayLike<number>;
    for (let i = 0; i < nRows; i++) {
      for (let j = i + 1; j < nCols; j++) if (flat[i * nCols + j] !== 0) collected.push(i, j);
    }
  } else {
    const indptr = toFloat64(src.read(joinPath(m.path, 'indptr')));
    const nOuter = indptr.length - 1;
    const chunkRows = opts.chunkRows ?? 50_000;
    for (let r0 = 0; r0 < nOuter; r0 += chunkRows) {
      const r1 = Math.min(nOuter, r0 + chunkRows);
      const s = indptr[r0];
      const e = indptr[r1];
      if (e > s) {
        const ind = src.slice(joinPath(m.path, 'indices'), [[s, e]]) as ArrayLike<number>;
        let row = r0;
        for (let k = 0; k < ind.length; k++) {
          const p = s + k;
          while (p >= indptr[row + 1]) row++;
          // CSR: row = i, ind = j. CSC: outer = column j, ind = row i — same unordered pair.
          push(collected, row, ind[k]);
        }
      }
      opts.onProgress?.({ stage: 'graph', done: r1, total: nOuter });
      await yieldToEventLoop();
      if (opts.shouldCancel?.()) throw new ReaderError('cancelled', 'cancelled');
    }
  }
  // Symmetric matrices list every edge twice; dedupe by sorting pairs.
  const nPairs = collected.length / 2;
  const keys = new Float64Array(nPairs);
  for (let k = 0; k < nPairs; k++) keys[k] = collected[2 * k] * 4294967296 + collected[2 * k + 1];
  keys.sort();
  const unique: number[] = [];
  let prev = -1;
  for (let k = 0; k < nPairs; k++) {
    if (keys[k] !== prev) {
      unique.push(keys[k]);
      prev = keys[k];
    }
  }
  const nTotal = unique.length;
  const subsampled = nTotal > maxEdges;
  const nEdges = subsampled ? maxEdges : nTotal;
  const pairs = new Uint32Array(nEdges * 2);
  const stride = subsampled ? nTotal / maxEdges : 1;
  for (let k = 0; k < nEdges; k++) {
    const key = unique[Math.floor(k * stride)];
    const i = Math.floor(key / 4294967296);
    pairs[2 * k] = i;
    pairs[2 * k + 1] = key - i * 4294967296;
  }
  return { pairs, nEdges, nTotal, subsampled };
}

// --- Summary -----------------------------------------------------------------------------------
export function isDefaultClusterColumn(name: string): number {
  const n = name.toLowerCase();
  for (let i = 0; i < CLUSTER_PRIORITY.length; i++) {
    const p = CLUSTER_PRIORITY[i];
    if (n === p || n.startsWith(p) || (p === 'cluster' && n.includes('cluster'))) return i;
  }
  return CLUSTER_PRIORITY.length;
}

/** Pick the default categorical color-by column (leiden > louvain > *cluster* > cell_type > first). */
export function defaultColorColumn(
  obs: DataFrameInfo,
  libraryColumn: string | null,
): string | null {
  const cats = obs.columns.filter((c) => c.kind === 'categorical' && c.name !== libraryColumn);
  if (cats.length === 0) return null;
  const ranked = [...cats].sort((a, b) => {
    const ra = isDefaultClusterColumn(a.name);
    const rb = isDefaultClusterColumn(b.name);
    if (ra !== rb) return ra - rb;
    const sa = (a.nCategories ?? 0) >= 2 && (a.nCategories ?? 0) <= 60 ? 0 : 1;
    const sb = (b.nCategories ?? 0) >= 2 && (b.nCategories ?? 0) <= 60 ? 0 : 1;
    return sa - sb;
  });
  return ranked[0].name;
}

export function collectFilters(
  ...infos: (MatrixInfo | DatasetMeta | null | undefined)[]
): FilterInfo[] {
  const seen = new Map<number, FilterInfo>();
  for (const info of infos) for (const f of info?.filters ?? []) seen.set(f.id, f);
  return [...seen.values()];
}

export function unsupportedFilters(filters: FilterInfo[]): FilterInfo[] {
  return filters.filter((f) => !BUILTIN_FILTER_IDS.has(f.id));
}

/** Read everything §5.5 allows on open: structure, dtypes, shapes, attributes — no bulk data. */
export function readSummary(src: H5Source): Summary {
  const rootAttrs = src.attrs('/');
  const topLevelKeys = src.keys('/');
  const encodingType = str(rootAttrs['encoding-type']);
  const encodingVersion = str(rootAttrs['encoding-version']);
  const hasObs = src.kind('obs') === 'group';
  const hasVar = src.kind('var') === 'group';
  const isAnnData = encodingType === 'anndata' || (hasObs && hasVar);
  if (!isAnnData) {
    throw new ReaderError(
      `This HDF5 file does not look like AnnData (no obs/var groups; top-level keys: ${topLevelKeys.join(', ') || 'none'})`,
      'not-anndata',
    );
  }
  const flags: string[] = [];
  const obs = hasObs
    ? readDataFrameInfo(src, 'obs')
    : {
        path: 'obs',
        indexName: '_index',
        indexPath: null,
        n: 0,
        columns: [],
        legacyCategories: false,
      };
  const varDf = hasVar
    ? readDataFrameInfo(src, 'var')
    : {
        path: 'var',
        indexName: '_index',
        indexPath: null,
        n: 0,
        columns: [],
        legacyCategories: false,
      };
  let nObs = obs.n;
  let nVars = varDf.n;
  const X = readMatrixInfo(src, 'X', nObs && nVars ? [nObs, nVars] : undefined);
  if (X) {
    if (!nObs) nObs = X.shape[0];
    if (!nVars) nVars = X.shape[1];
    if (X.shape[0] !== nObs) flags.push(`X has ${X.shape[0]} rows but obs has ${nObs}`);
    if (X.shape[1] !== nVars) flags.push(`X has ${X.shape[1]} columns but var has ${nVars}`);
    if (X.format === 'csr') {
      flags.push(
        `X is CSR (nnz ${X.nnz?.toLocaleString()}): gene columns need a scan of the whole index array` +
          ((X.nnz ?? 0) <= CSR_INDEX_MAX_NNZ
            ? ' — SPV builds an in-memory column index on the first gene'
            : ' — each gene is scanned in chunks (slow); consider prepare_h5ad.py --csc'),
      );
    }
    if (X.dtype === '<d') flags.push('X is float64; values are downcast to float32 for the GPU');
    if (
      X.dtype.startsWith('<i') ||
      X.dtype.startsWith('<q') ||
      X.dtype.startsWith('<h') ||
      X.dtype.startsWith('<b') ||
      X.dtype.startsWith('<B')
    ) {
      flags.push('X is integer-valued (raw counts?) — consider the log1p toggle');
    }
  } else {
    flags.push('X is missing; expression coloring is only available from layers/raw if present');
  }
  const layers: Record<string, MatrixInfo> = {};
  if (src.kind('layers') === 'group') {
    for (const k of src.keys('layers')) {
      const m = readMatrixInfo(src, joinPath('layers', k), [nObs, nVars]);
      if (m) layers[k] = m;
    }
  }
  let raw: Summary['raw'] = null;
  if (src.kind('raw') === 'group') {
    const rawVar = src.kind('raw/var') === 'group' ? readDataFrameInfo(src, 'raw/var') : null;
    const rawX = readMatrixInfo(src, 'raw/X', rawVar ? [nObs, rawVar.n] : undefined);
    raw = {
      X: rawX,
      nVars: rawVar?.n ?? rawX?.shape[1] ?? null,
      varNamesDiffer: rawVar ? rawVar.n !== nVars : false,
    };
  }
  for (const c of obs.columns) {
    if (c.kind === 'unsupported')
      flags.push(
        `obs/${c.name} is unsupported (${c.reason ?? c.encoding}) and is listed but not loadable`,
      );
    if (c.encoding === 'categorical-legacy')
      flags.push(`obs/${c.name} uses the legacy (anndata < 0.8) categorical encoding`);
  }
  const geneNameColumns = varDf.columns
    .filter((c) => GENE_NAME_COLUMNS.includes(c.name) && c.kind !== 'unsupported')
    .map((c) => c.name);
  const obsm = readObsmInfo(src);
  for (const o of Object.values(obsm)) {
    if (o.kind === 'array' && o.shape && o.shape[0] !== nObs)
      flags.push(`obsm/${o.key} has ${o.shape[0]} rows but obs has ${nObs}`);
  }
  const obsp: Record<string, MatrixInfo | null> = {};
  if (src.kind('obsp') === 'group') {
    for (const k of src.keys('obsp')) {
      obsp[k] = readMatrixInfo(src, joinPath('obsp', k), [nObs, nObs]);
      if (k.endsWith('_connectivities') && k !== 'spatial_connectivities')
        flags.push(`obsp/${k}: spatial graph with a non-default key_added`);
    }
  }
  const varm = src.kind('varm') === 'group' ? src.keys('varm') : [];
  const varp = src.kind('varp') === 'group' ? src.keys('varp') : [];
  const uns = readUnsSummary(src, obs.columns);
  if (uns.present && uns.keys.length === 0)
    flags.push('uns is empty: no tissue images, scale factors, colors or Squidpy results');
  if (uns.spatial) {
    for (const lib of uns.spatial) {
      for (const im of lib.images) {
        if (im.dtype === '<f' || im.dtype === '<d')
          flags.push(
            `uns/spatial/${lib.id}/images/${im.key} is stored as float (expected range [0, 1])`,
          );
        if (im.channels !== 1 && im.channels !== 3 && im.channels !== 4)
          flags.push(`uns/spatial/${lib.id}/images/${im.key} has ${im.channels} channels`);
      }
      if (lib.images.length > 0 && !lib.hasScalef)
        flags.push(
          `uns/spatial/${lib.id}: image present but no tissue_*_scalef — placement unknown`,
        );
    }
    if (uns.spatial.length > 50)
      flags.push(
        `uns/spatial has ${uns.spatial.length} entries (per-FOV layout); the section list is virtualised`,
      );
  }
  for (const [col, info] of Object.entries(uns.colors)) {
    const c = obs.columns.find((c) => c.name === col);
    if (!c) flags.push(`uns/${col}_colors has no matching obs column`);
    else if (c.nCategories !== null && c.nCategories !== info.n)
      flags.push(
        `uns/${col}_colors has ${info.n} entries for ${c.nCategories} categories — generated palette used`,
      );
  }
  const hasImages = Boolean(uns.spatial?.some((l) => l.images.length > 0));
  const spatial = detectSpatial(obsm, obs.columns, hasImages);
  if (!spatial.key)
    flags.push('no spatial coordinates detected — pick X/Y/Z sources in the Coordinates panel');
  const library = detectLibrary(obs.columns, uns.spatial, null);
  if (library.warning) flags.push(library.warning);
  const filtersUsed = collectFilters(
    X,
    ...Object.values(layers),
    raw?.X,
    spatial.key ? src.meta(spatial.key) : null,
    ...obs.columns
      .filter((c) => c.kind === 'categorical')
      .map((c) =>
        src.meta(c.encoding === 'categorical-legacy' ? c.path : joinPath(c.path, 'codes')),
      ),
  );
  for (const f of unsupportedFilters(filtersUsed))
    flags.push(
      `compression filter ${f.id} (${f.name.split(';')[0]}) needs the h5wasm-plugins bundle`,
    );
  if (obs.columns.some((c) => c.name === 'in_tissue'))
    flags.push('Visium in_tissue column found — filter available');
  return {
    isAnnData,
    encodingType,
    encodingVersion,
    topLevelKeys,
    nObs,
    nVars,
    X,
    layers,
    raw,
    obs,
    var: varDf,
    geneNameColumns,
    obsm,
    obsp,
    varm,
    varp,
    uns,
    spatial,
    library,
    filtersUsed,
    flags,
  };
}

/** Default coordinate spec from the detection result plus the detected library column. */
export function defaultCoordinateSpec(summary: Summary): CoordinateSpec | null {
  const refs = summary.spatial.refs;
  if (!refs) return null;
  return { x: refs.x, y: refs.y, z: refs.z, libraryKey: summary.library.key };
}

/**
 * After coordinates are known, a native-3-D file with a discrete z can reveal its section column
 * (a categorical whose categories map 1:1 onto the z levels) even when no candidate name matched.
 */
export function refineLibraryWithDiscreteZ(
  src: H5Source,
  summary: Summary,
  z: Float64Array,
): LibraryDetection {
  if (summary.library.key) return summary.library;
  const levels = uniqueSorted(z, DISCRETE_Z_LIMIT);
  if (!levels || levels.length < 2) return summary.library;
  const nLevels = levels.length;
  return detectLibrary(summary.obs.columns, summary.uns.spatial, {
    categoriesMatch: (col) => {
      if (col.nCategories !== nLevels) return false;
      const data = readColumn(src, summary.obs, col.name);
      if (data.kind !== 'categorical') return false;
      const seen: (number | null)[] = new Array(nLevels).fill(null);
      for (let i = 0; i < data.codes.length; i++) {
        const c = data.codes[i];
        if (c < 0) continue;
        const zi = z[i];
        if (seen[c] === null) seen[c] = zi;
        else if (seen[c] !== zi) return false;
      }
      return true;
    },
  });
}
