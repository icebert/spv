#!/usr/bin/env python3
"""Write tiny ``.h5ad`` fixtures (< 100 kB each) for SPV's unit tests, plus ``*.expected.json``
ground truth computed in Python from the in-memory objects (independent of the TypeScript reader).

Fixtures (tests/fixtures/):
  dense.h5ad      dense float32 X; 2-D spatial only (no z, no section column); categorical with
                  missing codes; unique-string, boolean, int, float and nullable columns; duplicate
                  gene names; var gene_symbols column; uns/cluster_colors; a wrong-length colors array.
  csr.h5ad        CSR float32 X; layers/counts (CSR int32); 2-D spatial + obs/Bregma z; leiden column.
  csc.h5ad        CSC float64 X; raw (CSR, more genes, different var); obsm/spatial3d AND obsm/spatial
                  (priority test); obs/Bregma; obs/sample string-ish categorical.
  nox.h5ad        no X at all; 2-D spatial + obs/z numeric.
  visium2.h5ad    two Visium-like libraries: obs/library_id matching uns/spatial keys, uns/spatial with
                  8x8 hires + lowres images (uint8 RGB and float RGBA), scalefactors, in_tissue,
                  array_row/col, dense int X, obsp spatial graph (default and key_added='custom'),
                  uns/spatial_neighbors, uns/moranI, uns/library_id_colors.
  demo_like.h5ad  mirrors data/demo.h5ad: CSR float64 X, obsm/spatial (n,3) with discrete z, categorical
                  obs (seurat_clusters, subtype, slice, structure, substructure) with int8 codes, empty
                  layers/obsp/uns/varm/varp, var with only the index. 3 slices (slice1, slice2, slice10)
                  so natural ordering is exercised.
  legacy.h5ad     hand-written with h5py in the anndata < 0.8 layout: X with h5sparse_format attrs,
                  obs categorical as codes + __categories reference, fixed-length byte index,
                  obsm/X_spatial as the coordinate key.
  visium_align.h5ad  one Visium-like section with a checkerboard image and spots on the bright
                  squares (image/spot alignment check).
  lzf.h5          LZF-compressed dataset (plugin path test).
  notanndata.h5   a plain HDF5 file (error-path test).

Run: python scripts/make_fixtures.py [--out tests/fixtures]
"""

from __future__ import annotations

import argparse
import json
import os

import anndata as ad
import h5py
import numpy as np
import pandas as pd
import scipy.sparse as sp

rng = np.random.default_rng(42)


# ----------------------------------------------------------------------------- helpers
def dense_col(X, j: int) -> list[float]:
    if X is None:
        return []
    col = X[:, j].toarray().ravel() if sp.issparse(X) else np.asarray(X[:, j]).ravel()
    return [round(float(v), 6) for v in col]


def describe_col(s: pd.Series) -> dict:
    if isinstance(s.dtype, pd.CategoricalDtype):
        return {"kind": "categorical", "categories": [str(c) for c in s.cat.categories],
                "codes": [int(c) for c in s.cat.codes], "ordered": bool(s.cat.ordered)}
    if pd.api.types.is_bool_dtype(s.dtype) and not isinstance(s.dtype, pd.BooleanDtype):
        return {"kind": "boolean", "values": [bool(v) for v in s]}
    if isinstance(s.dtype, pd.BooleanDtype):
        return {"kind": "nullable-boolean", "values": [None if pd.isna(v) else bool(v) for v in s]}
    if isinstance(s.dtype, pd.Int32Dtype | pd.Int64Dtype | pd.Int16Dtype | pd.Int8Dtype):
        return {"kind": "nullable-integer", "values": [None if pd.isna(v) else int(v) for v in s]}
    if pd.api.types.is_numeric_dtype(s.dtype):
        return {"kind": "numeric", "values": [None if pd.isna(v) else round(float(v), 6) for v in s]}
    return {"kind": "string", "values": [str(v) for v in s]}


def edges_of(m) -> list[list[int]]:
    coo = sp.coo_matrix(m)
    pairs = {(int(i), int(j)) for i, j in zip(coo.row, coo.col) if i < j}
    return sorted([list(p) for p in pairs])


