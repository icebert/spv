/**
 * GPU picking: render point ids as colours into a 1×1 target at the cursor (via
 * `camera.setViewOffset`) and read one pixel back asynchronously. Never uses Raycaster.
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

export class GpuPicker {
  private readonly target = new WebGLRenderTarget(1, 1, {
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    format: RGBAFormat,
    type: UnsignedByteType,
    depthBuffer: true,
    stencilBuffer: false,
  });
  private readonly pixel = new Uint8Array(4);
  private busy = false;
  private readonly clearColor = new Color();

  constructor(private readonly renderer: WebGLRenderer) {}

  /**
   * @param x,y cursor in CSS pixels relative to the canvas
   * @returns point index or -1
   */
  async pick(
    points: PointCloud,
    camera: Camera,
    x: number,
    y: number,
    cssWidth: number,
    cssHeight: number,
  ): Promise<number> {
    if (this.busy) return -2;
    this.busy = true;
    this.restored = false;
    const r = this.renderer;
    const dpr = r.getPixelRatio();
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
        Math.floor(x * dpr),
        Math.floor(y * dpr),
        1,
        1,
      );
      points.setPicking(true);
      r.setRenderTarget(this.target);
      r.setClearColor(0x000000, 0);
      r.clear();
      r.render(points.object, camera);
      // readRenderTargetPixelsAsync issues the GPU read immediately and only awaits the fence,
      // so all render state can be restored before waiting; a frame drawn meanwhile is unaffected.
      const pending = r.readRenderTargetPixelsAsync(this.target, 0, 0, 1, 1, this.pixel);
      this.restore(points, cam, prevTarget, prevAlpha);
      const buf = await pending;
      const id = buf[0] | (buf[1] << 8) | (buf[2] << 16);
      return id - 1;
    } catch {
      this.restore(points, cam, prevTarget, prevAlpha);
      return -1;
    } finally {
      this.busy = false;
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
