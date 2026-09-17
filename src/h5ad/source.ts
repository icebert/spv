/**
 * A minimal, synchronous view of an HDF5 file used by the schema reader. `H5wasmSource` adapts
 * h5wasm's `File`/`Group`/`Dataset` API (identical in the browser and `h5wasm/node` builds), so
 * the same reader code runs inside the Web Worker and in Vitest.
 */
import type { Dataset, File as H5File, Group } from 'h5wasm';
import type { DatasetMeta, FilterInfo } from './types';

export type SliceRange = [] | [number, number];

export interface H5Source {
  kind(path: string): 'group' | 'dataset' | 'other' | null;
  keys(path: string): string[];
  /** Attribute values with bigint / BigInt64Array normalised to number / Float64Array. */
  attrs(path: string): Record<string, unknown>;
  meta(path: string): DatasetMeta | null;
  /** Full dataset contents: typed array, `string[]`, or a scalar for 0-d datasets. */
  read(path: string): unknown;
  /** Hyperslab read; `[]` selects a whole axis. */
  slice(path: string, ranges: SliceRange[]): unknown;
  /** Resolve an HDF5 object reference stored in an attribute of `path` to the target path. */
  dereference(path: string, ref: unknown): string | null;
  close(): void;
}

type Entity = ReturnType<Group['get']>;

const TYPE_STRING = 3;
const TYPE_ENUM = 8;

/** Convert bigint-ish values coming out of h5wasm into plain JS numbers/arrays. */
export function normalizeValue(v: unknown): unknown {
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof BigInt64Array || v instanceof BigUint64Array) {
    return Float64Array.from(v, (x) => Number(x));
  }
  if (Array.isArray(v)) return v.map(normalizeValue);
  return v;
}

export class H5wasmSource implements H5Source {
  private readonly entities = new Map<string, Entity>();
  private readonly metas = new Map<string, DatasetMeta | null>();

  constructor(private readonly file: H5File) {}

  private normalizePath(path: string): string {
    const p = path.replace(/^\/+/, '').replace(/\/+$/, '');
    return p === '' ? '/' : p;
  }

  private entity(path: string): Entity {
    const key = this.normalizePath(path);
    if (this.entities.has(key)) return this.entities.get(key) ?? null;
    let e: Entity;
    try {
      e = key === '/' ? this.file : this.file.get(key);
    } catch {
      e = null;
    }
    this.entities.set(key, e);
    return e;
  }

  private dataset(path: string): Dataset | null {
    const e = this.entity(path);
    return e && (e as Dataset).type === 'Dataset' ? (e as Dataset) : null;
  }

  kind(path: string): 'group' | 'dataset' | 'other' | null {
    const e = this.entity(path);
    if (!e) return null;
    const t = (e as { type?: string }).type;
    if (t === 'Group') return 'group';
    if (t === 'Dataset') return 'dataset';
    return 'other';
  }

  keys(path: string): string[] {
    const e = this.entity(path);
    if (!e || (e as Group).type !== 'Group') return [];
    return (e as Group).keys();
  }

  attrs(path: string): Record<string, unknown> {
    const e = this.entity(path);
    const out: Record<string, unknown> = {};
    if (!e || !('attrs' in e)) return out;
    for (const [k, a] of Object.entries((e as Group).attrs)) {
      try {
        out[k] = normalizeValue(a.value);
      } catch {
        out[k] = undefined;
      }
    }
    return out;
  }

  meta(path: string): DatasetMeta | null {
    const key = this.normalizePath(path);
    if (this.metas.has(key)) return this.metas.get(key) ?? null;
    const ds = this.dataset(key);
    let m: DatasetMeta | null = null;
    if (ds) {
      const md = ds.metadata;
      const members = md.enum_type?.members ?? null;
      const memberKeys = members
        ? Object.keys(members)
            .map((s) => s.toUpperCase())
            .sort()
        : [];
      const isBool =
        md.type === TYPE_ENUM &&
        memberKeys.length === 2 &&
        memberKeys[0] === 'FALSE' &&
        memberKeys[1] === 'TRUE';
      let filters: FilterInfo[];
      try {
        filters = ds.filters.map((f) => ({ id: f.id, name: f.name }));
      } catch {
        filters = [];
      }
      m = {
        path: key,
        shape: md.shape ? md.shape.map(Number) : [],
        dtype: typeof ds.dtype === 'string' ? ds.dtype : JSON.stringify(ds.dtype),
        typeClass: md.type,
        size: md.size,
        signed: md.signed,
        vlen: md.vlen,
        isBool,
        isString: md.type === TYPE_STRING,
        chunks: md.chunks ? md.chunks.map(Number) : null,
        filters,
      };
    }
    this.metas.set(key, m);
    return m;
  }

  read(path: string): unknown {
    const ds = this.dataset(path);
    if (!ds) throw new Error(`Not a dataset: ${path}`);
    return normalizeValue(ds.value);
  }

  slice(path: string, ranges: SliceRange[]): unknown {
    const ds = this.dataset(path);
    if (!ds) throw new Error(`Not a dataset: ${path}`);
    return normalizeValue(ds.slice(ranges));
  }

  dereference(path: string, ref: unknown): string | null {
    const e = this.entity(path);
    if (!e || !('dereference' in e)) return null;
    const r = Array.isArray(ref) ? ref[0] : ref;
    if (!r || typeof r !== 'object' || !('ref_data' in (r as object))) return null;
    try {
      const target = (e as Dataset).dereference(r as never);
      const p = (target as { path?: string } | null)?.path;
      return typeof p === 'string' ? p.replace(/^\/+/, '') : null;
    } catch {
      return null;
    }
  }

  close(): void {
    this.entities.clear();
    this.metas.clear();
    this.file.close();
  }
}