def expected_for(adata: ad.AnnData, genes: list[str] | None = None, **extra) -> dict:
    genes = genes or list(adata.var_names[:3]) + [adata.var_names[-1]]
    exp: dict = {
        "n_obs": int(adata.n_obs), "n_vars": int(adata.n_vars),
        "obs_index_head": [str(x) for x in adata.obs_names[:3]],
        "var_names": [str(x) for x in adata.var_names],
        "obs_columns": {c: describe_col(adata.obs[c]) for c in adata.obs.columns},
        "var_columns": {c: describe_col(adata.var[c]) for c in adata.var.columns},
        "X": None,
        "layers": {},
        "raw": None,
        "obsm": {},
        "obsp_edges": {},
        "uns_colors": {},
        "moranI": None,
    }
    if adata.X is not None:
        fmt = "csr" if sp.isspmatrix_csr(adata.X) else "csc" if sp.isspmatrix_csc(adata.X) else "dense"
        exp["X"] = {"format": fmt, "dtype": str(adata.X.dtype),
                    "nnz": int(adata.X.nnz) if sp.issparse(adata.X) else int(np.count_nonzero(adata.X)),
                    "genes": {g: dense_col(adata.X, list(adata.var_names).index(g)) for g in genes}}
    for name, L in adata.layers.items():
        if name is None:  # anndata ≥ 0.13 also yields X under the key None
            continue
        fmt = "csr" if sp.isspmatrix_csr(L) else "csc" if sp.isspmatrix_csc(L) else "dense"
        exp["layers"][name] = {"format": fmt, "dtype": str(L.dtype),
                               "genes": {g: dense_col(L, list(adata.var_names).index(g)) for g in genes}}
    if adata.raw is not None:
        rv = list(adata.raw.var_names)
        rg = [g for g in genes if g in rv] + [rv[-1]]
        exp["raw"] = {"n_vars": len(rv), "var_names": rv,
                      "genes": {g: dense_col(adata.raw.X, rv.index(g)) for g in rg}}
    for k, v in adata.obsm.items():
        v = np.asarray(v, dtype=np.float64)
        exp["obsm"][k] = {"shape": list(v.shape), "col_sums": [round(float(s), 4) for s in v.sum(axis=0)],
                          "head": [[round(float(x), 6) for x in row] for row in v[:2]]}
    for k, v in adata.obsp.items():
        exp["obsp_edges"][k] = edges_of(v)
    for k, v in adata.uns.items():
        if k.endswith("_colors"):
            exp["uns_colors"][k] = [str(c) for c in v]
    if "moranI" in adata.uns:
        df = adata.uns["moranI"]
        exp["moranI"] = {"genes_by_I_desc": list(df.sort_values("I", ascending=False).index),
                         "I": {g: round(float(v), 6) for g, v in df["I"].items()}}
    exp.update(extra)
    return exp


def write(adata: ad.AnnData, out: str, name: str, expected: dict, compression: str | None = None) -> None:
    """Most fixtures are written uncompressed: HDF5 adds ~5 kB of chunk-index overhead per gzip'd
    dataset, which alone pushes these tiny files past the 100 kB budget. gzip is exercised by the
    fixtures that pass compression="gzip" (csr, demo_like) and by data/demo.h5ad itself."""
    path = os.path.join(out, f"{name}.h5ad")
    adata.write_h5ad(path, compression=compression)
    with open(os.path.join(out, f"{name}.expected.json"), "w") as fh:
        json.dump(expected, fh, indent=1)
    print(f"{name:<12} {os.path.getsize(path) / 1024:7.1f} kB  n_obs={adata.n_obs} n_vars={adata.n_vars}")


def gene_names(n: int, prefix: str = "Gene") -> list[str]:
    return [f"{prefix}{i:03d}" for i in range(n)]


def log_values(n_obs: int, n_vars: int, density: float, dtype=np.float32):
    counts = sp.random(n_obs, n_vars, density=density, format="csr", random_state=rng, data_rvs=lambda k: rng.integers(1, 20, k))
    m = counts.astype(np.float64)
    m.data = np.log1p(m.data)
    return m.astype(dtype)


