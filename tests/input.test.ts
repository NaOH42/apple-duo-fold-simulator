import assert from 'node:assert/strict';
import test from 'node:test';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, Quaternion, Vector3 } from 'three';
import { PHONE } from '../src/config';
import { canAcquireGrip, DuoInput, type GripAdmissionPoint } from '../src/input';
import type { Grip, HalfId, SimPhysics } from '../src/types';

const point = (overrides: Partial<GripAdmissionPoint> = {}): GripAdmissionPoint => ({
  half: 0, inner: true, facing: 1, visible: true, inViewport: true, ...overrides,
});

test('one pointer can acquire any visible phone surface, including the back and edge', () => {
  assert.deepEqual(canAcquireGrip([], point({ inner: false, facing: 0.05 })), { allowed: true });
});

test('two pointers can grab distinct visible inner halves', () => {
  assert.deepEqual(canAcquireGrip([point()], point({ half: 1 })), { allowed: true });
});

test('second pointer cannot grab the same half or an outer surface', () => {
  assert.deepEqual(canAcquireGrip([point()], point()), { allowed: false, reason: 'same-half' });
  assert.deepEqual(canAcquireGrip([point({ inner: false })], point({ half: 1 })), { allowed: false, reason: 'inner' });
  assert.deepEqual(canAcquireGrip([point()], point({ half: 1, inner: false })), { allowed: false, reason: 'inner' });
});

test('second pointer requires both current normals to face the camera beyond the grazing threshold', () => {
  assert.deepEqual(canAcquireGrip([point({ facing: 0.2 })], point({ half: 1 })), { allowed: false, reason: 'facing' });
  assert.deepEqual(canAcquireGrip([point()], point({ half: 1, facing: -1 })), { allowed: false, reason: 'facing' });
  assert.deepEqual(canAcquireGrip([point({ facing: 0.201 })], point({ half: 1, facing: 0.201 })), { allowed: true });
});

test('neither a hidden existing anchor nor an occluded candidate enables dual grabbing', () => {
  assert.deepEqual(canAcquireGrip([point({ visible: false })], point({ half: 1 })), { allowed: false, reason: 'occluded' });
  assert.deepEqual(canAcquireGrip([point()], point({ half: 1, visible: false })), { allowed: false, reason: 'occluded' });
  assert.deepEqual(canAcquireGrip([], point({ visible: false })), { allowed: false, reason: 'occluded' });
});

test('both anchors must be inside the current viewport at acquisition', () => {
  assert.deepEqual(canAcquireGrip([point({ inViewport: false })], point({ half: 1 })), { allowed: false, reason: 'offscreen' });
  assert.deepEqual(canAcquireGrip([point()], point({ half: 1, inViewport: false })), { allowed: false, reason: 'offscreen' });
});

test('a third pointer never adds a grip', () => {
  assert.deepEqual(canAcquireGrip([point(), point({ half: 1 })], point()), { allowed: false, reason: 'full' });
});

class FakeCanvas extends EventTarget {
  style = { touchAction: 'pan-y', cursor: 'auto' };
  captures = new Set<number>();
  getBoundingClientRect(): DOMRect { return { left: 0, top: 0, width: 800, height: 800 } as DOMRect; }
  setPointerCapture(id: number): void { this.captures.add(id); }
  hasPointerCapture(id: number): boolean { return this.captures.has(id); }
  releasePointerCapture(id: number): void { this.captures.delete(id); }
}

function emit(target: EventTarget, type: string, values: Record<string, unknown> = {}): void {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { pointerType: 'touch', pointerId: 1, button: 0, shiftKey: false, ...values });
  target.dispatchEvent(event);
}

