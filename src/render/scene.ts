/**
 * The viewer: renderer, scene, camera rig, helpers, render-on-demand loop, picking, screenshots,
 * resize / context-loss handling and disposal with `renderer.info` bookkeeping.
 */
import {
  AxesHelper,
  Box3,
  Box3Helper,
  Color,
  GridHelper,
  PerspectiveCamera,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { CameraRig, type ViewPreset } from './camera';
import { GpuPicker } from './picking';
import type { PointCloud } from './points';
import type { Bounds } from './sections';

export interface ViewerInfo {
  geometries: number;
  textures: number;
  programs: number;
  calls: number;
  points: number;
  frames: number;
}

export interface ScreenshotOptions {
  scale?: 1 | 2;
  transparent?: boolean;
}

export class Viewer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly rig: CameraRig;
  readonly picker: GpuPicker;
  readonly container: HTMLElement;
  pointCloud: PointCloud | null = null;
  private readonly axesScene = new Scene();
  private readonly axesCamera = new PerspectiveCamera(40, 1, 0.1, 10);
  private readonly axes = new AxesHelper(1);
  private bboxHelper: Box3Helper | null = null;
  private grid: GridHelper | null = null;
  private showAxes = true;
  private showBBox = false;
  private showGrid = false;
  private dark = true;
  private needsRender = true;
  private raf = 0;
  private frames = 0;
  private readonly size = new Vector2(1, 1);
  private readonly resizeObserver: ResizeObserver;
  private lastBounds: Bounds = { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] };
  onContextLost: (() => void) | null = null;
  onContextRestored: (() => void) | null = null;
  onBeforeRender: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.autoClear = true;
    const canvas = this.renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.setAttribute('aria-label', 'SPV 3D view');
    container.appendChild(canvas);
    this.rig = new CameraRig(canvas);
    this.rig.controls.addEventListener('change', () => this.requestRender());
    this.picker = new GpuPicker(this.renderer);
    this.axesScene.add(this.axes);
    this.axesCamera.position.set(0, 0, 3);
    this.setBackground(true);
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.onContextLost?.();
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.onContextRestored?.();
      this.requestRender();
    });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  get isDark(): boolean {
    return this.dark;
  }

  setBackground(dark: boolean, hex?: string): void {
    this.dark = dark;
    this.renderer.setClearColor(new Color(hex ?? (dark ? '#0f1115' : '#f5f6f8')), 1);
    const line = dark ? 0x6b7280 : 0x9ca3af;
    if (this.bboxHelper) (this.bboxHelper.material as unknown as { color: Color }).color.set(line);
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.dispose();
      this.grid = null;
      if (this.showGrid) this.updateGrid();
    }
    this.requestRender();
  }

  setPointCloud(pc: PointCloud | null): void {
    if (this.pointCloud) {
      this.scene.remove(this.pointCloud.object);
      this.pointCloud.dispose();
    }
    this.pointCloud = pc;
    if (pc) {
      this.scene.add(pc.object);
      pc.setViewport(this.size.y * this.renderer.getPixelRatio(), this.renderer.getPixelRatio());
    }
    this.requestRender();
  }

  /** Frame content and refresh helpers for the current layout bounds. */
  setBounds(bounds: Bounds, fit: boolean, preset: ViewPreset = 'iso', planar = false): void {
    this.lastBounds = bounds;
    if (fit) this.rig.fit(bounds, preset, planar);
    this.updateBBox();
    this.updateGrid();
    this.requestRender();
  }

  get bounds(): Bounds {
    return this.lastBounds;
  }

  setHelpers(opts: { axes?: boolean; bbox?: boolean; grid?: boolean }): void {
    if (opts.axes !== undefined) this.showAxes = opts.axes;
    if (opts.bbox !== undefined) this.showBBox = opts.bbox;
    if (opts.grid !== undefined) this.showGrid = opts.grid;
    this.updateBBox();
    this.updateGrid();
    this.requestRender();
  }

  private updateBBox(): void {
    if (this.bboxHelper) {
      this.scene.remove(this.bboxHelper);
      this.bboxHelper.dispose();
      this.bboxHelper = null;
    }
    if (!this.showBBox) return;
    const b = this.lastBounds;
    const box = new Box3(new Vector3(...b.min), new Vector3(...b.max));
    this.bboxHelper = new Box3Helper(box, this.dark ? 0x6b7280 : 0x9ca3af);
    this.scene.add(this.bboxHelper);
  }

  private updateGrid(): void {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.dispose();
      this.grid = null;
    }
    if (!this.showGrid) return;
    const b = this.lastBounds;
    const size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) * 1.2;
    this.grid = new GridHelper(
      size,
      10,
      this.dark ? 0x4b5563 : 0xb0b5bd,
      this.dark ? 0x2a2f3a : 0xd6d9de,
    );
    this.grid.rotation.x = Math.PI / 2; // GridHelper lies in XZ; sections live in XY
    this.grid.position.set(
      (b.min[0] + b.max[0]) / 2,
      (b.min[1] + b.max[1]) / 2,
      b.min[2] - size * 0.01,
    );
    this.scene.add(this.grid);
  }

  resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    if (w === this.size.x && h === this.size.y) return;
    this.size.set(w, h);
    this.renderer.setSize(w, h, false);
    this.rig.setAspect(w / h);
    this.pointCloud?.setViewport(h * this.renderer.getPixelRatio(), this.renderer.getPixelRatio());
    this.requestRender();
  }

  getSize(): { width: number; height: number } {
    return { width: this.size.x, height: this.size.y };
  }

  requestRender(): void {
    this.needsRender = true;
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private readonly frame = (): void => {
    this.raf = 0;
    const moved = this.rig.update();
    if (this.needsRender || moved) {
      this.needsRender = false;
      this.render();
    }
    // Exactly one pending frame: the controls' `change` event may already have re-armed the loop
    // via requestRender() during rig.update(); scheduling again here would double the callbacks
    // every frame while damping settles.
    if ((moved || this.rig.autoRotate) && !this.raf) this.raf = requestAnimationFrame(this.frame);
  };

  render(): void {
    this.onBeforeRender?.();
    const r = this.renderer;
    r.setViewport(0, 0, this.size.x, this.size.y);
    r.setScissorTest(false);
    r.render(this.scene, this.rig.camera);
    if (this.showAxes) {
      const s = Math.min(110, Math.floor(Math.min(this.size.x, this.size.y) * 0.22));
      this.axesCamera.quaternion.copy(this.rig.camera.quaternion);
      this.axesCamera.position
        .set(0, 0, 0)
        .add(new Vector3(0, 0, 3).applyQuaternion(this.rig.camera.quaternion));
      this.axesCamera.lookAt(0, 0, 0);
      this.axesCamera.up.copy(this.rig.camera.up);
      try {
        r.autoClear = false;
        r.clearDepth();
        r.setViewport(8, 8, s, s);
        r.setScissor(8, 8, s, s);
        r.setScissorTest(true);
        r.render(this.axesScene, this.axesCamera);
      } finally {
        r.setScissorTest(false);
        r.setViewport(0, 0, this.size.x, this.size.y);
        r.autoClear = true;
      }
    }
    this.frames++;
  }

  /** Point index under the cursor (CSS px relative to the canvas), or -1. */
  pick(x: number, y: number): Promise<number> {
    if (!this.pointCloud) return Promise.resolve(-1);
    return this.picker.pick(this.pointCloud, this.rig.camera, x, y, this.size.x, this.size.y);
  }

  async screenshot(opts: ScreenshotOptions = {}): Promise<Blob> {
    const scale = opts.scale ?? 1;
    const r = this.renderer;
    const pr = r.getPixelRatio();
    const prevColor = r.getClearColor(new Color());
    const prevAlpha = r.getClearAlpha();
    const prevAxes = this.showAxes;
    try {
      r.setPixelRatio(pr * scale);
      r.setSize(this.size.x, this.size.y, false);
      this.pointCloud?.setViewport(this.size.y * pr * scale, pr * scale);
      if (opts.transparent) r.setClearColor(0x000000, 0);
      this.render();
      const blob = await new Promise<Blob | null>((resolve) =>
        r.domElement.toBlob(resolve, 'image/png'),
      );
      if (!blob) throw new Error('Screenshot failed (canvas.toBlob returned null)');
      return blob;
    } finally {
      r.setPixelRatio(pr);
      r.setSize(this.size.x, this.size.y, false);
      this.pointCloud?.setViewport(this.size.y * pr, pr);
      r.setClearColor(prevColor, prevAlpha);
      this.showAxes = prevAxes;
      this.requestRender();
    }
  }

  info(): ViewerInfo {
    const i = this.renderer.info;
    return {
      geometries: i.memory.geometries,
      textures: i.memory.textures,
      programs: i.programs?.length ?? 0,
      calls: i.render.calls,
      points: i.render.points,
      frames: this.frames,
    };
  }

  dispose(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.setPointCloud(null);
    this.bboxHelper?.dispose();
    this.grid?.dispose();
    this.axes.dispose();
    this.picker.dispose();
    this.rig.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