# ----------------------------------------------------------------------------- fixtures
def make_dense(out: str) -> None:
    n, m = 40, 12
    X = rng.gamma(1.0, 1.0, size=(n, m)).astype(np.float32)
    X[X < 0.8] = 0.0
    X[:, 5] = 0.0  # zero-variance gene
    names = gene_names(m)
    names[3] = names[2]  # duplicate gene name
    var = pd.DataFrame({"gene_symbols": [f"SYM{i}" for i in range(m)], "highly_variable": rng.random(m) > 0.5}, index=names)
    obs = pd.DataFrame(index=[f"cell{i}" for i in range(n)])
    obs["cluster"] = pd.Categorical(rng.choice(["A", "B", "C", None], size=n, p=[0.4, 0.3, 0.2, 0.1]), categories=["A", "B", "C"])
    obs["barcode"] = [f"BC{i:04d}" for i in range(n)]  # all unique → stays a string column
    obs["is_doublet"] = rng.random(n) > 0.8
    obs["n_counts"] = rng.integers(100, 5000, size=n).astype(np.int64)
    obs["pct_mt"] = rng.random(n).astype(np.float32) * 10
    obs["nn_int"] = pd.array([None if i % 7 == 0 else int(i) for i in range(n)], dtype="Int32")
    obs["nn_bool"] = pd.array([None if i % 5 == 0 else bool(i % 2) for i in range(n)], dtype="boolean")
    obs["celltype"] = pd.Categorical(rng.choice(["T", "B", "NK"], size=n))
    spatial = np.column_stack([rng.random(n) * 1000 + 5000, rng.random(n) * 800 + 12000]).astype(np.float32)
    adata = ad.AnnData(X=X, obs=obs, var=var, obsm={"spatial": spatial, "X_pca": rng.random((n, 4)).astype(np.float32)},
                       uns={"cluster_colors": ["#1f77b4", "#ff7f0e", "#2ca02c"], "celltype_colors": ["#000000", "#ffffff"]})
    exp = expected_for(adata, genes=[names[0], names[5], names[-1]],
                       detection={"spatial_key": "obsm/spatial", "ndim": 2, "z_source": None, "library_key": None},
                       notes="duplicate gene name at index 3; celltype_colors has wrong length (2 vs 3)")
    exp["duplicate_gene_index"] = 3
    write(adata, out, "dense", exp)