function withInput(run: (harness: {
  input: DuoInput; canvas: FakeCanvas; window: EventTarget;
  physics: SimPhysics; camera: PerspectiveCamera; halves: [Group, Group]; at: (half: HalfId) => { clientX: number; clientY: number };
}) => void, cameraSetup?: (camera: PerspectiveCamera) => void): void {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const fakeWindow = new EventTarget();
  const fakeDocument = Object.assign(new EventTarget(), { hidden: false });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
  const canvas = new FakeCanvas();
  const camera = new PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  cameraSetup?.(camera);
  camera.updateMatrixWorld();
  const halves: [Group, Group] = [new Group(), new Group()];
  const pickables: Mesh[] = [];
  const material = new MeshBasicMaterial();
  for (const half of [0, 1] as const) {
    halves[half].position.x = (half === 0 ? -1 : 1) * (PHONE.width + PHONE.gap) / 2;
    const shell = new Mesh(new BoxGeometry(PHONE.width, PHONE.height, PHONE.thickness), material);
    shell.userData = { half, inner: false };
    const screen = new Mesh(new PlaneGeometry(PHONE.width * 0.9, PHONE.height * 0.9), material);
    screen.position.z = PHONE.thickness / 2 + 0.001;
    screen.userData = { half, inner: true };
    halves[half].add(shell, screen);
    halves[half].updateMatrixWorld(true);
    pickables.push(shell, screen);
  }
  const grips = new Map<number, Grip>();
  const physics: SimPhysics = {
    poses: halves.map((group) => ({ position: group.position.clone(), quaternion: new Quaternion() })) as SimPhysics['poses'],
    grips,
    setGrip: (grip) => { grips.set(grip.id, grip); },
    releaseGrip: (id) => { grips.delete(id); },
    releaseAll: () => grips.clear(),
    reset: () => {}, breakHinge: () => {}, setDamage: () => {}, fragments: [],
    step: () => ({ angle: 180, angularSpeed: 0, strain: 0, impact: 0, hardStop: 0, speed: 0 }),
  };
  const input = new DuoInput(canvas as unknown as HTMLCanvasElement, camera, halves, pickables, physics, () => {}, () => {});
  const at = (half: HalfId) => {
    const projected = halves[half].localToWorld(new Vector3(0, 0, PHONE.thickness / 2 + 0.001)).project(camera);
    return { clientX: (projected.x + 1) * 400, clientY: (1 - projected.y) * 400 };
  };
  try {
    run({ input, canvas, window: fakeWindow, physics, camera, halves, at });
  } finally {
    input.dispose();
    for (const mesh of pickables) mesh.geometry.dispose();
    material.dispose();
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
}

test('surface picking starts exactly on the surface and off-canvas dragging only changes a bounded force target', () => {
  withInput(({ canvas, physics, halves, at }) => {
    const originalPosition = halves[0].position.clone();
    emit(canvas, 'pointerdown', { pointerId: 11, ...at(0) });
    assert.equal(physics.grips.size, 1);
    const grip = physics.grips.get(11)!;
    const initialPoint = grip.target.clone();
    const actual = grip.localPoint.clone().applyQuaternion(physics.poses[0].quaternion).add(physics.poses[0].position);
    assert.ok(actual.distanceTo(initialPoint) < 1e-9);
    emit(canvas, 'pointermove', { pointerId: 11, clientX: 80000, clientY: -80000 });
    assert.ok(grip.target.distanceTo(actual) <= PHONE.height * 1.25 + 1e-9);
    assert.ok(grip.target.distanceTo(initialPoint) > 0.1);
    assert.ok(halves[0].position.equals(originalPosition));
    emit(canvas, 'pointerup', { pointerId: 11 });
    assert.equal(physics.grips.size, 0);
  });
});

test('an upward drag with the tilted game camera raises the target without pushing it farther across the table', () => {
  withInput(({ canvas, physics, camera, at }) => {
    const start = at(0);
    emit(canvas, 'pointerdown', { pointerId: 11, ...start });
    assert.equal(physics.grips.size, 1);
    const grip = physics.grips.get(11)!;
    const initial = grip.target.clone();
    emit(canvas, 'pointermove', { pointerId: 11, clientX: start.clientX, clientY: start.clientY - 80 });
    const delta = grip.target.clone().sub(initial);
    const depth = camera.getWorldDirection(new Vector3()).setY(0).normalize();
    assert.ok(delta.y > .3, `upward input still lifts the body: ${delta.y}`);
    assert.ok(Math.abs(delta.dot(depth)) < 1e-9, `unintended horizontal depth change ${delta.dot(depth)}`);
    emit(canvas, 'pointerup', { pointerId: 11 });
    assert.equal(physics.grips.size, 0);
  }, camera => { camera.position.set(3, 4.5, 5.8); camera.lookAt(0, .25, 0); });
});

test('a centred upward drag changes only height even with an oblique camera', () => {
  withInput(({ canvas, physics, at }) => {
    const start = at(0);
    emit(canvas, 'pointerdown', { pointerId: 11, ...start });
    const grip = physics.grips.get(11)!;
    const initial = grip.target.clone();
    emit(canvas, 'pointermove', { pointerId: 11, clientX: start.clientX, clientY: start.clientY - 80 });
    const delta = grip.target.clone().sub(initial);
    assert.ok(delta.y > .3);
    assert.ok(Math.hypot(delta.x, delta.z) < 1e-9, `horizontal travel ${Math.hypot(delta.x, delta.z)}`);
  }, camera => {
    const centre = new Vector3(-(PHONE.width + PHONE.gap) / 2, 0, PHONE.thickness / 2 + .001);
    camera.position.copy(centre).add(new Vector3(3, 4.5, 5.8)); camera.lookAt(centre);
  });
});

test('repeated lift, release and regrasp cannot accumulate hidden table-depth travel', () => {
  withInput(({ canvas, physics, camera, halves, at }) => {
    const depth = camera.getWorldDirection(new Vector3()).setY(0).normalize();
    const originalDepth = physics.poses[0].position.dot(depth);
    for (let cycle = 0; cycle < 12; cycle++) {
      const start = at(0);
      emit(canvas, 'pointerdown', { pointerId: 11, ...start });
      assert.equal(physics.grips.size, 1, `regrasp ${cycle}`);
      const grip = physics.grips.get(11)!;
      const initial = grip.target.clone();
      emit(canvas, 'pointermove', { pointerId: 11, clientX: start.clientX, clientY: start.clientY - 80 });
      const delta = grip.target.clone().sub(initial);
      emit(canvas, 'pointerup', { pointerId: 11 });
      // This input harness follows the horizontal target, then lets the lifted height settle.
      // Translating both leaves keeps their relative geometry unchanged for the next raycast.
      delta.y = 0;
      halves.forEach((half, index) => {
        half.position.add(delta); half.updateMatrixWorld(true);
        physics.poses[index].position.copy(half.position);
      });
      assert.ok(Math.abs(physics.poses[0].position.dot(depth) - originalDepth) < 1e-9,
        `table-depth drift after ${cycle + 1} lifts`);
    }
  }, camera => { camera.position.set(3, 4.5, 5.8); camera.lookAt(0, .25, 0); });
});

test('horizontal dragging with the tilted game camera still moves freely across the table', () => {
  withInput(({ canvas, physics, camera, at }) => {
    const start = at(0);
    emit(canvas, 'pointerdown', { pointerId: 11, ...start });
    const grip = physics.grips.get(11)!;
    const initial = grip.target.clone();
    emit(canvas, 'pointermove', { pointerId: 11, clientX: start.clientX + 80, clientY: start.clientY });
    const delta = grip.target.clone().sub(initial);
    const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const depth = camera.getWorldDirection(new Vector3()).setY(0).normalize();
    assert.ok(delta.dot(right) > .3, `horizontal input travel ${delta.dot(right)}`);
    assert.ok(Math.abs(delta.dot(depth)) < 1e-9);
  }, camera => { camera.position.set(3, 4.5, 5.8); camera.lookAt(0, .25, 0); });
});

test('two accepted grips survive turning away, and releasing one preserves the other', () => {
  withInput(({ canvas, physics, halves, at }) => {
    emit(canvas, 'pointerdown', { pointerId: 11, ...at(0) });
    emit(canvas, 'pointerdown', { pointerId: 12, ...at(1) });
    assert.equal(physics.grips.size, 2);
    halves[0].rotation.y = Math.PI;
    emit(canvas, 'pointermove', { pointerId: 11, clientX: 350, clientY: 430 });
    assert.equal(physics.grips.size, 2);
    emit(canvas, 'pointerup', { pointerId: 11 });
    assert.equal(physics.grips.size, 1);
    assert.ok(physics.grips.has(12));
  });
});

test('a first grip that turned behind its half prevents a new second grip', () => {
  withInput(({ canvas, physics, halves, at }) => {
    emit(canvas, 'pointerdown', { pointerId: 11, ...at(0) });
    halves[0].rotation.y = Math.PI;
    emit(canvas, 'pointerdown', { pointerId: 12, ...at(1) });
    assert.equal(physics.grips.size, 1);
    assert.ok(physics.grips.has(11));
  });
});

test('Shift click holds a virtual fingertip after mouseup; releasing Shift preserves the active mouse grip', () => {
  withInput(({ canvas, window, physics, at }) => {
    emit(canvas, 'pointerdown', { pointerType: 'mouse', pointerId: 1, shiftKey: true, ...at(0) });
    emit(canvas, 'pointerup', { pointerType: 'mouse', pointerId: 1, shiftKey: true });
    assert.ok(physics.grips.has(-1));
    emit(canvas, 'pointerdown', { pointerType: 'mouse', pointerId: 1, shiftKey: true, ...at(1) });
    assert.equal(physics.grips.size, 2);
    emit(window, 'keyup', { key: 'Shift', shiftKey: false });
    assert.equal(physics.grips.size, 1);
    assert.ok(physics.grips.has(1));
    emit(canvas, 'pointerup', { pointerType: 'mouse', pointerId: 1 });
    assert.equal(physics.grips.size, 0);
  });
});

test('pointer cancellation releases its grip and window blur clears remaining input', () => {
  withInput(({ canvas, window, physics, at }) => {
    emit(canvas, 'pointerdown', { pointerId: 11, ...at(0) });
    emit(canvas, 'pointerdown', { pointerId: 12, ...at(1) });
    emit(canvas, 'pointercancel', { pointerId: 11 });
    assert.equal(physics.grips.size, 1);
    emit(window, 'blur');
    assert.equal(physics.grips.size, 0);
    assert.equal(canvas.captures.size, 0);
  });
});
