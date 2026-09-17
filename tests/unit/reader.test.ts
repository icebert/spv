import { afterAll, describe, expect, it } from 'vitest';
import {
  CsrColumnIndex,
  ReaderError,
  computeQuantiles,
  createMatrixCache,
  defaultColorColumn,
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
  readSummary,
  refineLibraryWithDiscreteZ,
} from '../../src/h5ad/reader';
import type { H5wasmSource } from '../../src/h5ad/source';
import type { Summary } from '../../src/h5ad/types';
import { PY_DTYPE, closeArrays, expected, openFixture } from './helpers';

interface ExpectedColumn {
  kind: string;
  categories?: string[];
  codes?: number[];
  values?: (number | string | boolean | null)[];
}
interface Expected {
  n_obs: number;
  n_vars: number;
  obs_index_head: string[];
  var_names: string[];
  obs_columns: Record<string, ExpectedColumn>;
  X: { format: string; dtype: string; nnz: number; genes: Record<string, number[]> } | null;
  layers: Record<string, { format: string; dtype: string; genes: Record<string, number[]> }>;
  raw: { n_vars: number; var_names: string[]; genes: Record<string, number[]> } | null;
  obsm: Record<string, { shape: number[]; col_sums: number[]; head: number[][] }>;
  obsp_edges: Record<string, number[][]>;
  uns_colors: Record<string, string[]>;
  moranI: { genes_by_I_desc: string[]; I: Record<string, number> } | null;
  detection: {
    spatial_key: string;
    ndim: number;
    z_source: string | null;
    library_key: string | null;
    section_order?: string[];
    order_source?: string;
    z_levels?: number[];
  };
  sections?: Record<
    string,
    {
      n_cells: number;
      z?: number;
      scalefactors?: Record<string, number>;
      image_extent_fullres?: number[];
      bbox?: number[][];
    }
  >;
  images?: Record<string, { hires_first_pixel_rgba: number[] }>;
  duplicate_gene_index?: number;
}

const FIXTURE_NAMES = ['dense', 'csr', 'csc', 'nox', 'visium2', 'demo_like', 'legacy'];
const open: H5wasmSource[] = [];

async function load(name: string): Promise<{ src: H5wasmSource; exp: Expected; summary: Summary }> {
  const src = await openFixture(`${name}.h5ad`);
  open.push(src);
  return { src, exp: expected<Expected>(name), summary: readSummary(src) };
}

afterAll(() => {
  for (const s of open) s.close();
});

