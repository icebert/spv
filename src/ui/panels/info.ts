import type { App } from '../../app';
import { checkbox, clear, el, fmtBytes, fmtInt, group, kv, note } from '../dom';
import type { Panel } from '../sidebar';

export function infoPanel(app: App): Panel {
  const root = el('div');
  const render = () => {
    clear(root);
    const s = app.summary;
    if (!s) {
      root.appendChild(note('Open a dataset first.'));
      return;
    }
    const sp = app.spatial;
    const fields = app.store.slice('ui').tooltipFields;
    const cols = s.obs.columns.filter((c) => c.kind !== 'unsupported');
    const lib = s.library.column;
    root.appendChild(
      group(
        'Tooltip fields (up to 6)',
        el(
          'div',
          { style: 'max-height:180px;overflow:auto' },
          ...cols.map((c) =>
            checkbox(
              c.name === lib ? `${c.name} (shown as the section row)` : c.name,
              fields.includes(c.name),
              (v) => {
                const next = v ? [...fields, c.name].slice(-6) : fields.filter((f) => f !== c.name);
                app.store.update('ui', { tooltipFields: next });
              },
            ),
          ),
        ),
      ),
    );
    root.appendChild(
      group(
        'File',
        kv([
          ['encoding', `${s.encodingType ?? 'legacy'} ${s.encodingVersion ?? ''}`],
          ['cells × genes', `${fmtInt(s.nObs)} × ${fmtInt(s.nVars)}`],
          [
            'X',
            s.X
              ? `${s.X.format.toUpperCase()} ${s.X.dtype}${s.X.nnz !== null ? `, nnz ${fmtInt(s.X.nnz)}` : ''}${s.X.chunks ? `, chunks ${JSON.stringify(s.X.chunks)}` : ''}`
              : 'missing',
          ],
          [
            'layers',
            Object.entries(s.layers)
              .map(([k, m]) => `${k} (${m.format} ${m.dtype})`)
              .join(', ') || '—',
          ],
          [
            'raw',
            s.raw?.X
              ? `${s.raw.X.format} ${s.raw.X.dtype}, ${s.raw.nVars} genes${s.raw.varNamesDiffer ? ' (different var)' : ''}`
              : 'absent',
          ],
          [
            'obsm',
            Object.values(s.obsm)
              .map((o) => `${o.key} ${o.shape ? `(${o.shape.join('×')})` : o.kind}`)
              .join(', ') || '—',
          ],
          [
            'obsp',
            Object.entries(s.obsp)
              .map(([k, m]) => `${k}${m ? ` (${m.format}, nnz ${fmtInt(m.nnz ?? 0)})` : ''}`)
              .join(', ') || '—',
          ],
          ['varm / varp', `${s.varm.join(', ') || '—'} / ${s.varp.join(', ') || '—'}`],
          ['uns keys', s.uns.keys.join(', ') || '— (empty)'],
          [
            'Squidpy results',
            [
              s.uns.moranI ? `moranI (${s.uns.moranI.n} genes)` : null,
              s.uns.spatialNeighbors
                ? `spatial_neighbors ${JSON.stringify(s.uns.spatialNeighbors)}`
                : null,
              ...s.uns.squidpyResults,
            ]
              .filter(Boolean)
              .join('; ') || '—',
          ],
          ['gene-name columns', s.geneNameColumns.join(', ') || '— (var index only)'],
          ['filters', s.filtersUsed.map((f) => f.name.split(';')[0]).join(', ') || 'none'],
        ]),
      ),
    );
    root.appendChild(
      group(
        'obs columns',
        el(
          'div',
          { style: 'max-height:220px;overflow:auto;font-size:12px' },
          el(
            'table',
            { style: 'border-collapse:collapse;width:100%' },
            ...s.obs.columns.map((c) =>
              el(
                'tr',
                null,
                el('td', { style: 'padding:1px 6px 1px 0' }, c.name),
                el(
                  'td',
                  { style: 'color:var(--spv-muted)' },
                  c.kind === 'categorical'
                    ? `categorical (${c.nCategories})`
                    : c.kind === 'unsupported'
                      ? `unsupported: ${c.reason ?? c.encoding}`
                      : `${c.kind}${c.dtype ? ` ${c.dtype}` : ''}${c.nullable ? ', nullable' : ''}`,
                ),
              ),
            ),
          ),
        ),
      ),
    );
    if (sp) {
      const ext = (i: number) => `${sp.rawMin[i].toFixed(4)} … ${sp.rawMax[i].toFixed(4)}`;
      root.appendChild(
        group(
          'Coordinates',
          kv([
            ['source', `${s.spatial.key ?? 'custom'} (${sp.ndim}-D)`],
            ['x', ext(0)],
            ['y', ext(1)],
            ['z', sp.ndim === 3 ? ext(2) : 'flat'],
            ['dropped (NaN/inf)', fmtInt(sp.nDropped)],
            ['centre', sp.center.map((v) => v.toFixed(3)).join(', ')],
            ['unit scale', sp.scale.toExponential(3)],
          ]),
        ),
      );
      if (sp.sections.length) {
        root.appendChild(
          group(
            `Sections (${sp.sections.length}, ordered by ${sp.orderSource === 'uns_spatial' ? 'uns/spatial' : 'natural sort'})`,
            el(
              'div',
              { style: 'max-height:220px;overflow:auto;font-size:12px' },
              el(
                'table',
                { style: 'border-collapse:collapse;width:100%' },
                el(
                  'tr',
                  { style: 'color:var(--spv-muted)' },
                  el('td', null, 'name'),
                  el('td', null, 'cells'),
                  el('td', null, 'z'),
                  el('td', null, 'image'),
                  el('td', null, 'spot ⌀'),
                ),
                ...sp.sections.map((x) =>
                  el(
                    'tr',
                    null,
                    el('td', null, x.name),
                    el('td', null, fmtInt(x.nCells)),
                    el('td', null, x.z === null ? '—' : String(x.z)),
                    el(
                      'td',
                      null,
                      x.hasImage
                        ? `${x.imageKeys.join('/')}${x.placementKnown ? '' : ' (no scalef)'}`
                        : '—',
                    ),
                    el('td', null, x.spotDiameter === null ? '—' : String(x.spotDiameter)),
                  ),
                ),
              ),
            ),
          ),
        );
      }
    }
    if (s.uns.spatial?.length) {
      root.appendChild(
        group(
          'uns/spatial',
          el(
            'div',
            { style: 'max-height:200px;overflow:auto;font-size:12px' },
            ...s.uns.spatial.slice(0, 200).map((l) =>
              el(
                'div',
                null,
                el('b', null, l.id),
                `: images ${l.images.map((im) => `${im.key} ${im.width}×${im.height}×${im.channels} ${im.dtype}`).join(', ') || 'none'}; scalefactors: ${
                  Object.entries(l.scalefactors)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(', ') || 'none'
                }${l.extraKeys.length ? `; other: ${l.extraKeys.join(', ')}` : ''}`,
              ),
            ),
            s.uns.spatial.length > 200 ? note(`… ${s.uns.spatial.length - 200} more`) : null,
          ),
        ),
      );
    }
    const li = app.loadInfo;
    const vi = app.viewer.info();
    root.appendChild(
      group(
        'Session',
        kv([
          ['load mode', li ? li.loadMode : '—'],
          ['file size', li?.bytesTotal ? fmtBytes(li.bytesTotal) : '—'],
          [
            'open timings',
            li
              ? `engine ${li.timings.engineMs?.toFixed(0)} ms, load ${li.timings.loadMs?.toFixed(0)} ms, summary ${li.timings.summaryMs?.toFixed(0)} ms`
              : '—',
          ],
          ['plugins', li?.plugins.length ? li.plugins.join(', ') : 'none'],
          [
            'GPU',
            `${vi.geometries} geometries, ${vi.textures} textures, ${vi.programs} programs, ${vi.frames} frames`,
          ],
          ['image textures', app.planes ? fmtBytes(app.planes.totalBytes()) : '—'],
        ]),
      ),
    );
    if (s.flags.length)
      root.appendChild(
        group(
          'Notes',
          el(
            'ul',
            { style: 'padding-left:16px;font-size:12px;margin:0' },
            ...s.flags.map((f) => el('li', null, f)),
          ),
        ),
      );
  };
  app.on((e) => {
    if (e.type === 'dataset' || e.type === 'images') render();
  });
  app.store.on('ui', (v, prev) => v.tooltipFields !== prev.tooltipFields && render());
  render();
  return { id: 'info', title: 'Info', el: root };
}
