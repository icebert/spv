/**
 * Category legend on the viewport. Shown only while the sidebar is hidden, so the picture stays
 * readable in presentation mode; with the sidebar open the Color panel carries the full legend.
 */
import type { App } from '../app';
import { clear, el, fmtInt, pressable } from './dom';

const MAX_ROWS = 48;

export function createLegendFloat(app: App, host: HTMLElement): void {
  const root = el('div', {
    className: 'spv-legend-float',
    style: 'display:none',
    role: 'group',
    'aria-label': 'Legend',
  });
  host.appendChild(root);
  const render = () => {
    const lg = app.legend;
    if (!lg || app.store.slice('ui').sidebar) {
      root.style.display = 'none';
      return;
    }
    clear(root);
    root.style.display = 'block';
    root.appendChild(el('div', { className: 'spv-legend-float-title', title: lg.key }, lg.key));
    const n = Math.min(lg.categories.length, MAX_ROWS);
    for (let i = 0; i < n; i++) {
      const hidden = lg.hidden.has(i);
      root.appendChild(
        pressable(
          el(
            'div',
            {
              className: `spv-legend-row ${hidden ? 'spv-hidden' : ''}`,
              title: 'Click to toggle, Shift-click to solo',
              'aria-pressed': String(!hidden),
              onClick: (e: Event) =>
                (e as MouseEvent).shiftKey ? app.soloCategory(i) : app.toggleCategory(i),
            },
            el('span', { className: 'spv-swatch', style: `background:${lg.colors[i]}` }),
            el(
              'span',
              { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
              lg.categories[i],
            ),
            el('span', 'spv-count', fmtInt(lg.counts[i])),
          ),
        ),
      );
    }
    if (lg.categories.length > n)
      root.appendChild(
        el('p', 'spv-note', `${fmtInt(lg.categories.length - n)} more in the Color panel`),
      );
  };
  app.on((e) => {
    if (e.type === 'legend' || e.type === 'dataset' || e.type === 'colorbar') render();
  });
  app.store.on('ui', render);
  render();
}
