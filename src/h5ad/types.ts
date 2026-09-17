/**
 * Shared types for the AnnData reader (worker side), the RPC layer and the main thread.
 * Everything here must be structured-cloneable (no class instances, no functions).
 */

export type NumericTypedArray =
  | Float32Array
  | Float64Array
  | Int32Array
  | Uint32Array
  | Int16Array
  | Uint16Array
  | Int8Array
  | Uint8Array;

export interface FilterInfo {
  id: number;
  name: string;
}

/** Normalised HDF5 dataset metadata (see `source.ts`). */
export interface DatasetMeta {
  path: string;
  /** `[]` for scalar datasets. */
  shape: number[];
  /** h5wasm dtype string, e.g. `<f`, `<d`, `<i`, `<b`, `<q`, `S`, `A12`, `unknown` (enum). */
  dtype: string;
  /** HDF5 type class: 0 int, 1 float, 3 string, 6 compound, 7 reference, 8 enum. */
  typeClass: number;
  /** Bytes per element. */
  size: number;
  signed: boolean;
  vlen: boolean;
  /** Enum with exactly FALSE/TRUE members — how h5py stores numpy bool. */
  isBool: boolean;
  isString: boolean;
  chunks: number[] | null;
  filters: FilterInfo[];
}

export type ColumnKind = 'categorical' | 'numeric' | 'string' | 'boolean' | 'unsupported';

export interface ColumnDescriptor {
  name: string;
  path: string;
  kind: ColumnKind;
  /** `encoding-type` attribute, or an inferred label such as `categorical-legacy`. */
  encoding: string;
  dtype: string | null;
  n: number | null;
  nCategories: number | null;
  /** Loaded eagerly for categorical columns with ≤ 5000 categories (needed for detection + legends). */
  categories: string[] | null;
  ordered: boolean;
  nullable: boolean;
  reason: string | null;
}

export interface DataFrameInfo {
  path: string;
  indexName: string;
  indexPath: string | null;
  n: number;
  columns: ColumnDescriptor[];
  legacyCategories: boolean;
}

export type MatrixFormat = 'dense' | 'csr' | 'csc';

export interface MatrixInfo {
  path: string;
  format: MatrixFormat;
  shape: [number, number];
  dtype: string;
  nnz: number | null;
  indexDtype: string | null;
  chunks: number[] | null;
  filters: FilterInfo[];
}

export type ColumnData =
  | {
      kind: 'categorical';
      name: string;
      /** `-1` = missing. */
      codes: Int32Array;
      categories: string[];
      nMissing: number;
      /** What the column was on disk; string and boolean columns are factorised into categoricals. */
      source: 'categorical' | 'string' | 'boolean';
    }
  | {
      kind: 'numeric';
      name: string;
      /** NaN = missing. */
      values: NumericTypedArray;
      nMissing: number;
      /** 1001 quantiles (0 … 100 % in 0.1 % steps) of the finite values. */
      quantiles: Float64Array;
    };

export interface ObsmInfo {
  key: string;
  path: string;
  kind: 'array' | 'dataframe' | 'group';
  shape: number[] | null;
  dtype: string | null;
  columns: string[] | null;
}

export interface ImageInfo {
  key: string;
  path: string;
  shape: number[];
  dtype: string;
  height: number;
  width: number;
  channels: number;
}

export interface UnsSpatialLibrary {
  id: string;
  path: string;
  images: ImageInfo[];
  scalefactors: Record<string, number>;
  /** `tissue_hires_scalef` or `tissue_lowres_scalef` present → image placement is known. */
  hasScalef: boolean;
  extraKeys: string[];
}

export interface UnsSummary {
  present: boolean;
  keys: string[];
  spatial: UnsSpatialLibrary[] | null;
  colors: Record<string, { path: string; n: number }>;
  moranI: { path: string; n: number; columns: string[] } | null;
  spatialNeighbors: Record<string, string | number | boolean | null> | null;
  squidpyResults: string[];
}

