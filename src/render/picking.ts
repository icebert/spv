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
    const prevMaterial = points.object.material;
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
      points.object.material = points.pickMaterial;
      r.setRenderTarget(this.target);
      r.setClearColor(0x000000, 0);
      r.clear();
      r.render(points.object, camera);
      // readRenderTargetPixelsAsync issues the GPU read immediately and only awaits the fence,
      // so all render state can be restored before waiting; a frame drawn meanwhile is unaffected.
      const pending = r.readRenderTargetPixelsAsync(this.target, 0, 0, 1, 1, this.pixel);
      this.restore(points, cam, prevMaterial, prevTarget, prevAlpha);
      const buf = await pending;
      const id = buf[0] | (buf[1] << 8) | (buf[2] << 16);
      return id - 1;
    } catch {
      this.restore(points, cam, prevMaterial, prevTarget, prevAlpha);
      return -1;
    } finally {
      this.busy = false;
    }
  }

  private restored = false;

  private restore(
    points: PointCloud,
    cam: { clearViewOffset(): void },
    prevMaterial: PointCloud['object']['material'],
    prevTarget: ReturnType<WebGLRenderer['getRenderTarget']>,
    prevAlpha: number,
  ): void {
    if (this.restored) return;
    this.restored = true;
    cam.clearViewOffset();
    points.object.material = prevMaterial;
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.setClearColor(this.clearColor, prevAlpha);
  }

  /**
   * Diagnostic: render the points with the id material into an offscreen buffer and return how
   * many pixels each point id covered, so we can tell which sections the GPU actually drew.
   */
  census(points: PointCloud, camera: Camera, width = 320, height = 200): Map<number, number> {
    const r = this.renderer;
    const target = new WebGLRenderTarget(width, height, {
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      format: RGBAFormat,
      type: UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
    });
    const prevMaterial = points.object.material;
    const prevTarget = r.getRenderTarget();
    const prevAlpha = r.getClearAlpha();
    r.getClearColor(this.clearColor);
    const counts = new Map<number, number>();
    try {
      points.object.material = points.pickMaterial;
      r.setRenderTarget(target);
      r.setClearColor(0x000000, 0);
      r.clear();
      r.render(points.object, camera);
      const buf = new Uint8Array(width * height * 4);
      r.readRenderTargetPixels(target, 0, 0, width, height, buf);
      for (let i = 0; i < buf.length; i += 4) {
        const id = (buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16)) - 1;
        if (id >= 0) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    } finally {
      points.object.material = prevMaterial;
      r.setRenderTarget(prevTarget);
      r.setClearColor(this.clearColor, prevAlpha);
      target.dispose();
    }
    return counts;
  }

  dispose(): void {
    this.target.dispose();
  }
}
