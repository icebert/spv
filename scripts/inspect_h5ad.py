#!/usr/bin/env python3
"""Inspect an AnnData ``.h5ad`` file with h5py only (never loads ``X`` wholesale).

Reports the full HDF5 structure (paths, shapes, dtypes, encodings, filters,
chunking), the ``obs``/``var`` dataframes, ``obsm``/``obsp``/``layers``/``raw``,
the Squidpy structures under ``uns`` (``spatial``, ``*_colors``, ``moranI``,
``spatial_neighbors``), the detected spatial coordinate source, the detected
library/section column, per-section cell counts and bounding boxes, and a list
of flags for anything the SPV spec did not anticipate.

Writes a machine-readable ``<file>.meta.json`` next to the file (or ``--out``)
that is used to fill ``data/datasets.json`` and as ground truth for the E2E
tests, and prints a human-readable summary.

Usage:
    python scripts/inspect_h5ad.py data/demo.h5ad [--out data/demo.meta.json]
                                   [--genes Gene1,Gene2] [--n-gene-examples 5]
                                   [--max-items 5000] [--quiet]

Only ``h5py`` and ``numpy`` are required.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from typing import Any

import h5py
import numpy as np

# --- Conventions mirrored from the viewer's reader (src/h5ad/reader.ts) ----------
SPATIAL_KEYS_3D_ORDER = ["spatial3d", "spatial_3d", "X_spatial_3d", "spatial", "X_spatial"]
Z_OBS_KEYS = ["z", "Z", "z_coord", "z_um", "depth", "Bregma"]
LIBRARY_KEY_CANDIDATES = [
    "library_id", "library", "sample", "sample_id", "section", "slice", "slide",
    "fov", "z_index", "batch",
]
CLUSTER_PRIORITY = ["leiden", "louvain", "cluster", "cell_type", "celltype"]
GENE_NAME_COLUMNS = ["gene_symbols", "gene_symbol", "feature_name", "symbol"]
SCALEFACTOR_KEYS = [
    "tissue_hires_scalef", "tissue_lowres_scalef", "spot_diameter_fullres",
    "fiducial_diameter_fullres",
]
CSR_NNZ_WARN = 50_000_000  # matches the viewer's warning threshold (§5.3)


# --- Small helpers -----------------------------------------------------------------
def to_py(v: Any) -> Any:
    """Convert h5py attribute / scalar values to JSON-serialisable Python."""
    if isinstance(v, bytes):
        return v.decode("utf-8", "replace")
    if isinstance(v, np.generic):
        return v.item()
    if isinstance(v, np.ndarray):
        if v.dtype.kind in ("S", "O"):
            return [to_py(x) for x in v.tolist()]
        return v.tolist()
    if isinstance(v, h5py.Reference):
        return "<object reference>"
    if isinstance(v, (list, tuple)):
        return [to_py(x) for x in v]
    if isinstance(v, float) and not math.isfinite(v):
        return None
    return v


def attrs_of(obj: h5py.HLObject) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in obj.attrs.items():
        try:
            out[k] = to_py(v)
        except Exception as exc:  # pragma: no cover - defensive
            out[k] = f"<unreadable: {exc}>"
    return out


def decode_strings(arr: np.ndarray) -> list[str]:
    return [x.decode("utf-8", "replace") if isinstance(x, bytes) else str(x) for x in arr.tolist()]


def dtype_str(ds: h5py.Dataset) -> str:
    dt = ds.dtype
    if h5py.check_string_dtype(dt) is not None:
        info = h5py.check_string_dtype(dt)
        return f"string(vlen)" if info.length is None else f"string(fixed:{info.length})"
    if h5py.check_enum_dtype(dt) is not None:
        return f"enum({dt.base}){h5py.check_enum_dtype(dt)}"
    if dt.kind == "O":
        return "object"
    return str(dt)


def describe(path: str, obj: h5py.HLObject) -> dict[str, Any]:
    if isinstance(obj, h5py.Dataset):
        filters: list[str] = []
        if obj.compression:
            filters.append(f"{obj.compression}({obj.compression_opts})")
        if obj.shuffle:
            filters.append("shuffle")
        if obj.fletcher32:
            filters.append("fletcher32")
        if obj.scaleoffset is not None:
            filters.append(f"scaleoffset({obj.scaleoffset})")
        return {
            "path": path, "kind": "dataset", "shape": list(obj.shape), "dtype": dtype_str(obj),
            "chunks": list(obj.chunks) if obj.chunks else None,
            "filters": filters, "attrs": attrs_of(obj),
        }
    return {"path": path, "kind": "group", "attrs": attrs_of(obj)}


def natural_key(s: str) -> list[Any]:
    """Sort key: split digits (incl. negative decimals) so 'S2' < 'S10' and 'Bregma_-0.29' orders numerically."""
    parts = re.split(r"(-?\d+(?:\.\d+)?)", s)
    key: list[Any] = []
    for p in parts:
        if p == "":
            continue
        try:
            key.append((0, float(p)))
        except ValueError:
            key.append((1, p.lower()))
    return key


def sparse_format_of(g: h5py.Group) -> str | None:
    enc = to_py(g.attrs.get("encoding-type"))
    if enc in ("csr_matrix", "csc_matrix"):
        return enc.replace("_matrix", "")
    legacy = to_py(g.attrs.get("h5sparse_format"))
    if legacy in ("csr", "csc"):
        return legacy
    if {"data", "indices", "indptr"} <= set(g.keys()):
        return "unknown-sparse"
    return None


def sparse_shape_of(g: h5py.Group) -> list[int] | None:
    for k in ("shape", "h5sparse_shape"):
        if k in g.attrs:
            return [int(x) for x in to_py(g.attrs[k])]
    return None


# --- Dataframe decoding -------------------------------------------------------------
def column_info(f: h5py.File, df: h5py.Group, name: str, sample: int = 8) -> dict[str, Any]:
    """Describe one dataframe column the way the viewer will decode it."""
    obj = df[name]
    info: dict[str, Any] = {"name": name, "encoding": to_py(obj.attrs.get("encoding-type"))}
    try:
        if isinstance(obj, h5py.Group):
            enc = info["encoding"]
            if enc == "categorical" or ("codes" in obj and "categories" in obj):
                codes, cats = obj["codes"], obj["categories"]
                cat_vals = cats[...]
                cat_list = decode_strings(cat_vals) if cat_vals.dtype.kind in ("O", "S", "U") else to_py(cat_vals)
                codes_arr = codes[...]
                info.update({
                    "kind": "categorical", "codes_dtype": str(codes.dtype),
                    "categories_dtype": dtype_str(cats), "n_categories": int(cats.shape[0]),
                    "categories_head": cat_list[:sample], "ordered": bool(to_py(obj.attrs.get("ordered", False))),
                    "n_missing": int((codes_arr < 0).sum()), "n": int(codes.shape[0]),
                })
                info["_categories"] = cat_list  # used internally, stripped before writing
                info["_codes"] = codes_arr
            elif enc in ("nullable-integer", "nullable-boolean") or ("values" in obj and "mask" in obj):
                vals, mask = obj["values"], obj["mask"]
                info.update({"kind": enc or "nullable", "dtype": dtype_str(vals),
                             "n_missing": int(mask[...].sum()), "n": int(vals.shape[0])})
            else:
                info.update({"kind": "unsupported", "reason": f"group with encoding {enc!r}", "keys": list(obj.keys())})
        else:
            ds: h5py.Dataset = obj
            # Legacy anndata (<0.8) categorical: int codes + 'categories' attr referencing __categories/<col>
            if "categories" in ds.attrs:
                ref = ds.attrs["categories"]
                cats_ds = f[ref] if isinstance(ref, h5py.Reference) else None
                if cats_ds is None and "__categories" in df and name in df["__categories"]:
                    cats_ds = df["__categories"][name]
                if cats_ds is not None:
                    cat_vals = cats_ds[...]
                    cat_list = decode_strings(cat_vals) if cat_vals.dtype.kind in ("O", "S", "U") else to_py(cat_vals)
                    codes_arr = ds[...]
                    info.update({
                        "kind": "categorical-legacy", "codes_dtype": str(ds.dtype),
                        "n_categories": int(cats_ds.shape[0]), "categories_head": cat_list[:sample],
                        "n_missing": int((codes_arr < 0).sum()), "n": int(ds.shape[0]),
                    })
                    info["_categories"] = cat_list
                    info["_codes"] = codes_arr
                    return info
            if h5py.check_string_dtype(ds.dtype) is not None or ds.dtype.kind in ("S", "U", "O"):
                head = decode_strings(ds[: min(sample, ds.shape[0])]) if ds.ndim == 1 else []
                info.update({"kind": "string", "dtype": dtype_str(ds), "n": int(ds.shape[0]), "head": head})
            elif h5py.check_enum_dtype(ds.dtype) is not None or ds.dtype.kind == "b":
                info.update({"kind": "boolean", "dtype": dtype_str(ds), "n": int(ds.shape[0])})
            elif ds.dtype.kind in ("i", "u", "f"):
                if ds.ndim != 1:
                    info.update({"kind": "unsupported", "reason": f"numeric column with ndim={ds.ndim}", "shape": list(ds.shape)})
                else:
                    arr = ds[...]
                    finite = arr[np.isfinite(arr)] if arr.dtype.kind == "f" else arr
                    info.update({
                        "kind": "numeric", "dtype": str(ds.dtype), "n": int(ds.shape[0]),
                        "min": to_py(finite.min()) if finite.size else None,
                        "max": to_py(finite.max()) if finite.size else None,
                        "n_unique": int(np.unique(arr).size) if arr.size <= 5_000_000 else None,
                        "n_nonfinite": int((~np.isfinite(arr)).sum()) if arr.dtype.kind == "f" else 0,
                    })
                    info["_values"] = arr
            else:
                info.update({"kind": "unsupported", "reason": f"dtype {ds.dtype}"})
    except Exception as exc:
        info.update({"kind": "unsupported", "reason": f"decode error: {exc}"})
    return info


def dataframe_info(f: h5py.File, df: h5py.Group) -> dict[str, Any]:
    index_name = to_py(df.attrs.get("_index", "_index"))
    order = to_py(df.attrs.get("column-order"))
    if order is None:
        order = [k for k in df.keys() if k not in (index_name, "__categories")]
    index_ds = df.get(index_name)
    out: dict[str, Any] = {
        "encoding": to_py(df.attrs.get("encoding-type")),
        "encoding_version": to_py(df.attrs.get("encoding-version")),
        "index_name": index_name,
        "index_dtype": dtype_str(index_ds) if isinstance(index_ds, h5py.Dataset) else None,
        "index_head": decode_strings(index_ds[:5]) if isinstance(index_ds, h5py.Dataset) and index_ds.ndim == 1 else [],
        "n": int(index_ds.shape[0]) if isinstance(index_ds, h5py.Dataset) else None,
        "column_order": order,
        "columns": [column_info(f, df, c) for c in order if c in df],
        "extra_keys": [k for k in df.keys() if k not in order and k not in (index_name, "__categories")],
        "has_legacy_categories_group": "__categories" in df,
    }
    return out


def strip_private(d: Any) -> Any:
    if isinstance(d, dict):
        return {k: strip_private(v) for k, v in d.items() if not k.startswith("_")}
    if isinstance(d, list):
        return [strip_private(x) for x in d]
    return d


# --- Matrices ------------------------------------------------------------------------
def matrix_info(obj: h5py.HLObject | None) -> dict[str, Any] | None:
    if obj is None:
        return None
    if isinstance(obj, h5py.Dataset):
        return {"format": "dense", "shape": list(obj.shape), "dtype": str(obj.dtype),
                "chunks": list(obj.chunks) if obj.chunks else None, "compression": obj.compression,
                "n_elements": int(np.prod(obj.shape))}
    fmt = sparse_format_of(obj)
    if fmt is None:
        return {"format": "unknown", "keys": list(obj.keys()), "attrs": attrs_of(obj)}
    data, indices, indptr = obj["data"], obj["indices"], obj["indptr"]
    return {"format": fmt, "shape": sparse_shape_of(obj), "dtype": str(data.dtype),
            "index_dtype": str(indices.dtype), "indptr_dtype": str(indptr.dtype), "nnz": int(data.shape[0]),
            "chunks": {"data": list(data.chunks) if data.chunks else None,
                       "indices": list(indices.chunks) if indices.chunks else None,
                       "indptr": list(indptr.chunks) if indptr.chunks else None},
            "compression": data.compression, "attrs": attrs_of(obj)}


def gene_examples(f: h5py.File, xinfo: dict[str, Any], var_names: list[str], wanted: list[str], n_auto: int,
                  nnz_cap: int) -> tuple[list[dict[str, Any]], list[str]]:
    """Compute reference statistics for a few gene columns (used by E2E tests).

    CSR: one chunked pass over indices/data collecting per-gene nnz/sum/max, then the
    chosen columns. CSC: slice via indptr. Dense: slice columns. Skipped above nnz_cap.
    """
    flags: list[str] = []
    X = f["X"]
    n_vars = len(var_names)
    name_to_idx: dict[str, int] = {}
    for i, n in enumerate(var_names):
        name_to_idx.setdefault(n, i)
    chosen: list[int] = [name_to_idx[g] for g in wanted if g in name_to_idx]
    for g in wanted:
        if g not in name_to_idx:
            flags.append(f"--genes: {g!r} not found in var names")

    fmt = xinfo["format"]
    per_gene_nnz: np.ndarray | None = None
    per_gene_sum: np.ndarray | None = None
    per_gene_max: np.ndarray | None = None
    if fmt == "csr":
        nnz = xinfo["nnz"]
        if nnz > nnz_cap:
            flags.append(f"X nnz={nnz:,} exceeds --nnz-cap; gene statistics skipped")
            return [], flags
        per_gene_nnz = np.zeros(n_vars, dtype=np.int64)
        per_gene_sum = np.zeros(n_vars, dtype=np.float64)
        per_gene_max = np.full(n_vars, -np.inf)
        step = 4_000_000
        for s in range(0, nnz, step):
            e = min(nnz, s + step)
            ind = X["indices"][s:e]
            dat = X["data"][s:e].astype(np.float64)
            per_gene_nnz += np.bincount(ind, minlength=n_vars)
            per_gene_sum += np.bincount(ind, weights=dat, minlength=n_vars)
            np.maximum.at(per_gene_max, ind, dat)
    elif fmt == "csc":
        indptr = X["indptr"][...]
        per_gene_nnz = np.diff(indptr).astype(np.int64)
    elif fmt == "dense":
        if xinfo["n_elements"] > nnz_cap:
            flags.append("dense X too large for gene statistics; skipped")
            return [], flags

    if not chosen:
        if per_gene_nnz is not None and per_gene_nnz.size:
            order = np.argsort(-per_gene_nnz)
            top = [int(i) for i in order[: max(1, n_auto // 2 + 1)]]
            mid = [int(i) for i in order[len(order) // 2: len(order) // 2 + max(1, n_auto - len(top))]]
            chosen = list(dict.fromkeys(top + mid))[:n_auto]
        else:
            chosen = list(range(min(n_auto, n_vars)))

    examples: list[dict[str, Any]] = []
    n_obs = xinfo["shape"][0]
    for j in chosen:
        if fmt == "csr":
            # Second pass restricted to this column: chunked so memory stays bounded.
            rows: list[np.ndarray] = []
            vals: list[np.ndarray] = []
            indptr = X["indptr"][...]
            nnz = xinfo["nnz"]
            step = 4_000_000
            for s in range(0, nnz, step):
                e = min(nnz, s + step)
                ind = X["indices"][s:e]
                hit = np.nonzero(ind == j)[0]
                if hit.size:
                    dat = X["data"][s:e]
                    pos = hit + s
                    rows.append(np.searchsorted(indptr, pos, side="right") - 1)
                    vals.append(dat[hit].astype(np.float64))
            r = np.concatenate(rows) if rows else np.zeros(0, dtype=np.int64)
            v = np.concatenate(vals) if vals else np.zeros(0)
        elif fmt == "csc":
            indptr = X["indptr"][...]
            s, e = int(indptr[j]), int(indptr[j + 1])
            r = X["indices"][s:e].astype(np.int64)
            v = X["data"][s:e].astype(np.float64)
        else:
            col = X[:, j].astype(np.float64)
            r = np.nonzero(col)[0]
            v = col[r]
        order = np.argsort(r, kind="stable")
        r, v = r[order], v[order]
        examples.append({
            "name": var_names[j], "index": int(j), "nnz": int(r.size),
            "sum": float(v.sum()), "max": float(v.max()) if v.size else 0.0,
            "mean_over_all_cells": float(v.sum() / n_obs) if n_obs else 0.0,
            "first_nonzero": [[int(a), float(b)] for a, b in zip(r[:5], v[:5])],
        })
    return examples, flags


# --- uns / Squidpy structures -------------------------------------------------------
def uns_summary(f: h5py.File, max_libraries_detail: int = 64) -> dict[str, Any]:
    out: dict[str, Any] = {"present": "uns" in f, "keys": [], "spatial": None, "colors": {},
                           "moranI": None, "spatial_neighbors": None, "squidpy_results": []}
    if "uns" not in f:
        return out
    uns = f["uns"]
    keys = list(uns.keys())
    out["keys"] = keys
    for k in keys:
        if k.endswith("_colors") and isinstance(uns[k], h5py.Dataset):
            ds = uns[k]
            head = decode_strings(ds[: min(4, ds.shape[0])]) if ds.ndim == 1 else []
            out["colors"][k] = {"obs_column": k[: -len("_colors")], "n": int(ds.shape[0]), "head": head}
        for suffix in ("_nhood_enrichment", "_co_occurrence", "_centrality_scores"):
            if k.endswith(suffix):
                out["squidpy_results"].append(k)
        if "_ripley_" in k:
            out["squidpy_results"].append(k)
    if "moranI" in uns:
        m = uns["moranI"]
        if isinstance(m, h5py.Group):
            out["moranI"] = {"encoding": to_py(m.attrs.get("encoding-type")), "columns": to_py(m.attrs.get("column-order")),
                             "index": to_py(m.attrs.get("_index")),
                             "n": int(m[to_py(m.attrs.get("_index", "_index"))].shape[0]) if to_py(m.attrs.get("_index", "_index")) in m else None}
        else:
            out["moranI"] = {"encoding": "dataset", "shape": list(m.shape)}
    if "spatial_neighbors" in uns and isinstance(uns["spatial_neighbors"], h5py.Group):
        sn = uns["spatial_neighbors"]
        params = {}
        if "params" in sn and isinstance(sn["params"], h5py.Group):
            for pk, pv in sn["params"].items():
                params[pk] = to_py(pv[()]) if isinstance(pv, h5py.Dataset) and pv.ndim == 0 else "<...>"
        out["spatial_neighbors"] = {"keys": list(sn.keys()), "params": params}
    if "spatial" in uns and isinstance(uns["spatial"], h5py.Group):
        sp = uns["spatial"]
        lib_ids = list(sp.keys())  # h5py returns stored (alphabetical / creation) order
        libs: dict[str, Any] = {}
        for lid in lib_ids[:max_libraries_detail]:
            g = sp[lid]
            entry: dict[str, Any] = {"keys": list(g.keys()) if isinstance(g, h5py.Group) else [], "images": {},
                                     "scalefactors": {}, "extra_scalefactor_keys": []}
            if isinstance(g, h5py.Group) and "images" in g and isinstance(g["images"], h5py.Group):
                for ik, iv in g["images"].items():
                    if isinstance(iv, h5py.Dataset):
                        entry["images"][ik] = {"shape": list(iv.shape), "dtype": str(iv.dtype),
                                               "compression": iv.compression, "chunks": list(iv.chunks) if iv.chunks else None}
            if isinstance(g, h5py.Group) and "scalefactors" in g and isinstance(g["scalefactors"], h5py.Group):
                for sk, sv in g["scalefactors"].items():
                    if isinstance(sv, h5py.Dataset) and sv.ndim == 0:
                        entry["scalefactors"][sk] = to_py(sv[()])
                    else:
                        entry["scalefactors"][sk] = f"<{'group' if isinstance(sv, h5py.Group) else 'array ' + str(list(sv.shape))}>"
                    if sk not in SCALEFACTOR_KEYS:
                        entry["extra_scalefactor_keys"].append(sk)
            libs[lid] = entry
        out["spatial"] = {"library_ids": lib_ids, "n_libraries": len(lib_ids), "libraries": libs,
                          "detail_truncated": len(lib_ids) > max_libraries_detail}
    return out


# --- Spatial detection --------------------------------------------------------------
def obsm_infos(f: h5py.File) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if "obsm" not in f:
        return out
    for k, v in f["obsm"].items():
        if isinstance(v, h5py.Dataset):
            out[k] = {"kind": "array", "shape": list(v.shape), "dtype": str(v.dtype),
                      "chunks": list(v.chunks) if v.chunks else None, "compression": v.compression}
        else:
            enc = to_py(v.attrs.get("encoding-type"))
            out[k] = {"kind": "dataframe" if enc == "dataframe" else "group", "encoding": enc,
                      "columns": to_py(v.attrs.get("column-order")), "keys": list(v.keys())}
    return out


def detect_spatial(f: h5py.File, obsm: dict[str, Any], obs_cols: list[dict[str, Any]]) -> dict[str, Any]:
    """Mirror §5.2 steps 1-2 (native 3D, then 2D + explicit z obs column)."""
    result: dict[str, Any] = {"key": None, "ndim": 0, "method": "none", "z_source": None}
    candidates = [k for k in SPATIAL_KEYS_3D_ORDER if k in obsm]
    candidates += sorted(k for k in obsm if k not in candidates and ("spatial" in k.lower() or "xyz" in k.lower()))
    best2d: str | None = None
    for k in candidates:
        info = obsm[k]
        if info.get("kind") != "array" or len(info["shape"]) != 2:
            continue
        ncol = info["shape"][1]
        if ncol == 3:
            result.update({"key": f"obsm/{k}", "ndim": 3, "method": "native3d"})
            break
        if ncol == 2 and best2d is None:
            best2d = k
    if result["key"] is None and best2d is not None:
        result.update({"key": f"obsm/{best2d}", "ndim": 2, "method": "2d"})
        for zk in Z_OBS_KEYS:
            col = next((c for c in obs_cols if c["name"] == zk and c.get("kind") == "numeric"), None)
            if col is not None:
                result.update({"method": "2d+obs_z", "z_source": f"obs/{zk}"})
                break
    return result


def load_coords(f: h5py.File, spatial: dict[str, Any], obs_cols: list[dict[str, Any]]) -> np.ndarray | None:
    if not spatial["key"]:
        return None
    ds = f[spatial["key"]]
    arr = np.asarray(ds[...], dtype=np.float64)
    if spatial["ndim"] == 2 and spatial.get("z_source"):
        zname = spatial["z_source"].split("/", 1)[1]
        zcol = next(c for c in obs_cols if c["name"] == zname)
        arr = np.column_stack([arr, np.asarray(zcol["_values"], dtype=np.float64)])
    return arr


def detect_library(obs_cols: list[dict[str, Any]], uns_spatial: dict[str, Any] | None,
                   coords: np.ndarray | None) -> dict[str, Any]:
    """Mirror §5.2 step 3: match uns/spatial keys, else candidate names, else discrete-z alignment."""
    cats = [c for c in obs_cols if c.get("kind", "").startswith("categorical") or c.get("kind") == "string"]
    out: dict[str, Any] = {"key": None, "method": "none", "matches_uns_spatial": None, "warning": None}
    if uns_spatial and uns_spatial.get("library_ids"):
        ids = set(uns_spatial["library_ids"])
        for c in cats:
            if c.get("kind", "").startswith("categorical") and set(c["_categories"]) == ids:
                return {**out, "key": f"obs/{c['name']}", "method": "uns_spatial_exact", "matches_uns_spatial": True}
        for c in cats:
            if c.get("kind", "").startswith("categorical") and set(c["_categories"]) & ids:
                return {**out, "key": f"obs/{c['name']}", "method": "uns_spatial_partial", "matches_uns_spatial": False,
                        "warning": "library column categories only partially match uns/spatial keys"}
        out["warning"] = "uns/spatial exists but no obs column matches its keys"
    for name in LIBRARY_KEY_CANDIDATES:
        c = next((c for c in cats if c["name"] == name), None)
        if c is not None:
            return {**out, "key": f"obs/{name}", "method": "candidate_name"}
    # Native 3D with discrete z: a categorical whose categories map 1:1 onto the z levels.
    if coords is not None and coords.shape[1] == 3:
        zu = np.unique(coords[:, 2])
        if 1 < zu.size <= 512:
            for c in cats:
                if c.get("kind", "").startswith("categorical") and c["n_categories"] == zu.size:
                    codes = c["_codes"]
                    ok = all(np.unique(coords[codes == i, 2]).size == 1 for i in range(c["n_categories"]))
                    if ok:
                        return {**out, "key": f"obs/{c['name']}", "method": "discrete_z_alignment"}
    return out


def build_sections(obs_cols: list[dict[str, Any]], library: dict[str, Any], coords: np.ndarray | None,
                   uns_spatial: dict[str, Any] | None) -> dict[str, Any]:
    if not library["key"]:
        return {"library_key": None, "n_sections": 0, "sections": []}
    name = library["key"].split("/", 1)[1]
    col = next(c for c in obs_cols if c["name"] == name)
    cats: list[str] = [str(x) for x in col["_categories"]]
    codes: np.ndarray = col["_codes"]
    if uns_spatial and library.get("matches_uns_spatial"):
        order = [c for c in uns_spatial["library_ids"] if c in cats]
        order_source = "uns/spatial key order"
    else:
        order = sorted(cats, key=natural_key)
        order_source = "natural sort of category names"
    stored_is_natural = order == cats
    libs = (uns_spatial or {}).get("libraries", {}) if uns_spatial else {}
    sections = []
    for ordinal, cname in enumerate(order):
        ci = cats.index(cname)
        m = codes == ci
        entry: dict[str, Any] = {"id": cname, "name": cname, "ordinal": ordinal, "n_cells": int(m.sum())}
        if coords is not None and m.any():
            sub = coords[m]
            sub = sub[np.isfinite(sub).all(axis=1)]
            if sub.size:
                entry["bbox"] = {"min": [float(v) for v in sub.min(axis=0)], "max": [float(v) for v in sub.max(axis=0)]}
                if coords.shape[1] == 3:
                    zu = np.unique(sub[:, 2])
                    entry["z_unique_count"] = int(zu.size)
                    entry["z"] = float(zu[0]) if zu.size == 1 else None
        lib = libs.get(cname)
        entry["has_image"] = bool(lib and lib["images"])
        entry["image_keys"] = list(lib["images"].keys()) if lib else []
        entry["spot_diameter_fullres"] = (lib or {}).get("scalefactors", {}).get("spot_diameter_fullres")
        entry["tissue_hires_scalef"] = (lib or {}).get("scalefactors", {}).get("tissue_hires_scalef")
        sections.append(entry)
    n_missing = int((codes < 0).sum())
    return {"library_key": library["key"], "order_source": order_source, "stored_order_is_natural": stored_is_natural,
            "n_sections": len(sections), "n_cells_without_section": n_missing, "sections": sections}


# --- Main ------------------------------------------------------------------------------
def inspect(path: str, wanted_genes: list[str], n_gene_examples: int, max_items: int, nnz_cap: int) -> dict[str, Any]:
    flags: list[str] = []
    meta: dict[str, Any] = {"file": path, "size_bytes": os.path.getsize(path)}
    with h5py.File(path, "r") as f:
        meta["root_attrs"] = attrs_of(f)
        if to_py(f.attrs.get("encoding-type")) != "anndata":
            flags.append("root attrs lack encoding-type='anndata' (older anndata, R writer, or not an AnnData file)")
        top = list(f.keys())
        meta["top_level_keys"] = top
        for k in top:
            if k not in ("X", "obs", "var", "obsm", "obsp", "varm", "varp", "uns", "layers", "raw"):
                flags.append(f"unexpected top-level key: {k!r}")

        # Structure listing (bounded).
        structure: list[dict[str, Any]] = []
        truncated = False

        def visitor(name: str, obj: h5py.HLObject) -> None:
            nonlocal truncated
            if len(structure) >= max_items:
                truncated = True
                return
            structure.append(describe(name, obj))

        f.visititems(visitor)
        meta["structure"] = structure
        meta["structure_truncated"] = truncated
        if truncated:
            flags.append(f"structure listing truncated at {max_items} items (use --max-items)")
        filters_used = sorted({flt.split("(")[0] for s in structure if s["kind"] == "dataset" for flt in s["filters"]})
        meta["filters_used"] = filters_used
        for flt in filters_used:
            if flt not in ("gzip", "shuffle", "fletcher32"):
                flags.append(f"compression filter {flt!r} needs h5wasm-plugins in the browser")

        # Dataframes.
        obs = dataframe_info(f, f["obs"]) if "obs" in f else None
        var = dataframe_info(f, f["var"]) if "var" in f else None
        if obs is None:
            flags.append("no obs group")
        if var is None:
            flags.append("no var group")
        obs_cols = obs["columns"] if obs else []
        n_obs = obs["n"] if obs else None
        n_vars = var["n"] if var else None
        meta["n_obs"], meta["n_vars"] = n_obs, n_vars
        for c in obs_cols:
            if c.get("kind") == "unsupported":
                flags.append(f"obs column {c['name']!r} unsupported: {c.get('reason')}")
            if c.get("kind", "").startswith("categorical") and c.get("n_missing"):
                flags.append(f"obs column {c['name']!r} has {c['n_missing']} missing (-1) codes → 'NA' legend entry")
            if c.get("kind") == "categorical-legacy":
                flags.append(f"obs column {c['name']!r} uses legacy (<0.8) categorical encoding")
        if obs and obs["index_dtype"] and "string" not in obs["index_dtype"]:
            flags.append(f"obs index dtype is {obs['index_dtype']} (bytes / non-string index)")
        var_names: list[str] = []
        if var:
            idx = f["var"][var["index_name"]]
            var_names = decode_strings(idx[...])
            dup = len(var_names) - len(set(var_names))
            var["n_duplicate_names"] = dup
            var["gene_name_columns"] = [c["name"] for c in var["columns"] if c["name"] in GENE_NAME_COLUMNS]
            var["names_head"] = var_names[:10]
            if dup:
                flags.append(f"var has {dup} duplicate gene names")
            if not var["gene_name_columns"] and not var["columns"]:
                flags.append("var has no columns besides the index (no alternative gene-symbol column)")
        meta["obs"], meta["var"] = obs, var

        # Matrices.
        xinfo = matrix_info(f.get("X"))
        meta["X"] = xinfo
        if xinfo is None:
            flags.append("X is missing (expression coloring unavailable unless layers/raw exist)")
        else:
            if xinfo["format"] == "csr":
                flags.append("X is CSR: gene-column extraction must scan all of indices (viewer reads it in chunks); "
                             "prepare_h5ad.py --csc makes gene switching O(nnz_column)"
                             + (f"; nnz={xinfo['nnz']:,} exceeds the {CSR_NNZ_WARN:,} warning threshold" if xinfo["nnz"] > CSR_NNZ_WARN else f"; nnz={xinfo['nnz']:,} is below the {CSR_NNZ_WARN:,} warning threshold"))
            if xinfo["dtype"] == "float64":
                flags.append("X data is float64 → viewer downcasts to float32 for the GPU")
            if xinfo["dtype"].startswith(("int", "uint")):
                flags.append(f"X is integer ({xinfo['dtype']}) → likely raw counts")
            if xinfo["format"] == "unknown":
                flags.append("X group has an unrecognised sparse layout")
            shp = xinfo.get("shape")
            if shp and n_obs is not None and shp[0] != n_obs:
                flags.append(f"X shape[0]={shp[0]} != n_obs={n_obs}")
            if shp and n_vars is not None and shp[1] != n_vars:
                flags.append(f"X shape[1]={shp[1]} != n_vars={n_vars}")
            # Sample of values to guess normalisation.
            try:
                if xinfo["format"] in ("csr", "csc"):
                    sample = f["X/data"][: min(200_000, xinfo["nnz"])]
                else:
                    sample = f["X"][: min(256, shp[0]), : min(256, shp[1])].ravel()
                sample = np.asarray(sample, dtype=np.float64)
                xinfo["value_sample"] = {"min": float(sample.min()), "max": float(sample.max()),
                                         "all_integer": bool(np.all(sample == np.round(sample))),
                                         "n": int(sample.size)}
                if not xinfo["value_sample"]["all_integer"] and sample.max() < 30:
                    flags.append("X values look log-normalised (non-integer, max < 30) → log1p toggle should default off")
            except Exception as exc:  # pragma: no cover
                flags.append(f"could not sample X values: {exc}")
        meta["layers"] = {k: matrix_info(v) for k, v in f["layers"].items()} if "layers" in f else {}
        if "raw" in f:
            raw = f["raw"]
            raw_var = dataframe_info(f, raw["var"]) if "var" in raw else None
            meta["raw"] = {"X": matrix_info(raw.get("X")), "var_n": raw_var["n"] if raw_var else None,
                           "var_differs_from_var": bool(raw_var and raw_var["n"] != n_vars)}
        else:
            meta["raw"] = None

        # obsm / obsp / varm / varp.
        obsm = obsm_infos(f)
        meta["obsm"] = obsm
        for k, v in obsm.items():
            if v.get("kind") == "array" and n_obs is not None and v["shape"][0] != n_obs:
                flags.append(f"obsm/{k} has {v['shape'][0]} rows but n_obs={n_obs}")
        obsp: dict[str, Any] = {}
        if "obsp" in f:
            for k, v in f["obsp"].items():
                obsp[k] = matrix_info(v)
                if k.endswith("_connectivities") and obsp[k] and obsp[k].get("format") not in ("csr", "csc"):
                    flags.append(f"obsp/{k} is not CSR/CSC ({obsp[k].get('format')})")
                if k.endswith("_connectivities") and k != "spatial_connectivities":
                    flags.append(f"obsp/{k}: spatial graph with non-default key_added")
        meta["obsp"] = obsp
        meta["varm"] = {k: (list(v.shape) if isinstance(v, h5py.Dataset) else "group") for k, v in f["varm"].items()} if "varm" in f else {}
        meta["varp"] = {k: (list(v.shape) if isinstance(v, h5py.Dataset) else "group") for k, v in f["varp"].items()} if "varp" in f else {}

        # uns.
        uns = uns_summary(f)
        meta["uns"] = uns
        if uns["present"] and not uns["keys"]:
            flags.append("uns is empty: no uns/spatial (no tissue images, no scale factors), no *_colors, no Squidpy results")
        if uns["spatial"]:
            for lid, lib in uns["spatial"]["libraries"].items():
                for ik, iv in lib["images"].items():
                    if iv["dtype"].startswith("float"):
                        flags.append(f"uns/spatial/{lid}/images/{ik} stored as float (expect [0,1])")
                    if len(iv["shape"]) == 3 and iv["shape"][2] not in (3, 4):
                        flags.append(f"uns/spatial/{lid}/images/{ik} has unexpected channel count {iv['shape'][2]}")
                if lib["images"] and "tissue_hires_scalef" not in lib["scalefactors"] and "tissue_lowres_scalef" not in lib["scalefactors"]:
                    flags.append(f"uns/spatial/{lid}: image present but no tissue_*_scalef → placement unknown")
                if lib["extra_scalefactor_keys"]:
                    flags.append(f"uns/spatial/{lid}: extra scalefactor keys {lib['extra_scalefactor_keys']}")
            if uns["spatial"]["n_libraries"] > 50:
                flags.append(f"uns/spatial has {uns['spatial']['n_libraries']} entries (CosMx-style FOVs?) → virtualise the section list")
        for ck, cv in uns["colors"].items():
            col = next((c for c in obs_cols if c["name"] == cv["obs_column"]), None)
            if col is None:
                flags.append(f"uns/{ck} has no matching obs column")
            elif col.get("n_categories") != cv["n"]:
                flags.append(f"uns/{ck} length {cv['n']} != {col.get('n_categories')} categories → palette fallback")

        # Spatial detection + sections.
        spatial = detect_spatial(f, obsm, obs_cols)
        coords = load_coords(f, spatial, obs_cols)
        if coords is None:
            flags.append("no spatial coordinates detected (viewer will render z=0 and ask for a z source)")
        else:
            finite = np.isfinite(coords).all(axis=1)
            spatial["n_nonfinite_rows"] = int((~finite).sum())
            if spatial["n_nonfinite_rows"]:
                flags.append(f"{spatial['n_nonfinite_rows']} coordinate rows are NaN/inf → dropped by the viewer")
            fc = coords[finite]
            axes = ["x", "y", "z"][: fc.shape[1]]
            spatial["extent"] = {a: {"min": float(fc[:, i].min()), "max": float(fc[:, i].max()),
                                     "range": float(fc[:, i].max() - fc[:, i].min()), "mean": float(fc[:, i].mean()),
                                     "n_unique": int(np.unique(fc[:, i]).size) if fc.shape[0] <= 5_000_000 else None}
                                 for i, a in enumerate(axes)}
            spatial["checksum"] = {a: float(fc[:, i].sum()) for i, a in enumerate(axes)}
            if fc.shape[1] == 3:
                zu = spatial["extent"]["z"]["n_unique"]
                spatial["z_is_discrete"] = bool(zu is not None and zu <= 512)
                if spatial["z_is_discrete"]:
                    zvals = np.unique(fc[:, 2])
                    spatial["z_levels"] = [float(v) for v in zvals]
                    d = np.diff(zvals)
                    spatial["z_spacing_uniform"] = bool(zvals.size < 3 or np.allclose(d, d[0]))
                    flags.append(f"{spatial['key']} is 3-D with a discrete z ({zu} levels, "
                                 f"{'uniform' if spatial['z_spacing_uniform'] else 'NON-uniform'} spacing) → native-3D path with section stacking from data z")
            xy_r = [spatial["extent"][a]["range"] for a in axes[:2]]
            if fc.shape[1] == 3 and spatial["extent"]["z"]["range"] > 0 and max(xy_r) > 0:
                ratio = spatial["extent"]["z"]["range"] / max(xy_r)
                if ratio > 3 or ratio < 0.05:
                    flags.append(f"z extent / XY extent = {ratio:.3f}: z probably in a different unit → z-scale slider matters")
            if max(abs(spatial["extent"][a]["min"]) for a in axes) > 1e4 or max(abs(spatial["extent"][a]["max"]) for a in axes) > 1e4:
                flags.append("coordinates exceed 1e4 → center in float64 before float32 cast (spec §5.2)")
        meta["spatial"] = spatial

        library = detect_library(obs_cols, uns["spatial"], coords)
        if library.get("warning"):
            flags.append(library["warning"])
        sections = build_sections(obs_cols, library, coords, uns["spatial"])
        meta["library"] = library
        meta["sections"] = sections
        if sections["n_sections"] > 1 and coords is not None:
            bboxes = [s["bbox"] for s in sections["sections"] if "bbox" in s]
            if len(bboxes) > 1:
                cx = [(b["min"][0] + b["max"][0]) / 2 for b in bboxes]
                cy = [(b["min"][1] + b["max"][1]) / 2 for b in bboxes]
                drift = max(max(cx) - min(cx), max(cy) - min(cy))
                xy_extent = max(spatial["extent"]["x"]["range"], spatial["extent"]["y"]["range"])
                sections["xy_center_drift"] = float(drift)
                sections["xy_center_drift_fraction"] = float(drift / xy_extent) if xy_extent else None
                if xy_extent and drift / xy_extent > 0.1:
                    flags.append(f"section XY bounding-box centres drift by {drift:.1f} ({100 * drift / xy_extent:.0f}% of XY extent) → sections are not registered; 'Stack normalized' recentres them")
            if not sections["stored_order_is_natural"]:
                flags.append("stored category order differs from natural sort → viewer reorders sections")
        if sections["n_sections"] == 0 and coords is not None and coords.shape[1] == 2:
            flags.append("2-D coordinates without a section column → single flat section")

        # Suggested manifest defaults.
        cat_cols = [c for c in obs_cols if c.get("kind", "").startswith("categorical")]
        lib_name = library["key"].split("/", 1)[1] if library["key"] else None

        def cluster_rank(c: dict[str, Any]) -> tuple[int, int]:
            n = c["name"].lower()
            for i, p in enumerate(CLUSTER_PRIORITY):
                if n == p or n.startswith(p) or (p == "cluster" and "cluster" in n):
                    return (i, 0)
            return (len(CLUSTER_PRIORITY), 0 if 2 <= c.get("n_categories", 0) <= 60 else 1)

        color_candidates = sorted([c for c in cat_cols if c["name"] != lib_name], key=cluster_rank)
        default_color = color_candidates[0]["name"] if color_candidates else None
        if default_color and cluster_rank(color_candidates[0])[0] == len(CLUSTER_PRIORITY):
            flags.append(f"no leiden/louvain/cluster*/cell_type column; default color-by falls back to {default_color!r} (first categorical column)")
        in_tissue = next((c for c in obs_cols if c["name"] == "in_tissue"), None)
        if in_tissue is None:
            flags.append("no obs/in_tissue column (Visium filter not applicable)")
        if not any(c.get("kind") == "numeric" for c in obs_cols):
            flags.append("no numeric obs columns (continuous obs coloring has nothing to offer)")
        examples: list[dict[str, Any]] = []
        if xinfo and xinfo.get("format") in ("csr", "csc", "dense") and var_names:
            examples, gflags = gene_examples(f, xinfo, var_names, wanted_genes, n_gene_examples, nnz_cap)
            flags.extend(gflags)
        meta["suggested"] = {
            "name": os.path.splitext(os.path.basename(path))[0],
            "spatial_key": spatial["key"],
            "library_key": library["key"],
            "default_color_by": {"type": "obs", "key": default_color} if default_color else None,
            "default_tooltip_fields": [x for x in [lib_name, default_color] if x],
            "gene_examples": examples,
        }
        meta["flags"] = flags
    return strip_private(meta)


def print_summary(meta: dict[str, Any]) -> None:
    p = print
    p(f"\n=== {meta['file']}  ({meta['size_bytes'] / 1e6:.1f} MB) ===")
    p(f"root attrs: {meta['root_attrs']}")
    p(f"n_obs={meta['n_obs']}  n_vars={meta['n_vars']}  top-level keys={meta['top_level_keys']}")
    p(f"filters used: {meta['filters_used']}")
    x = meta["X"]
    if x:
        p(f"\nX: {x['format']} dtype={x['dtype']} shape={x.get('shape')} nnz={x.get('nnz', x.get('n_elements')):,} "
          f"compression={x.get('compression')} sample={x.get('value_sample')}")
    else:
        p("\nX: MISSING")
    p(f"layers: {list(meta['layers'].keys())}   raw: {'present' if meta['raw'] else 'absent'}")
    if meta["obs"]:
        p(f"\nobs: index={meta['obs']['index_name']!r} ({meta['obs']['index_dtype']}), head={meta['obs']['index_head'][:2]}")
        for c in meta["obs"]["columns"]:
            extra = ""
            if c.get("kind", "").startswith("categorical"):
                extra = f"{c['n_categories']} categories, codes {c['codes_dtype']}, missing={c['n_missing']}, head={c['categories_head'][:6]}"
            elif c.get("kind") == "numeric":
                extra = f"{c['dtype']} range=[{c.get('min')}, {c.get('max')}] unique={c.get('n_unique')}"
            elif c.get("kind") == "unsupported":
                extra = f"UNSUPPORTED: {c.get('reason')}"
            else:
                extra = c.get("dtype", "")
            p(f"  - {c['name']:<24} {c.get('kind', '?'):<20} {extra}")
    if meta["var"]:
        v = meta["var"]
        p(f"\nvar: n={v['n']} index={v['index_name']!r} columns={v['column_order']} gene-name columns={v['gene_name_columns']} "
          f"duplicates={v['n_duplicate_names']} head={v['names_head'][:6]}")
    p("\nobsm:")
    for k, v in meta["obsm"].items():
        p(f"  - {k}: {v}")
    p(f"obsp: {[(k, v['format'], v.get('nnz')) for k, v in meta['obsp'].items()] if meta['obsp'] else '{}'}")
    p(f"varm: {meta['varm']}  varp: {meta['varp']}")
    u = meta["uns"]
    p(f"\nuns keys: {u['keys']}")
    if u["spatial"]:
        p(f"uns/spatial: {u['spatial']['n_libraries']} libraries, stored order: {u['spatial']['library_ids'][:20]}")
        for lid, lib in list(u["spatial"]["libraries"].items())[:20]:
            p(f"  - {lid}: images={ {k: (i['shape'], i['dtype']) for k, i in lib['images'].items()} } scalefactors={lib['scalefactors']}")
    p(f"uns colors: {u['colors']}")
    p(f"uns moranI: {u['moranI']}   spatial_neighbors: {u['spatial_neighbors']}   squidpy results: {u['squidpy_results']}")
    s = meta["spatial"]
    p(f"\nspatial: key={s['key']} ndim={s['ndim']} method={s['method']} z_source={s.get('z_source')}")
    for a, e in (s.get("extent") or {}).items():
        p(f"  {a}: [{e['min']:.4f}, {e['max']:.4f}] range={e['range']:.4f} mean={e['mean']:.4f} unique={e['n_unique']}")
    if s.get("z_levels"):
        p(f"  z levels ({len(s['z_levels'])}): {s['z_levels']}  uniform={s.get('z_spacing_uniform')}")
    lib = meta["library"]
    sec = meta["sections"]
    p(f"\nlibrary column: {lib['key']} (method={lib['method']}, matches uns/spatial={lib['matches_uns_spatial']})")
    p(f"sections: {sec['n_sections']} (order: {sec.get('order_source')}; drift={sec.get('xy_center_drift')})")
    for sct in sec["sections"][:64]:
        bb = sct.get("bbox")
        bbs = f"x=[{bb['min'][0]:.1f},{bb['max'][0]:.1f}] y=[{bb['min'][1]:.1f},{bb['max'][1]:.1f}]" if bb else ""
        p(f"  {sct['ordinal']:>3} {sct['name']:<16} n={sct['n_cells']:>7} z={sct.get('z')} img={sct['has_image']} "
          f"spot_d={sct['spot_diameter_fullres']} {bbs}")
    sg = meta["suggested"]
    p(f"\nsuggested: color_by={sg['default_color_by']} tooltip={sg['default_tooltip_fields']}")
    for g in sg["gene_examples"]:
        p(f"  gene {g['name']!r} (col {g['index']}): nnz={g['nnz']} sum={g['sum']:.4f} max={g['max']:.4f} first={g['first_nonzero'][:2]}")
    p("\nFLAGS (things the spec did not anticipate or that need care):")
    for fl in meta["flags"]:
        p(f"  ! {fl}")
    p("")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file")
    ap.add_argument("--out", help="output JSON path (default: <file dir>/<stem>.meta.json)")
    ap.add_argument("--genes", default="", help="comma-separated gene names to compute reference statistics for")
    ap.add_argument("--n-gene-examples", type=int, default=5)
    ap.add_argument("--max-items", type=int, default=5000, help="cap on structure entries listed")
    ap.add_argument("--nnz-cap", type=int, default=200_000_000, help="skip gene statistics above this nnz")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)
    if not os.path.isfile(args.file):
        print(f"error: {args.file} not found", file=sys.stderr)
        return 2
    wanted = [g.strip() for g in args.genes.split(",") if g.strip()]
    meta = inspect(args.file, wanted, args.n_gene_examples, args.max_items, args.nnz_cap)
    out = args.out or os.path.join(os.path.dirname(args.file) or ".", os.path.splitext(os.path.basename(args.file))[0] + ".meta.json")
    with open(out, "w") as fh:
        json.dump(meta, fh, indent=2)
    if not args.quiet:
        print_summary(meta)
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
