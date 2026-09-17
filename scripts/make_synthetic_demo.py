#!/usr/bin/env python3
"""Generate synthetic datasets for development and benchmarking (output gitignored under data/synthetic/).

Native 3-D, MERFISH-like (default)::

    python scripts/make_synthetic_demo.py                       # 40k cells, 300 genes, 10 slices
    python scripts/make_synthetic_demo.py --n-cells 500000 --n-genes 50 --out data/synthetic/synthetic_500k.h5ad
    python scripts/make_synthetic_demo.py --n-cells 2000000 --n-genes 8 --no-graph --no-moran

  obsm/spatial3d (x, y in µm; z = Bregma in mm → a different unit, as in the Squidpy MERFISH
  tutorial), obs/Bregma (float), obs/slice_id (categorical, one per slice), obs/cell_type,
  obs/total_counts, CSC float32 X with cell-type marker genes, uns/cell_type_colors,
  uns/moranI (real Moran's I on a kNN graph, first 50 genes), obsp/spatial_connectivities
  (kNN within each slice) + uns/spatial_neighbors/params.

Visium-like multi-section with tissue images (for the image benchmark)::

    python scripts/make_synthetic_demo.py --visium 4 --image-size 2048 --out data/synthetic/synthetic_visium4.h5ad

  N sections, each with a hires image (image-size px, synthetic H&E-like texture) + lowres,
  scalefactors, spots on a hexagonal grid inside the tissue, obs/in_tissue, obs/library_id
  matching uns/spatial keys, CSC counts.

Only numpy/scipy/anndata are needed (no squidpy).
"""

from __future__ import annotations

import argparse
import os

import anndata as ad
import numpy as np
import pandas as pd
import scipy.sparse as sp
from scipy.spatial import cKDTree

CELL_TYPES = ["Astro", "Endo", "Excitatory", "Inhibitory", "Microglia", "OD Mature", "OD Immature", "Pericytes", "Ependymal"]
COLORS = ["#cc6677", "#332288", "#ddcc77", "#117733", "#88ccee", "#882255", "#44aa99", "#999933", "#aa4499"]


def knn_graph(xy: np.ndarray, k: int, offset: int, n_total: int) -> sp.csr_matrix:
    tree = cKDTree(xy)
    d, j = tree.query(xy, k=k + 1)
    rows = np.repeat(np.arange(len(xy)), k) + offset
    cols = j[:, 1:].ravel() + offset
    m = sp.coo_matrix((np.ones(len(rows)), (rows, cols)), shape=(n_total, n_total)).tocsr()
    m = ((m + m.T) > 0).astype(np.float64)
    return m.tocsr()


def morans_i(X: sp.csc_matrix, W: sp.csr_matrix, genes: int) -> np.ndarray:
    n = X.shape[0]
    Wsum = W.sum()
    out = np.zeros(genes)
    for g in range(genes):
        x = X[:, g].toarray().ravel().astype(np.float64)
        z = x - x.mean()
        denom = (z**2).sum()
        out[g] = (n / Wsum) * (z @ (W @ z)) / denom if denom > 0 else 0.0
    return out


