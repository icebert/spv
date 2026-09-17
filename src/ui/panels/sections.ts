import type { App } from '../../app';
import { LAYOUT_MODES, hasNativeZ, type LayoutMode } from '../../render/sections';
import {
  append,
  button,
  checkbox,
  clear,
  el,
  fmtInt,
  group,
  note,
  radio,
  select,
  slider,
  virtualList,
} from '../dom';
import type { Panel } from '../sidebar';

const LAYOUT_LABELS: Record<LayoutMode, string> = {
  stack: 'Stack',
  'stack-normalized': 'Stack, normalized',
  tile: 'Tile',
  single: 'Single',
};

export function sectionsPanel(app: App): Panel {
  const root = el('div');
  const layoutBox = el('div');
  const stepperBox = el('div');
  const listBox = el('div');
  const imagesBox = el('div');
  const alignBox = el('div');
  root.append(
    group('Layout', layoutBox),
    group('Section stepper', stepperBox),
    group('Sections', listBox),
    group('Align current section', alignBox),
    group('Tissue images', imagesBox),
  );

  const renderLayout = () => {
    clear(layoutBox);
    const l = app.store.slice('layout');
    const nativeZ = hasNativeZ(app.geoms);
    layoutBox.appendChild(
      radio(
        'spv-layout',
        LAYOUT_MODES.map((m) => ({ value: m, label: LAYOUT_LABELS[m] })),
        l.mode,
        (v) => app.store.update('layout', { mode: v as LayoutMode }),
      ),
    );
    if (nativeZ)
      layoutBox.appendChild(
        checkbox(
          'Uniform spacing (ignore data z)',
          l.uniformSpacing,
          (v) => app.store.update('layout', { uniformSpacing: v }),
          'Replace the native z of each section by ordinal × spacing',
        ),
      );
    const spacingEnabled = !nativeZ || l.uniformSpacing;
    const sp = slider({
      label: 'Spacing',
      min: 0,
      max: 1,
      step: 0.005,
      value: l.spacing,
      format: (v) => v.toFixed(3),
      onInput: (v) => app.store.update('layout', { spacing: v }),
    });
    (sp.el.querySelector('input') as HTMLInputElement).disabled =
      !spacingEnabled || l.mode === 'tile' || l.mode === 'single';
    layoutBox.appendChild(sp.el);
    const gap = slider({
      label: 'Tile gap',
      min: 0,
      max: 0.5,
      step: 0.005,
      value: l.gap,
      format: (v) => v.toFixed(3),
      onInput: (v) => app.store.update('layout', { gap: v }),
    });
    (gap.el.querySelector('input') as HTMLInputElement).disabled = l.mode !== 'tile';
    layoutBox.appendChild(gap.el);
    const ex = slider({
      label: 'Explode z',
      min: 0.2,
      max: 6,
      step: 0.05,
      value: l.explode,
      format: (v) => `${v.toFixed(2)}×`,
      onInput: (v) => app.store.update('layout', { explode: v }),
    });
    (ex.el.querySelector('input') as HTMLInputElement).disabled =
      l.mode === 'tile' || l.mode === 'single';
    layoutBox.appendChild(ex.el);
    if (nativeZ)
      layoutBox.appendChild(
        note(
          'This dataset has a native z per section; Stack uses it (scaled by the Coordinates › z-scale slider).',
        ),
      );
  };

  const renderStepper = () => {
    clear(stepperBox);
    const l = app.store.slice('layout');
    const n = app.sections.length;
    const cur = app.currentSection;
    stepperBox.appendChild(
      el(
        'div',
        'spv-row',
        button('◀', () => app.stepSection(-1), { title: 'Previous section (←)' }),
        button(l.playing ? '❚❚' : '▶', () => app.store.update('layout', { playing: !l.playing }), {
          title: 'Play / pause (Space)',
        }),
        button('▶|', () => app.stepSection(1), { title: 'Next section (→)' }),
        el(
          'span',
          { style: 'flex:1;font-variant-numeric:tabular-nums' },
          cur ? `${cur.name} (${l.current + 1}/${n})` : '—',
        ),
      ),
    );
    stepperBox.appendChild(
      slider({
        label: 'Speed',
        min: 0.5,
        max: 10,
        step: 0.5,
        value: l.playFps,
        format: (v) => `${v} /s`,
        onInput: (v) => app.store.update('layout', { playFps: v }),
      }).el,
    );
    if (l.mode !== 'single')
      stepperBox.appendChild(
        checkbox('Highlight current section (dim others)', l.dimOthers, (v) =>
          app.store.update('layout', { dimOthers: v }),
        ),
      );
    else
      stepperBox.appendChild(
        checkbox(
          'Crossfade between sections',
          l.crossfade,
          (v) => app.store.update('layout', { crossfade: v }),
          'Short opacity blend when stepping (flip-book)',
        ),
      );
  };

  const renderList = () => {
    clear(listBox);
    const sections = app.sections;
    if (sections.length === 0) {
      listBox.appendChild(
        note(
          'This dataset has a single section (or no section column). Pick a library column in Coordinates to split it.',
        ),
      );
      return;
    }
    const l = app.store.slice('layout');
    const hidden = new Set(l.hidden);
    listBox.appendChild(
      el(
        'div',
        'spv-row',
        button('Show all', () => app.showAllSections(), { className: 'spv-small' }),
        button('Hide all', () => app.hideAllSections(), { className: 'spv-small' }),
        el(
          'span',
          { style: 'color:var(--spv-muted);font-size:12px' },
          `${sections.length - hidden.size} of ${sections.length} shown`,
        ),
      ),
    );
    const rowEl = (s: (typeof sections)[number]) => {
      const st = app.imageStatus.get(s.ordinal);
      const bb = s.bbox;
      const title = [
        `${s.name}: ${fmtInt(s.nCells)} cells`,
        bb
          ? `x ${bb.min[0].toFixed(1)} … ${bb.max[0].toFixed(1)}, y ${bb.min[1].toFixed(1)} … ${bb.max[1].toFixed(1)}${s.z !== null ? `, z ${s.z}` : ''}`
          : '',
        s.spotDiameter ? `spot diameter ${s.spotDiameter}` : '',
        s.hasImage
          ? `image: ${Object.entries(s.imageShapes)
              .map(([k, sh]) => `${k} ${sh[1]}×${sh[0]}`)
              .join(
                ', ',
              )}${st?.state === 'loaded' ? ` (loaded ${st.width}×${st.height})` : st?.state ? ` (${st.state}${st.message ? `: ${st.message}` : ''})` : ''}`
          : 'no image',
      ]
        .filter(Boolean)
        .join('\n');
      const cb = el('input', { type: 'checkbox', title: 'Show / hide' });
      cb.checked = !hidden.has(s.ordinal);
      cb.addEventListener('change', () => app.toggleSection(s.ordinal, cb.checked));
      const img = s.hasImage
        ? el(
            'span',
            { className: `spv-badge ${st?.state === 'loaded' ? 'spv-ok' : ''}`, title },
            st?.state === 'loading'
              ? '⌛'
              : st?.state === 'loaded'
                ? '🖼'
                : st?.state === 'unplaced'
                  ? '🖼?'
                  : st?.state === 'error'
                    ? '⚠'
                    : '🖼·',
          )
        : el('span', { className: 'spv-badge', style: 'opacity:.4' }, '—');
      const r = el(
        'div',
        { className: `spv-list-row ${l.current === s.ordinal ? 'spv-current' : ''}`, title },
        cb,
        el(
          'span',
          {
            className: 'spv-grow',
            style: 'cursor:pointer',
            onClick: () => app.setCurrentSection(s.ordinal),
          },
          s.name,
        ),
        el('span', { className: 'spv-badge' }, fmtInt(s.nCells)),
        img,
        button('solo', () => app.soloSection(s.ordinal), {
          className: 'spv-small',
          title: 'Show only this section',
        }),
      );
      return r;
    };
    if (sections.length > 50) listBox.appendChild(virtualList(sections, 26, rowEl, 320));
    else
      listBox.appendChild(
        el(
          'div',
          { className: 'spv-vlist', style: 'max-height:320px' },
          ...sections.map((s) => {
            const r = rowEl(s);
            r.style.height = '26px';
            return r;
          }),
        ),
      );
  };

  const renderImages = () => {
    clear(imagesBox);
    const im = app.store.slice('images');
    const withImages = app.sections.filter((s) => s.hasImage);
    if (withImages.length === 0) {
      imagesBox.appendChild(
        note(
          app.summary?.uns.spatial
            ? 'uns/spatial has no images for these sections.'
            : 'No tissue images in this file (no uns/spatial).',
        ),
      );
      return;
    }
    const loaded = withImages.filter(
      (s) => app.imageStatus.get(s.ordinal)?.state === 'loaded',
    ).length;
    const unplaced = withImages.filter((s) => !s.placementKnown).length;
    imagesBox.appendChild(
      checkbox(
        `Show tissue images (${loaded}/${withImages.length} loaded)`,
        im.enabled,
        (v) => app.store.update('images', { enabled: v }),
        'Toggle with I',
      ),
    );
    imagesBox.appendChild(
      slider({
        label: 'Opacity',
        min: 0,
        max: 1,
        step: 0.01,
        value: im.opacity,
        format: (v) => `${Math.round(v * 100)}%`,
        onInput: (v) => app.store.update('images', { opacity: v }),
      }).el,
    );
    imagesBox.appendChild(
      el(
        'div',
        'spv-row',
        el('span', 'spv-slider-label', 'Resolution'),
        select(
          [
            { value: 'auto', label: 'auto' },
            { value: 'hires', label: 'hires' },
            { value: 'lowres', label: 'lowres' },
          ],
          im.resolution,
          (v) => app.store.update('images', { resolution: v as 'auto' | 'hires' | 'lowres' }),
        ),
      ),
    );
    imagesBox.appendChild(
      checkbox(
        'Grayscale',
        im.grayscale,
        (v) => app.store.update('images', { grayscale: v }),
        'Desaturate images so coloured spots stand out',
      ),
    );
    if (unplaced)
      imagesBox.appendChild(
        note(
          `${unplaced} section(s) have an image but no tissue_*_scalef; placement unknown, image not drawn.`,
          'warn',
        ),
      );
    const errors = withImages.filter((s) => app.imageStatus.get(s.ordinal)?.state === 'error');
    if (errors.length)
      imagesBox.appendChild(
        note(`${errors.length} image(s) failed to decode; showing points only.`, 'warn'),
      );
  };

  const renderAlign = () => {
    clear(alignBox);
    const cur = app.currentSection;
    const sp = app.spatial;
    if (!cur || !sp || app.sections.length < 2) {
      alignBox.appendChild(
        note('Pick a section (stepper or list) to nudge it into register with its neighbours.'),
      );
      return;
    }
    const a = app.store.slice('layout').alignment[cur.ordinal] ?? {
      dx: 0,
      dy: 0,
      dz: 0,
      rot: 0,
      fx: false,
      fy: false,
    };
    const extent = Math.max(sp.rawMax[0] - sp.rawMin[0], sp.rawMax[1] - sp.rawMin[1]) || 1;
    const step = Number((extent / 200).toPrecision(2));
    const num = (label: string, value: number, key: 'dx' | 'dy' | 'dz' | 'rot', st: number) => {
      const input = el('input', {
        type: 'number',
        className: 'spv-input',
        step: String(st),
        value: String(Number(value.toPrecision(6))),
      });
      input.addEventListener('change', () =>
        app.setAlignment(cur.ordinal, { [key]: Number(input.value) || 0 }),
      );
      return el(
        'div',
        'spv-row',
        el('span', 'spv-slider-label', label),
        input,
        button('−', () => app.setAlignment(cur.ordinal, { [key]: (a[key] as number) - st }), {
          className: 'spv-small',
        }),
        button('+', () => app.setAlignment(cur.ordinal, { [key]: (a[key] as number) + st }), {
          className: 'spv-small',
        }),
      );
    };
    append(
      alignBox,
      el(
        'div',
        { style: 'font-size:12px;color:var(--spv-muted)' },
        `${cur.name} — offsets in file units, rotation in degrees about the section centre`,
      ),
      num('X offset', a.dx, 'dx', step),
      num('Y offset', a.dy, 'dy', step),
      num('Rotation', a.rot, 'rot', 1),
      cur.z !== null
        ? (() => {
            const shown = Number((cur.z + a.dz).toPrecision(8));
            const zInput = el('input', {
              type: 'number',
              className: 'spv-input',
              step: 'any',
              value: String(shown),
            });
            zInput.addEventListener('change', () => {
              const v = Number(zInput.value);
              if (Number.isFinite(v))
                app.setAlignment(cur.ordinal, { dz: Number((v - cur.z!).toPrecision(8)) });
            });
            return el(
              'div',
              null,
              el(
                'div',
                'spv-row',
                el('span', 'spv-slider-label', 'Shown at z'),
                zInput,
                el(
                  'span',
                  { style: 'font-size:12px;color:var(--spv-muted)' },
                  `file: ${cur.z}${a.dz ? ` (offset ${a.dz > 0 ? '+' : ''}${Number(a.dz.toPrecision(6))})` : ''}`,
                ),
              ),
            );
          })()
        : null,
      el(
        'div',
        'spv-row',
        checkbox('Flip X', a.fx, (v) => app.setAlignment(cur.ordinal, { fx: v })),
        checkbox('Flip Y', a.fy, (v) => app.setAlignment(cur.ordinal, { fy: v })),
        button('Reset', () => app.resetAlignment(cur.ordinal), { className: 'spv-small' }),
        button('Reset all', () => app.resetAlignment(), { className: 'spv-small' }),
      ),
      note(
        'Alignment is stored in the share link. Compare neighbouring sections in Single or Tile mode with a small point size.',
      ),
    );
  };

  const renderAll = () => {
    renderAlign();
    renderLayout();
    renderStepper();
    renderList();
    renderImages();
  };
  app.store.on('layout', renderAll);
  app.store.on('images', renderImages);
  app.on((e) => {
    if (e.type === 'dataset' || e.type === 'sections') renderAll();
    if (e.type === 'images') {
      renderImages();
      renderList();
    }
  });
  renderAll();
  return {
    id: 'sections',
    title: 'Sections',
    el: root,
    enabled: () => app.sections.length > 1 || (app.spatial?.zLevels?.length ?? 0) > 1,
  };
}