def make_csr(out: str) -> None:
    n, m = 60, 15
    X = log_values(n, m, 0.3)
    counts = sp.random(n, m, density=0.3, format="csr", random_state=rng, data_rvs=lambda k: rng.integers(1, 9, k)).astype(np.int32)
    obs = pd.DataFrame(index=[f"c{i}" for i in range(n)])
    obs["leiden"] = pd.Categorical([str(i % 4) for i in range(n)], categories=["0", "1", "2", "3"])
    obs["Bregma"] = np.repeat([-0.29, -0.24, -0.19], n // 3).astype(np.float64)
    spatial = np.column_stack([rng.random(n) * 2000, rng.random(n) * 2000]).astype(np.float64)
    adata = ad.AnnData(X=X, obs=obs, var=pd.DataFrame(index=gene_names(m)), obsm={"spatial": spatial}, layers={"counts": counts})
    exp = expected_for(adata, detection={"spatial_key": "obsm/spatial", "ndim": 2, "z_source": "obs/Bregma", "library_key": None})
    write(adata, out, "csr", exp, compression="gzip")


def make_csc(out: str) -> None:
    n, m, m_raw = 60, 15, 20
    X = log_values(n, m, 0.35, dtype=np.float64).tocsc()
    raw_names = gene_names(m_raw)
    raw_X = sp.random(n, m_raw, density=0.3, format="csr", random_state=rng, data_rvs=lambda k: rng.integers(1, 30, k)).astype(np.float32)
    obs = pd.DataFrame(index=[f"c{i}" for i in range(n)])
    obs["Bregma"] = np.repeat([0.26, 0.21, 0.16, 0.11], n // 4).astype(np.float32)
    obs["sample"] = pd.Categorical(np.repeat(["s1", "s2"], n // 2))
    xy = np.column_stack([rng.random(n) * 500, rng.random(n) * 500])
    z = obs["Bregma"].to_numpy(dtype=np.float64) * 1000
    adata = ad.AnnData(X=X, obs=obs, var=pd.DataFrame(index=gene_names(m)),
                       obsm={"spatial": xy.astype(np.float64), "spatial3d": np.column_stack([xy, z]).astype(np.float64)})
    adata.raw = ad.AnnData(X=raw_X, obs=obs[[]], var=pd.DataFrame(index=raw_names))
    exp = expected_for(adata, detection={"spatial_key": "obsm/spatial3d", "ndim": 3, "z_source": None, "library_key": "obs/sample"})
    write(adata, out, "csc", exp)


def make_nox(out: str) -> None:
    n, m = 30, 5
    obs = pd.DataFrame(index=[f"c{i}" for i in range(n)])
    obs["z"] = np.repeat([0.0, 10.0, 20.0], n // 3)
    obs["group"] = pd.Categorical(rng.choice(["g1", "g2"], size=n))
    adata = ad.AnnData(obs=obs, var=pd.DataFrame(index=gene_names(m)),
                       obsm={"spatial": np.column_stack([rng.random(n) * 100, rng.random(n) * 100]).astype(np.float64)})
    exp = expected_for(adata, detection={"spatial_key": "obsm/spatial", "ndim": 2, "z_source": "obs/z", "library_key": None})
    write(adata, out, "nox", exp)


def make_visium2(out: str) -> None:
    libs = {"V1_A": (8, 8), "V1_B": (10, 8)}  # (H, W) of hires image
    hires_scalef, lowres_scalef = 0.1, 0.05  # hires 8 px ↔ 80 full-res px
    n_per = 30
    obs_parts, coords, lib_col = [], [], []
    for lib, (H, W) in libs.items():
        full_w, full_h = W / hires_scalef, H / hires_scalef
        xy = np.column_stack([rng.random(n_per) * full_w, rng.random(n_per) * full_h])
        coords.append(xy)
        lib_col += [lib] * n_per
        obs_parts.append(pd.DataFrame({
            "in_tissue": (rng.random(n_per) > 0.2).astype(np.int64),
            "array_row": rng.integers(0, 78, n_per).astype(np.int64),
            "array_col": rng.integers(0, 128, n_per).astype(np.int64),
        }, index=[f"{lib}-{i}" for i in range(n_per)]))
    obs = pd.concat(obs_parts)
    # Stored category order deliberately differs from uns/spatial (alphabetical) order.
    obs["library_id"] = pd.Categorical(lib_col, categories=["V1_B", "V1_A"])
    obs["cluster"] = pd.Categorical(rng.choice(["c0", "c1", "c2"], size=len(obs)))
    n, m = len(obs), 10
    X = rng.poisson(2.0, size=(n, m)).astype(np.int32)
    xy_all = np.vstack(coords)
    imgs = {
        "V1_A": {"hires": rng.integers(0, 255, size=(8, 8, 3), dtype=np.uint8), "lowres": rng.integers(0, 255, size=(4, 4, 3), dtype=np.uint8)},
        "V1_B": {"hires": rng.random((10, 8, 4)).astype(np.float32), "lowres": rng.random((5, 4, 3)).astype(np.float32)},
    }
    uns_spatial = {
        lib: {"images": imgs[lib],
              "scalefactors": {"tissue_hires_scalef": hires_scalef, "tissue_lowres_scalef": lowres_scalef,
                               "spot_diameter_fullres": 6.5 if lib == "V1_A" else 7.25, "fiducial_diameter_fullres": 10.5},
              "metadata": {"chemistry_description": "Spatial 3' v1", "software_version": "spaceranger-1.1.0"}}
        for lib in libs
    }
    # Spatial graph: 2 nearest neighbours within each library, symmetrised; never crosses libraries.
    conn = sp.lil_matrix((n, n), dtype=np.float64)
    dist = sp.lil_matrix((n, n), dtype=np.float64)
    for li, lib in enumerate(libs):
        idx = np.arange(li * n_per, (li + 1) * n_per)
        pts = xy_all[idx]
        d = np.linalg.norm(pts[:, None, :] - pts[None, :, :], axis=2)
        np.fill_diagonal(d, np.inf)
        for a in range(n_per):
            for b in np.argsort(d[a])[:2]:
                i, j = idx[a], idx[b]
                conn[i, j] = conn[j, i] = 1.0
                dist[i, j] = dist[j, i] = d[a, b]
    conn, dist = conn.tocsr(), dist.tocsr()
    custom = conn.copy()
    custom.data[:] = 1.0
    custom = (custom @ custom > 0).astype(np.float64).tocsr()  # 2-hop, still per-library
    custom.setdiag(0)
    custom.eliminate_zeros()
    var_names = gene_names(m, "G")
    moran = pd.DataFrame({"I": rng.random(m), "pval_norm": rng.random(m) * 0.05, "var_norm": rng.random(m) * 0.01,
                          "pval_norm_fdr_bh": rng.random(m) * 0.1}, index=var_names).sort_values("I", ascending=False)
    adata = ad.AnnData(X=X, obs=obs, var=pd.DataFrame(index=var_names), obsm={"spatial": xy_all.astype(np.float64)},
                       obsp={"spatial_connectivities": conn, "spatial_distances": dist, "custom_connectivities": custom},
                       uns={"spatial": uns_spatial,
                            "spatial_neighbors": {"params": {"n_neighbors": 2, "coord_type": "generic", "transform": "None", "radius": 0.0}},
                            "custom_neighbors": {"params": {"n_neighbors": 4, "coord_type": "generic"}},
                            "moranI": moran,
                            "library_id_colors": ["#ff0000", "#00ff00"],
                            "cluster_colors": ["#111111", "#222222", "#333333"]})
    exp = expected_for(adata, detection={"spatial_key": "obsm/spatial", "ndim": 2, "z_source": None, "library_key": "obs/library_id",
                                         "section_order": ["V1_A", "V1_B"], "order_source": "uns/spatial"},
                       sections={lib: {"n_cells": n_per, "image_hires_shape": list(imgs[lib]["hires"].shape),
                                       "image_lowres_shape": list(imgs[lib]["lowres"].shape),
                                       "scalefactors": uns_spatial[lib]["scalefactors"],
                                       "image_extent_fullres": [imgs[lib]["hires"].shape[1] / hires_scalef, imgs[lib]["hires"].shape[0] / hires_scalef],
                                       "bbox": [[float(v) for v in coords[i].min(axis=0)], [float(v) for v in coords[i].max(axis=0)]]}
                                 for i, lib in enumerate(libs)},
                       images={lib: {"hires_first_pixel_rgba": [int(v) for v in (np.asarray(imgs[lib]["hires"][0, 0]) * (255 if imgs[lib]["hires"].dtype.kind == "f" else 1)).round()] + ([255] if imgs[lib]["hires"].shape[2] == 3 else [])}
                               for lib in libs})
    write(adata, out, "visium2", exp)


def make_demo_like(out: str) -> None:
    slices = [("slice1", 320.0), ("slice2", 340.0), ("slice10", 498.0)]
    n_per, m = 35, 20
    rows, coords, slice_col = [], [], []
    for k, (name, z) in enumerate(slices):
        xy = np.column_stack([rng.random(n_per) * 220 + 670 + 15 * k, rng.random(n_per) * 230 + 300 + 5 * k])
        coords.append(np.column_stack([xy, np.full(n_per, z)]))
        slice_col += [name] * n_per
        rows += [f"r1_s{k + 1}_{rng.integers(1e18, 9e18)}{rng.integers(1e18, 9e18)}" for _ in range(n_per)]
    n = n_per * len(slices)
    obs = pd.DataFrame(index=rows)
    obs["seurat_clusters"] = pd.Categorical(rng.choice(["Astro", "Car3", "D1 MSN", "L2/3 IT CTX", "Oligo"], size=n))
    obs["subtype"] = pd.Categorical(rng.choice(["Astro", "Car3 1", "Car3 2", "D1 MSN", "Oligo 1", "Oligo 2"], size=n))
    # alphabetical storage order (slice1, slice10, slice2) — natural order must give slice1, slice2, slice10
    obs["slice"] = pd.Categorical(slice_col, categories=sorted([s for s, _ in slices]))
    obs["structure"] = pd.Categorical(rng.choice(["ACB", "AId", "CP", "MOp"], size=n))
    obs["substructure"] = pd.Categorical(rng.choice(["ACB", "AId1", "AId2/3", "CP", "MOp1", "MOp5"], size=n))
    X = log_values(n, m, 0.2, dtype=np.float64)
    var_names = ["Oprk1", "Npbwr1", "Sulf1", "Kcnb2", "Col19a1", "Il1r1", "Il1rl1", "Spag16", "Igfbp5", "Asic4",
                 "Itpr1", "Cacnb4", "Gria2", "Pbx3", "Kcnj11", "Slc17a7", "Gad1", "Gad2", "Pvalb", "Sst"]
    adata = ad.AnnData(X=X, obs=obs, var=pd.DataFrame(index=var_names), obsm={"spatial": np.vstack(coords).astype(np.float64)})
    for c in ["seurat_clusters", "subtype", "slice", "structure", "substructure"]:
        assert adata.obs[c].cat.codes.dtype == np.int8
    exp = expected_for(adata, genes=["Oprk1", "Itpr1", "Sst"],
                       detection={"spatial_key": "obsm/spatial", "ndim": 3, "z_source": None, "library_key": "obs/slice",
                                  "section_order": ["slice1", "slice2", "slice10"], "order_source": "natural",
                                  "z_levels": [z for _, z in slices]},
                       sections={name: {"n_cells": n_per, "z": z} for name, z in slices})
    write(adata, out, "demo_like", exp, compression="gzip")


def make_legacy(out: str) -> None:
    """anndata < 0.8 style file written by hand with h5py."""
    n, m = 25, 6
    path = os.path.join(out, "legacy.h5ad")
    X = sp.random(n, m, density=0.4, format="csr", random_state=rng, data_rvs=lambda k: rng.random(k) * 5).astype(np.float32)
    cats = ["Neuron", "Glia", "Vascular"]
    codes = rng.integers(-1, 3, size=n).astype(np.int8)  # includes -1 (missing)
    n_counts = rng.random(n).astype(np.float32) * 100
    obs_index = np.array([f"cell_{i}".encode() for i in range(n)], dtype="S12")
    var_index = np.array([f"g{i}".encode() for i in range(m)], dtype="S4")
    xy = np.column_stack([rng.random(n) * 50, rng.random(n) * 50]).astype(np.float64)
    with h5py.File(path, "w") as f:
        g = f.create_group("X")
        g.attrs["h5sparse_format"] = "csr"
        g.attrs["h5sparse_shape"] = np.array([n, m], dtype=np.int64)
        g.create_dataset("data", data=X.data)
        g.create_dataset("indices", data=X.indices.astype(np.int32))
        g.create_dataset("indptr", data=X.indptr.astype(np.int32))
        obs = f.create_group("obs")
        obs.attrs["_index"] = "index"
        obs.attrs["column-order"] = np.array(["celltype", "n_counts"], dtype=h5py.string_dtype())
        obs.create_dataset("index", data=obs_index)
        catg = obs.create_group("__categories")
        cds = catg.create_dataset("celltype", data=np.array(cats, dtype=object), dtype=h5py.string_dtype())
        cd = obs.create_dataset("celltype", data=codes)
        cd.attrs["categories"] = cds.ref
        obs.create_dataset("n_counts", data=n_counts)
        var = f.create_group("var")
        var.attrs["_index"] = "index"
        var.attrs["column-order"] = np.array([], dtype=h5py.string_dtype())
        var.create_dataset("index", data=var_index)
        obsm = f.create_group("obsm")
        obsm.create_dataset("X_spatial", data=xy)
        f.create_group("uns")
    dense = X.toarray()
    exp = {
        "n_obs": n, "n_vars": m, "obs_index_head": [f"cell_{i}" for i in range(3)],
        "var_names": [f"g{i}" for i in range(m)],
        "obs_columns": {"celltype": {"kind": "categorical", "categories": cats, "codes": [int(c) for c in codes]},
                        "n_counts": {"kind": "numeric", "values": [round(float(v), 6) for v in n_counts]}},
        "X": {"format": "csr", "dtype": "float32", "nnz": int(X.nnz),
              "genes": {f"g{j}": [round(float(v), 6) for v in dense[:, j]] for j in (0, m - 1)}},
        "obsm": {"X_spatial": {"shape": [n, 2], "col_sums": [round(float(s), 4) for s in xy.sum(axis=0)],
                               "head": [[round(float(v), 6) for v in row] for row in xy[:2]]}},
        "detection": {"spatial_key": "obsm/X_spatial", "ndim": 2, "z_source": None, "library_key": None},
    }
    with open(os.path.join(out, "legacy.expected.json"), "w") as fh:
        json.dump(exp, fh, indent=1)
    print(f"{'legacy':<12} {os.path.getsize(path) / 1024:7.1f} kB  (h5py hand-written)")


def make_visium_align(out: str) -> None:
    """One Visium-like section whose 64x64 image is a checkerboard of 16 px squares with a red
    top-left corner marker; spots sit exactly on the centres of the bright squares in full-res
    pixel space (scalef 0.25 → 4 full-res px per image px). Used to verify image/spot alignment."""
    H = W = 64
    img = np.zeros((H, W, 3), dtype=np.uint8)
    img[:] = 40
    for r in range(0, H, 16):
        for c in range(0, W, 16):
            if ((r // 16) + (c // 16)) % 2 == 0:
                img[r:r + 16, c:c + 16] = 230
    img[0:8, 0:8] = (220, 30, 30)  # top-left marker (image row 0 = smallest y in Visium pixel space)
    img[H - 8:H, W - 8:W] = (30, 90, 220)  # bottom-right marker
    scalef = 0.25
    spots = []
    for r in range(0, H, 16):
        for c in range(0, W, 16):
            if ((r // 16) + (c // 16)) % 2 == 0:
                spots.append([(c + 8) / scalef, (r + 8) / scalef])  # (x, y) full-res, y down
    xy = np.array(spots, dtype=np.float64)
    n = len(xy)
    obs = pd.DataFrame({"in_tissue": np.ones(n, dtype=np.int64), "array_row": np.arange(n), "array_col": np.arange(n)}, index=[f"spot{i}" for i in range(n)])
    obs["library_id"] = pd.Categorical(["A"] * n)
    obs["kind"] = pd.Categorical(["bright"] * n)
    adata = ad.AnnData(X=np.ones((n, 3), dtype=np.float32), obs=obs, var=pd.DataFrame(index=["g0", "g1", "g2"]),
                       obsm={"spatial": xy},
                       uns={"spatial": {"A": {"images": {"hires": img}, "scalefactors": {"tissue_hires_scalef": scalef, "spot_diameter_fullres": 40.0}}}})
    exp = expected_for(adata, detection={"spatial_key": "obsm/spatial", "ndim": 2, "z_source": None, "library_key": "obs/library_id",
                                         "section_order": ["A"], "order_source": "uns/spatial"},
                       sections={"A": {"n_cells": n, "scalefactors": {"tissue_hires_scalef": scalef, "spot_diameter_fullres": 40.0},
                                       "image_extent_fullres": [W / scalef, H / scalef]}},
                       alignment={"image_px": [W, H], "scalef": scalef, "bright_square_centers_fullres": spots,
                                  "marker_topleft_fullres": [4 / scalef, 4 / scalef], "marker_bottomright_fullres": [(W - 4) / scalef, (H - 4) / scalef]})
    write(adata, out, "visium_align", exp)


def make_lzf(out: str) -> None:
    """Dataset compressed with LZF (h5py ships the filter) — exercises the h5wasm-plugins path."""
    path = os.path.join(out, "lzf.h5")
    with h5py.File(path, "w") as f:
        f.create_dataset("data", data=(np.arange(1000) % 7).astype(np.float32), chunks=(100,), compression="lzf")
        f.create_dataset("plain", data=np.array([1, 2, 3], dtype=np.int32))
    print(f"{'lzf':<12} {os.path.getsize(path) / 1024:7.1f} kB  (lzf-compressed, needs plugin)")


def make_notanndata(out: str) -> None:
    path = os.path.join(out, "notanndata.h5")
    with h5py.File(path, "w") as f:
        f.create_dataset("foo/bar", data=np.arange(10, dtype=np.int32))
        f.attrs["title"] = "not an anndata file"
    print(f"{'notanndata':<12} {os.path.getsize(path) / 1024:7.1f} kB")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=os.path.join("tests", "fixtures"))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    for fn in (make_dense, make_csr, make_csc, make_nox, make_visium2, make_demo_like, make_legacy, make_visium_align, make_lzf, make_notanndata):
        fn(args.out)
    big = [f for f in os.listdir(args.out) if os.path.getsize(os.path.join(args.out, f)) > 100 * 1024]
    if big:
        raise SystemExit(f"fixtures over 100 kB: {big}")
    print("all fixtures < 100 kB")


if __name__ == "__main__":
    main()
