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

## 8. Phase 5 notes (performance, E2E, README)

- **Benchmark method**: `.scratch`-style Playwright scripts against the production build served at
  `/spv/`, Chromium launched with `--use-angle=metal --ignore-gpu-blocklist` so headless Chromium
  uses the real GPU (AMD Radeon Pro 5500 XT here). Headless has no vsync, so frame rate was
  measured as render + synchronous 1-pixel `readPixels` (a true GPU fence; `gl.finish()` returned
  early on this driver and gave meaningless sub-millisecond numbers for 2 M points). Interaction
  stalls are the synchronous main-thread time of the store update plus the next two frames.
- **Bug found by the benchmark**: the render loop re-armed itself twice per frame while OrbitControls
  damping settled (once from the controls' `change` event via `requestRender()`, once from the loop),
  so pending `requestAnimationFrame` callbacks doubled every frame. Fixed in `Viewer.frame` (only one
  pending frame). The earlier headless "30 fps orbit" number was this bug, not rendering cost.
- **Numbers** are in README "Measured performance". Highlights: demo points visible 0.58 s after
  navigation with 7.3 MB of 25 MB fetched; 103k/500k/2M points at 2.9/5.2/11 ms per frame; layout
  switches 2–9 ms of main-thread work; first CSR gene 0.95 s (index build), later genes ≤ 22 ms;
  4 × 2048² images decoded and uploaded 1.3 s after the first frame; dataset switching ×3 leaves GPU
  geometry/texture counts at baseline.
- **Not measurable here**: the spec's "2022-class laptop with integrated graphics" target. Frame
  times above are from a desktop discrete GPU; at 2 M points (11–19 ms per frame) an integrated GPU
  will be several times slower — the subsample filter exists for that case.
- **E2E**: 9 Playwright tests (`tests/e2e/demo.spec.ts`) run against the production build at a
  non-root base: manifest load and meta.json match, gene/category colouring and legend toggles,
  section stepping and all layouts, share-link round trip, dataset switching memory baseline,
  image alignment on the checkerboard fixture (red marker in the upper half), in_tissue filter,
  error paths, and a skippable native-3D synthetic test. They also run in the deploy workflow.
- **External hosting** verified with `curl`: GitHub Pages sends `Accept-Ranges: bytes`; a public GCS
  object serves ranges (CORS is per-bucket config); Zenodo sends `Access-Control-Allow-Origin: *` but
  ignored a Range request (full-download fallback). GitHub Release assets were not verified.
- **Scripts**: `prepare_h5ad.py` verified on the demo (CSR → CSC float32, 25.2 → 25.8 MB) and on a
  synthetic Visium-like file (stratified subsample, top genes, image downscale with consistent
  `tissue_hires_scalef`, `spatial3d` materialisation); `inspect_h5ad.py` re-read both. The inspector
  gained support for anndata ≥ 0.11 `nullable-string-array` indexes/columns (current anndata writes
  them; the demo does not use them).
- **Nice-to-haves (§7.3)** are the remaining work, in the spec's order.

## 9. Nice-to-haves (§7.3) — all seven implemented, in the spec's order

1. **Manual alignment**: `layout.alignment[ordinal] = {dx, dy, rot, fx, fy}` in file units/degrees, converted
   to the display frame and fed to the existing per-section transform table (points, edges and image
   planes all follow); numeric inputs + nudge buttons in the Sections panel; `al=` in the URL.
2. **Spatial graph overlay**: `src/render/edges.ts` — `LineSegments` whose vertex shader transforms both
   endpoints with the point uniforms and hides an edge when either endpoint is hidden (section alpha,
   clip, category mask, user filter). Key, colour, opacity and edge cap in Appearance; `gr=`, `gc=`,
   `go=`, `ge=` in the URL. 141,631 edges for the 40k synthetic file load in ~0.3 s.
3. **Top spatially variable genes**: `uns/moranI` sorted by I in the Color panel (click to colour).
4. **Crossfade**: 220 ms smoothstep on the two sections' table alphas in Single mode (`cf=0` disables).
5. **Two-gene blend**: second scalar attribute + `uColorMode = 3`; additive mixing of two user colours
   with per-gene percentile/absolute ranges; `c2=` and `bc=` in the URL; tooltip shows both values.
6. **Lasso / box selection + export**: CPU re-projection of the visible points with the shader math,
   point-in-polygon test, `aSelected` attribute dims the rest; CSV/TSV with `cell_index,row,section`,
   tooltip fields and the coloured gene(s). The worker reads the whole obs index once for large
   exports (`getObsIndex` > 256 rows).
7. **Histogram**: 64 bins of the current variable under the colorbar with draggable min/max handles
   that switch the range to explicit values.

Bug found while wiring these: the Color panel did not re-render its gene controls when the blend gene
changed (caught by the E2E test). Total E2E: 15 tests (one skipped without the synthetic file).

## 10. Per-section z correction (requested after delivery)

Three slices of `data/demo.h5ad` are stored at a z that breaks the otherwise regular 20-unit spacing
(spacings 20, 15, 25, 18, 20, 20, 23, 17, 20 …): slice3 = 355, slice5 = 398, slice8 = 461. The viewer
renders the file faithfully (verified: rendered z == file z for all 16 sections). A first fix snapped
those three onto their neighbours' spacing; the data owner rejected that assumption (section spacing
may vary), and neither the obs index prefixes (`r1_s1` … `r1_s16`, consistent with the labels) nor the
anatomical footprint trend of the slices identifies which slices are wrong or where they belong. So:
no correction is applied by default; `AlignmentState` gained `dz` (file units), carried through the
section transform table, image planes, selection projection and the share link
(`al=ord:dx,dy,rot,flags,dz`); `Sections › Align current section` has a "Shown at z" field that stores the
difference to the file value; a manifest entry may carry `section_alignment` keyed by section name to
make such corrections the default for a hosted dataset (`make_manifest.py` preserves it). The correct z
values for the three slices have to come from the data owner.

