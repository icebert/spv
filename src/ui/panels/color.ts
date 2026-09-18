import type { App } from '../../app';
import { COLORMAP_NAMES, colormapCss, type ColormapName } from '../../color/colormaps';
import {
  button,
  pressable,
  checkbox,
  clear,
  dualSlider,
  el,
  fmtInt,
  group,
  note,
  radio,
  select,
  textInput,
  virtualList,
} from '../dom';
import { histogramWidget } from '../histogram';
import type { Panel } from '../sidebar';

/** Compact gene autocomplete used for the blend gene. */
function geneSearch(
  app: App,
  placeholder: string,
  value: string,
  onPick: (name: string) => void,
): HTMLElement {
  const wrap = el('div', { className: 'spv-autocomplete', style: 'flex:1;min-width:120px' });
  const list = el('div', { className: 'spv-autocomplete-list', style: 'display:none' });
  let results: { index: number; name: string }[] = [];
  let timer = 0;
  const pick = (name: string) => {
    input.value = name;
    list.style.display = 'none';
    onPick(name);
  };
  const show = (q: string) => {
    results = app.searchGenes(q, 30);
    clear(list);
    if (!results.length) {
      list.style.display = 'none';
      return;
    }
    for (const r of results) {
      list.appendChild(
        el(
          'div',
          {
            className: 'spv-autocomplete-item',
            onMousedown: (e: Event) => {
              e.preventDefault();
              pick(r.name);
            },
          },
          el('span', null, r.name),
        ),
      );
    }
    list.style.display = 'block';
  };
  const input = textInput(
    placeholder,
    (v) => {
      if (v && app.varDisplay.includes(v)) pick(v);
      else if (results.length) pick(results[0].name);
    },
    {
      value,
      onInput: (v) => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => show(v), 120);
      },
    },
  );
  input.addEventListener('blur', () => setTimeout(() => (list.style.display = 'none'), 150));
  wrap.append(input, list);
  return wrap;
}

