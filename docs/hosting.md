# Hosting SPV and its datasets

Details for people who deploy the viewer or publish datasets for it. The short version is in the [README](../README.md).

## Adding a hosted dataset

Datasets are listed in `data/datasets.json`. Generate the entry from the file itself so no field is
guessed:

```sh
python scripts/inspect_h5ad.py data/mydata.h5ad          # writes data/mydata.meta.json
python scripts/make_manifest.py data/*.meta.json          # rewrites data/datasets.json
```

Manifest schema (only `id`, `name`, `url` are required; the rest are hints the reader does not depend on). `section_alignment` holds per-section manual corrections in file units and degrees (`dx`, `dy`, `dz`, `rot`, `fx`, `fy`, keyed by section name) that the viewer applies by default; `make_manifest.py` preserves it when regenerating the manifest:

```json
{
  "datasets": [
    {
      "id": "demo",
      "name": "demo",
      "description": "103,085 cells × 434 genes; 16 sections from obs/slice; …",
      "url": "data/demo.h5ad",
      "size_bytes": 25193286,
      "spatial_key": "obsm/spatial",
      "library_key": "obs/slice",
      "default_color_by": { "type": "obs", "key": "seurat_clusters" },
      "default_tooltip_fields": ["slice", "seurat_clusters"],
      "example_genes": ["Itpr1", "Cacnb4", "Gria2"],
      "section_alignment": { "slice3": { "dz": 0 } }
    }
  ]
}
```

Size limits: GitHub rejects files over 100 MB, and Git LFS objects are not served by Pages. Keep
hosted files under 100 MB (see below) or host large files elsewhere and use an absolute `url`. The
host must allow cross-origin requests; byte-range support makes loading lazy. What was verified:

| Host | CORS | Range requests | Notes |
|---|---|---|---|
| GitHub Pages (same origin) | n/a | yes (`Accept-Ranges: bytes`) | files ≤ 100 MB in the repo |
| Cloud buckets (S3, GCS, R2, …) | configure on the bucket | yes | verified `Accept-Ranges: bytes` on a public GCS object; add a CORS rule allowing `GET, HEAD` from your Pages origin |
| Zenodo | yes (`Access-Control-Allow-Origin: *`) | not observed | works, but the whole file is downloaded |
| GitHub Release assets | check | check | run the check below before relying on it |

Check any URL with:

```sh
curl -sI -H "Origin: https://<user>.github.io" -r 0-7 "https://host/path/file.h5ad" | grep -i -E "HTTP/|access-control-allow-origin|accept-ranges|content-range"
```

You want `HTTP 206`, an `Access-Control-Allow-Origin` header and `Accept-Ranges: bytes`.

How the lazy loader requests bytes, and why it matters for Safari: the file is read in 1 MiB
chunks, and every chunk is requested under its own URL (`file.h5ad?spv_range=<from>-<to>`; static
hosts ignore the query string). Safari's HTTP cache is keyed by URL and ignores the `Range` header,
so without this a cached partial response for one range can be handed back for another range of the
same URL, and HDF5 would silently read another part of the file (cells drawn with other cells'
coordinates, sections at the wrong z). Every response is also verified against its `Content-Range`
and length; a wrong or truncated response is retried once with a cache-busting parameter and then
reported as an error instead of being used, and a server that ignores `Range` and returns the whole
file with `200` is handled by slicing locally. Two consequences for hosting:

- URLs that already carry a query string (signed S3/GCS/Azure URLs) are never altered, so the
  per-chunk key is not added. Serve such files with `Cache-Control: no-store` if Safari users matter.
- Cross-origin hosts should expose the range header (`Access-Control-Expose-Headers: Content-Range`);
  otherwise only the response length can be checked.

## Preparing a large dataset

`scripts/prepare_h5ad.py` shrinks and converts files without touching the original:

