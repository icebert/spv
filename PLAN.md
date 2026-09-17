# SPV — Spatial Viewer: implementation plan

Written before any viewer code, per SPEC.md §17. Everything below about `data/demo.h5ad` comes
from `scripts/inspect_h5ad.py` (output in `data/demo.meta.json`), not from assumptions.

## 1. Inspection summary of `data/demo.h5ad`

| Item | Value |
|---|---|
| Size | 25,193,286 bytes (24 MB) — under GitHub's 100 MB limit, can be committed and served by Pages |
| Root attrs | `encoding-type=anndata`, `encoding-version=0.1.0` (anndata ≥ 0.8 writer; dataframes are `0.2.0`) |
| `n_obs` × `n_vars` | 103,085 × 434 |
| `X` | **CSR** group (`encoding-type=csr_matrix`), `data` **float64**, `indices`/`indptr` int32, nnz 8,814,835, gzip level 4, chunks data=(8609,) indices=(17217,) indptr=(3222,) |
| `X` values | 0.693–4.47 in a 200k sample, non-integer → already log-normalised (log1p of counts) |
| `obs` | index `_index` (vlen UTF-8, 46-char ids like `r1_s1_1076…`); 5 columns, **all categorical** with int8 codes, no missing codes: `seurat_clusters` (25), `subtype` (45), `slice` (16), `structure` (28), `substructure` (74) |
| `var` | index only (434 gene symbols: `Oprk1`, `Npbwr1`, …); no alternative gene-name column; no duplicates |
| `obsm` | **`spatial` only, shape (103085, 3), float64**, chunks (3222, 1) → column reads are cheap |
| `obsp`, `layers`, `varm`, `varp` | present but **empty** groups |
| `uns` | present but **empty**: no `uns/spatial`, no images, no scale factors, no `*_colors`, no `moranI`, no `spatial_neighbors` |
| `raw` | absent |
| Coordinates | x ∈ [672.5, 1060.8] (range 388), y ∈ [302.1, 620.4] (range 318), **z ∈ [320, 618] with exactly 16 distinct values** (320, 340, 355, 380, 398, 418, 438, 461, 478, 498, 518, 538, 558, 578, 598, 618 — non-uniform spacing). No NaN/inf. |
| Section column | `obs/slice` (found via the candidate-name list; `uns/spatial` does not exist). Categories `slice1…slice16` in stored order = natural order. Each slice sits on exactly one z level, monotonically increasing with slice number. 3,778–8,630 cells per slice. |
| Section XY frames | Bounding-box centres drift by ~176 units (45 % of the XY extent) from slice1 to slice16 — the drift is smooth and monotonic, i.e. these are registered 3-D coordinates (likely an atlas frame) and the drift is anatomy, not misregistration |
| Filters | gzip only → h5wasm built-in, no plugins needed |
| Reference genes (for E2E) | `Itpr1` (col 170, nnz 98,508), `Cacnb4` (col 38), `Gria2` (col 85), `Pbx3` (col 36, nnz 12,870), `Kcnj11` (col 197) — exact nnz/sum/max/first-nonzero stored in `demo.meta.json` |

### Where the real file differs from what SPEC.md assumes

