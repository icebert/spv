# SPV — Spatial Viewer

SPV is a lightweight, static, browser-based 3D viewer for spatial transcriptomics data stored as
AnnData `.h5ad` files. It opens one file at a time straight from a URL or from your disk, parses the
HDF5 layout in a Web Worker with `h5wasm`, and renders every cell or spot as a GPU point sprite with
Three.js. Multi-section datasets (Visium slides, Xenium or CosMx slides, serial MERFISH slices)
become an explorable 3D stack: sections spread along z, optionally drawn on their tissue image,
steppable one at a time, or tiled side by side. There is no backend, no upload, and no build-time
data conversion: the site is plain files served by GitHub Pages.

![SPV showing the demo dataset: 16 slices coloured by gene expression, with the Sections panel and a pinned tooltip](docs/screenshot.png)

![Tile layout: the 16 sections of the demo side by side](docs/screenshot-tile.png)

**Live demo:** `https://<user>.github.io/<repo>/` (replace after deploying; see [Deploy in 5 minutes](#deploy-in-5-minutes)).

## Features

- Opens `.h5ad` files from a curated manifest, any CORS-enabled URL, or a local file (file picker or drag and drop). Remote files on hosts that support HTTP range requests are read on demand, so only the bytes HDF5 touches are downloaded.
- Squidpy conventions first: `obsm["spatial"]` / `obsm["spatial3d"]`, a `library_key` column matched against `uns["spatial"]`, tissue images with `scalefactors`, `uns/*_colors`, `obsp/*_connectivities`, `uns/moranI`. Generic AnnData files still work, and every coordinate source can be overridden.
- Four section layouts applied in the vertex shader from a per-section transform table, so switching is instant and never re-uploads positions: **Stack** (native z or uniform spacing), **Stack normalized** (each section recentred), **Tile** (grid, top-down orthographic), **Single** (one section at a time). Spacing, tile gap, z-scale and z-explode sliders; a section stepper with play/pause; show/hide/solo per section.
- Tissue image overlay per section, placed from `tissue_hires_scalef` / `tissue_lowres_scalef` exactly like `squidpy.pl.spatial_scatter`, with opacity, resolution choice, grayscale, a 256 MB texture budget and progressive loading after the first frame.
- Colour by categorical `obs` (file palette or colour-blind-safe defaults; legend with counts, click to toggle, shift-click to solo, search and virtualisation for large legends), by numeric `obs`, or by gene expression from `X`, any layer or `raw.X`, with `log1p`, eight colormaps, percentile or explicit ranges and a colorbar. Colour changes are texture and uniform updates only.
- Filters: Visium `in_tissue`, native-frame X/Y clip planes, z range, deterministic random subsampling, category visibility.
- Hover tooltip and click-to-pin with GPU picking (no raycasting), showing the cell index, section, the value driving the colour and up to six chosen `obs` fields.
- Perspective or orthographic camera, presets, turntable, PNG export at 1× or 2× with optional transparent background, and a compact versioned share link that restores the whole view.
- Actionable errors for every failure path: WebGL missing, not HDF5, not AnnData, CORS blocked, missing compression plugin, shape mismatch, image decode failure.
- Manual section alignment (per-section XY and z offset, rotation, flips in file units, stored in the share link and optionally in the manifest, with a one-click snap of a mis-placed section's z onto its neighbours' spacing), a spatial graph overlay from `obsp/*_connectivities` that respects every point filter, the top spatially variable genes from `uns/moranI`, a Single-mode crossfade, two-gene blend colouring, lasso and box selection with CSV/TSV export (including the section column), and a histogram with draggable range handles.

## Supported `.h5ad` features and known limitations

Supported:

- anndata ≥ 0.8 encodings (`encoding-type` attributes) and legacy anndata < 0.8 files (`__categories`, `h5sparse_format`), including files written by current anndata 0.13 (`nullable-string-array` indexes).
- `X`, `layers/*`, `raw/X` as dense, CSR or CSC, any numeric dtype (float64 is downcast to float32 for the GPU).
- `obs`/`var` columns: numeric, string, boolean, categorical (with `-1` missing codes → "NA"), nullable integer/boolean, legacy categoricals. Unsupported columns are listed, never fatal.
- Coordinates: `obsm/spatial3d`, `spatial_3d`, `X_spatial_3d`, `spatial`, `X_spatial`, any `obsm` key containing "spatial"/"xyz", plus `z`/`Z`/`z_coord`/`z_um`/`depth`/`Bregma` from `obs`. NaN/inf rows are dropped and reported.
- Sections from a `library_key` column matched to `uns/spatial`, from the usual column names (`library_id`, `sample`, `section`, `slice`, `slide`, `fov`, …), or inferred from a discrete z.
- Images as `uint8`, `uint16` or float in [0, 1], RGB or RGBA or grayscale, `hires` and `lowres`.
- Compression: gzip and shuffle built in; lzf, zstd, blosc, blosc2, lz4, bz2, bshuf, zfp, jpeg, bitgroom and bitround through lazily loaded `h5wasm-plugins`.

Limitations:

- Alignment is manual (numeric inputs and nudge buttons); there is no automatic registration.
- Selection works on the visible points only (hidden sections, categories and clipped points are never selected) and is not stored in the share link.
- CSR `X` needs one full pass over the index array before the first gene can be coloured. Below 25 M non-zeros SPV builds an in-memory column index (8 bytes per non-zero) so later genes are instant; above that each gene is scanned in chunks. Convert to CSC with `prepare_h5ad.py --csc` for large matrices.
- The whole file is downloaded when the host does not support byte ranges or serves it gzip-encoded.
- A single WebGL context: GPU memory for images is capped at 256 MB and images are downscaled to 2048 px (1024 px above 8 sections).
- `obs` columns with more than 65,535 categories cannot be used for colouring (they still work in tooltips).

## The demo dataset

`data/demo.h5ad` (24 MB) is a 16-slice mouse brain dataset with 103,085 cells and 434 genes. It is a
native 3-D file: `obsm/spatial` has three columns and each `obs/slice` category sits on one z level
(320–618, non-uniform spacing), `X` is CSR float64 with log-normalised values, and `uns` is empty
(no tissue images, no stored colours). SPV therefore stacks the slices at their real z, offers
"Uniform spacing" to space them evenly instead, generates palettes for the five categorical columns,
and builds the CSR column index on the first gene. Three slices are stored at a z that breaks the
otherwise regular 20-unit spacing (slice3 at 355, slice5 at 398, slice8 at 461); the manifest's
`section_alignment` shifts them to 360, 400 and 458 by default, without touching the file. The offsets
are visible and editable in Sections › Align current section ("Snap z to neighbours" recomputes them).
Everything about the file that needed a special case is listed in [`PLAN.md`](PLAN.md).

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
      "section_alignment": { "slice3": { "dz": 5 }, "slice5": { "dz": 2 }, "slice8": { "dz": -3 } }
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

## Deploy in 5 minutes

1. Fork or clone this repository and push it to GitHub.
2. In the repository settings open **Pages** and set **Source** to **GitHub Actions**.
3. Push to `main`. The workflow in `.github/workflows/deploy.yml` runs typecheck, lint, unit tests, builds with `VITE_BASE=/<repo>/`, runs the Playwright end-to-end suite against the built site at that sub-path, and deploys.
4. Open `https://<user>.github.io/<repo>/`. `#dataset=<id>` deep-links a manifest entry, `#url=<encoded-url>` any CORS-enabled file.

For a root site (repository named `<user>.github.io`) change `VITE_BASE` in the workflow to `/`. Locally, `npm run dev` serves at `/`, and `VITE_BASE=/spv/ npm run build && VITE_BASE=/spv/ npm run preview` reproduces the sub-path deployment.

## Development

```sh
npm ci
npm run dev          # Vite dev server with data/ served at /data/ (Range-capable)
npm run typecheck    # three tsconfigs: app (DOM), worker (WebWorker), node (tests/config)
npm run lint         # eslint + prettier --check
npm test             # vitest: reader against every fixture, colormaps, palettes, layouts, URL state
npm run e2e          # playwright: production build at /spv/, demo + fixtures + error paths
npm run build && npm run preview
python scripts/make_fixtures.py        # regenerate tests/fixtures (committed)
python scripts/make_synthetic_demo.py  # optional native-3D and Visium-like synthetic files (gitignored)
```

## Keyboard shortcuts

| Key | Action |
|---|---|
| `R` | Reset view |
| `H` | Toggle sidebar |
| `F` | Toggle fullscreen |
| `S` | Screenshot |
| `1` / `2` / `3` / `4` | Top / front / side / isometric view |
| `←` / `→` | Previous / next section |
| `Space` | Play / pause section stepping |
| `I` | Toggle tissue images |
| `L` | Cycle layout mode |
| `O` | Toggle orthographic camera |
| `X` | Lasso / box selection mode (Shift-drag for a box) |
| `Esc` | Clear the pinned cell / the selection / leave selection mode |
| `?` | Help |

## Privacy

Everything runs in your browser. Local files are mounted into the worker's virtual filesystem
through the File API (`WORKERFS`), read in place and never uploaded anywhere. Remote files are
fetched by your browser directly from the host you name. Share links for local files contain the
view state only; the recipient has to open the same file.

## Measured performance

Measured on the production build served locally, Chromium 1243 (Playwright) with ANGLE Metal on an
AMD Radeon Pro 5500 XT (a desktop discrete GPU, so frame times are better than on the spec's
integrated-graphics laptop; the numbers are frame times including GPU completion, not vsync-capped
frame rates). The synthetic files come from `scripts/make_synthetic_demo.py`.

| Measurement | Result |
|---|---|
| `data/demo.h5ad` (103,085 cells, 16 sections, 24 MB): navigation → points visible | 0.58 s, of which HDF5 engine start 30 ms, open + summary 80 ms, coordinates + section model 55 ms |
| Bytes fetched before the first frame (lazy range requests) | 7.3 MB of 25.2 MB; 21 MB after the first gene (CSR index needs all of `X`) |
| Same file with a full download instead of range requests (local server) | open 87 ms + coordinates 27 ms after the 25 MB download |
| Frame time while orbiting, 3 px points | 103k: 2.9 ms · 500k: 5.2 ms · 2M: 11.1 ms (≈ 340 / 190 / 90 fps capacity) |
| Frame time, 2M points at 6 px | 19 ms (≈ 53 fps) |
| Layout switch (stack ↔ tile ↔ single), spacing, explode, step, hide section | 2–4 ms of main-thread work at 103k–500k points, 9 ms at 2M; no position re-upload |
| Colormap, range, category toggle, point size, opacity | < 1–3 ms (texture/uniform updates) |
| Gene switch, CSR demo | first gene 0.95 s (builds the 71 MB in-memory column index in the worker), then 12–22 ms |
| Gene switch, CSC (synthetic 500k × 50 / 2M × 8) | 60–85 ms / 220–350 ms |
| GPU pick latency (hover) | 5–13 ms |
| Tissue images: 4 sections × 2048 × 2048 hires (synthetic Visium-like) | all decoded + uploaded 1.3 s after the first frame (67 MB of textures); stepping sections in Single mode 2 ms per step |
| Switching datasets 3× (demo ↔ 4-image file) | GPU geometries 2 → 2, textures 3 → 2, image bytes 0; WASM heap grows once (19 → 40 MB) and then stays flat |

Initial JS payload: 174 kB gzipped (Three.js included). The worker chunk with the HDF5 engine
(4.8 MB, WASM embedded in the JS) loads when the first dataset is opened.

## Design notes

- **Worker-only I/O.** `h5wasm` lives in one Web Worker with a small typed RPC (`open`, `getSummary`, `getSpatial`, `getObsColumn`, `getVarNames`, `getGeneVector`, `getImage`, `getGraphEdges`, …). Typed arrays are transferred, never copied. Requests run in order; long scans yield between chunks so progress and cancellation work. The HDF5 "throwing error handler" is always on because failed reads otherwise return garbage silently.
- **Partial reads.** Open reads only structure, shapes, attributes, coordinates, var names and the obs column list. Columns, genes, images and graphs are read on demand. `uns` is never read wholesale.
- **Remote files.** A HEAD plus a ranged GET of the first 8 bytes verifies the HDF5 signature and byte-range support before Emscripten's lazy file is created (its own failure path would abort the WASM runtime). Local files are mounted with `WORKERFS`, so nothing is copied into WASM memory.
- **Texture-driven rendering.** One `THREE.Points`. Per-point attributes are uploaded once per dataset (positions, section ordinal, validity) and once per colour variable (scalar or code). Everything interactive is a small texture or uniform: a 256-texel colormap, a palette whose alpha channel is the category mask, and a per-section transform table (offset, alpha, rotation/flip, pivot) that implements all four layouts, section visibility, dimming and manual alignment. Native z is kept through a `uNativeZ` uniform, so native-3D stacks and uniform stacks share one shader path.
- **Display frame.** Flips and the Y/Z swap are applied in the shader before the section transform; the same `toDisplay` function produces the section geometry, image-plane placement and clip bounds on the CPU, so images always follow their spots.
- **Picking.** Point ids are rendered as colours into a 1×1 target through `camera.setViewOffset` and read back asynchronously; no raycasting.
- **Selection.** Lasso/box selection re-runs the vertex-shader transform on the CPU (display frame, section table, alignment, explode, camera) for the visible points and tests them against the screen-space polygon, so it agrees with what is drawn; exports fetch cell ids from the worker in one pass.
- **State.** One typed slice store drives both the GPU side and the panels; the URL hash is a compact, versioned serialisation of everything except transient UI, written with `replaceState` after a debounce.
- **Deviations from the original spec** (ESLint flat config, TypeScript 5.9 instead of 7, embedded WASM, fixture sizes) and everything the demo file changed about the design are recorded in `PLAN.md`.

## License

MIT, see [`LICENSE`](LICENSE).
