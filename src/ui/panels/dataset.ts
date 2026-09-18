import type { App } from '../../app';
import { button, clear, el, fmtBytes, fmtInt, group, kv, note, select, textInput } from '../dom';
import type { Panel } from '../sidebar';

export function datasetPanel(app: App): Panel {
  const root = el('div');
  const manifestBox = el('div');
  const desc = el('p', 'spv-note');
  const progressWrap = el('div', { style: 'display:none' });
  const progressLabel = el('div', { style: 'font-size:12px;color:var(--spv-muted)' });
  const progressBar = el('div', 'spv-progress', el('div'));
  const cancel = button('Cancel', () => app.cancelLoad(), { className: 'spv-small' });
  progressWrap.append(progressLabel, progressBar, el('div', 'spv-row', cancel));
  const summaryBox = el('div');
  const errorBox = el('div');

  const urlInput = textInput('https://…/dataset.h5ad', (v) => v && void app.openUrl(v));
  // The native file control is replaced by a label styled as a button; the input stays in the
  // DOM (visually hidden, still focusable) so the picker, keyboard and tests keep working.
  const fileInput = el('input', {
    type: 'file',
    accept: '.h5ad,.h5',
    className: 'spv-visually-hidden',
  });
  const fileName = el('span', 'spv-file-name');
  const filePick = el('label', 'spv-btn spv-file', 'Choose a file…', fileInput);
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    fileName.textContent = f ? `${f.name} (${fmtBytes(f.size)})` : '';
    if (f) void app.openFile(f);
  });

  root.append(
    group('Hosted datasets', manifestBox, desc),
    group(
      'Open URL',
      el(
        'div',
        'spv-row',
        urlInput,
        button('Open', () => urlInput.value.trim() && void app.openUrl(urlInput.value.trim()), {
          className: 'spv-primary',
        }),
      ),
      note(
        'The host must allow cross-origin requests (CORS). Servers with HTTP range support are read on demand; others are downloaded fully.',
      ),
    ),
    group(
      'Open local file',
      el('div', 'spv-row', filePick, fileName),
      note(
        'Or drop a .h5ad anywhere on the page. Files are read in your browser only and never uploaded.',
      ),
    ),
    progressWrap,
    errorBox,
    summaryBox,
  );

  const renderManifest = () => {
    clear(manifestBox);
    if (app.manifest.length === 0) {
      manifestBox.appendChild(note('No manifest entries (data/datasets.json).'));
      return;
    }
    const cur = app.store.slice('dataset');
    const options = [
      { value: '', label: 'Choose a dataset…' },
      ...app.manifest.map((d) => ({
        value: d.id,
        label: `${d.name}${d.size_bytes ? ` (${fmtBytes(d.size_bytes)})` : ''}`,
      })),
    ];
    const sel = select(options, cur.id ?? '', (v) => v && void app.openFromManifest(v), {
      className: 'spv-input',
    });
    manifestBox.appendChild(sel);
    const entry = app.manifest.find((d) => d.id === cur.id);
    desc.textContent = entry?.description ?? '';
    desc.style.display = entry?.description ? 'block' : 'none';
  };

  const renderSummary = () => {
    clear(summaryBox);
    clear(errorBox);
    if (app.status === 'error' && app.errorMessage)
      errorBox.appendChild(note(app.errorMessage, 'warn'));
    const s = app.summary;
    if (!s) return;
    const sp = app.spatial;
    const x = s.X;
    summaryBox.appendChild(
      group(
        'Summary',
        kv([
          ['cells × genes', `${fmtInt(s.nObs)} × ${fmtInt(s.nVars)}`],
          [
            'X',
            x
              ? `${x.format.toUpperCase()} ${x.dtype}${x.nnz !== null ? `, nnz ${fmtInt(x.nnz)}` : ''}`
              : 'missing',
          ],
          ['layers', Object.keys(s.layers).join(', ') || '—'],
          ['raw', s.raw ? `yes (${s.raw.nVars ?? '?'} genes)` : 'no'],
          [
            'coordinates',
            s.spatial.key
              ? `${s.spatial.key} (${s.spatial.ndim}-D${s.spatial.zSource ? `, z from ${s.spatial.zSource}` : ''})`
              : 'not detected',
          ],
          [
            'sections',
            sp && sp.sections.length ? `${sp.sections.length} from ${s.library.key}` : 'none',
          ],
          [
            'images',
            s.uns.spatial
              ? `${s.uns.spatial.filter((l) => l.images.length).length} of ${s.uns.spatial.length} libraries`
              : 'none',
          ],
          [
            'loaded via',
            app.loadInfo
              ? `${app.loadInfo.loadMode}${app.loadInfo.bytesTotal ? `, ${fmtBytes(app.loadInfo.bytesTotal)}` : ''}`
              : '—',
          ],
        ]),
        s.flags.length
          ? el(
              'details',
              null,
              el(
                'summary',
                { style: 'cursor:pointer;color:var(--spv-muted)' },
                `${s.flags.length} notes about this file`,
              ),
              el(
                'ul',
                { style: 'padding-left:16px;font-size:12px' },
                ...s.flags.map((f) => el('li', null, f)),
              ),
            )
          : null,
      ),
    );
  };

  app.on((e) => {
    if (e.type === 'progress') {
      const p = e.progress;
      progressWrap.style.display = p ? 'block' : 'none';
      if (p) {
        const pct = p.total ? Math.round((100 * p.done) / p.total) : 0;
        progressLabel.textContent = progressText(p);
        (progressBar.firstElementChild as HTMLElement).style.width = `${pct}%`;
      }
    }
    if (e.type === 'dataset' || e.type === 'status') {
      renderManifest();
      renderSummary();
      cancel.disabled = app.status !== 'loading';
    }
  });
  app.store.on('dataset', renderManifest);
  renderManifest();
  return { id: 'dataset', title: 'Dataset', el: root };
}

/** "Reading coordinates, 40%, 9.6 MB" — one line for the panel and the viewport notice. */
export function progressText(p: {
  stage: string;
  done: number;
  total?: number | null;
  message?: string | null;
}): string {
  const pct = p.total ? `${Math.round((100 * p.done) / p.total)}%` : '';
  return [stageLabel(p.stage), pct, p.message ?? ''].filter(Boolean).join(', ');
}

export function stageLabel(stage: string): string {
  return (
    {
      engine: 'Starting HDF5 engine',
      download: 'Downloading',
      open: 'Opening',
      coordinates: 'Reading coordinates',
      index: 'Indexing expression matrix',
      gene: 'Reading gene',
      image: 'Loading image',
      graph: 'Reading graph',
    }[stage] ?? stage
  );
}
