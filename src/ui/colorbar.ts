import type { App } from '../app';
import { colormapCss } from '../color/colormaps';
import { formatValue } from '../app';
import { clear, el } from './dom';

/** Floating colorbar with tick labels, shown for continuous colouring. */
export function createColorbar(app: App, host: HTMLElement): void {
  const root = el('div', { className: 'spv-colorbar-float', style: 'display:none' });
  host.appendChild(root);
  const render = () => {
    const cb = app.colorbar;
    if (!cb) {
      root.style.display = 'none';
      return;
    }
    clear(root);
    root.style.display = 'block';
    root.appendChild(
      el(
        'div',
        {
          style:
            'font-size:12px;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
          title: cb.label,
        },
        cb.label,
      ),
    );
    if (cb.blend) {
      const rowStyle = 'display:flex;align-items:center;gap:6px;font-size:12px';
      root.appendChild(
        el(
          'div',
          { style: rowStyle },
          el('span', { className: 'spv-swatch', style: `background:${cb.blend.colorA}` }),
          `${cb.blend.nameA} ${formatValue(cb.vmin)} – ${formatValue(cb.vmax)}`,
        ),
      );
      root.appendChild(
        el(
          'div',
          { style: rowStyle },
          el('span', { className: 'spv-swatch', style: `background:${cb.blend.colorB}` }),
          `${cb.blend.nameB} ${formatValue(cb.blend.vminB)} – ${formatValue(cb.blend.vmaxB)}`,
        ),
      );
    } else {
      root.appendChild(
        el('div', {
          className: 'spv-colorbar',
          style: `background:${colormapCss(cb.colormap, cb.reversed)}`,
        }),
      );
      const mid = (cb.vmin + cb.vmax) / 2;
      root.appendChild(
        el(
          'div',
          'spv-colorbar-ticks',
          el('span', null, formatValue(cb.vmin)),
          el('span', null, formatValue(mid)),
          el('span', null, formatValue(cb.vmax)),
        ),
      );
    }
    root.appendChild(
      el(
        'div',
        {
          style:
            'display:flex;align-items:center;gap:6px;font-size:11px;color:var(--spv-muted);margin-top:4px',
        },
        el('span', { className: 'spv-swatch', style: `background:${cb.nanColor}` }),
        'NaN / missing',
      ),
    );
  };
  app.on((e) => {
    if (e.type === 'colorbar' || e.type === 'legend' || e.type === 'dataset') render();
  });
}