def make_merfish(n_cells: int, n_genes: int, n_slices: int, seed: int, graph: bool, moran: bool) -> ad.AnnData:
    rng = np.random.default_rng(seed)
    bregma = np.round(np.linspace(0.26, -0.29, n_slices), 2)
    per = np.full(n_slices, n_cells // n_slices)
    per[: n_cells - per.sum()] += 1
    xs, ys, zs, slice_col, ctype = [], [], [], [], []
    centers = rng.uniform(-1500, 1500, size=(len(CELL_TYPES), 2))
    for si, (b, m) in enumerate(zip(bregma, per)):
        # tissue = ellipse whose size drifts with Bregma, plus a hollow ventricle
        rx, ry = 2200 - 400 * abs(b), 1600 + 300 * b
        pts = np.empty((0, 2))
        while len(pts) < m:
            cand = rng.uniform([-rx, -ry], [rx, ry], size=(m * 2, 2))
            inside = (cand[:, 0] / rx) ** 2 + (cand[:, 1] / ry) ** 2 <= 1
            hole = ((cand[:, 0] - 200) / 250) ** 2 + (cand[:, 1] / 500) ** 2 <= 1
            pts = np.vstack([pts, cand[inside & ~hole]])
        pts = pts[:m]
        # cell type from a soft spatial mixture (structured, not uniform)
        d2 = ((pts[:, None, :] - centers[None, :, :]) ** 2).sum(-1)
        logits = -d2 / (2 * 900**2) + rng.normal(0, 0.6, size=d2.shape)
        logits[:, 2] += 0.8  # excitatory neurons are common
        t = logits.argmax(axis=1)
        xs.append(pts[:, 0] + 3000)
        ys.append(pts[:, 1] + 2500)
        zs.append(np.full(m, b))
        slice_col += [f"Bregma_{b:+.2f}"] * m
        ctype.append(t)
    x = np.concatenate(xs)
    y = np.concatenate(ys)
    z = np.concatenate(zs)
    t = np.concatenate(ctype)
    n = len(x)
    # expression: cell-type marker structure + noise, Poisson counts, CSC float32
    markers = rng.integers(0, len(CELL_TYPES), size=n_genes)
    base = rng.gamma(0.4, 1.0, size=n_genes)
    rows, cols, vals = [], [], []
    chunk = 200_000
    for s in range(0, n, chunk):
        e = min(n, s + chunk)
        lam = np.tile(base, (e - s, 1)) * 0.6
        lam[np.arange(e - s)[:, None], np.arange(n_genes)[None, :]] *= np.where(markers[None, :] == t[s:e, None], 6.0, 1.0)
        counts = rng.poisson(lam).astype(np.float32)
        r, c = np.nonzero(counts)
        rows.append(r + s)
        cols.append(c)
        vals.append(counts[r, c])
    X = sp.csc_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(n, n_genes), dtype=np.float32)
    obs = pd.DataFrame(index=[f"cell_{i}" for i in range(n)])
    obs["Bregma"] = z.astype(np.float64)
    obs["slice_id"] = pd.Categorical(slice_col, categories=[f"Bregma_{b:+.2f}" for b in bregma])
    obs["cell_type"] = pd.Categorical([CELL_TYPES[i] for i in t], categories=CELL_TYPES)
    obs["total_counts"] = np.asarray(X.sum(axis=1)).ravel().astype(np.float32)
    var = pd.DataFrame(index=[f"Gene{i:04d}" for i in range(n_genes)])
    adata = ad.AnnData(X=X, obs=obs, var=var, obsm={"spatial3d": np.column_stack([x, y, z]).astype(np.float64), "spatial": np.column_stack([x, y]).astype(np.float64)})
    adata.uns["cell_type_colors"] = COLORS[: len(CELL_TYPES)]
    if graph and n <= 600_000:
        offset = 0
        W = sp.csr_matrix((n, n))
        for m in per:
            W = W + knn_graph(np.column_stack([x[offset : offset + m], y[offset : offset + m]]), 6, offset, n)
            offset += m
        adata.obsp["spatial_connectivities"] = W.tocsr()
        adata.uns["spatial_neighbors"] = {"params": {"n_neighbors": 6, "coord_type": "generic", "transform": "None", "library_key": "slice_id"}}
        if moran:
            g = min(50, n_genes)
            I = morans_i(X, W.tocsr(), g)
            adata.uns["moranI"] = pd.DataFrame({"I": I, "pval_norm": np.clip(1 - I, 0, 1), "var_norm": np.full(g, 1e-4), "pval_norm_fdr_bh": np.clip(1 - I, 0, 1)}, index=var.index[:g]).sort_values("I", ascending=False)
    return adata