**Resolved (2026-09-17): the misplaced slices were not in the file.** The owner saw them in Safari
only; Chromium/WebKit-via-Playwright never reproduced them. With all sections but slice13 hidden,
Safari showed two slabs; the GPU pixel census (D key) attributed every drawn pixel to slice13, and the
owner's screenshots showed one slab with coherent cluster structure and one with scrambled colours —
cells drawn at other cells' coordinates. `data/demo.h5ad` has one z and one footprint per slice, so the
coordinate array had been read from the wrong bytes. Cause: Emscripten's `FS.createLazyFile` trusts
whatever a `Range` XHR returns, and Safari's URL cache ignores byte ranges, so a cached partial response
for one 1 MiB chunk is replayed for another chunk of the same URL. slice13 straddles the chunk boundary
at row 87,381, and slices 14–16 lie entirely in the following chunk, which is exactly the set of
"wrong z" reports. Fix: `src/h5ad/lazyFile.ts` replaces the built-in loader (per-chunk URLs
`?spv_range=from-to`, `Content-Range`/length verification, one cache-busting retry, whole-file 200
handled by slicing, block copies instead of per-byte `get`), the pre-flight fetches use
`cache: 'no-store'`, and the D-key report now includes a coordinate-buffer check (every cell of a
visible single-z section at that z). The "Shown at z" / `section_alignment` mechanism stays available
for genuinely misregistered data but is not needed for the demo. Also fixed on the way: the E2E suite
now builds to `dist-e2e/` on port 4174 instead of reusing a developer's preview server on 4173, which
had made the suite test a stale bundle.

**Second cause, same row boundary (2026-09-18).** With the loader fixed, Safari 26.5 on the AMD iMac
still showed two slabs while the CPU arrays were verified intact and the export proved the duplicate
was inside the drawing buffer. The per-cell diagnostic (GPU pixel centroid vs CPU projection, before
and after re-uploading every attribute) showed exactly ids 87,381–90,010 displaced by ~450 px and
unchanged by the re-upload: 87,381 × 12 bytes = 1 MiB into the *position* buffer. Row 87,381 is also
where the file's float64 coordinate array crosses 2 MiB, which is why the loader hypothesis fit so
well. Playwright's WebKit on the same GPU does not reproduce it. Fix: `PointCloud` draws in batches
of 65,536 points with separate sub-1 MiB buffers (`uIdOffset` keeps ids global); the GPU picker and
the census swap materials per batch. Chromium, WebKit and the owner's Safari 26.5 report 0 displaced
cells and a GPU footprint matching the CPU projection within 2 px.
The graph overlay (`EdgeCloud`) was batched the same way (32,768 edges = 65,536 vertices per
`LineSegments`, one shared material) at the owner's request.

