# Security

SPV is a static site with no server-side code, accounts or stored data. Everything happens in the
visitor's browser: the `.h5ad` file is parsed by libhdf5 compiled to WebAssembly inside a Web
Worker and drawn with WebGL.

## Reporting a vulnerability

Report it privately through **Security → Report a vulnerability** on this repository rather than
in a public issue. Include the build stamp from the Help dialog and, if possible, a file or link
that reproduces the problem. Expect an acknowledgement within a week.

## Untrusted input and how it is handled

- **`.h5ad` files** from any URL or from disk. Parsing happens inside WebAssembly, so a memory
  bug in libhdf5 cannot leave the sandbox; an abort or crash is caught and the worker replaced.
  Strings from files (names, categories, gene symbols) reach the page only as text nodes, never
  as HTML. Colours from files must match a hex pattern. Images above 512 M samples are refused
  before any allocation; category counts, matrix indexes and graph sizes are capped.
- **Share links** (`#…`). Every key is parsed explicitly and validated (numbers, enumerations,
  hex colours); unknown keys are ignored, numbers that do not parse fall back to the defaults, and
  index lists are capped at 100 000 entries. `#url=` and the URL box accept http(s) targets only.
- **The dataset manifest** (`data/datasets.json`) is the site owner's file, but every entry must
  carry string `id`, `name` and `url` fields or it is skipped with a warning.
- **Exports.** CSV/TSV cells that start with a formula character get a leading apostrophe;
  download names are reduced to letters, digits, `_` and `-`.

## Defences in the shipped page

- Content Security Policy: scripts, workers, styles and fonts from the site itself only; no
  inline scripts or styles; no objects. `connect-src` is open so datasets can be fetched from
  other hosts.
- No third-party resources, no cookies, no analytics, `referrer: no-referrer`. Cross-origin
  dataset requests carry no credentials.
- Exact dependency pins installed from the lockfile with install scripts disabled; `npm audit`
  and `npm audit signatures` in CI; Dependabot; GitHub Actions pinned to commit hashes with
  read-only, non-persisted credentials; only the deploy job, which runs nothing but the deploy
  action, holds the Pages and OIDC permissions.

## Out of scope

- The hosts that `#url=` points at. SPV fetches them as the visitor's browser would.
- The hosting platform. On GitHub Pages, turn on **Enforce HTTPS**; when self-hosting, send the
  headers listed in `docs/hosting.md`.