1. **It is native 3-D, not "2-D + sections".** `obsm/spatial` has 3 columns, so §5.2 step 1 fires (`spatial` with 3 columns), yet it also has a genuine section column (`slice`) with one discrete z per section. The spec treats these as two separate cases; the demo is both. **Decision:** the section model is built whenever a library column exists, regardless of coordinate dimensionality. The point `position` attribute stores native XYZ (z = 0 for 2-D data). The vertex shader computes `z' = z·u_nativeZ + T[section].z`, where `T` is the per-section transform table: for native-3-D data Stack mode uses `u_nativeZ = 1`, `T.z = 0` (data z, times the z-scale slider); a **"uniform spacing"** toggle in the Sections panel sets `u_nativeZ = 0`, `T.z = ordinal × spacing` (the spec's Stack behaviour). For 2-D-stacked data only the latter exists. Stack normalized / Tile / Single work identically for both cases because they only touch `T`.
2. **No tissue images anywhere.** `uns` is empty. The image-overlay pipeline (§5.6/§6/§7.2-2) is still built and unit-tested against the `visium2` fixture (real Visium-style `uns/spatial` layout with `hires`/`lowres`, uint8 RGB and float RGBA images, scale factors) and verified visually with a synthetic file, but it cannot be exercised on the demo. The Sections panel will show "no image" for every demo section. Acceptance item "images line up with spots" is verified on the fixture/synthetic data and documented.
3. **`X` is CSR float64.** Gene coloring on the demo needs a chunked scan of `X/indices` (8.8 M int32 = 35 MB uncompressed, ~10 MB gzip) per gene, cached. nnz is below the 50 M warning threshold. `scripts/prepare_h5ad.py --csc --float32` is the recommended conversion (documented; the provided file is not modified).
4. **No `uns/*_colors`** → generated qualitative palettes for every column (25/45/28/74 categories: the ≤ 10 / ≤ 20 / distinct-generator tiers all get exercised).
5. **No numeric `obs` columns** and no `in_tissue` → continuous-obs coloring and the Visium filter are exercised by fixtures only.
6. **Cluster column is `seurat_clusters`**, not `leiden`/`louvain`. The spec's `cluster*` rule is read as "contains `cluster`" so it ranks first on merit.
7. **Sections are not "unregistered slides"**: the XY drift is anatomical, so *Stack* (native z) is the right default and *Stack normalized* is offered as an option, not the default.
8. **`obs` index strings are long** (103k × 46 chars ≈ 5 MB decoded). They are never bulk-loaded: the tooltip reads one index entry via a 1-element slice on hover.

## 2. Pinned library versions (verified against npm on 2026-09-16)

| Package | Version | Notes |
|---|---|---|
| `h5wasm` | 0.10.3 | ESM build **embeds the WASM inside `hdf5_util.js` (4.1 MB, no separate `.wasm`)**; exposes `WORKERFS`, `FS.createLazyFile` (sync XHR `Range` reads, 1 MB chunks, needs `Accept-Ranges: bytes`, only in workers), `MAXIMUM_MEMORY` = 2 GiB. `h5wasm/node` used by Vitest. |
| `h5wasm-plugins` | 0.3.0 | `install_plugins()` fetches `.so` files relative to its own `import.meta.url`, which breaks under bundling → SPV imports only the needed plugin as a Vite `?url` asset and writes it to the plugin search path itself. |
| `three` / `@types/three` | 0.186.0 | `three/addons/controls/OrbitControls.js`; `readRenderTargetPixelsAsync` for picking; `renderer.info.memory` for leak checks. |
| `vite` | 8.3.0 | rolldown-based; `base` from `VITE_BASE`. |
| `typescript` | **5.9.3** | 7.0.2 is the native (Go) port and `typescript-eslint` 8.70 only supports `< 6.1`; 6.0 is a transitional release. 5.9.3 is the last widely supported JS release. Revisit when typescript-eslint supports 7. |
| `vitest` | 5.0.1 | Node environment; reader tests use `h5wasm/node`. |
| `@playwright/test` | 1.63.0 | Chromium only. |
| `eslint` 10.10.0, `@eslint/js` 10.0.1, `typescript-eslint` 8.70.0, `eslint-config-prettier` 10.1.8, `globals` 17.12.0, `prettier` 3.9.7 | | ESLint 10 dropped eslintrc → **`eslint.config.js` (flat, `defineConfig`) replaces the spec's `.eslintrc.cjs`**. |
| `@types/node` | 22.20.3 | for `vite.config.ts`, Playwright config and unit tests only (separate `tsconfig.node.json`). |
| Python | numpy 2.3.5, scipy 1.18.1, h5py 3.16.0, anndata 0.13.3.post0, scanpy 1.12.4 | `scripts/requirements.txt`; `squidpy` optional (only `make_synthetic_demo.py`). |

## 3. Deviations from SPEC.md and decisions taken

- **ESLint config file name** (`eslint.config.js`, not `.eslintrc.cjs`) — ESLint 10 requirement.
- **Three tsconfigs**: `tsconfig.json` (app, DOM lib), `tsconfig.worker.json` (worker, WebWorker lib — DOM and WebWorker libs cannot be mixed), `tsconfig.node.json` (configs + tests). `npm run typecheck` runs all three.
- **"Lazy WASM"**: the WASM is embedded in h5wasm's JS, so the lazily loaded unit is the worker chunk (created on first dataset open, with a progress indicator). Initial payload (main bundle + three) stays under the 400 KB gzipped budget; the worker chunk is excluded from that budget as the spec allows.
- **Lazy remote loading**: SPV does an async pre-flight (`HEAD`, check status, `Accept-Ranges: bytes`, `Content-Length`, no `Content-Encoding: gzip`) before calling `FS.createLazyFile`, because a failure inside Emscripten's sync XHR calls `abort()` and kills the WASM runtime. If pre-flight fails → full `fetch` with progress into MEMFS. Bytes actually downloaded in lazy mode are read from the lazy node's chunk table for the README numbers.
- **Fixture mirroring the demo** uses 3 sections (`slice1`, `slice2`, `slice10`) × 35 cells × 20 genes instead of 2 × 50 so the natural-sort ordering path (`slice10` after `slice2`) is covered by the same fixture.
- **Most fixtures are uncompressed**: HDF5 adds ~5 kB chunk-index overhead per gzip'd dataset, which alone blew the 100 kB budget. gzip is covered by `csr`, `demo_like` and the demo itself.
- **Manifest is generated**, not hand-filled: `scripts/make_manifest.py data/demo.meta.json` derives every field from the inspection output.
- **`data/` serving**: a Vite plugin (`serveDataDir` in `vite.config.ts`) serves repo-root `data/` at `<base>/data/` in dev and preview with `Range`/`HEAD` support and copies `data/*.h5ad|json` into `dist/data/` on build. No symlink (portable, and Vite's static middleware lacks `Range`).
- **Layout modes with native z**: see §1 item 1 (`u_nativeZ` uniform + "uniform spacing" toggle).
- **GPU picking** uses `readRenderTargetPixelsAsync` (WebGL2 PBO) when available to avoid a sync GPU stall, falling back to `readRenderTargetPixels`.
- **Deploy workflow** also runs the Playwright E2E on the production build (spec §14 says "run in CI"). Action versions verified 2026-09-16: `actions/checkout@v7`, `actions/setup-node@v7`, `actions/upload-pages-artifact@v5`, `actions/deploy-pages@v5`.

## 4. Architecture (fixed before coding)

- **Worker RPC** (`src/h5ad/rpc.ts`): request/response messages with ids; typed API `open`, `getSummary`, `getObsColumn`, `getSpatial`, `getGeneVector`, `getVarNames`, `getImage`, `getGraphEdges`, `getObsIndex(rows)`, `close`, plus `progress` and `log` events. Typed arrays are transferred.
- **Reader** (`src/h5ad/reader.ts`): pure schema logic on top of a tiny `H5Source` interface (`keys/attrs/shape/dtype/slice/value`) implemented by `h5wasm` (browser and node builds share the API), so the same code runs in the worker and in Vitest.
- **Coordinates**: centred and scaled to a unit cube in float64 on the worker (`getSpatial` returns `Float32Array xyz`, the float64 `center`/`scale`, per-section bbox and the section model).
- **Per-section transform table**: `DataTexture` (RGBA float32, `nSections × 2` texels): texel 0 = (dx, dy, dz, alpha/visibility), texel 1 = (cos θ, sin θ, flipX, flipY) — the alignment hooks for §7.3-1. Layout switches rewrite this texture only.
- **Coloring**: 256-texel colormap `DataTexture`, palette `DataTexture` (≤ 65536 entries, 256 wide), category mask texture; per-point attributes `position`, `section` (Uint16), `scalar` (Float32), `code` (Uint16 or Float32 above 65535), `pointId`, `visible` (Uint8).
- **State**: one typed store with a `subscribe(keys, cb)` API; URL hash sync (`v=1`) debounced.

## 5. Phases

- **Phase 1 — scaffold** (this commit): Vite/TS/ESLint/Prettier config, `data/` plugin, deploy workflow, `inspect_h5ad.py` + `demo.meta.json` + generated manifest, `make_fixtures.py` + committed fixtures, placeholder page, `npm run typecheck && lint && test && build` green.
- **Phase 2 — reader**: `H5Source` adapter, dataframe/categorical/sparse decoders, spatial + library detection, section model, `uns/spatial` + image decoding, CSR/CSC/dense gene extraction, worker + RPC, lazy/WORKERFS/MEMFS loading, plugin retry; unit tests against every fixture; headless-browser check that the real demo opens and matches `demo.meta.json`.
- **Phase 3 — rendering core**: points + shader with transform table, layout modes, camera/controls, GPU picking, disposal; verified on the demo.
- **Phase 4 — images + UI**: tissue planes (alignment first, on `visium2`/synthetic), Sections panel first, then Dataset/Color/Filter/Coordinates/Appearance/Info, tooltip, URL state, export, error paths, Help.
- **Phase 5 — performance, E2E, README, polish**; then nice-to-haves in the spec's order and `make_synthetic_demo.py`.

## 6. Recommended preparation command for the demo (not executed — the file is not modified)

```
python scripts/prepare_h5ad.py data/demo.h5ad data/demo.csc.h5ad --csc --float32 --compression gzip --level 4
```
Would make gene switching an `indptr` slice instead of a full `indices` scan and halve `X/data`.

## 7. Phase 2 findings (reader + worker, verified on `data/demo.h5ad` in headless Chromium)

- **anndata ≥ 0.11 `nullable-string-array`**: current anndata writes the `obs`/`var` index and plain string
  columns as groups (`values` + `mask`, attr `na-value`) — not in the spec's encoding list. Supported in
  `readStringArray`; the demo itself (older writer) uses plain `string-array` datasets. Both are tested.
- **h5wasm quirks handled**: failed `File` open does not throw (returns `file_id = -1`); failed hyperslab
  reads (e.g. missing compression plugin) silently return garbage unless
  `Module.activate_throwing_error_handler()` is on — the worker always enables it. Booleans arrive as
  enum datasets (`dtype "unknown"`, members FALSE/TRUE); int64 as `BigInt64Array`; sparse `shape` attrs as
  BigInt arrays; legacy `categories` attrs as a one-element `Reference` array. Empty `column-order` comes back
  as `Float64Array(0)`.
- **Remote loading**: `probeUrl` does a HEAD, then a ranged GET of the first 8 bytes to verify the HDF5
  signature (catches 404 fallback pages served with 200) and byte-range support, before
  `FS.createLazyFile`. Lazy mode on the demo downloaded 20 of 24 MB because gene coloring needs all of
  `X` (CSR); metadata + coordinates alone touch ~3 MB.
- **Measured (production build, local preview, M-series laptop)**: engine start 29 ms; open + summary
  ~360 ms; coordinates + section model 54 ms; first gene on CSR (builds the 70 MB column index)
  0.9 s; next gene 20 ms. Local file via WORKERFS: identical numbers, no copy into WASM memory.
- Fixture `lzf.h5` (h5py's built-in LZF filter) covers the plugin path in Node via
  `install_local_plugins`; the browser path uses `?url` asset imports (`src/h5ad/plugins.ts`).
