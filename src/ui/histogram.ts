/** Histogram of the current continuous variable with draggable min/max range handles. */
import type { App } from '../app';
import { el } from './dom';

export function histogramWidget(app: App): HTMLElement {
  const W = 288;
  const H = 64;
  const canvas = el('canvas', {
    width: W * 2,
    height: H * 2,
    style: `width:${W}px;height:${H}px;display:block;cursor:ew-resize;border-radius:4px;background:var(--spv-panel-2)`,
  });
  const label = el('div', { style: 'font-size:11px;color:var(--spv-muted);margin-top:2px' });
  const root = el('div', { style: 'margin:6px 0' }, canvas, label);
  const ctx = canvas.getContext('2d')!;
  let drag: 'lo' | 'hi' | null = null;

  const xOf = (v: number) => {
    const h = app.histogram!;
    return ((v - h.lo) / (h.hi - h.lo || 1)) * W;
  };
  const vOf = (x: number) => {
    const h = app.histogram!;
    return h.lo + (Math.min(W, Math.max(0, x)) / W) * (h.hi - h.lo);
  };

  const draw = () => {
    const h = app.histogram;
    const cb = app.colorbar;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!h || !cb) {
      root.style.display = 'none';
      return;
    }
    root.style.display = 'block';
    const n = h.bins.length;
    const bw = W / n;
    const dark = app.viewer.isDark;
    ctx.fillStyle = dark ? '#6b7280' : '#9ca3af';
    for (let i = 0; i < n; i++) {
      const v = Math.sqrt(h.bins[i] / (h.max || 1)) * (H - 8);
      ctx.fillRect(i * bw + 0.5, H - v, Math.max(1, bw - 1), v);
    }
    const lo = xOf(cb.vmin);
    const hi = xOf(cb.vmax);
    ctx.fillStyle = dark ? 'rgba(102,194,165,0.18)' : 'rgba(17,119,51,0.15)';
    ctx.fillRect(lo, 0, Math.max(0, hi - lo), H);
    ctx.strokeStyle = '#66c2a5';
    ctx.lineWidth = 2;
    for (const x of [lo, hi]) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    label.textContent = `histogram of ${cb.label} (sqrt scale, 64 bins) — drag the handles to set an explicit range`;
  };

  canvas.addEventListener('pointerdown', (e) => {
    const cb = app.colorbar;
    if (!cb || !app.histogram) return;
    const x = e.offsetX;
    drag = Math.abs(x - xOf(cb.vmin)) <= Math.abs(x - xOf(cb.vmax)) ? 'lo' : 'hi';
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || !app.colorbar) return;
    const v = vOf(e.offsetX);
    const cb = app.colorbar;
    const vmin = drag === 'lo' ? Math.min(v, cb.vmax) : cb.vmin;
    const vmax = drag === 'hi' ? Math.max(v, cb.vmin) : cb.vmax;
    app.store.update('color', { rangeMode: 'absolute', vmin, vmax });
  });
  const end = () => (drag = null);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  app.on((e) => {
    if (e.type === 'colorbar' || e.type === 'dataset') draw();
  });
  draw();
  return root;
}
