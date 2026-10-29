import { Group, Matrix3, Mesh, PerspectiveCamera, Plane, Quaternion, Raycaster, Vector2, Vector3 } from 'three';
import { PHONE } from './config';
import type { Grip, HalfId, SimPhysics } from './types';

export interface GripAdmissionPoint {
  half: HalfId;
  inner: boolean;
  facing: number;
  visible: boolean;
  inViewport: boolean;
}

export type GripRejection = 'full' | 'same-half' | 'inner' | 'facing' | 'occluded' | 'offscreen';
export type GripAdmission = { allowed: true } | { allowed: false; reason: GripRejection };

/** Visibility is checked when a grip is acquired, never while an existing grip turns away. */
export function canAcquireGrip(existing: readonly GripAdmissionPoint[], candidate: GripAdmissionPoint): GripAdmission {
  if (existing.length >= 2) return { allowed: false, reason: 'full' };
  if (!candidate.inViewport) return { allowed: false, reason: 'offscreen' };
  if (!candidate.visible) return { allowed: false, reason: 'occluded' };
  if (existing.length === 0) return { allowed: true };
  const first = existing[0];
  if (first.half === candidate.half) return { allowed: false, reason: 'same-half' };
  if (!first.inner || !candidate.inner) return { allowed: false, reason: 'inner' };
  if (first.facing <= 0.2 || candidate.facing <= 0.2) return { allowed: false, reason: 'facing' };
  if (!first.inViewport) return { allowed: false, reason: 'offscreen' };
  if (!first.visible) return { allowed: false, reason: 'occluded' };
  return { allowed: true };
}

interface HeldGrip {
  grip: Grip;
  inner: boolean;
  plane: Plane;
  origin: Vector3;
}

const PIN_ID = -1;
const MAX_TARGET_TRAVEL = PHONE.height * 2.6;
const MAX_GRIP_STRETCH = PHONE.height * 1.25;
const VISIBILITY_EPSILON = PHONE.thickness * 0.04;

