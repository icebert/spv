/**
 * GPU picking: render point ids as colours into a small target around the cursor (via
 * `camera.setViewOffset`) and read it back asynchronously. A mouse picks the exact pixel; a finger
 * gets a radius, and the point nearest to the touch wins. Never uses Raycaster.
 */
import {
  NearestFilter,
  RGBAFormat,
  UnsignedByteType,
  WebGLRenderTarget,
  type Camera,
  Color,
  type WebGLRenderer,
} from 'three';
import type { PointCloud } from './points';

export interface PickOptions {
  /** Search radius in CSS pixels around the cursor; the nearest point wins. 0 = the exact pixel. */
  radius?: number;
  /** When another pick is in flight, wait for it instead of returning -2. */
  wait?: boolean;
}

export class GpuPicker {
  private readonly target = new WebGLRenderTarget(1, 1, {
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    format: RGBAFormat,
    type: UnsignedByteType,
    depthBuffer: true,
    stencilBuffer: false,
  });
  /** Edge of `target` in device pixels; resized when the radius changes. */
  private edge = 1;
  private pixels = new Uint8Array(4);
  private inflight: Promise<number> | null = null;
  private readonly clearColor = new Color();

  constructor(private readonly renderer: WebGLRenderer) {}

  /**
   * @param x,y cursor in CSS pixels relative to the canvas
   * @returns point index, -1 for background, or -2 when a pick is already in flight and
   *   `opts.wait` is not set (hover simply retries on the next move)
   */
  async pick(
    points: PointCloud,
    camera: Camera,
    x: number,
    y: number,
    cssWidth: number,
    cssHeight: number,
    opts: PickOptions = {},
  ): Promise<number> {
    while (this.inflight) {
      if (!opts.wait) return -2;
      await this.inflight;
    }
    const run = this.run(points, camera, x, y, cssWidth, cssHeight, opts.radius ?? 0);
    this.inflight = run;
    try {
      return await run;
    } finally {
      this.inflight = null;
    }
  }

  private async run(
    points: PointCloud,
    camera: Camera,
    x: number,
    y: number,
    cssWidth: number,
    cssHeight: number,
    radius: number,
  ): Promise<number> {
    this.restored = false;
    const r = this.renderer;
    const dpr = r.getPixelRatio();
    const rad = Math.max(0, Math.ceil(radius * dpr));
    const n = 2 * rad + 1;
    if (n !== this.edge) {
      this.target.setSize(n, n);
      this.edge = n;
      this.pixels = new Uint8Array(n * n * 4);
    }
    const cam = camera as Camera & {
      setViewOffset(fw: number, fh: number, x: number, y: number, w: number, h: number): void;
      clearViewOffset(): void;
    };
    const prevTarget = r.getRenderTarget();
    const prevAlpha = r.getClearAlpha();
    r.getClearColor(this.clearColor);
    try {
      cam.setViewOffset(
        Math.floor(cssWidth * dpr),
        Math.floor(cssHeight * dpr),
        Math.floor(x * dpr) - rad,
        Math.floor(y * dpr) - rad,
        n,
        n,
      );
      points.setPicking(true);
      r.setRenderTarget(this.target);
      r.setClearColor(0x000000, 0);
      r.clear();
      r.render(points.object, camera);
      // readRenderTargetPixelsAsync issues the GPU read immediately and only awaits the fence,
      // so all render state can be restored before waiting; a frame drawn meanwhile is unaffected.
      const pending = r.readRenderTargetPixelsAsync(this.target, 0, 0, n, n, this.pixels);
      this.restore(points, cam, prevTarget, prevAlpha);
      const buf = await pending;
      // Nearest drawn point to the centre; the depth test already chose the front-most per pixel.
      // Rows come back bottom-up, which does not matter for a distance from the centre.
      let best = -1;
      let bestDist = Infinity;
      for (let py = 0, p = 0; py < n; py++) {
        for (let px = 0; px < n; px++, p += 4) {
          const id = (buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)) - 1;
          if (id < 0) continue;
          const d = (px - rad) ** 2 + (py - rad) ** 2;
          if (d < bestDist) {
            bestDist = d;
            best = id;
          }
        }
      }
      return best;
    } catch {
      this.restore(points, cam, prevTarget, prevAlpha);
      return -1;
    }
  }

  private restored = false;

  private restore(
    points: PointCloud,
    cam: { clearViewOffset(): void },
    prevTarget: ReturnType<WebGLRenderer['getRenderTarget']>,
    prevAlpha: number,
  ): void {
    if (this.restored) return;
    this.restored = true;
    cam.clearViewOffset();
    points.setPicking(false);
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.setClearColor(this.clearColor, prevAlpha);
  }

  /**
   * Diagnostic: render the points with the id material and return the point id under every pixel
   * (-1 = background). `'offscreen'` draws into a plain render target; `'screen'` draws into the
   * canvas itself (antialiasing, alpha and size exactly as the user sees them), so the two can be
   * compared when the on-screen picture looks wrong. After a `'screen'` census the caller must
   * redraw the real frame.
   */
  censusIds(
    points: PointCloud,
    camera: Camera,
    mode: 'offscreen' | 'screen',
    width = 320,
    height = 200,
  ): { width: number; height: number; ids: Int32Array } {
    const r = this.renderer;
    const gl = r.getContext() as WebGL2RenderingContext;
    const target =
      mode === 'offscreen'
        ? new WebGLRenderTarget(width, height, {
            minFilter: NearestFilter,
            magFilter: NearestFilter,
            format: RGBAFormat,
            type: UnsignedByteType,
            depthBuffer: true,
            stencilBuffer: false,
          })
        : null;
    const prevTarget = r.getRenderTarget();
    const prevAlpha = r.getClearAlpha();
    r.getClearColor(this.clearColor);
    try {
      points.setPicking(true);
      r.setRenderTarget(target);
      r.setClearColor(0x000000, 0);
      r.clear();
      r.render(points.object, camera);
      const w = target ? width : gl.drawingBufferWidth;
      const h = target ? height : gl.drawingBufferHeight;
      const buf = new Uint8Array(w * h * 4);
      // A pending async pick may have left its pixel-pack buffer bound, which would make this
      // readPixels fail; the pick rebinds its own buffer before reading it back.
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      if (target) r.readRenderTargetPixels(target, 0, 0, w, h, buf);
      else gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const ids = new Int32Array(w * h);
      for (let i = 0, p = 0; i < ids.length; i++, p += 4)
        ids[i] = (buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)) - 1;
      return { width: w, height: h, ids };
    } finally {
      points.setPicking(false);
      r.setRenderTarget(prevTarget);
      r.setClearColor(this.clearColor, prevAlpha);
      target?.dispose();
    }
  }

  /** Pixels per point id in an offscreen render of the current view. */
  census(points: PointCloud, camera: Camera, width = 320, height = 200): Map<number, number> {
    const { ids } = this.censusIds(points, camera, 'offscreen', width, height);
    const counts = new Map<number, number>();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (id >= 0) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }

  dispose(): void {
    this.target.dispose();
  }
}
