import type { App } from '../../app';
import type { ColumnRef } from '../../h5ad/types';
import { checkbox, clear, el, group, kv, note, select, slider } from '../dom';
import type { Panel } from '../sidebar';

function refKey(r: ColumnRef | null): string {
  return r ? (r.column === null ? r.path : `${r.path}:${r.column}`) : '';
}

function parseRef(v: string): ColumnRef | null {
  if (!v) return null;
  const m = /^(.*):(\d+)$/.exec(v);
  return m ? { path: m[1], column: Number(m[2]) } : { path: v, column: null };
}

export function coordinatesPanel(app: App): Panel {
  const root = el('div');
  const render = () => {
    clear(root);
    const s = app.summary;
    const c = app.store.slice('coords');
    if (!s) {
      root.appendChild(note('Open a dataset first.'));
      return;
    }
    const opts: { value: string; label: string }[] = [];
    for (const o of Object.values(s.obsm)) {
      if (o.kind === 'array' && o.shape && o.shape.length === 2 && o.shape[1] <= 16) {
        for (let k = 0; k < o.shape[1]; k++)
          opts.push({ value: `${o.path}:${k}`, label: `${o.path}[${k}]` });
      }
    }
    for (const col of s.obs.columns)
      if (col.kind === 'numeric') opts.push({ value: col.path, label: col.path });
    const refs = s.spatial.refs;
    const axis = (
      label: string,
      cur: ColumnRef | null,
      def: ColumnRef | null,
      onChange: (r: ColumnRef | null) => void,
      allowNone: boolean,
    ) => {
      const options = [
        ...(allowNone ? [{ value: '', label: def ? `none (flat)` : 'none' }] : []),
        ...opts,
      ];
      const value = refKey(cur ?? def);
      if (value && !options.some((o) => o.value === value)) options.push({ value, label: value });
      return el(
        'div',
        'spv-row',
        el('span', 'spv-slider-label', label),
        select(options, value, (v) => onChange(parseRef(v)), { className: 'spv-input' }),
      );
    };
    root.appendChild(
      group(
        'Sources',
        kv([
          [
            'detected',
            s.spatial.key
              ? `${s.spatial.key} (${s.spatial.method}${s.spatial.zSource ? `, z: ${s.spatial.zSource}` : ''})`
              : 'nothing — choose X and Y below',
          ],
          [
            'library column',
            s.library.key ? `${s.library.key} (${s.library.method.replace(/_/g, ' ')})` : 'none',
          ],
        ]),
        axis('X', c.x, refs?.x ?? null, (r) => r && app.store.update('coords', { x: r }), false),
        axis('Y', c.y, refs?.y ?? null, (r) => r && app.store.update('coords', { y: r }), false),
        axis(
          'Z',
          c.zNone ? null : c.z,
          c.zNone ? null : (refs?.z ?? null),
          (r) => app.store.update('coords', { z: r, zNone: r === null }),
          true,
        ),
      ),
    );
    const libCols = s.obs.columns.filter(
      (col) => col.kind === 'categorical' || col.kind === 'string' || col.kind === 'boolean',
    );
    const libValue = c.libraryNone ? '' : (c.libraryKey ?? s.library.key ?? '');
    root.appendChild(
      group(
        'Sections',
        el(
          'div',
          'spv-row',
          el('span', 'spv-slider-label', 'Library column'),
          select(
            [
              { value: '', label: 'none (single section)' },
              ...libCols.map((col) => ({
                value: col.path,
                label: `${col.path}${col.nCategories ? ` (${col.nCategories})` : ''}`,
              })),
            ],
            libValue,
            (v) => app.store.update('coords', { libraryKey: v || null, libraryNone: !v }),
            { className: 'spv-input' },
          ),
        ),
      ),
    );
    root.appendChild(
      group(
        'Frame',
        el(
          'div',
          'spv-row',
          checkbox('Flip X', c.flipX, (v) => app.store.update('coords', { flipX: v })),
          checkbox(
            'Flip Y',
            c.flipY,
            (v) => app.store.update('coords', { flipY: v }),
            'Image-space coordinates (Visium) have y pointing down; on by default when tissue images exist',
          ),
          checkbox('Flip Z', c.flipZ, (v) => app.store.update('coords', { flipZ: v })),
          checkbox('Swap Y/Z', c.swapYZ, (v) => app.store.update('coords', { swapYZ: v })),
        ),
        slider({
          label: 'Z scale',
          min: 0.05,
          max: 20,
          step: 0.05,
          value: c.zScale,
          format: (v) => `${v.toFixed(2)}×`,
          onInput: (v) => app.store.update('coords', { zScale: v }),
          title: 'z is often stored in a different unit than x/y',
        }).el,
      ),
    );
    const sp = app.spatial;
    if (sp) {
      const ext = (i: number) =>
        `${sp.rawMin[i].toFixed(3)} … ${sp.rawMax[i].toFixed(3)} (range ${(sp.rawMax[i] - sp.rawMin[i]).toFixed(3)})`;
      root.appendChild(
        group(
          'Raw extent (file units)',
          kv([
            ['x', ext(0)],
            ['y', ext(1)],
            ['z', sp.ndim === 3 ? ext(2) : 'flat (2-D)'],
            ['distinct z', sp.zLevels ? String(sp.zLevels.length) : 'continuous'],
          ]),
        ),
      );
      root.appendChild(
        note(
          'Units are not standardised across platforms (Visium: full-resolution pixels; Xenium/Vizgen: microns; CosMx: global pixels). The viewer never assumes equal X/Y/Z units.',
        ),
      );
    }
  };
  app.on((e) => {
    if (e.type === 'dataset') render();
  });
  app.store.on('coords', render);
  render();
  return { id: 'coordinates', title: 'Coordinates', el: root };
}
