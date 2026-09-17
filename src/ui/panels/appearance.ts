import type { App } from '../../app';
import type { SizeMode, SpriteShape } from '../../render/points';
import { button, checkbox, clear, el, fmtInt, group, note, radio, select, slider } from '../dom';
import type { Panel } from '../sidebar';

export function appearancePanel(app: App): Panel {
  const root = el('div');
  const render = () => {
    clear(root);
    const a = app.store.slice('appearance');
    const spot = app.spotDiameterRaw();
    const sizeOpts = [
      { value: 'screen', label: 'Screen pixels' },
      { value: 'attenuated', label: 'Perspective' },
    ];
    if (spot) sizeOpts.push({ value: 'true', label: 'True spot size' });
    root.appendChild(
      group(
        'Points',
        slider({
          label: 'Point size',
          min: 0.5,
          max: 24,
          step: 0.5,
          value: a.pointSize,
          format: (v) => `${v} px`,
          onInput: (v) => app.store.update('appearance', { pointSize: v }),
        }).el,
        radio('spv-size', sizeOpts, a.trueSize && spot ? 'true' : a.sizeMode, (v) =>
          app.store.update(
            'appearance',
            v === 'true'
              ? { trueSize: true, sizeMode: 'world' }
              : { trueSize: false, sizeMode: v as SizeMode },
          ),
        ),
        spot
          ? note(
              `spot_diameter_fullres = ${spot} (median over sections). True spot size draws each spot at its physical diameter, like squidpy.pl.spatial_scatter.`,
            )
          : null,
        slider({
          label: 'Opacity',
          min: 0.05,
          max: 1,
          step: 0.01,
          value: a.opacity,
          format: (v) => `${Math.round(v * 100)}%`,
          onInput: (v) => app.store.update('appearance', { opacity: v }),
        }).el,
        el(
          'div',
          'spv-row',
          el('span', 'spv-slider-label', 'Shape'),
          radio(
            'spv-shape',
            [
              { value: 'round', label: 'Round' },
              { value: 'square', label: 'Square' },
            ],
            a.shape,
            (v) => app.store.update('appearance', { shape: v as SpriteShape }),
          ),
        ),
      ),
    );
    root.appendChild(
      group(
        'Scene',
        el(
          'div',
          'spv-row',
          el('span', 'spv-slider-label', 'Background'),
          radio(
            'spv-bg',
            [
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
            ],
            a.background,
            (v) => app.store.update('appearance', { background: v as 'dark' | 'light' }),
          ),
        ),
        el(
          'div',
          'spv-row',
          checkbox('Axes', a.axes, (v) => app.store.update('appearance', { axes: v })),
          checkbox('Bounding box', a.bbox, (v) => app.store.update('appearance', { bbox: v })),
          checkbox('Grid', a.grid, (v) => app.store.update('appearance', { grid: v })),
        ),
      ),
    );
    root.appendChild(
      group(
        'Camera',
        el(
          'div',
          'spv-row',
          checkbox(
            'Orthographic',
            a.ortho,
            (v) => app.store.update('appearance', { ortho: v }),
            'Toggle with O',
          ),
          checkbox(
            'Turntable',
            a.turntable,
            (v) => app.store.update('appearance', { turntable: v }),
            'Auto-rotate',
          ),
        ),
        el(
          'div',
          'spv-row',
          button('Reset (R)', () => {
            app.viewer.rig.reset();
            app.viewer.requestRender();
          }),
          button('Top (1)', () => preset('top')),
          button('Front (2)', () => preset('front')),
          button('Side (3)', () => preset('side')),
          button('Iso (4)', () => preset('iso')),
        ),
      ),
    );
    const graph = renderGraph();
    if (graph) root.appendChild(graph);
  };
  const renderGraph = (): HTMLElement | null => {
    const keys = app.graphKeys();
    if (!keys.length) return null;
    const g = app.store.slice('graph');
    const st = app.graphStatus;
    const color = el('input', { type: 'color', value: g.color, title: 'Edge colour' });
    color.addEventListener('input', () => app.store.update('graph', { color: color.value }));
    const cap = el('input', {
      type: 'number',
      className: 'spv-input',
      min: '1000',
      step: '10000',
      value: String(g.maxEdges),
      style: 'width:110px',
    });
    cap.addEventListener('change', () =>
      app.store.update('graph', { maxEdges: Math.max(1000, Number(cap.value) || 1_000_000) }),
    );
    return group(
      'Spatial graph (obsp)',
      checkbox('Show spatial graph edges', g.enabled, (v) =>
        app.store.update('graph', { enabled: v }),
      ),
      el(
        'div',
        'spv-row',
        el('span', 'spv-slider-label', 'Graph'),
        select(
          keys.map((k) => ({ value: k, label: k })),
          g.key && keys.includes(g.key) ? g.key : keys[0],
          (v) => app.store.update('graph', { key: v }),
        ),
      ),
      el(
        'div',
        'spv-row',
        el('span', 'spv-slider-label', 'Edge colour'),
        color,
        el('span', 'spv-slider-label', 'Max edges'),
        cap,
      ),
      slider({
        label: 'Edge opacity',
        min: 0.02,
        max: 1,
        step: 0.01,
        value: g.opacity,
        format: (v) => `${Math.round(v * 100)}%`,
        onInput: (v) => app.store.update('graph', { opacity: v }),
      }).el,
      st
        ? note(
            `${fmtInt(st.nEdges)} edges shown${st.subsampled ? ` (uniformly subsampled from ${fmtInt(st.nTotal)})` : ''}; edges follow the section, clip, category and subsample filters.`,
          )
        : null,
    );
  };
  const preset = (v: 'top' | 'front' | 'side' | 'iso') => {
    app.viewer.rig.preset(v);
    app.viewer.requestRender();
  };
  app.store.on('appearance', render);
  app.store.on('graph', render);
  app.on((e) => {
    if (e.type === 'dataset' || e.type === 'sections') render();
  });
  render();
  return { id: 'appearance', title: 'Appearance', el: root };
}
