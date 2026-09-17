/**
 * Perspective/orthographic camera pair sharing one OrbitControls, with fit-to-bounds, presets,
 * reset and serialisable state. The stack axis (z) is "up", so orbiting spins the section stack.
 */
import { MathUtils, OrthographicCamera, PerspectiveCamera, Vector3, type Camera } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Bounds } from './sections';

export type ViewPreset = 'top' | 'front' | 'side' | 'iso';

export interface CameraState {
  ortho: boolean;
  position: [number, number, number];
  target: [number, number, number];
  zoom: number;
}

const PRESET_DIRS: Record<ViewPreset, [number, number, number]> = {
  top: [0, 0, 1],
  front: [0, -1, 0],
  side: [1, 0, 0],
  iso: [0.9, -1.3, 1.0],
};

export class CameraRig {
  readonly perspective = new PerspectiveCamera(40, 1, 0.001, 200);
  readonly orthographic = new OrthographicCamera(-1, 1, 1, -1, -100, 100);
  readonly controls: OrbitControls;
  private ortho = false;
  private aspect = 1;
  private orthoHalfHeight = 1;
  private home: CameraState | null = null;
  private readonly tmp = new Vector3();

  constructor(domElement: HTMLElement) {
    this.perspective.up.set(0, 0, 1);
    this.orthographic.up.set(0, 0, 1);
    this.perspective.position.set(1.2, -1.8, 1.4);
    this.controls = new OrbitControls(this.perspective, domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.controls.rotateSpeed = 0.8;
  }

  get camera(): Camera {
    return this.ortho ? this.orthographic : this.perspective;
  }

  get isOrthographic(): boolean {
    return this.ortho;
  }

  get autoRotate(): boolean {
    return this.controls.autoRotate;
  }

  set autoRotate(on: boolean) {
    this.controls.autoRotate = on;
    this.controls.autoRotateSpeed = 1.5;
  }

  setAspect(aspect: number): void {
    this.aspect = Math.max(1e-6, aspect);
    this.perspective.aspect = this.aspect;
    this.perspective.updateProjectionMatrix();
    this.applyOrthoFrustum();
  }

  private applyOrthoFrustum(): void {
    const h = this.orthoHalfHeight;
    this.orthographic.top = h;
    this.orthographic.bottom = -h;
    this.orthographic.left = -h * this.aspect;
    this.orthographic.right = h * this.aspect;
    this.orthographic.updateProjectionMatrix();
  }

  setOrthographic(on: boolean): void {
    if (on === this.ortho) return;
    const from = this.camera;
    const to = on ? this.orthographic : this.perspective;
    const target = this.controls.target;
    const dist = from.position.distanceTo(target);
    const halfFov = MathUtils.degToRad(this.perspective.fov / 2);
    to.position.copy(from.position);
    if (on) {
      this.orthoHalfHeight = dist * Math.tan(halfFov);
      this.orthographic.zoom = 1;
      this.applyOrthoFrustum();
    } else {
      const visibleHalf = this.orthoHalfHeight / this.orthographic.zoom;
      const d = visibleHalf / Math.tan(halfFov);
      this.tmp.copy(from.position).sub(target).normalize().multiplyScalar(d);
      to.position.copy(target).add(this.tmp);
    }
    this.ortho = on;
    this.controls.object = to;
    to.lookAt(target);
    to.updateProjectionMatrix();
    this.controls.update();
  }

  /** Frame `bounds`; planar layouts fit the XY rectangle, others the bounding sphere. */
  fit(bounds: Bounds, preset: ViewPreset = 'iso', planar = false, setHome = true): void {
    const center = new Vector3(
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    );
    const size = new Vector3(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    );
    const radius = Math.max(size.length() / 2, 1e-3);
    const halfFov = MathUtils.degToRad(this.perspective.fov / 2);
    const fovH = Math.atan(Math.tan(halfFov) * this.aspect);
    let halfHeight: number;
    if (planar) {
      halfHeight = Math.max(size.y / 2, size.x / 2 / this.aspect, 1e-3) * 1.08;
    } else {
      halfHeight = (radius * 1.05) / Math.min(1, Math.tan(fovH) / Math.tan(halfFov));
    }
    const dist = planar
      ? halfHeight / Math.tan(halfFov)
      : (radius * 1.05) / Math.sin(Math.min(halfFov, fovH));
    const dir = new Vector3(...PRESET_DIRS[preset]).normalize();
    this.controls.target.copy(center);
    const pos = center.clone().add(dir.multiplyScalar(dist));
    this.perspective.position.copy(pos);
    this.orthographic.position.copy(pos);
    this.orthoHalfHeight = halfHeight;
    this.orthographic.zoom = 1;
    this.applyOrthoFrustum();
    this.perspective.lookAt(center);
    this.orthographic.lookAt(center);
    this.controls.update();
    if (setHome) this.home = this.getState();
  }

  /** Move the camera to a preset direction, keeping the current distance and target. */
  preset(view: ViewPreset): void {
    const target = this.controls.target;
    const dist = this.camera.position.distanceTo(target);
    const dir = new Vector3(...PRESET_DIRS[view]).normalize().multiplyScalar(dist);
    this.camera.position.copy(target).add(dir);
    this.camera.lookAt(target);
    this.controls.update();
  }

  reset(): void {
    if (this.home) this.setState(this.home);
  }

  getState(): CameraState {
    const p = this.camera.position;
    const t = this.controls.target;
    return {
      ortho: this.ortho,
      position: [p.x, p.y, p.z],
      target: [t.x, t.y, t.z],
      zoom: this.ortho ? this.orthographic.zoom : 1,
    };
  }

  setState(s: CameraState): void {
    this.controls.target.set(...s.target);
    this.setOrthographic(s.ortho);
    this.camera.position.set(...s.position);
    if (s.ortho) {
      this.orthographic.zoom = s.zoom;
      this.orthographic.updateProjectionMatrix();
    }
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }

  /** Advance damping / auto-rotate; true when the camera moved. */
  update(): boolean {
    return this.controls.update();
  }

  dispose(): void {
    this.controls.dispose();
  }
}