describe.each(FIXTURE_NAMES)('reader on fixture %s', (name) => {
  it('reads n_obs / n_vars, index and var names', async () => {
    const { src, exp, summary } = await load(name);
    expect(summary.nObs).toBe(exp.n_obs);
    expect(summary.nVars).toBe(exp.n_vars);
    expect(readIndex(src, summary.obs).slice(0, 3)).toEqual(exp.obs_index_head);
    expect(readIndexRows(src, summary.obs, [2, 0])).toEqual([
      exp.obs_index_head[2],
      exp.obs_index_head[0],
    ]);
    expect(readIndex(src, summary.var)).toEqual(exp.var_names);
  });

  it('decodes every obs column', async () => {
    const { src, exp, summary } = await load(name);
    for (const [col, e] of Object.entries(exp.obs_columns)) {
      const desc = summary.obs.columns.find((c) => c.name === col);
      expect(desc, `column ${col} listed`).toBeDefined();
      const data = readColumn(src, summary.obs, col);
      switch (e.kind) {
        case 'categorical':
          expect(data.kind).toBe('categorical');
          if (data.kind !== 'categorical') break;
          expect(data.categories).toEqual(e.categories);
          expect(Array.from(data.codes)).toEqual(e.codes);
          expect(data.nMissing).toBe(e.codes!.filter((c) => c < 0).length);
          break;
        case 'string':
          expect(desc!.kind).toBe('string');
          expect(data.kind).toBe('categorical');
          if (data.kind !== 'categorical') break;
          expect(Array.from(data.codes, (c) => data.categories[c])).toEqual(e.values);
          break;
        case 'boolean':
        case 'nullable-boolean':
          expect(desc!.kind).toBe('boolean');
          expect(data.kind).toBe('categorical');
          if (data.kind !== 'categorical') break;
          expect(data.categories).toEqual(['False', 'True']);
          expect(Array.from(data.codes)).toEqual(
            e.values!.map((v) => (v === null ? -1 : v ? 1 : 0)),
          );
          break;
        case 'numeric':
        case 'nullable-integer':
          expect(desc!.kind).toBe('numeric');
          expect(data.kind).toBe('numeric');
          if (data.kind !== 'numeric') break;
          closeArrays(data.values, e.values as (number | null)[]);
          expect(data.nMissing).toBe(e.values!.filter((v) => v === null).length);
          expect(data.quantiles).toHaveLength(1001);
          break;
        default:
          throw new Error(`unexpected kind ${e.kind}`);
      }
    }
  });

  it('describes X / layers / raw and extracts gene columns exactly', async () => {
    const { src, exp, summary } = await load(name);
    const cache = createMatrixCache();
    if (!exp.X) {
      expect(summary.X).toBeNull();
    } else {
      expect(summary.X).not.toBeNull();
      expect(summary.X!.format).toBe(exp.X.format);
      expect(summary.X!.dtype).toBe(PY_DTYPE[exp.X.dtype]);
      if (exp.X.format !== 'dense') expect(summary.X!.nnz).toBe(exp.X.nnz);
      for (const [gene, col] of Object.entries(exp.X.genes)) {
        const j = exp.var_names.indexOf(gene);
        const v = await readGeneVector(src, summary.X!, j, cache);
        closeArrays(v.values, col);
        expect(v.nnz).toBe(col.filter((x) => x !== 0).length);
        expect(v.quantiles[1000]).toBeCloseTo(Math.max(...col), 4);
      }
    }
    for (const [layer, e] of Object.entries(exp.layers ?? {})) {
      const m = summary.layers[layer];
      expect(m).toBeDefined();
      expect(m.format).toBe(e.format);
      for (const [gene, col] of Object.entries(e.genes)) {
        const v = await readGeneVector(src, m, exp.var_names.indexOf(gene), cache);
        closeArrays(v.values, col);
      }
    }
    if (exp.raw) {
      expect(summary.raw).not.toBeNull();
      expect(summary.raw!.nVars).toBe(exp.raw.n_vars);
      expect(summary.raw!.varNamesDiffer).toBe(exp.raw.n_vars !== exp.n_vars);
      const rawVarNames = readIndex(src, {
        ...summary.var,
        path: 'raw/var',
        indexPath: 'raw/var/_index',
      });
      expect(rawVarNames).toEqual(exp.raw.var_names);
      for (const [gene, col] of Object.entries(exp.raw.genes)) {
        const v = await readGeneVector(
          src,
          summary.raw!.X!,
          exp.raw.var_names.indexOf(gene),
          cache,
        );
        closeArrays(v.values, col);
      }
    } else {
      expect(summary.raw).toBeNull();
    }
  });

  it('lists obsm with shapes and detects coordinates + library column', async () => {
    const { src, exp, summary } = await load(name);
    for (const [key, e] of Object.entries(exp.obsm)) {
      expect(summary.obsm[key].shape).toEqual(e.shape);
    }
    expect(summary.spatial.key).toBe(exp.detection.spatial_key);
    expect(summary.spatial.ndim).toBe(exp.detection.ndim);
    expect(summary.spatial.zSource).toBe(exp.detection.z_source);
    expect(summary.library.key).toBe(exp.detection.library_key);
    const spec = defaultCoordinateSpec(summary)!;
    expect(spec).not.toBeNull();
    const libCol = summary.library.column
      ? readColumn(src, summary.obs, summary.library.column)
      : null;
    const sd = readSpatialData(
      src,
      spec,
      summary.nObs,
      libCol && libCol.kind === 'categorical' ? libCol : null,
      summary.uns.spatial,
      summary.library.matchesUnsSpatial === true,
    );
    expect(sd.n).toBe(exp.n_obs);
    expect(sd.nDropped).toBe(0);
    // raw = xyz / scale + center must reproduce the obsm column sums
    const key = exp.detection.spatial_key.split('/')[1];
    const e = exp.obsm[key];
    const sums = [0, 0, 0];
    for (let i = 0; i < sd.n; i++)
      for (let a = 0; a < 3; a++) sums[a] += sd.xyz[i * 3 + a] / sd.scale + sd.center[a];
    expect(sums[0]).toBeCloseTo(e.col_sums[0], 0);
    expect(sums[1]).toBeCloseTo(e.col_sums[1], 0);
    if (exp.detection.ndim === 3 && spec.z && spec.z.path === spec.x.path)
      expect(sums[2]).toBeCloseTo(e.col_sums[2], 0);
    // unit cube: largest extent is exactly 1, centred on 0
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < sd.n; i++) {
      mn = Math.min(mn, sd.xyz[i * 3], sd.xyz[i * 3 + 1], sd.xyz[i * 3 + 2]);
      mx = Math.max(mx, sd.xyz[i * 3], sd.xyz[i * 3 + 1], sd.xyz[i * 3 + 2]);
    }
    expect(mx - mn).toBeCloseTo(1, 5);
    if (exp.detection.section_order) {
      expect(sd.sections.map((s) => s.name)).toEqual(exp.detection.section_order);
      expect(sd.orderSource).toBe(
        exp.detection.order_source === 'uns/spatial' ? 'uns_spatial' : 'natural',
      );
      for (const s of sd.sections) {
        const es = exp.sections![s.name];
        expect(s.nCells).toBe(es.n_cells);
        if (es.z !== undefined) expect(s.z).toBe(es.z);
        if (es.scalefactors) {
          expect(s.spotDiameter).toBe(es.scalefactors['spot_diameter_fullres']);
          expect(s.hiresScalef).toBe(es.scalefactors['tissue_hires_scalef']);
          expect(s.hasImage).toBe(true);
          expect(s.placementKnown).toBe(true);
        }
        if (es.bbox) {
          expect(s.bbox!.min[0]).toBeCloseTo(es.bbox[0][0], 6);
          expect(s.bbox!.max[1]).toBeCloseTo(es.bbox[1][1], 6);
        }
      }
      expect(new Set(Array.from(sd.sectionOf!)).size).toBe(exp.detection.section_order.length);
    } else if (exp.detection.library_key === null) {
      expect(sd.sections).toEqual([]);
      expect(sd.sectionOf).toBeNull();
    } else {
      expect(sd.sections.length).toBeGreaterThan(1);
    }
    if (exp.detection.z_levels) expect(sd.zLevels).toEqual(exp.detection.z_levels);
  });

  it('reads obsp edges, uns colors and moranI', async () => {
    const { src, exp, summary } = await load(name);
    for (const [key, edges] of Object.entries(exp.obsp_edges ?? {})) {
      const m = summary.obsp[key];
      expect(m).not.toBeNull();
      const g = await readGraphEdges(src, m!);
      const pairs: number[][] = [];
      for (let k = 0; k < g.nEdges; k++) pairs.push([g.pairs[2 * k], g.pairs[2 * k + 1]]);
      pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      expect(pairs).toEqual(edges);
      expect(g.subsampled).toBe(false);
      if (edges.length > 10) {
        const capped = await readGraphEdges(src, m!, { maxEdges: 10 });
        expect(capped.nEdges).toBe(10);
        expect(capped.nTotal).toBe(edges.length);
        expect(capped.subsampled).toBe(true);
      }
    }
    for (const [key, colors] of Object.entries(exp.uns_colors ?? {})) {
      const col = key.replace(/_colors$/, '');
      expect(summary.uns.colors[col]?.n).toBe(colors.length);
      const desc = summary.obs.columns.find((c) => c.name === col);
      if (desc && desc.nCategories !== null) {
        const got = readCategoryColors(src, col, desc.nCategories);
        if (desc.nCategories === colors.length) expect(got).toEqual(colors);
        else expect(got).toBeNull();
      }
    }
    if (exp.moranI) {
      expect(summary.uns.moranI?.n).toBe(exp.moranI.genes_by_I_desc.length);
      const mi = readMoranI(src)!;
      const order = mi.genes
        .map((g, i) => [g, mi.I[i]] as const)
        .sort((a, b) => b[1] - a[1])
        .map((x) => x[0]);
      expect(order).toEqual(exp.moranI.genes_by_I_desc);
    } else {
      expect(summary.uns.moranI).toBeNull();
    }
  });
});