/** A column of a 2-D `obsm` dataset (`column` set) or a 1-D numeric dataset (`column` null). */
export interface ColumnRef {
  path: string;
  column: number | null;
}

export interface SpatialDetection {
  key: string | null;
  ndim: 0 | 2 | 3;
  method: 'native3d' | '2d+obs_z' | '2d' | 'none';
  zSource: string | null;
  refs: { x: ColumnRef; y: ColumnRef; z: ColumnRef | null } | null;
  /** Image-space (Visium) coordinates have y pointing down. */
  flipYDefault: boolean;
  candidates: { key: string; ncols: number }[];
}

export interface LibraryDetection {
  /** Full path, e.g. `obs/slice`. */
  key: string | null;
  column: string | null;
  method: 'uns_spatial_exact' | 'uns_spatial_partial' | 'candidate_name' | 'discrete_z' | 'none';
  matchesUnsSpatial: boolean | null;
  warning: string | null;
}

export interface Summary {
  isAnnData: boolean;
  encodingType: string | null;
  encodingVersion: string | null;
  topLevelKeys: string[];
  nObs: number;
  nVars: number;
  X: MatrixInfo | null;
  layers: Record<string, MatrixInfo>;
  raw: { X: MatrixInfo | null; nVars: number | null; varNamesDiffer: boolean } | null;
  obs: DataFrameInfo;
  var: DataFrameInfo;
  /** `var` columns that look like alternative gene names. */
  geneNameColumns: string[];
  obsm: Record<string, ObsmInfo>;
  obsp: Record<string, MatrixInfo | null>;
  varm: string[];
  varp: string[];
  uns: UnsSummary;
  spatial: SpatialDetection;
  library: LibraryDetection;
  filtersUsed: FilterInfo[];
  flags: string[];
}

export interface SectionInfo {
  id: string;
  name: string;
  ordinal: number;
  /** Category code in the library column. */
  code: number;
  nCells: number;
  /** Raw-unit z when every cell of the section shares one z. */
  z: number | null;
  /** Raw-unit bounding box. */
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
  hasImage: boolean;
  imageKeys: string[];
  imageShapes: Record<string, number[]>;
  spotDiameter: number | null;
  hiresScalef: number | null;
  lowresScalef: number | null;
  placementKnown: boolean;
}

export interface CoordinateSpec {
  x: ColumnRef;
  y: ColumnRef;
  z: ColumnRef | null;
  /** `obs/<column>` or null for a single implicit section. */
  libraryKey: string | null;
}

export interface SpatialData {
  spec: CoordinateSpec;
  n: number;
  ndim: 2 | 3;
  /** n × 3, centred and scaled to a unit cube (float64 math on the worker), z = 0 for 2-D data. */
  xyz: Float32Array;
  /** 1 = finite coordinates. */
  valid: Uint8Array;
  nDropped: number;
  /** raw = xyz / scale + center */
  center: [number, number, number];
  scale: number;
  rawMin: [number, number, number];
  rawMax: [number, number, number];
  sectionOf: Uint16Array | null;
  sections: SectionInfo[];
  orderSource: 'uns_spatial' | 'natural' | 'none';
  nWithoutSection: number;
  /** Distinct raw z values when there are ≤ 512 of them. */
  zLevels: number[] | null;
}

export interface GeneVector {
  matrix: string;
  index: number;
  values: Float32Array;
  nnz: number;
  min: number;
  max: number;
  quantiles: Float64Array;
}

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, row-major, top row first. */
  data: Uint8ClampedArray;
  sourceShape: number[];
  downscale: number;
}

export interface GraphEdges {
  /** Flat pairs (i, j) with i < j. */
  pairs: Uint32Array;
  nEdges: number;
  nTotal: number;
  subsampled: boolean;
}

export interface MoranI {
  genes: string[];
  I: Float64Array;
  columns: string[];
}

export interface ProgressEvent {
  stage: string;
  done: number;
  total: number;
  message?: string;
}

export type ProgressFn = (p: ProgressEvent) => void;