**Visual design pass (2026-09-17).** At the owner's request the chrome was redesigned around one rule, colour belongs to the data: neutral-grey tokens in both themes (viewport `#161616` / `#ffffff`, matched in `Viewer.setBackground`), state shown by ink weight and fill instead of the old ColorBrewer green accent (which sat next to green cluster swatches in every legend), sentence-case group titles instead of tracked capitals, and a prose status line in the top bar. The typeface is Atkinson Hyperlegible Next (self-hosted variable font, latin + latin-ext, ~53 KB) for its unambiguous I/l/1 in gene symbols. The one new element is the z staircase in the Sections list: a per-row tick at the section's drawn z (native z × z-scale + layout/alignment offset, normalised over the stack), hidden in the planar Tile/Single layouts, with the file-unit z range under the list. Layout, behaviour, shortcuts and the test suites are unchanged; the E2E selectors (roles, labels, `spv-active`, `spv-panel`, `spv-legend-row`, …) were kept.

**Polish round (2026-09-17).** Glyph buttons (stepper, sidebar toggle) became inline SVG icons in `src/ui/icons.ts` with `aria-label`s; the native file control became a label styled as a button around a visually hidden input; the viewport loading notice and the Dataset progress line share `progressText()` (friendly stage names instead of raw keys); the progress track, colour inputs and drop-zone label were tuned to the token system; the manifest placeholder reads "Choose a dataset…".

**Third review pass (2026-09-17).** Hiding the sidebar used to remove the categorical legend entirely (the `.spv-legend-float` class existed but nothing rendered it); `createLegendFloat` now shows a compact, clickable legend on the viewport while the sidebar is hidden. Legend rows and the section names in the Sections list are keyboard-operable (`pressable()`: role=button, tab stop, Enter/Space, Shift passed through for solo). Phone layout: the grid columns are `minmax(0, 1fr)` so long content can no longer widen the app past the screen, and the sidebar-hidden rule no longer collapses the viewport to 0 px below 800 px (a pre-existing bug); the wordmark subtitle hides below 600 px. The no-WebGL page spans the whole grid instead of the 320 px sidebar column. Remaining em-dash copy in the viewport notice and the diagnostic toast was reworded.

**Production readiness (2026-09-17).** A pass over everything that is not a feature. `index.html` now carries a Content Security Policy as a meta tag (same-origin scripts, workers, styles and fonts; `connect-src *` for `#url=`; no objects, no inline scripts), loosened for `style-src-elem` in the dev server only (`devCsp()` in `vite.config.ts`), plus `theme-color`, `referrer: no-referrer` and a `<noscript>` page. `main.ts` installs `error` and `unhandledrejection` handlers (one toast per distinct message per 10 s, benign cancellations ignored) and wraps start-up so a failure while constructing the app shows the fatal page instead of a blank one; `src/util/errorLog.ts` keeps the last 20 errors (including every error notice) and the `D` report begins with `SPV <version>, build <sha>[+] <date>; <user agent>` and ends with them. The version and build stamp come from `define` in `vite.config.ts` (`src/version.ts`; `GITHUB_SHA` in CI, `git rev-parse` locally, `+` for a dirty tree, the commit date) and appear in the Help dialog and on `window.__spv`. `H5adClient` marks itself `dead` after an uncaught worker error so calls fail fast instead of hanging, and `App.open()` replaces a dead or aborted worker (`Aborted(`, `RuntimeError`, out of memory) with a fresh one. The unused `html:` attribute (an `innerHTML` sink) was removed from `el()`, and the WebGL probe context is released. CI: `ci.yml` runs on pull requests and non-main branches (audit of runtime dependencies, typecheck, lint, unit tests, build, bundle budget, E2E, traces uploaded on failure); `deploy.yml` gained the same audit, budget and artifact steps; `.nvmrc` pins Node 22; Dependabot updates npm and actions weekly. `scripts/bundle_budget.mjs` fails the build when `dist/assets` files outgrow their budgets (main script 900 kB, worker 5.5 MB, fonts 80 kB, plugins 5 MB, total 12 MB; today 707 kB / 4.8 MB / 53 kB / 3.9 MB / 9.5 MB). Three E2E tests cover the CSP (no violations through loading, images and export), the version surfaces, and the error toasts and log. `CHANGELOG.md` was started. The version stays 0.1.0; bumping to 1.0.0 is the owner's call.
