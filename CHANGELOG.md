# Changelog

Notable changes to SPV, newest first. The version is the one in `package.json`; the Help dialog
and the `D` diagnostic report show it together with the build stamp (short commit hash and commit date).

## Unreleased

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