```sh
# recommended recipe for a Pages-hosted file (< 100 MB, fast gene switching)
python scripts/prepare_h5ad.py in.h5ad out.h5ad --csc --float32 --compression gzip --level 4 \
    --drop raw,varm,varp --n-top-genes 2000 --downscale-images 2000

# make 2-D multi-section stacking explicit
python scripts/prepare_h5ad.py in.h5ad out.h5ad --library-key library_id --z-spacing 500
```

Options: `--max-cells N [--stratify col]`, `--genes FILE|list`, `--n-top-genes N [--rank variance|moranI]`,
`--layer NAME`, `--drop raw,layers,obsp,varm,varp,uns` (`uns` keeps `spatial`, `*_colors`,
`spatial_neighbors`, `moranI`), `--downscale-images PX` (rescales `tissue_hires_scalef` consistently),
`--drop-images`, `--drop-graph`, `--csc`, `--float32`, `--spatial-key KEY`, `--library-key COL --z-spacing F`,
`--compression gzip|lzf|none --level L`. It prints before/after size, nnz, image bytes and a rough
browser memory estimate. For the demo file the recommended command is
`prepare_h5ad.py data/demo.h5ad demo_csc.h5ad --csc --float32` (CSC makes each gene an `indptr` slice);
the file in this repository is left exactly as provided.

Python environment: `uv venv .venv --python 3.12 && uv pip install --python .venv/bin/python --only-binary :all: -r scripts/requirements.txt`.

## GitHub Pages details

For a root site (repository named `<user>.github.io`) change `VITE_BASE` in the workflow to `/`. Locally, `npm run dev` serves at `/`, and `VITE_BASE=/spv/ npm run build && VITE_BASE=/spv/ npm run preview` reproduces the sub-path deployment.

Pull requests and pushes to other branches run the same gates in `.github/workflows/ci.yml` without deploying: `npm audit` on the runtime dependencies, typecheck, lint, unit tests, a production build, the bundle budget (`scripts/bundle_budget.mjs`, per-file size limits for `dist/assets/`) and the end-to-end suite; Playwright traces are kept as an artifact when a test fails. Dependabot opens weekly update pull requests for npm packages and the actions. Node is pinned by `.nvmrc`.

## Self-hosting, browser support and versions

- **Browser support.** Current Chrome, Edge, Firefox and Safari with WebGL 2. Without WebGL 2, or with JavaScript off, the page says so and what to do; if the app fails while starting, the same page shows the error and the build stamp.
- **Content Security Policy.** `index.html` carries a `<meta http-equiv="Content-Security-Policy">` (GitHub Pages cannot send headers): scripts, workers, styles and fonts only from the site itself, no plugins or embedded objects, no inline scripts. `connect-src` stays open because `#url=` may point at any CORS-enabled host. The dev server loosens one directive (`style-src-elem`) because Vite injects CSS as inline `<style>` elements; builds and `vite preview` use the strict policy, and the end-to-end suite fails on any violation. Nothing is loaded from third parties: the typeface, the WASM engine and the compression plugins ship with the site, and the page sends no `Referer` header.
- **Self-hosting.** Any static file server works. Serve `assets/` with `Cache-Control: public, max-age=31536000, immutable` (file names carry content hashes) and `index.html` plus `data/` with a short max-age. `.h5ad` files need `Accept-Ranges: bytes`; add CORS (`GET, HEAD`, exposing `Content-Range`, `Content-Length` and `Accept-Ranges`) when they live on another origin. Sending the same policy as a `Content-Security-Policy` header, plus `X-Content-Type-Options: nosniff`, is a good idea where headers are available.
- **Versions and support.** `package.json` holds the version; the Help dialog and `window.__spv.version` show it, and every build carries a stamp (short commit hash, `+` when built from uncommitted changes, and the commit date). Uncaught errors and unhandled promise rejections show one toast per distinct message every ten seconds and are kept in a short log; the `D` report starts with version, build and browser and ends with the last errors, so a pasted report is enough to reproduce a problem. If the data worker crashes (WASM abort, out of memory), the next file open starts a fresh worker. `CHANGELOG.md` records what changed between versions.