export class DuoInput {
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly held = new Map<number, HeldGrip>();
  private readonly captured = new Set<number>();
  private readonly previousTouchAction: string;
  private readonly previousCursor: string;
  private interacted = false;
  private shiftHeld = false;
  private pinSource: number | null = null;
  private lastHint = -Infinity;
  private disposed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: PerspectiveCamera,
    private readonly halves: [Group, Group],
    private readonly pickables: Mesh[],
    private readonly physics: SimPhysics,
    private readonly onInteract: () => void,
    private readonly onHint: (message: string) => void,
  ) {
    this.previousTouchAction = canvas.style.touchAction;
    this.previousCursor = canvas.style.cursor;
    canvas.style.touchAction = 'none';
    canvas.style.cursor = 'grab';
    canvas.addEventListener('pointerdown', this.pointerDown, { passive: false });
    canvas.addEventListener('pointermove', this.pointerMove, { passive: false });
    canvas.addEventListener('pointerup', this.pointerUp);
    canvas.addEventListener('pointercancel', this.pointerCancel);
    canvas.addEventListener('lostpointercapture', this.lostCapture);
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);
    window.addEventListener('blur', this.windowBlur);
    document.addEventListener('visibilitychange', this.visibilityChange);
  }

  releaseAll(): void {
    this.pinSource = null;
    this.shiftHeld = false;
    this.held.clear();
    this.physics.releaseAll();
    for (const id of [...this.captured]) this.releaseCapture(id);
    this.canvas.style.cursor = 'grab';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseAll();
    this.canvas.removeEventListener('pointerdown', this.pointerDown);
    this.canvas.removeEventListener('pointermove', this.pointerMove);
    this.canvas.removeEventListener('pointerup', this.pointerUp);
    this.canvas.removeEventListener('pointercancel', this.pointerCancel);
    this.canvas.removeEventListener('lostpointercapture', this.lostCapture);
    window.removeEventListener('keydown', this.keyDown);
    window.removeEventListener('keyup', this.keyUp);
    window.removeEventListener('blur', this.windowBlur);
    document.removeEventListener('visibilitychange', this.visibilityChange);
    this.canvas.style.touchAction = this.previousTouchAction;
    this.canvas.style.cursor = this.previousCursor;
  }

  private readonly pointerDown = (event: PointerEvent): void => {
    if (this.disposed || (event.pointerType !== 'touch' && event.button !== 0)) return;
    if (event.cancelable) event.preventDefault();
    if (!this.interacted) {
      this.interacted = true;
      this.onInteract();
    }
    if (this.held.size >= 2 || this.held.has(event.pointerId)) return;
    this.syncMatrices();
    if (!this.updateRay(event)) return;
    const hit = this.raycaster.intersectObjects(this.pickables, false).find((entry) => this.halfOf(entry.object) !== null);
    if (!hit || !hit.face) return;
    const half = this.halfOf(hit.object)!;
    const group = this.halves[half];
    const worldNormal = hit.face.normal.clone().applyMatrix3(new Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
    const localNormal = worldNormal.applyQuaternion(group.getWorldQuaternion(new Quaternion()).invert()).normalize();
    const isPin = event.pointerType === 'mouse' && event.shiftKey && !this.held.has(PIN_ID);
    const inner = hit.object.userData.inner === true;
    if (isPin && !inner) {
      this.hint('按住 Shift，点击内屏留下指尖');
      return;
    }
    const id = isPin ? PIN_ID : event.pointerId;
    const held: HeldGrip = {
      grip: { id, half, localPoint: group.worldToLocal(hit.point.clone()), localNormal, target: hit.point.clone() },
      inner,
      plane: new Plane().setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(new Vector3()), hit.point),
      origin: hit.point.clone(),
    };
    const result = canAcquireGrip([...this.held.values()].map((entry) => this.admissionPoint(entry)), this.admissionPoint(held));
    if (!result.allowed) {
      if (result.reason !== 'full') this.hint(result.reason === 'same-half' ? '另一根手指抓住另一侧内屏' : '先把两侧内屏转向你');
      return;
    }
    this.held.set(id, held);
    this.physics.setGrip(held.grip);
    if (isPin) {
      this.pinSource = event.pointerId;
      this.shiftHeld = true;
    }
    this.capture(event.pointerId);
    this.canvas.style.cursor = 'grabbing';
  };

  private readonly pointerMove = (event: PointerEvent): void => {
    const held = this.held.get(event.pointerId);
    if (!held) return;
    if (event.cancelable) event.preventDefault();
    this.syncMatrices();
    if (!this.updateRay(event)) return;
    const target = this.raycaster.ray.intersectPlane(held.plane, new Vector3());
    if (!target) return;
    target.sub(held.origin).clampLength(0, MAX_TARGET_TRAVEL).add(held.origin);
    const pose = this.physics.poses[held.grip.half];
    const actualPoint = held.grip.localPoint.clone().applyQuaternion(pose.quaternion).add(pose.position);
    target.sub(actualPoint).clampLength(0, MAX_GRIP_STRETCH).add(actualPoint);
    held.grip.target.copy(target);
    this.physics.setGrip(held.grip);
  };

  private readonly pointerUp = (event: PointerEvent): void => {
    if (this.pinSource === event.pointerId) {
      this.pinSource = null;
      if (!this.shiftHeld) this.release(PIN_ID);
    }
    this.release(event.pointerId);
    this.releaseCapture(event.pointerId);
  };

  private readonly pointerCancel = (event: PointerEvent): void => {
    if (this.pinSource === event.pointerId) {
      this.pinSource = null;
      this.release(PIN_ID);
    }
    this.release(event.pointerId);
    this.releaseCapture(event.pointerId);
  };

  private readonly lostCapture = (event: PointerEvent): void => {
    this.captured.delete(event.pointerId);
    if (this.pinSource === event.pointerId) {
      this.pinSource = null;
      this.release(PIN_ID);
    }
    this.release(event.pointerId);
  };

  private readonly keyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Shift') this.shiftHeld = true;
  };

  private readonly keyUp = (event: KeyboardEvent): void => {
    if (event.key !== 'Shift' || event.shiftKey) return;
    this.shiftHeld = false;
    this.pinSource = null;
    this.release(PIN_ID);
  };

  private readonly windowBlur = (): void => this.releaseAll();
  private readonly visibilityChange = (): void => {
    if (document.hidden) this.releaseAll();
  };

  private syncMatrices(): void {
    this.camera.updateWorldMatrix(true, false);
    for (const half of this.halves) half.updateWorldMatrix(true, true);
  }

  private updateRay(event: PointerEvent): boolean {
    const bounds = this.canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return false;
    this.pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, 1 - ((event.clientY - bounds.top) / bounds.height) * 2);
    this.raycaster.near = 0;
    this.raycaster.far = Infinity;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return true;
  }

  private admissionPoint(held: HeldGrip): GripAdmissionPoint {
    const group = this.halves[held.grip.half];
    const point = group.localToWorld(held.grip.localPoint.clone());
    const cameraPosition = this.camera.getWorldPosition(new Vector3());
    const toCamera = cameraPosition.clone().sub(point).normalize();
    const normalMatrix = new Matrix3().getNormalMatrix(group.matrixWorld);
    const surfaceNormal = held.grip.localNormal.clone().applyMatrix3(normalMatrix).normalize();
    const innerNormal = new Vector3(0, 0, 1).applyMatrix3(normalMatrix).normalize();
    const facing = held.inner ? Math.min(surfaceNormal.dot(toCamera), innerNormal.dot(toCamera)) : surfaceNormal.dot(toCamera);
    const projected = point.clone().project(this.camera);
    const inViewport = Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1 && projected.z >= -1 && projected.z <= 1;
    const distance = cameraPosition.distanceTo(point);
    const visibilityRay = new Raycaster(cameraPosition, point.clone().sub(cameraPosition).normalize(), 0, distance + VISIBILITY_EPSILON);
    const nearest = visibilityRay.intersectObjects(this.pickables, false).find((hit) => this.halfOf(hit.object) !== null);
    const visible = nearest !== undefined && this.halfOf(nearest.object) === held.grip.half && Math.abs(nearest.distance - distance) <= VISIBILITY_EPSILON;
    return { half: held.grip.half, inner: held.inner, facing, visible, inViewport };
  }

  private halfOf(object: { userData: Record<string, unknown> }): HalfId | null {
    return object.userData.half === 0 || object.userData.half === 1 ? object.userData.half : null;
  }

  private capture(id: number): void {
    try {
      this.canvas.setPointerCapture(id);
      this.captured.add(id);
    } catch {
      // A pointer cancelled by the browser between dispatch and capture is no longer usable.
      if (this.pinSource === id) {
        this.pinSource = null;
        this.release(PIN_ID);
      }
      this.release(id);
    }
  }

  private releaseCapture(id: number): void {
    this.captured.delete(id);
    try {
      if (this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id);
    } catch {
      // Capture is already gone when a browser cancels a native pointer stream.
    }
  }

  private release(id: number): void {
    if (!this.held.delete(id)) return;
    this.physics.releaseGrip(id);
    this.canvas.style.cursor = this.held.size > 0 ? 'grabbing' : 'grab';
  }

  private hint(message: string): void {
    const now = performance.now();
    if (now - this.lastHint < 1600) return;
    this.lastHint = now;
    this.onHint(message);
  }
}