def he_texture(rng: np.random.Generator, size: int) -> np.ndarray:
    """Cheap H&E-looking texture: pink background, purple 'nuclei' speckles, tissue blob mask."""
    yy, xx = np.mgrid[0:size, 0:size] / size
    blob = ((xx - 0.5) / 0.42) ** 2 + ((yy - 0.5) / 0.36) ** 2 <= 1
    low = rng.random((size // 32 + 1, size // 32 + 1))
    noise = np.kron(low, np.ones((32, 32)))[:size, :size]
    nuclei = rng.random((size, size)) > 0.985
    img = np.empty((size, size, 3), dtype=np.uint8)
    img[..., 0] = 235
    img[..., 1] = 225
    img[..., 2] = 235
    pink = np.stack([230 - 30 * noise, 150 + 40 * noise, 190 + 20 * noise], axis=-1)
    img[blob] = pink[blob].astype(np.uint8)
    img[blob & nuclei] = (90, 50, 140)
    img[:24, :24] = (200, 30, 30)  # top-left marker
    return img


def make_visium(n_sections: int, image_size: int, seed: int) -> ad.AnnData:
    rng = np.random.default_rng(seed)
    scalef = image_size / 20000.0  # hires spans 20000 full-res px
    spot_d = 130.0
    pitch = 200.0
    lib_ids = [f"section{i + 1}" for i in range(n_sections)]
    frames = []
    coords = []
    uns_spatial = {}
    for li, lid in enumerate(lib_ids):
        img = he_texture(rng, image_size)
        low_f = 4
        low = img[: image_size // low_f * low_f, : image_size // low_f * low_f].reshape(image_size // low_f, low_f, image_size // low_f, low_f, 3).mean(axis=(1, 3)).astype(np.uint8)
        cols = np.arange(0, 20000, pitch)
        rows = np.arange(0, 20000, pitch * 0.866)
        gx, gy = np.meshgrid(cols, rows)
        gx = gx + (np.arange(len(rows))[:, None] % 2) * pitch / 2
        xy = np.column_stack([gx.ravel(), gy.ravel()])
        u = xy / 20000.0
        inside = ((u[:, 0] - 0.5) / 0.42) ** 2 + ((u[:, 1] - 0.5) / 0.36) ** 2 <= 1
        in_tissue = inside.astype(np.int64)
        keep = inside | (rng.random(len(xy)) < 0.15)  # a few out-of-tissue spots like real Visium
        xy = xy[keep]
        in_tissue = in_tissue[keep]
        m = len(xy)
        frames.append(pd.DataFrame({"in_tissue": in_tissue, "array_row": np.arange(m), "array_col": np.arange(m), "library_id": lid, "cluster": rng.choice(["c0", "c1", "c2", "c3", "c4", "c5"], size=m)}, index=[f"{lid}-{i}" for i in range(m)]))
        coords.append(xy)
        uns_spatial[lid] = {"images": {"hires": img, "lowres": low}, "scalefactors": {"tissue_hires_scalef": scalef, "tissue_lowres_scalef": scalef / low_f, "spot_diameter_fullres": spot_d, "fiducial_diameter_fullres": spot_d * 1.6}}
    obs = pd.concat(frames)
    obs["library_id"] = pd.Categorical(obs["library_id"], categories=lib_ids)
    obs["cluster"] = pd.Categorical(obs["cluster"])
    n = len(obs)
    n_genes = 200
    X = sp.random(n, n_genes, density=0.15, format="csc", random_state=seed, data_rvs=lambda k: rng.integers(1, 40, k)).astype(np.float32)
    adata = ad.AnnData(X=X, obs=obs, var=pd.DataFrame(index=[f"Gene{i:04d}" for i in range(n_genes)]), obsm={"spatial": np.vstack(coords).astype(np.float64)}, uns={"spatial": uns_spatial})
    return adata


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=os.path.join("data", "synthetic", "synthetic_40k.h5ad"))
    ap.add_argument("--n-cells", type=int, default=40_000)
    ap.add_argument("--n-genes", type=int, default=300)
    ap.add_argument("--n-slices", type=int, default=10)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--no-graph", action="store_true")
    ap.add_argument("--no-moran", action="store_true")
    ap.add_argument("--visium", type=int, metavar="N_SECTIONS", help="generate a Visium-like dataset with images instead")
    ap.add_argument("--image-size", type=int, default=2048)
    a = ap.parse_args()
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    adata = make_visium(a.visium, a.image_size, a.seed) if a.visium else make_merfish(a.n_cells, a.n_genes, a.n_slices, a.seed, not a.no_graph, not a.no_moran)
    adata.write_h5ad(a.out, compression="gzip", compression_opts=4)
    print(f"wrote {a.out}: {adata.n_obs:,} cells × {adata.n_vars:,} genes, {os.path.getsize(a.out) / 1e6:.1f} MB; obsm={list(adata.obsm.keys())} uns={list(adata.uns.keys())} obsp={list(adata.obsp.keys())}")


if __name__ == "__main__":
    main()
