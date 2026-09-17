import type { App } from '../../app';
import { button, checkbox, clear, dualSlider, el, fmtInt, group, note } from '../dom';
import type { Panel } from '../sidebar';

export function filterPanel(app: App): Panel {
  const root = el('div');
  const render = () => {
    clear(root);
    const sp = app.spatial;
    const f = app.store.slice('filter');
    if (!sp) {
      root.appendChild(note('Open a dataset first.'));
      return;
    }
    if (sp.ndim === 3 && sp.sections.length <= 1) {
      const lo = sp.rawMin[2];
      const hi = sp.rawMax[2];
      const step = (hi - lo) / 500 || 1;
      root.appendChild(
        group(
          'Z range (raw units)',
          dualSlider({
            label: 'z',
            min: lo,
            max: hi,
            step,
            lo: f.zRange?.[0] ?? lo,
            hi: f.zRange?.[1] ?? hi,
            format: (v) => v.toFixed(2),
            onInput: (a, b) =>
              app.store.update('filter', { zRange: a <= lo && b >= hi ? null : [a, b] }),
          }).el,
        ),
      );
    } else if (sp.sections.length > 1) {
      root.appendChild(
        note('Sectioned data: use the Sections panel to show, hide or step through sections.'),
      );
    }
    if (app.hasInTissue()) {
      root.appendChild(
        group(
          'Visium',
          checkbox('Show only in_tissue == 1', f.inTissueOnly, (v) =>
            app.store.update('filter', { inTissueOnly: v }),
          ),
        ),
      );
    }
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    root.appendChild(
      group(
        'Clip planes (per-section XY frame)',
        dualSlider({
          label: 'X',
          min: 0,
          max: 1,
          step: 0.005,
          lo: f.clipX[0],
          hi: f.clipX[1],
          format: pct,
          onInput: (a, b) => app.store.update('filter', { clipX: [a, b] }),
        }).el,
        dualSlider({
          label: 'Y',
          min: 0,
          max: 1,
          step: 0.005,
          lo: f.clipY[0],
          hi: f.clipY[1],
          format: pct,
          onInput: (a, b) => app.store.update('filter', { clipY: [a, b] }),
        }).el,
        button(
          'Reset clips',
          () => app.store.update('filter', { clipX: [0, 1], clipY: [0, 1], zRange: null }),
          { className: 'spv-small' },
        ),
      ),
    );
    const sub = el('input', {
      type: 'number',
      className: 'spv-input',
      min: '1000',
      step: '1000',
      placeholder: `all ${fmtInt(sp.n)}`,
      value: f.subsample ? String(f.subsample) : '',
    });
    root.appendChild(
      group(
        'Random subsample',
        el(
          'div',
          'spv-row',
          sub,
          button(
            'Apply',
            () =>
              app.store.update('filter', {
                subsample:
                  Number(sub.value) > 0 && Number(sub.value) < sp.n ? Number(sub.value) : null,
              }),
            { className: 'spv-small' },
          ),
          button('Clear', () => app.store.update('filter', { subsample: null }), {
            className: 'spv-small',
          }),
        ),
        note(
          'Keeps a fixed random subset of cells (deterministic). Useful above ~1 M points on slower machines.',
        ),
      ),
    );
    const hiddenCats = app.store.slice('color').hiddenCategories.length;
    root.appendChild(
      group(
        'Category filter',
        hiddenCats
          ? el(
              'div',
              'spv-row',
              el(
                'span',
                null,
                `${hiddenCats} categor${hiddenCats === 1 ? 'y' : 'ies'} hidden via the legend`,
              ),
              button('Show all', () => app.setAllCategories(true), { className: 'spv-small' }),
            )
          : note('No categories hidden. Click legend entries in the Color panel to hide them.'),
      ),
    );
    root.appendChild(
      note(
        `${fmtInt(app.visibleCount())} of ${fmtInt(sp.n)} cells pass the filters (before category and section visibility).`,
      ),
    );
  };
  app.on((e) => {
    if (e.type === 'dataset' || e.type === 'counts' || e.type === 'legend') render();
  });
  app.store.on('filter', render);
  render();
  return { id: 'filter', title: 'Filter', el: root };
}
