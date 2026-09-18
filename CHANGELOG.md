# Changelog

Notable changes to SPV, newest first. The version is the one in `package.json`; the Help dialog
and the `D` diagnostic report show it together with the build stamp (short commit hash and commit date).

## Unreleased

- Tablets: touch targets grow to 36 px on coarse pointers; a long press stands in for Shift-click
  (solo) on legend entries and sections; the selection bar offers Lasso and Box buttons; a
  Fullscreen button appears where the browser allows it; the pinned tooltip sits above the finger;
  portrait tablets up to 900 px wide get the sheet layout; safe-area insets are respected; no text
  selection or callouts on controls and the view.

- Security: `#url=` and the URL box accept http(s) targets only; CSV/TSV exports neutralise
  formula-leading cells; images above 512 M samples are refused before allocation; element
  styles go through the CSSOM so the Content Security Policy allows no inline styles at all;
  install scripts are disabled for dependencies; `npm audit signatures` runs in CI; GitHub
  Actions are pinned to commit hashes with non-persisted, read-only credentials. `SECURITY.md`
  added. Second pass: the deploy workflow grants Pages and OIDC permissions to the deploy job only;
  share-link numbers that do not parse fall back to defaults and index lists are capped; the
  dataset manifest is validated entry by entry; `npm run e2e:webkit` runs the policy tests in
  WebKit (Safari's engine).

## 0.1.0 (2026-09-17)

First complete build.

- Static, browser-only viewer for AnnData `.h5ad` files: h5wasm in a Web Worker with lazy range
  reads for remote files and in-place reads for local ones; a Three.js point cloud coloured by
  `obs` columns or gene expression (two-gene blends, histogram range handles); Stack, Stack
  normalized, Tile and Single layouts; tissue image overlays, spatial graph overlay, manual section
  alignment, lasso and box selection with CSV export, share links in the URL hash.
- Safari/Metal workaround: every GPU vertex buffer stays below 1 MiB (65,536-point batches).
- Neutral-grey visual design in both themes, Atkinson Hyperlegible Next typeface, z staircase in
  the Sections list, floating legend when the sidebar is hidden, keyboard-operable lists, phone
  layout.
- Production hardening: Content Security Policy, global error reporting with a recent-error log
  in the diagnostic report, version and build stamp, data-worker crash recovery, bundle budget,
  pull-request CI and Dependabot.
