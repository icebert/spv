#!/usr/bin/env python3
"""Generate ``data/datasets.json`` from one or more ``*.meta.json`` files written by inspect_h5ad.py.

Every manifest value is derived from the inspection output (nothing is hard-coded), so the
manifest can never disagree with the file. Re-run after replacing a dataset.

Usage: python scripts/make_manifest.py data/demo.meta.json [more.meta.json ...] [--out data/datasets.json]
"""

from __future__ import annotations

import argparse
import json
import os


def entry_from_meta(meta_path: str) -> dict:
    meta = json.load(open(meta_path))
    stem = os.path.splitext(os.path.splitext(os.path.basename(meta_path))[0])[0]  # demo.meta.json -> demo
    sug = meta["suggested"]
    n_sections = meta["sections"]["n_sections"]
    x = meta.get("X")
    parts = [f"{meta['n_obs']:,} cells × {meta['n_vars']:,} genes"]
    if n_sections > 1:
        parts.append(f"{n_sections} sections from {meta['library']['key']}")
    sp = meta["spatial"]
    if sp.get("key"):
        parts.append(f"{sp['ndim']}-D coordinates in {sp['key']}")
    if x:
        fmt = x["format"].upper() if x["format"] in ("csr", "csc") else x["format"]
        parts.append(f"{fmt} X ({x['dtype']})")
    has_images = any(s.get("has_image") for s in meta["sections"]["sections"])
    parts.append("tissue images" if has_images else "no tissue images")
    entry = {
        "id": stem,
        "name": stem,
        "description": "; ".join(parts),
        "url": f"data/{os.path.basename(meta['file'])}",
        "size_bytes": meta["size_bytes"],
    }
    if sp.get("key"):
        entry["spatial_key"] = sp["key"]
    if meta["library"].get("key"):
        entry["library_key"] = meta["library"]["key"]
    if sug.get("default_color_by"):
        entry["default_color_by"] = sug["default_color_by"]
    if sug.get("default_tooltip_fields"):
        entry["default_tooltip_fields"] = sug["default_tooltip_fields"]
    if sug.get("gene_examples"):
        entry["example_genes"] = [g["name"] for g in sug["gene_examples"][:3]]
    return entry


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("meta", nargs="+")
    ap.add_argument("--out", default=os.path.join("data", "datasets.json"))
    args = ap.parse_args()
    manifest = {"datasets": [entry_from_meta(m) for m in args.meta]}
    with open(args.out, "w") as fh:
        json.dump(manifest, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    print(json.dumps(manifest, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
