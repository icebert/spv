#!/usr/bin/env python3
"""Shrink / convert an AnnData ``.h5ad`` so it loads fast in SPV and fits GitHub Pages (< 100 MB).

Examples
--------
Recommended recipe for a hosted dataset::

    python scripts/prepare_h5ad.py in.h5ad out.h5ad --csc --float32 --compression gzip --level 4 \
        --drop raw,varm,varp --downscale-images 2000 --n-top-genes 2000

Make section stacking unambiguous for a 2-D multi-section file::

    python scripts/prepare_h5ad.py in.h5ad out.h5ad --library-key library_id --z-spacing 500

Options
-------
--max-cells N [--stratify OBS_COL]   random (stratified) subsample of cells
--genes FILE|g1,g2,...               keep only these genes (file: one name per line)
--n-top-genes N [--rank variance|moranI]   keep the N most variable genes (or top Moran's I when uns/moranI exists)
--layer NAME                         promote layers/NAME to X
--drop raw,layers,obsp,varm,varp,uns  drop groups; --drop uns KEEPS uns/spatial, uns/*_colors,
                                     uns/spatial_neighbors and uns/moranI
--downscale-images PX                shrink uns/spatial/*/images/hires so the longest side ≤ PX and rescale
                                     tissue_hires_scalef consistently (lowres likewise if larger)
--drop-images                        remove all tissue images
--keep-graph / --drop-graph          keep (default) or drop obsp/*_connectivities and *_distances
--csc                                store X as CSC (gene columns become a cheap slice in the browser)
--float32                            store X data as float32
--spatial-key KEY                    copy obsm/KEY to obsm/spatial
--library-key OBS_COL --z-spacing F  materialise obsm/spatial3d = [x, y, ordinal * F] (natural sort order)
--compression gzip|lzf|none --level L
"""

from __future__ import annotations

import argparse
import os
import re
import sys

import anndata as ad
import numpy as np
import scipy.sparse as sp

KEEP_UNS = ("spatial", "spatial_neighbors", "moranI")


def natural_key(s: str):
    return [(0, float(p)) if re.fullmatch(r"-?\d+(?:\.\d+)?", p) else (1, p.lower()) for p in re.split(r"(-?\d+(?:\.\d+)?)", s) if p]


def nnz_of(x) -> int:
    if x is None:
        return 0
    return int(x.nnz) if sp.issparse(x) else int(np.count_nonzero(x))


def image_bytes(adata: ad.AnnData) -> int:
    total = 0
    for lib in adata.uns.get("spatial", {}).values():
        for img in lib.get("images", {}).values():
            total += int(np.asarray(img).nbytes)
    return total