export function colorPanel(app: App): Panel {
  const root = el('div');
  const sourceBox = el('div');
  const geneBox = el('div');
  const legendBox = el('div');
  const contBox = el('div');
  root.append(group('Colour by', sourceBox), group('Gene expression', geneBox), legendBox, contBox);
  let legendQuery = '';

  const renderSource = () => {
    clear(sourceBox);
    const s = app.summary;
    const c = app.store.slice('color');
    if (!s) {
      sourceBox.appendChild(note('Open a dataset first.'));
      return;
    }
    const cols = s.obs.columns.filter((col) => col.kind !== 'unsupported');
    const options = [
      { value: '', label: 'None (uniform colour)' },
      ...cols.map((col) => ({
        value: `obs:${col.name}`,
        label: `${col.name} (${col.kind === 'categorical' ? `${col.nCategories} categories` : col.kind})`,
      })),
    ];
    if (c.source === 'gene' && c.key)
      options.push({ value: `gene:${c.key}`, label: `gene: ${c.key}` });
    const value = c.source === 'none' || !c.key ? '' : `${c.source}:${c.key}`;
    sourceBox.appendChild(
      select(
        options,
        value,
        (v) => {
          if (!v) app.store.update('color', { source: 'none', key: null });
          else if (v.startsWith('obs:')) app.colorByColumn(v.slice(4));
        },
        { className: 'spv-input' },
      ),
    );
  };

  const renderGene = () => {
    clear(geneBox);
    const s = app.summary;
    const c = app.store.slice('color');
    if (!s) return;
    const matrices = [
      { value: 'X', label: 'X' },
      ...Object.keys(s.layers).map((k) => ({ value: `layers/${k}`, label: `layers/${k}` })),
      ...(s.raw?.X ? [{ value: 'raw/X', label: 'raw/X' }] : []),
    ];
    if (!s.X && matrices.length === 1) {
      geneBox.appendChild(note('No expression matrix (X, layers or raw) in this file.'));
      return;
    }
    const wrap = el('div', 'spv-autocomplete');
    const list = el('div', { className: 'spv-autocomplete-list', style: 'display:none' });
    let active = -1;
    let results: { index: number; name: string }[] = [];
    const show = (q: string) => {
      results = app.searchGenes(q, 40);
      clear(list);
      active = -1;
      if (!results.length) {
        list.style.display = 'none';
        return;
      }
      for (const r of results) {
        list.appendChild(
          el(
            'div',
            {
              className: 'spv-autocomplete-item',
              onMousedown: (e: Event) => {
                e.preventDefault();
                pick(r.name);
              },
            },
            el('span', null, r.name),
            el('small', null, `#${r.index}`),
          ),
        );
      }
      list.style.display = 'block';
    };
    const pick = (name: string) => {
      input.value = name;
      list.style.display = 'none';
      app.colorByGene(name);
    };
    let timer = 0;
    const input = textInput(
      `Search ${fmtInt(s.nVars)} genes…`,
      (v) => {
        if (active >= 0 && results[active]) pick(results[active].name);
        else if (v && app.varDisplay.includes(v)) pick(v);
        else if (results.length) pick(results[0].name);
      },
      {
        value: c.source === 'gene' ? (c.key ?? '') : '',
        onInput: (v) => {
          window.clearTimeout(timer);
          timer = window.setTimeout(() => show(v), 120);
        },
      },
    );
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!results.length) return;
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
        [...list.children].forEach((ch, i) => ch.classList.toggle('spv-active', i === active));
      } else if (e.key === 'Escape') list.style.display = 'none';
    });
    input.addEventListener('blur', () => setTimeout(() => (list.style.display = 'none'), 150));
    input.addEventListener('focus', () => input.value && show(input.value));
    wrap.append(input, list);
    geneBox.appendChild(wrap);
    if (c.source === 'gene' && c.key) {
      const b = geneSearch(app, 'Second gene…', c.gene2 ?? '', (name) => app.blendWithGene(name));
      const colA = el('input', {
        type: 'color',
        value: c.blendColors[0],
        title: `${c.key} colour`,
      });
      const colB = el('input', {
        type: 'color',
        value: c.blendColors[1],
        title: 'second gene colour',
      });
      const setColors = () => app.store.update('color', { blendColors: [colA.value, colB.value] });
      colA.addEventListener('input', setColors);
      colB.addEventListener('input', setColors);
      geneBox.appendChild(
        el(
          'div',
          'spv-row',
          el('span', 'spv-slider-label', 'Blend'),
          b,
          colA,
          colB,
          c.gene2
            ? button('Clear', () => app.blendWithGene(null), { className: 'spv-small' })
            : null,
        ),
      );
      if (c.gene2)
        geneBox.appendChild(
          note(
            `${c.key} → first colour, ${c.gene2} → second colour; co-expression mixes them additively. Ranges follow the percentile / min-max settings below.`,
          ),
        );
    }
    if (matrices.length > 1)
      geneBox.appendChild(
        el(
          'div',
          'spv-row',
          el('span', 'spv-slider-label', 'Matrix'),
          select(matrices, c.matrix, (v) => app.store.update('color', { matrix: v })),
        ),
      );
    geneBox.appendChild(
      checkbox(
        'log1p',
        c.log1p,
        (v) => app.store.update('color', { log1p: v }),
        'Apply log(1 + x) to the expression values',
      ),
    );
    if (s.geneNameColumns.length) {
      geneBox.appendChild(
        el(
          'div',
          'spv-row',
          el('span', 'spv-slider-label', 'Gene names'),
          select(
            [
              { value: '', label: 'var index' },
              ...s.geneNameColumns.map((g) => ({ value: g, label: `var/${g}` })),
            ],
            c.geneNameColumn ?? '',
            (v) => app.store.update('color', { geneNameColumn: v || null }),
          ),
        ),
      );
    }
    if (s.uns.moranI) {
      const det = el(
        'details',
        null,
        el(
          'summary',
          { style: 'cursor:pointer;color:var(--spv-muted)' },
          `Top spatially variable genes (uns/moranI, ${s.uns.moranI.n})`,
        ),
      );
      const list = el('div', { style: 'max-height:220px;overflow:auto;font-size:12px' });
      det.appendChild(list);
      det.addEventListener('toggle', () => {
        if (!det.open || list.childElementCount) return;
        void app.moranI().then((rows) => {
          clear(list);
          if (!rows || !rows.length) {
            list.appendChild(note('moranI has no genes matching the var names.'));
            return;
          }
          for (const r of rows.slice(0, 50)) {
            list.appendChild(
              el(
                'div',
                {
                  className: 'spv-legend-row',
                  title: `Moran's I = ${r.I.toFixed(4)}`,
                  onClick: () => pick(r.name),
                },
                el('span', null, r.name),
                el('span', 'spv-count', r.I.toFixed(3)),
              ),
            );
          }
        });
      });
      geneBox.appendChild(det);
    }
    if (app.currentEntry?.example_genes?.length) {
      geneBox.appendChild(
        el(
          'div',
          'spv-row',
          el('span', { style: 'color:var(--spv-muted);font-size:12px' }, 'e.g.'),
          ...app.currentEntry.example_genes.map((g) =>
            button(g, () => pick(g), { className: 'spv-small' }),
          ),
        ),
      );
    }
  };

  const renderLegend = () => {
    clear(legendBox);
    const lg = app.legend;
    if (!lg) return;
    const nCats = lg.categories.length;
    const g = group(`Legend for ${lg.key} (${nCats})`);
    g.appendChild(
      el(
        'div',
        'spv-row',
        button('Show all', () => app.setAllCategories(true), { className: 'spv-small' }),
        button('Hide all', () => app.setAllCategories(false), { className: 'spv-small' }),
        button('Invert', () => app.invertCategories(), { className: 'spv-small' }),
      ),
    );
    let items = lg.categories.map((name, i) => ({ name, i }));
    if (nCats > 30) {
      const q = textInput('Filter categories…', () => undefined, {
        value: legendQuery,
        onInput: (v) => {
          legendQuery = v;
          renderLegend();
        },
      });
      g.appendChild(q);
      if (legendQuery)
        items = items.filter((it) => it.name.toLowerCase().includes(legendQuery.toLowerCase()));
    }
    const rowEl = ({ name, i }: { name: string; i: number }) => {
      const isNa =
        name === 'NA' &&
        i === lg.colors.length - 1 &&
        lg.categories.at(-1) === 'NA' &&
        lg.counts.length === lg.categories.length &&
        i >= (lg.source ? 0 : 0) &&
        i === lg.categories.length - 1 &&
        lg.categories.length > (app.legend?.hidden.size ?? -1) &&
        name === 'NA';
      const hidden = lg.hidden.has(i);
      return pressable(
        el(
          'div',
          {
            className: `spv-legend-row ${hidden ? 'spv-hidden' : ''}`,
            title: 'Click to toggle, Shift-click to solo',
            'aria-pressed': String(!hidden),
            onClick: (e: Event) => {
              if (
                isNa &&
                i >= lg.colors.length - 1 &&
                lg.categories.at(-1) === 'NA' &&
                i === lg.categories.length - 1
              )
                return;
              if ((e as MouseEvent).shiftKey) app.soloCategory(i);
              else app.toggleCategory(i);
            },
          },
          el('span', { className: 'spv-swatch', style: `background:${lg.colors[i]}` }),
          el('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, name),
          el('span', 'spv-count', fmtInt(lg.counts[i])),
        ),
      );
    };
    if (items.length > 200) g.appendChild(virtualList(items, 22, rowEl, 360));
    else g.appendChild(el('div', { style: 'max-height:360px;overflow:auto' }, ...items.map(rowEl)));
    if (lg.source !== 'categorical')
      g.appendChild(note(`This ${lg.source} column was converted to categories for colouring.`));
    legendBox.appendChild(g);
  };

  const renderContinuous = () => {
    clear(contBox);
    const cb = app.colorbar;
    const c = app.store.slice('color');
    if (!cb) return;
    const g = group(`Range for ${cb.label}`);
    if (cb.blend) {
      g.appendChild(
        el(
          'div',
          'spv-row',
          el('span', { className: 'spv-swatch', style: `background:${cb.blend.colorA}` }),
          el(
            'span',
            null,
            `${cb.blend.nameA}: ${cb.vmin.toPrecision(3)} – ${cb.vmax.toPrecision(3)}`,
          ),
        ),
      );
      g.appendChild(
        el(
          'div',
          'spv-row',
          el('span', { className: 'spv-swatch', style: `background:${cb.blend.colorB}` }),
          el(
            'span',
            null,
            `${cb.blend.nameB}: ${cb.blend.vminB.toPrecision(3)} – ${cb.blend.vmaxB.toPrecision(3)}`,
          ),
        ),
      );
    }
    g.appendChild(
      el(
        'div',
        'spv-row',
        el('span', 'spv-slider-label', 'Colormap'),
        select(
          COLORMAP_NAMES.map((n) => ({ value: n, label: n })),
          c.colormap,
          (v) => app.store.update('color', { colormap: v as ColormapName }),
        ),
        checkbox('reversed', c.reversed, (v) => app.store.update('color', { reversed: v })),
      ),
    );
    if (!cb.blend) {
      g.appendChild(
        el('div', {
          className: 'spv-colorbar',
          style: `background:${colormapCss(c.colormap, c.reversed)};margin:4px 0`,
        }),
      );
      g.appendChild(histogramWidget(app));
    }
    g.appendChild(
      radio(
        'spv-range',
        [
          { value: 'percentile', label: 'Percentile' },
          { value: 'absolute', label: 'Min / max' },
        ],
        c.rangeMode,
        (v) => {
          if (v === 'absolute')
            app.store.update('color', {
              rangeMode: 'absolute',
              vmin: c.vmin ?? cb.vmin,
              vmax: c.vmax ?? cb.vmax,
            });
          else app.store.update('color', { rangeMode: 'percentile' });
        },
      ),
    );
    if (c.rangeMode === 'percentile') {
      g.appendChild(
        dualSlider({
          label: 'Percentiles',
          min: 0,
          max: 100,
          step: 0.1,
          lo: c.pLo,
          hi: c.pHi,
          format: (v) => `${v.toFixed(1)}%`,
          onInput: (lo, hi) => app.store.update('color', { pLo: lo, pHi: hi }),
        }).el,
      );
    } else {
      const lo = el('input', {
        type: 'number',
        className: 'spv-input',
        step: 'any',
        value: String(c.vmin ?? cb.vmin),
      });
      const hi = el('input', {
        type: 'number',
        className: 'spv-input',
        step: 'any',
        value: String(c.vmax ?? cb.vmax),
      });
      const apply = () =>
        app.store.update('color', { vmin: Number(lo.value), vmax: Number(hi.value) });
      lo.addEventListener('change', apply);
      hi.addEventListener('change', apply);
      g.appendChild(el('div', 'spv-row', el('span', 'spv-slider-label', 'min / max'), lo, hi));
    }
    const nan = el('input', {
      type: 'color',
      value: c.nanColor,
      title: 'Colour for NaN / missing values',
    });
    nan.addEventListener('input', () => app.store.update('color', { nanColor: nan.value }));
    g.appendChild(el('div', 'spv-row', el('span', 'spv-slider-label', 'NaN colour'), nan));
    if (cb.vmax === cb.vmin)
      g.appendChild(note('This variable has zero variance; all cells get the low colour.', 'warn'));
    contBox.appendChild(g);
  };

  app.on((e) => {
    if (e.type === 'dataset') {
      renderSource();
      renderGene();
    }
    if (e.type === 'legend') {
      renderSource();
      renderLegend();
    }
    if (e.type === 'colorbar') {
      renderSource();
      renderContinuous();
    }
  });
  app.store.on('color', (v, prev) => {
    if (
      v.matrix !== prev.matrix ||
      v.log1p !== prev.log1p ||
      v.geneNameColumn !== prev.geneNameColumn ||
      v.gene2 !== prev.gene2 ||
      v.source !== prev.source ||
      v.key !== prev.key
    )
      renderGene();
    if (
      v.colormap !== prev.colormap ||
      v.reversed !== prev.reversed ||
      v.rangeMode !== prev.rangeMode
    )
      renderContinuous();
  });
  renderSource();
  renderGene();
  return { id: 'color', title: 'Color', el: root };
}
