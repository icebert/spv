import type { App } from '../app';
import { button, el, fmtInt } from './dom';
import { openHelp } from './help';
import { toast } from './toast';

export function createTopbar(app: App): HTMLElement {
  const name = el('span', 'spv-grow');
  const sectionName = el('span', 'spv-section-name');
  const shotMenu = el('div', {
    className: 'spv-autocomplete-list',
    style: 'display:none;right:0;left:auto;top:110%;min-width:200px',
  });
  const shotWrap = el('div', { className: 'spv-menu-wrap' });
  const shotBtn = button(
    'Screenshot',
    () => (shotMenu.style.display = shotMenu.style.display === 'none' ? 'block' : 'none'),
    { title: 'Save a PNG (S)' },
  );
  for (const [label, scale, transparent] of [
    ['PNG 1×', 1, false],
    ['PNG 2×', 2, false],
    ['PNG 1× transparent background', 1, true],
    ['PNG 2× transparent background', 2, true],
  ] as const) {
    shotMenu.appendChild(
      el(
        'div',
        {
          className: 'spv-menu-item',
          onClick: () => {
            shotMenu.style.display = 'none';
            void app
              .screenshot(scale, transparent)
              .catch((e: Error) => toast(`Screenshot failed: ${e.message}`, 'error'));
          },
        },
        label,
      ),
    );
  }
  shotWrap.append(shotBtn, shotMenu);
  document.addEventListener('click', (e) => {
    if (!shotWrap.contains(e.target as Node)) shotMenu.style.display = 'none';
  });
  const share = button(
    'Share link',
    async () => {
      const url = app.shareLink();
      try {
        await navigator.clipboard.writeText(url);
        toast(
          app.store.slice('dataset').local
            ? 'Link copied. It encodes the view only; the recipient must open the same local file.'
            : 'Share link copied to the clipboard.',
          'info',
        );
      } catch {
        window.prompt('Copy this link', url);
      }
    },
    { title: 'Copy a link that restores this view' },
  );
  const selectBtn = button('Select', () => app.setSelectMode(!app.selectMode), {
    title: 'Lasso / box selection (X). Drag on the view; Shift-drag for a box.',
  });
  app.on((e) => {
    if (e.type === 'selection') selectBtn.classList.toggle('spv-primary', app.selectMode);
  });
  const help = button('?', openHelp, { className: 'spv-icon', title: 'Help' });
  const toggle = button(
    '☰',
    () => app.store.update('ui', { sidebar: !app.store.slice('ui').sidebar }),
    { className: 'spv-icon', title: 'Toggle sidebar (H)' },
  );
  const bar = el(
    'header',
    'spv-topbar',
    toggle,
    el(
      'span',
      { className: 'spv-wordmark', title: 'Spatial Viewer' },
      'SPV',
      el('small', null, 'Spatial Viewer'),
    ),
    name,
    sectionName,
    selectBtn,
    shotWrap,
    share,
    help,
  );

  const refresh = () => {
    const d = app.store.slice('dataset');
    const total = app.spatial?.n ?? 0;
    const visible = app.visibleCount();
    const parts: (string | HTMLElement)[] = [];
    if (d.name) parts.push(el('b', null, d.name));
    if (app.status === 'loading') parts.push(` · ${app.statusMessage || 'loading…'}`);
    else if (total)
      parts.push(
        ` · ${visible < total ? `${fmtInt(visible)} of ${fmtInt(total)}` : fmtInt(total)} cells`,
      );
    if (app.sections.length > 1) parts.push(` · ${app.sections.length} sections`);
    name.replaceChildren(...parts);
    const l = app.store.slice('layout');
    const cur = app.currentSection;
    sectionName.textContent =
      cur && (l.mode === 'single' || l.dimOthers)
        ? `${cur.name} (${l.current + 1}/${app.sections.length})`
        : '';
  };
  app.on((e) => {
    if (e.type === 'status' || e.type === 'dataset' || e.type === 'counts' || e.type === 'sections')
      refresh();
  });
  app.store.on('layout', refresh);
  refresh();
  return bar;
}