describe('fixture-specific behaviour', () => {
  it('dense: duplicate gene names are kept, zero-variance gene has flat range, bad colors rejected', async () => {
    const { src, exp, summary } = await load('dense');
    const names = readIndex(src, summary.var);
    expect(names[exp.duplicate_gene_index!]).toBe(names[exp.duplicate_gene_index! - 1]);
    expect(summary.geneNameColumns).toEqual(['gene_symbols']);
    const v = await readGeneVector(src, summary.X!, 5, createMatrixCache());
    expect(v.min).toBe(0);
    expect(v.max).toBe(0);
    expect(readCategoryColors(src, 'celltype', 3)).toBeNull();
    expect(readCategoryColors(src, 'cluster', 3)).toEqual(exp.uns_colors['cluster_colors']);
    expect(summary.library.key).toBeNull();
    expect(defaultColorColumn(summary.obs, null)).toBe('cluster');
  });

  it('csc: spatial3d wins over spatial, Bregma stays a numeric column, raw maps by name', async () => {
    const { summary } = await load('csc');
    expect(summary.spatial.method).toBe('native3d');
    expect(summary.spatial.key).toBe('obsm/spatial3d');
    expect(summary.spatial.candidates.map((c) => c.key).sort()).toEqual(['spatial', 'spatial3d']);
    expect(summary.library.method).toBe('candidate_name');
  });

  it('csr: 2-D + Bregma gives a 2d+obs_z detection and the chunked scan matches the column index', async () => {
    const { src, exp, summary } = await load('csr');
    expect(summary.spatial.method).toBe('2d+obs_z');
    const j = exp.var_names.indexOf(Object.keys(exp.X!.genes)[1]);
    const scanned = await readGeneVector(src, summary.X!, j, createMatrixCache(), {
      allowIndex: false,
      chunk: 7,
    });
    const indexed = await readGeneVector(src, summary.X!, j, createMatrixCache(), { chunk: 11 });
    expect(Array.from(scanned.values)).toEqual(Array.from(indexed.values));
    const idx = await CsrColumnIndex.build(
      src,
      summary.X!,
      Float64Array.from(src.read('X/indptr') as Float64Array),
      { chunk: 5 },
    );
    const col = idx.column(j);
    expect(col.rows.length).toBe(indexed.nnz);
    for (let k = 1; k < col.rows.length; k++) expect(col.rows[k]).toBeGreaterThan(col.rows[k - 1]);
  });

  it('nox: missing X is reported, not fatal; z comes from obs/z', async () => {
    const { summary } = await load('nox');
    expect(summary.X).toBeNull();
    expect(summary.flags.some((f) => f.includes('X is missing'))).toBe(true);
    expect(summary.spatial.zSource).toBe('obs/z');
  });

  it('visium2: uns/spatial parsing, image decoding (uint8 RGB and float RGBA), placement extents', async () => {
    const { src, exp, summary } = await load('visium2');
    expect(summary.library.method).toBe('uns_spatial_exact');
    expect(summary.spatial.flipYDefault).toBe(true);
    expect(summary.uns.spatial!.map((l) => l.id)).toEqual(['V1_A', 'V1_B']);
    for (const lib of summary.uns.spatial!) {
      const es = exp.sections![lib.id];
      expect(lib.scalefactors).toEqual(es.scalefactors);
      const hires = lib.images.find((i) => i.key === 'hires')!;
      expect([
        hires.width / lib.scalefactors['tissue_hires_scalef'],
        hires.height / lib.scalefactors['tissue_hires_scalef'],
      ]).toEqual(es.image_extent_fullres);
      const img = readImage(src, hires, 2048);
      expect([img.width, img.height]).toEqual([hires.width, hires.height]);
      expect(Array.from(img.data.slice(0, 4))).toEqual(exp.images![lib.id].hires_first_pixel_rgba);
      const small = readImage(src, hires, 4);
      expect(Math.max(small.width, small.height)).toBeLessThanOrEqual(4);
      expect(small.downscale).toBeGreaterThan(1);
    }
    expect(summary.uns.spatialNeighbors).toMatchObject({ n_neighbors: 2, coord_type: 'generic' });
    expect(summary.obsp['custom_connectivities']).not.toBeNull();
    expect(summary.flags.some((f) => f.includes('non-default key_added'))).toBe(true);
    expect(summary.flags.some((f) => f.includes('in_tissue'))).toBe(true);
    expect(summary.X!.format).toBe('dense');
    expect(summary.X!.dtype).toBe('<i');
  });

  it('demo_like: native 3-D with a slice column, natural order, discrete z, seurat_clusters default', async () => {
    const { src, summary } = await load('demo_like');
    expect(summary.spatial.method).toBe('native3d');
    expect(summary.library.key).toBe('obs/slice');
    expect(defaultColorColumn(summary.obs, 'slice')).toBe('seurat_clusters');
    expect(summary.X!.format).toBe('csr');
    expect(summary.X!.dtype).toBe('<d');
    expect(summary.uns.keys).toEqual([]);
    expect(summary.flags.some((f) => f.includes('uns is empty'))).toBe(true);
    // discrete-z refinement finds the same column when the name-based rule is disabled
    const spec = defaultCoordinateSpec(summary)!;
    const z = Float64Array.from(
      { length: summary.nObs },
      (_, i) => (src.read('obsm/spatial') as Float64Array)[i * 3 + 2],
    );
    // Rename the column so the candidate-name rule cannot claim it first.
    const noLib = { ...summary.library, key: null, column: null, method: 'none' as const };
    const renamed = summary.obs.columns.map((c) =>
      c.name === 'slice' ? { ...c, name: 'sec' } : c,
    );
    const refined = refineLibraryWithDiscreteZ(
      src,
      { ...summary, obs: { ...summary.obs, columns: renamed }, library: noLib },
      z,
    );
    expect(refined.key).toBe('obs/slice');
    expect(refined.method).toBe('discrete_z');
    // Without any column aligned to the z levels nothing is detected.
    const without = summary.obs.columns.filter((c) => c.name !== 'slice');
    expect(
      refineLibraryWithDiscreteZ(
        src,
        { ...summary, obs: { ...summary.obs, columns: without }, library: noLib },
        z,
      ).key,
    ).toBeNull();
    void spec;
  });

  it('legacy: h5sparse attrs, __categories reference, fixed-length byte index, X_spatial key', async () => {
    const { src, exp, summary } = await load('legacy');
    expect(summary.encodingType).toBeNull();
    expect(summary.isAnnData).toBe(true);
    expect(summary.X!.format).toBe('csr');
    expect(summary.obs.legacyCategories).toBe(true);
    const ct = summary.obs.columns.find((c) => c.name === 'celltype')!;
    expect(ct.encoding).toBe('categorical-legacy');
    const data = readColumn(src, summary.obs, 'celltype');
    expect(data.kind).toBe('categorical');
    if (data.kind === 'categorical')
      expect(data.nMissing).toBe(exp.obs_columns['celltype'].codes!.filter((c) => c < 0).length);
    expect(summary.spatial.key).toBe('obsm/X_spatial');
  });

  it('notanndata: a plain HDF5 file is rejected with a clear error', async () => {
    const src = await openFixture('notanndata.h5');
    open.push(src);
    expect(() => readSummary(src)).toThrowError(ReaderError);
    try {
      readSummary(src);
    } catch (e) {
      expect((e as ReaderError).code).toBe('not-anndata');
      expect((e as ReaderError).message).toContain('foo');
    }
  });

  it('lzf: unsupported filter reads throw with the throwing handler and work after installing the plugin', async () => {
    const src = await openFixture('lzf.h5');
    open.push(src);
    const meta = src.meta('data')!;
    expect(meta.filters.map((f) => f.id)).toEqual([32000]);
    expect(() => src.slice('data', [[0, 10]])).toThrow();
    const mod = await import('h5wasm/node');
    const plugins = await import('h5wasm-plugins');
    plugins.install_local_plugins(await mod.ready);
    expect(Array.from(src.slice('data', [[0, 7]]) as Float32Array)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('computeQuantiles interpolates and ignores non-finite values', () => {
    const q = computeQuantiles([NaN, 4, 1, 3, 2, Infinity]);
    expect(q[0]).toBe(1);
    expect(q[1000]).toBe(4);
    expect(q[500]).toBeCloseTo(2.5, 9);
  });
});
