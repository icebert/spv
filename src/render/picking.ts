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
      const buf = await r.readRenderTargetPixelsAsync(this.target, 0, 0, 1, 1, this.pixel);
      const id = buf[0] | (buf[1] << 8) | (buf[2] << 16);
      return id - 1;
    } finally {
      cam.clearViewOffset();
      points.object.material = prevMaterial;
      r.setRenderTarget(prevTarget);
      r.setClearColor(this.clearColor, prevAlpha);
      this.busy = false;
    }
  }

  dispose(): void {
    this.target.dispose();
  }
}
