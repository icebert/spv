/**
 * Lasso / box selection: a 2-D overlay canvas for drawing the shape while `app.selectMode` is on,
 * and a floating bar with the count and CSV/TSV export.
 */
import type { App } from '../app';
import { button, el, fmtInt } from './dom';
import { toast } from './toast';

export function createSelection(app: App, viewport: HTMLElement, canvas: HTMLCanvasElement): void {
  const overlay = el('canvas', {
    className: 'spv-select-overlay',
    style: 'position:absolute;inset:0;pointer-events:none;display:none',
  });
  viewport.appendChild(overlay);
  const bar = el('div', { className: 'spv-selection-bar', style: 'display:none' });
  viewport.appendChild(bar);
  const ctx = overlay.getContext('2d')!;
  let path: [number, number][] = [];
  let box = false;
  let drawing = false;

  const resize = () => {
    const r = viewport.getBoundingClientRect();
    overlay.width = Math.floor(r.width * devicePixelRatio);
    overlay.height = Math.floor(r.height * devicePixelRatio);
    overlay.style.width = `${r.width}px`;
    overlay.style.height = `${r.height}px`;
  };
  const draw = () => {
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (path.length < 2) return;
    ctx.strokeStyle = '#66c2a5';
    ctx.fillStyle = 'rgba(102,194,165,0.12)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    if (box) {
      const [x0, y0] = path[0];
      const [x1, y1] = path[path.length - 1];
      ctx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    } else {
      ctx.moveTo(path[0][0], path[0][1]);
      for (const [x, y] of path) ctx.lineTo(x, y);
      ctx.closePath();
    }
    ctx.fill();
    ctx.stroke();
  };
  const local = (e: PointerEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (!app.selectMode || e.button !== 0) return;
    resize();
    overlay.style.display = 'block';
    drawing = true;
    box = e.shiftKey;
    path = [local(e)];
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = local(e);
    if (box) path = [path[0], p];
    else path.push(p);
    draw();
  });
  const finish = (e: PointerEvent) => {
    if (!drawing) return;
    drawing = false;
    overlay.style.display = 'none';
    const p = local(e);
    if (box) {
      const [x0, y0] = path[0];
      app.selectByPolygon([
        [x0, y0],
        [p[0], y0],
        [p[0], p[1]],
        [x0, p[1]],
      ]);
    } else if (path.length >= 3) app.selectByPolygon(path);
    path = [];
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  const render = () => {
    const n = app.selectionCount;
    bar.replaceChildren();
    if (!n && !app.selectMode) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'flex';
    bar.append(
      el(
        'span',
        null,
        app.selectMode && !n
          ? 'Select mode: drag a lasso (Shift-drag for a box)'
          : `${fmtInt(n)} cell${n === 1 ? '' : 's'} selected`,
      ),
      ...(n
        ? [
            button(
              'CSV',
              () =>
                void app.exportSelection('csv').catch((err: Error) => toast(err.message, 'error')),
              { className: 'spv-small', title: 'Download selected cell ids as CSV' },
            ),
            button(
              'TSV',
              () =>
                void app.exportSelection('tsv').catch((err: Error) => toast(err.message, 'error')),
              { className: 'spv-small' },
            ),
            button('Clear', () => app.clearSelection(), { className: 'spv-small' }),
          ]
        : []),
    );
  };
  app.on((e) => {
    if (e.type === 'selection' || e.type === 'dataset') render();
  });
  render();
}
