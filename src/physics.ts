import RAPIER from '@dimforge/rapier3d-compat';
import { Camera, Frustum, Matrix4, Quaternion, Vector3 } from 'three';
import { CAMERA, FIXED_DT, MAX_FRAGMENTS, PHONE } from './config';
import type { BodyPose, DamageState, Grip, HalfId, PhysicsSample, SimPhysics } from './types';

let initialized: Promise<unknown> | undefined;
/** Keep the whole folding range inside (-pi, pi), away from Rapier's angle wrap. */
export const HINGE_REFERENCE = Math.PI / 2;
const RIGHT_BODY_FRAME = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), HINGE_REFERENCE);
const RIGHT_MODEL_FRAME = RIGHT_BODY_FRAME.clone().invert();
const v3 = (v: { x: number; y: number; z: number }) => new Vector3(v.x, v.y, v.z);
const pose = (): BodyPose => ({ position: new Vector3(), quaternion: new Quaternion() });
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** World units are deliberately toy scale. All damage is game calibration, not material data. */
export class DuoPhysics implements SimPhysics {
  world!: RAPIER.World;
  bodies!: [RAPIER.RigidBody, RAPIER.RigidBody];
  private colliders!: [RAPIER.Collider, RAPIER.Collider];
  private colliderOwners = new Map<number, HalfId>();
  private joint: RAPIER.RevoluteImpulseJoint | null = null;
  private queue!: RAPIER.EventQueue;
  private fragmentBodies: RAPIER.RigidBody[] = [];
  private viewportWalls: RAPIER.Collider[] = [];
  private contactTimes = new Map<string, number>();
  private time = 0;
  private strain = 0;
  private lastScreen = 100;
  private seed = 17;
  poses: [BodyPose, BodyPose] = [pose(), pose()];
  fragments: BodyPose[] = [];
  grips = new Map<number, Grip>();

  static async create(): Promise<DuoPhysics> {
    await (initialized ??= RAPIER.init());
    const sim = new DuoPhysics();
    sim.reset();
    return sim;
  }

  reset(): void {
    this.releaseAll();
    this.queue?.free();
    this.world?.free();
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = FIXED_DT;
    this.world.numSolverIterations = 12;
    this.queue = new RAPIER.EventQueue(true);
    this.time = 0;
    this.strain = 0;
    this.lastScreen = 100;
    this.seed = 17;
    this.contactTimes.clear();
    this.colliderOwners.clear();
    this.fragmentBodies = [];
    this.viewportWalls = [];
    this.fragments = [];
    const floor = RAPIER.ColliderDesc.cuboid(12, 0.2, 12)
      .setTranslation(0, -0.2, 0).setFriction(0.65).setRestitution(0.16);
    this.world.createCollider(floor);
    // These boundaries remain outside the normal composition; no object is teleported back.
    for (const x of [-4, 4]) this.world.createCollider(RAPIER.ColliderDesc.cuboid(0.15, 6, 6).setTranslation(x, 5, 0).setRestitution(0.22));
    for (const z of [-3, 3]) this.world.createCollider(RAPIER.ColliderDesc.cuboid(6, 6, 0.15).setTranslation(0, 5, z).setRestitution(0.22));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(6, 0.15, 6).setTranslation(0, 6, 0));

