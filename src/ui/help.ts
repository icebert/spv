import { el } from './dom';

const SHORTCUTS: [string, string][] = [
  ['R', 'Reset view'],
  ['H', 'Toggle sidebar'],
  ['F', 'Toggle fullscreen'],
  ['S', 'Screenshot (PNG)'],
  ['1 / 2 / 3', 'Top / front / side view'],
  ['4', 'Isometric view'],
  ['← / →', 'Previous / next section'],
  ['Space', 'Play / pause section stepping'],
  ['I', 'Toggle tissue images'],
  ['L', 'Cycle layout mode'],
  ['O', 'Toggle orthographic camera'],
  ['Esc', 'Clear selection / close dialogs'],
];

export function openHelp(): void {
  if (document.querySelector('.spv-modal-backdrop')) return;
  const close = () => backdrop.remove();
  const backdrop = el(
    'div',
    { className: 'spv-modal-backdrop', onClick: (e: Event) => e.target === backdrop && close() },
    el(
      'div',
      { className: 'spv-modal', role: 'dialog', 'aria-label': 'Help' },
      el('h2', null, 'SPV — Spatial Viewer'),
      el(
        'p',
        null,
        'A static, browser-based 3D viewer for spatial transcriptomics AnnData (.h5ad) files. Sections are spread along z (Stack), recentred (Stack normalized), laid out side by side (Tile) or shown one at a time (Single).',
      ),
      el('h3', null, 'Controls'),
      el(
        'p',
        null,
        'Drag to orbit, right-drag (or two-finger drag) to pan, scroll or pinch to zoom. Hover a cell for details; click to pin the tooltip and highlight the cell.',
      ),
      el('h3', null, 'Keyboard shortcuts'),
      el(
        'table',
        null,
        ...SHORTCUTS.map(([k, d]) =>
          el('tr', null, el('td', null, el('kbd', null, k)), el('td', null, d)),
        ),
      ),
      el('h3', null, 'Supported file features'),
      el(
        'ul',
        null,
        el(
          'li',
          null,
          'AnnData ≥ 0.8 (and legacy < 0.8) layouts: dense / CSR / CSC X, layers, raw, categorical (incl. missing codes), string, boolean, nullable and legacy columns.',
        ),
        el(
          'li',
          null,
          'Coordinates from obsm/spatial3d, spatial, X_spatial (any obsm or numeric obs column can be chosen), z from obs (z, Bregma, …) or from a section column.',
        ),
        el(
          'li',
          null,
          'Squidpy conventions: uns/spatial/<library>/images + scalefactors (tissue image overlay), library_key columns, uns/*_colors, obsp/*_connectivities, uns/moranI.',
        ),
        el(
          'li',
          null,
          'gzip/shuffle built in; lzf, zstd, blosc, lz4, bz2, … via lazily loaded plugins.',
        ),
      ),
      el('h3', null, 'Privacy'),
      el(
        'p',
        null,
        'Everything runs in your browser. Local files are read in place through the File API inside a Web Worker and are never uploaded anywhere. Remote files are fetched directly by your browser.',
      ),
      el(
        'div',
        'spv-row',
        el('button', { className: 'spv-btn spv-primary', onClick: close }, 'Close'),
      ),
    ),
  );
  document.body.appendChild(backdrop);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      close();
      window.removeEventListener('keydown', onKey);
    }
  };
  window.addEventListener('keydown', onKey);
}