def downscale(img: np.ndarray, max_side: int) -> tuple[np.ndarray, float]:
    """Integer-factor box downscale; returns (image, factor applied to scale factors)."""
    h, w = img.shape[:2]
    f = int(np.ceil(max(h, w) / max_side))
    if f <= 1:
        return img, 1.0
    hh, ww = h // f, w // f
    cropped = img[: hh * f, : ww * f].astype(np.float32)
    if img.ndim == 3:
        small = cropped.reshape(hh, f, ww, f, img.shape[2]).mean(axis=(1, 3))
    else:
        small = cropped.reshape(hh, f, ww, f).mean(axis=(1, 3))
    small = small.astype(img.dtype) if img.dtype != np.uint8 else np.clip(np.round(small), 0, 255).astype(np.uint8)
    return small, ww / w


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--max-cells", type=int)
    ap.add_argument("--stratify")
    ap.add_argument("--genes")
    ap.add_argument("--n-top-genes", type=int)
    ap.add_argument("--rank", choices=["variance", "moranI"], default=None)
    ap.add_argument("--layer")
    ap.add_argument("--drop", default="")
    ap.add_argument("--downscale-images", type=int)
    ap.add_argument("--drop-images", action="store_true")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--keep-graph", action="store_true", default=True)
    g.add_argument("--drop-graph", action="store_true")
    ap.add_argument("--csc", action="store_true")
    ap.add_argument("--float32", action="store_true")
    ap.add_argument("--spatial-key")
    ap.add_argument("--library-key")
    ap.add_argument("--z-spacing", type=float)
    ap.add_argument("--compression", default="gzip", choices=["gzip", "lzf", "none"])
    ap.add_argument("--level", type=int, default=4)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()

    before = os.path.getsize(a.input)
    adata = ad.read_h5ad(a.input)
    rng = np.random.default_rng(a.seed)
    print(f"in : {a.input}  {before / 1e6:.1f} MB  {adata.n_obs:,} × {adata.n_vars:,}  X={'None' if adata.X is None else type(adata.X).__name__} nnz={nnz_of(adata.X):,}  images={image_bytes(adata) / 1e6:.1f} MB")

    if a.layer:
        adata.X = adata.layers[a.layer]
        del adata.layers[a.layer]
        print(f"promoted layers/{a.layer} to X")

    if a.max_cells and a.max_cells < adata.n_obs:
        if a.stratify:
            groups = adata.obs[a.stratify].astype(str).to_numpy()
            keep = []
            for gname in np.unique(groups):
                idx = np.flatnonzero(groups == gname)
                k = max(1, int(round(len(idx) * a.max_cells / adata.n_obs)))
                keep.append(rng.choice(idx, size=min(k, len(idx)), replace=False))
            keep = np.sort(np.concatenate(keep))
        else:
            keep = np.sort(rng.choice(adata.n_obs, size=a.max_cells, replace=False))
        adata = adata[keep].copy()
        print(f"subsampled to {adata.n_obs:,} cells" + (f" (stratified by {a.stratify})" if a.stratify else ""))

    if a.genes:
        names = [l.strip() for l in open(a.genes)] if os.path.isfile(a.genes) else [x.strip() for x in a.genes.split(",")]
        names = [n for n in names if n]
        mask = adata.var_names.isin(names)
        missing = set(names) - set(adata.var_names[mask])
        if missing:
            print(f"warning: {len(missing)} requested genes not found (e.g. {sorted(missing)[:5]})", file=sys.stderr)
        adata = adata[:, mask].copy()
        print(f"kept {adata.n_vars:,} listed genes")
    elif a.n_top_genes and a.n_top_genes < adata.n_vars:
        rank = a.rank or ("moranI" if "moranI" in adata.uns else "variance")
        if rank == "moranI" and "moranI" in adata.uns:
            mi = adata.uns["moranI"]
            top = list(mi.sort_values("I", ascending=False).index[: a.n_top_genes])
            mask = adata.var_names.isin(top)
        else:
            X = adata.X
            if sp.issparse(X):
                mean = np.asarray(X.mean(axis=0)).ravel()
                sq = np.asarray(X.multiply(X).mean(axis=0)).ravel()
                var = sq - mean**2
            else:
                var = np.asarray(np.var(X, axis=0)).ravel()
            order = np.argsort(-var)[: a.n_top_genes]
            mask = np.zeros(adata.n_vars, dtype=bool)
            mask[order] = True
        adata = adata[:, mask].copy()
        print(f"kept {adata.n_vars:,} top genes by {rank}")

    drops = {d.strip() for d in a.drop.split(",") if d.strip()}
    if "raw" in drops and adata.raw is not None:
        adata.raw = None
        print("dropped raw")
    if "layers" in drops:
        for k in list(adata.layers.keys()):
            del adata.layers[k]
        print("dropped layers")
    if "obsp" in drops or a.drop_graph:
        for k in list(adata.obsp.keys()):
            if "obsp" in drops or k.endswith(("_connectivities", "_distances")):
                del adata.obsp[k]
        print("dropped obsp graphs")
    if "varm" in drops:
        for k in list(adata.varm.keys()):
            del adata.varm[k]
    if "varp" in drops:
        for k in list(adata.varp.keys()):
            del adata.varp[k]
    if "uns" in drops:
        for k in list(adata.uns.keys()):
            if k in KEEP_UNS or k.endswith("_colors"):
                continue
            del adata.uns[k]
        print(f"dropped uns except {KEEP_UNS} and *_colors")

    spatial = adata.uns.get("spatial")
    if isinstance(spatial, dict):
        if a.drop_images:
            for lib in spatial.values():
                lib.pop("images", None)
            print("dropped tissue images")
        elif a.downscale_images:
            for lid, lib in spatial.items():
                imgs = lib.get("images", {})
                sf = lib.setdefault("scalefactors", {})
                for key, scalef_key in (("hires", "tissue_hires_scalef"), ("lowres", "tissue_lowres_scalef")):
                    if key in imgs:
                        img = np.asarray(imgs[key])
                        small, factor = downscale(img, a.downscale_images)
                        if factor != 1.0:
                            imgs[key] = small
                            if scalef_key in sf:
                                sf[scalef_key] = float(sf[scalef_key]) * factor
                            print(f"  {lid}/{key}: {img.shape[1]}×{img.shape[0]} → {small.shape[1]}×{small.shape[0]} ({scalef_key} × {factor:.4f})")

    if a.spatial_key and a.spatial_key in adata.obsm:
        adata.obsm["spatial"] = np.asarray(adata.obsm[a.spatial_key])
        print(f"copied obsm/{a.spatial_key} → obsm/spatial")

    if a.library_key:
        if a.z_spacing is None:
            ap.error("--library-key requires --z-spacing")
        col = adata.obs[a.library_key].astype(str)
        order = sorted(col.unique(), key=natural_key)
        ordinal = col.map({name: i for i, name in enumerate(order)}).to_numpy(dtype=np.float64)
        xy = np.asarray(adata.obsm["spatial"], dtype=np.float64)[:, :2]
        adata.obsm["spatial3d"] = np.column_stack([xy, ordinal * a.z_spacing])
        print(f"wrote obsm/spatial3d with {len(order)} sections spaced {a.z_spacing}")

    if adata.X is not None:
        if a.float32:
            if sp.issparse(adata.X):
                adata.X = adata.X.astype(np.float32)
            else:
                adata.X = np.asarray(adata.X, dtype=np.float32)
        if a.csc:
            adata.X = sp.csc_matrix(adata.X)
        elif sp.issparse(adata.X) and not sp.isspmatrix_csr(adata.X):
            adata.X = sp.csr_matrix(adata.X)

    comp = None if a.compression == "none" else a.compression
    opts = a.level if comp == "gzip" else None
    adata.write_h5ad(a.output, compression=comp, compression_opts=opts)
    after = os.path.getsize(a.output)
    nnz = nnz_of(adata.X)
    coords_mb = adata.n_obs * 12 / 1e6
    index_mb = (nnz * 8 / 1e6) if (adata.X is not None and sp.isspmatrix_csr(adata.X) and nnz <= 25_000_000) else 0
    img_mb = image_bytes(adata) / 1e6 * (4 / 3)
    print(f"out: {a.output}  {after / 1e6:.1f} MB  {adata.n_obs:,} × {adata.n_vars:,}  X={'None' if adata.X is None else type(adata.X).__name__} nnz={nnz:,}  images={image_bytes(adata) / 1e6:.1f} MB")
    print(f"rough browser memory: coordinates {coords_mb:.0f} MB + gene index {index_mb:.0f} MB + image textures {img_mb:.0f} MB"
          + (" (+ the whole file in memory if the host lacks range requests)" if after > 50e6 else ""))
    if after > 100e6:
        print("warning: still over GitHub's 100 MB limit — host it elsewhere (with CORS + Range) or shrink further", file=sys.stderr)


if __name__ == "__main__":
    main()