    const base = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -0.22).multiply(base);
    const anchor0 = new Vector3(PHONE.width / 2 + PHONE.gap / 2, 0, PHONE.hingeZ);
    const anchor1 = new Vector3(-PHONE.width / 2 - PHONE.gap / 2, 0, PHONE.hingeZ);
    const p0 = new Vector3(-PHONE.width / 2 - PHONE.gap / 2, 0.12, 0).applyAxisAngle(new Vector3(0, 1, 0), -0.22);
    const hinge = anchor0.clone().applyQuaternion(q).add(p0);
    const q1 = q.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -0.18));
    const p1 = hinge.clone().sub(anchor1.clone().applyQuaternion(q1));
    this.bodies = [p0, p1].map((p, i) => this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z)
        .setRotation(i === 0 ? q : q1.clone().multiply(RIGHT_BODY_FRAME)).setLinearDamping(0.12).setAngularDamping(0.22)
        .setCcdEnabled(true).setCanSleep(true),
    )) as [RAPIER.RigidBody, RAPIER.RigidBody];
    const corner = Math.min(0.018, PHONE.thickness / 4);
    this.colliders = this.bodies.map((body, i) => this.world.createCollider(
      RAPIER.ColliderDesc.roundCuboid(PHONE.width / 2 - corner, PHONE.height / 2 - corner, PHONE.thickness / 2 - corner, corner)
        .setRotation(i === 0 ? new Quaternion() : RIGHT_MODEL_FRAME)
        .setMass(0.18).setFriction(0.6).setRestitution(0.18)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(4), body,
    )) as [RAPIER.Collider, RAPIER.Collider];
    this.colliders.forEach((collider, i) => this.colliderOwners.set(collider.handle, i as HalfId));
    // A back camera must support the leaf on the table instead of visually sinking through it.
    const rearCamera = this.world.createCollider(
      RAPIER.ColliderDesc.roundCuboid(CAMERA.width / 2 - .009, CAMERA.height / 2 - .009, CAMERA.lensProtrusion / 2 - .009, .009)
        .setTranslation(CAMERA.centerX, CAMERA.centerY, -PHONE.thickness / 2 - CAMERA.lensProtrusion / 2)
        .setMass(0).setFriction(.6).setRestitution(.18)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(4),
      this.bodies[0],
    );
    this.colliderOwners.set(rearCamera.handle, 0);
    this.joint = this.world.createImpulseJoint(
      RAPIER.JointData.revolute(anchor0, anchor1.clone().applyQuaternion(RIGHT_MODEL_FRAME), { x: 0, y: 1, z: 0 }),
      this.bodies[0], this.bodies[1], true,
    ) as RAPIER.RevoluteImpulseJoint;
    this.joint.setLimits(-Math.PI + HINGE_REFERENCE + 0.002, HINGE_REFERENCE + 0.006);
    this.joint.setContactsEnabled(false);
    this.joint.configureMotorModel(RAPIER.MotorModel.ForceBased);
    this.joint.configureMotorVelocity(0, 0.025);
    this.syncPoses();
  }

  setGrip(grip: Grip): void {
    this.grips.set(grip.id, grip);
    this.bodies[grip.half].wakeUp();
  }
  releaseGrip(id: number): void { this.grips.delete(id); }
  releaseAll(): void { this.grips.clear(); }

  /** Four invisible physical walls follow the fixed camera frustum, so a throw stays reachable on small screens. */
  setViewBounds(camera: Camera): void {
    for (const wall of this.viewportWalls) this.world.removeCollider(wall, true);
    this.viewportWalls = [];
    camera.updateMatrixWorld(true);
    const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    for (const plane of frustum.planes.slice(0, 4)) {
      const center = plane.normal.clone().multiplyScalar(-plane.constant - .12);
      const rotation = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), plane.normal);
      this.viewportWalls.push(this.world.createCollider(RAPIER.ColliderDesc.cuboid(20, 20, .12)
        .setTranslation(center.x, center.y, center.z).setRotation(rotation).setFriction(.12).setRestitution(.3)));
    }
  }

  step(dt: number): PhysicsSample {
    this.world.timestep = dt;
    this.time += dt;
    this.syncPoses();
    const before = this.bodies.map(b => ({ velocity: v3(b.linvel()), angular: v3(b.angvel()) }));
    const hingeAxis = new Vector3(0, 1, 0).applyQuaternion(this.poses[0].quaternion);
    const angleBefore = this.foldAngle();
    let relativeTorque = 0;
    let springLoad = 0;
    for (const body of this.bodies) {
      body.resetForces(false);
      body.resetTorques(false);
    }
    for (const grip of this.grips.values()) {
      const body = this.bodies[grip.half];
      const transform = this.poses[grip.half];
      const offset = grip.localPoint.clone().applyQuaternion(transform.quaternion);
      const point = offset.clone().add(transform.position);
      const pointVelocity = before[grip.half].angular.clone().cross(offset).add(before[grip.half].velocity);
      const error = grip.target.clone().sub(point).clampLength(0, 2.8);
      const force = error.multiplyScalar(42).addScaledVector(pointVelocity, -3.8).clampLength(0, 18);
      body.addForceAtPoint(force, point, true);
      const hingeLocal = new Vector3((grip.half === 0 ? 1 : -1) * (PHONE.width / 2 + PHONE.gap / 2), 0, PHONE.hingeZ);
      const lever = grip.localPoint.clone().sub(hingeLocal).applyQuaternion(transform.quaternion);
      const torque = lever.cross(force).dot(hingeAxis);
      relativeTorque += grip.half === 1 ? torque : -torque;
      springLoad = Math.max(springLoad, force.length() / 18);
    }
    const hardStop = this.joint && ((angleBefore > 170 && relativeTorque > 0) || (angleBefore < 12 && relativeTorque < 0))
      ? Math.abs(relativeTorque) / 3.2 : 0;
    this.world.step(this.queue);
    this.syncPoses();
    let impact = 0;
    this.queue.drainContactForceEvents(event => {
      const handles = [event.collider1(), event.collider2()];
      const ownHandle = handles.find(h => this.colliderOwners.has(h));
      if (ownHandle === undefined) return;
      const own = this.colliderOwners.get(ownHandle)!;
      if (handles.every(h => this.colliderOwners.has(h))) return;
      const key = [...handles].sort((a, b) => a - b).join(':');
      const normal = v3(event.maxForceDirection());
      const hitSpeed = Math.abs(before[own].velocity.dot(normal)) + Math.min(2.5, before[own].angular.length() * 0.12);
      if (hitSpeed > 1.4 && this.time - (this.contactTimes.get(key) ?? -10) > 0.25) {
        impact = Math.max(impact, hitSpeed);
        this.contactTimes.set(key, this.time);
      }
    });
    const angularSpeed = this.joint ? Math.abs(v3(this.bodies[1].angvel()).sub(v3(this.bodies[0].angvel())).dot(hingeAxis)) : 0;
    const rawStrain = Math.max(angularSpeed / 14, hardStop, impact / 7, springLoad * 0.45);
    this.strain += (rawStrain - this.strain) * (1 - Math.exp(-dt * (rawStrain > this.strain ? 18 : 5)));
    // Input targets are bounded, with CCD as the main guard against thin-body tunnelling.
    for (const body of this.bodies) {
      const vel = v3(body.linvel());
      const omega = v3(body.angvel());
      if (vel.length() > 18) body.setLinvel(vel.clampLength(0, 18), true);
      if (omega.length() > 40) body.setAngvel(omega.clampLength(0, 40), true);
    }
    return {
      angle: this.foldAngle(), angularSpeed, strain: this.strain, impact, hardStop,
      speed: Math.max(...this.bodies.map(b => v3(b.linvel()).length())),
    };
  }

  private foldAngle(): number {
    const n0 = new Vector3(0, 0, 1).applyQuaternion(this.poses[0].quaternion);
    const n1 = new Vector3(0, 0, 1).applyQuaternion(this.poses[1].quaternion);
    return clamp(180 - Math.acos(clamp(n0.dot(n1), -1, 1)) * 180 / Math.PI, 0, 180);
  }

  setDamage(damage: DamageState): void {
    if ((this.lastScreen > 65 && damage.screen <= 65) || (this.lastScreen > 25 && damage.screen <= 25)) this.spawnFragments(4);
    this.lastScreen = damage.screen;
    if (damage.broken && this.joint) this.breakHinge();
    this.joint?.configureMotorVelocity(0, 0.008 + damage.hinge / 100 * 0.017);
  }

  breakHinge(): void {
    if (!this.joint) return;
    this.world.removeImpulseJoint(this.joint, true);
    this.joint = null;
    this.spawnFragments(12);
    this.bodies.forEach(body => body.wakeUp());
  }

  private random(): number {
    this.seed = (Math.imul(1664525, this.seed) + 1013904223) >>> 0;
    return this.seed / 0x100000000;
  }

  private spawnFragments(count: number): void {
    for (let i = 0; i < count && this.fragments.length < MAX_FRAGMENTS; i++) {
      const half = (i % 2) as HalfId;
      const transform = this.poses[half];
      const location = new Vector3((this.random() - 0.5) * PHONE.width * 0.8, (this.random() - 0.5) * PHONE.height * 0.8, PHONE.thickness)
        .applyQuaternion(transform.quaternion).add(transform.position);
      location.y = Math.max(location.y, 0.06);
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(location.x, location.y, location.z).setRotation(transform.quaternion)
        .setCcdEnabled(true).setLinearDamping(0.3).setAngularDamping(0.35));
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(0.025, 0.035, 0.006).setMass(0.003).setRestitution(0.25), body);
      body.setLinvel(v3(this.bodies[half].linvel()).multiplyScalar(0.4).add(new Vector3((this.random() - 0.5) * 1.5, this.random() + 0.4, (this.random() - 0.5) * 1.5)), true);
      body.setAngvel({ x: this.random() * 8, y: this.random() * 8, z: this.random() * 8 }, true);
      this.fragmentBodies.push(body);
      this.fragments.push(pose());
    }
  }

  private syncPoses(): void {
    this.bodies.forEach((body, i) => {
      this.poses[i].position.copy(body.translation());
      this.poses[i].quaternion.copy(body.rotation());
      if (i === 1) this.poses[i].quaternion.multiply(RIGHT_MODEL_FRAME);
    });
    this.fragmentBodies.forEach((body, i) => {
      this.fragments[i].position.copy(body.translation());
      this.fragments[i].quaternion.copy(body.rotation());
    });
  }

  dispose(): void { this.releaseAll(); this.queue.free(); this.world.free(); }
}
