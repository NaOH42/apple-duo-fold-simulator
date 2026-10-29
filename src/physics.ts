import RAPIER from '@dimforge/rapier3d-compat';
import { Camera, Frustum, Matrix4, Quaternion, Vector3 } from 'three';
import { CAMERA, FIXED_DT, MAX_FRAGMENTS, PHONE } from './config';
import type { BodyPose, ContactMaterial, ContactSample, DamageState, FragmentPose, Grip, HalfId, PhysicsSample, RetiredPhone, SimPhysics } from './types';

let initialized: Promise<unknown> | undefined;
/** Keep the whole folding range inside (-pi, pi), away from Rapier's angle wrap. */
export const HINGE_REFERENCE = Math.PI / 2;
const RIGHT_BODY_FRAME = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), HINGE_REFERENCE);
const RIGHT_MODEL_FRAME = RIGHT_BODY_FRAME.clone().invert();
const v3 = (v: { x: number; y: number; z: number }) => new Vector3(v.x, v.y, v.z);
const pose = (): BodyPose => ({ position: new Vector3(), quaternion: new Quaternion() });
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface PhoneRecord extends RetiredPhone {
  bodies: [RAPIER.RigidBody, RAPIER.RigidBody];
  colliders: [RAPIER.Collider, RAPIER.Collider];
  joint: RAPIER.RevoluteImpulseJoint | null;
  detachedAt: number;
}
interface FragmentRecord {
  id: number; half: HalfId; body: RAPIER.RigidBody; collider: RAPIER.Collider;
  pose: FragmentPose; material: ContactMaterial; size: Vector3; generation: number;
  createdAt: number;
}
interface ColliderOwner {
  half: HalfId; phone?: PhoneRecord; fragment?: FragmentRecord; camera?: boolean;
}
interface BeforeMotion { velocity: Vector3; angular: Vector3; position: Vector3 }
interface PairFeedback { id: number; lastSeen: number; lastHit: number; lastSpeed: number }

/** World units are deliberately toy scale. All damage is game calibration, not material data. */
export class DuoPhysics implements SimPhysics {
  world!: RAPIER.World;
  bodies!: [RAPIER.RigidBody, RAPIER.RigidBody];
  private colliders!: [RAPIER.Collider, RAPIER.Collider];
  private colliderOwners = new Map<number, HalfId>();
  private joint: RAPIER.RevoluteImpulseJoint | null = null;
  private queue!: RAPIER.EventQueue;
  private fragmentBodies: FragmentRecord[] = [];
  private allColliderOwners = new Map<number, ColliderOwner>();
  private currentPhone!: PhoneRecord;
  private oldPhones: PhoneRecord[] = [];
  private floorHandle = 0;
  private phoneSerial = 0;
  private fragmentSerial = 0;
  private contactSerial = 0;
  private pairFeedback = new Map<string, PairFeedback>();
  private viewportWalls: RAPIER.Collider[] = [];
  private contactTimes = new Map<string, number>();
  private time = 0;
  private strain = 0;
  private lastScreen = 100;
  private seed = 17;
  poses: [BodyPose, BodyPose] = [pose(), pose()];
  fragments: FragmentPose[] = [];
  retiredPhones: RetiredPhone[] = [];
  activeVisible: [boolean, boolean] = [true, true];
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
    this.allColliderOwners.clear();
    this.pairFeedback.clear();
    this.oldPhones = [];
    this.retiredPhones = [];
    this.phoneSerial = this.fragmentSerial = this.contactSerial = 0;
    this.fragmentBodies = [];
    this.viewportWalls = [];
    this.fragments = [];
    const floor = RAPIER.ColliderDesc.cuboid(12, 0.2, 12)
      .setTranslation(0, -0.2, 0).setFriction(0.65).setRestitution(0.16);
    this.floorHandle = this.world.createCollider(floor).handle;
    // These boundaries remain outside the normal composition; no object is teleported back.
    for (const x of [-4, 4]) this.world.createCollider(RAPIER.ColliderDesc.cuboid(0.15, 6, 6).setTranslation(x, 5, 0).setRestitution(0.22));
    for (const z of [-3, 3]) this.world.createCollider(RAPIER.ColliderDesc.cuboid(6, 6, 0.15).setTranslation(0, 5, z).setRestitution(0.22));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(6, 0.15, 6).setTranslation(0, 6, 0));

    this.createPhone(new Vector3());
    this.syncPoses();
  }

  /** Build a fresh assembly without disturbing any already-simulated objects. */
  private createPhone(offset: Vector3): void {
    const base = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -0.22).multiply(base);
    const anchor0 = new Vector3(PHONE.width / 2 + PHONE.gap / 2, 0, PHONE.hingeZ);
    const anchor1 = new Vector3(-PHONE.width / 2 - PHONE.gap / 2, 0, PHONE.hingeZ);
    const p0 = new Vector3(-PHONE.width / 2 - PHONE.gap / 2, 0.12, 0).applyAxisAngle(new Vector3(0, 1, 0), -0.22).add(offset);
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
    this.poses = [pose(), pose()];
    this.activeVisible = [true, true];
    this.currentPhone = {
      id: ++this.phoneSerial, bodies: this.bodies, colliders: this.colliders, joint: this.joint,
      poses: this.poses, visible: this.activeVisible,
      damage: { screen: 100, hinge: 100, broken: false }, detachedAt: Infinity,
    };
    this.colliders.forEach((collider, i) => this.allColliderOwners.set(collider.handle, { phone: this.currentPhone, half: i as HalfId }));
    this.allColliderOwners.set(rearCamera.handle, { phone: this.currentPhone, half: 0, camera: true });
  }

  setGrip(grip: Grip): void {
    if (!this.activeVisible[grip.half]) return;
    this.grips.set(grip.id, grip);
    this.bodies[grip.half].wakeUp();
  }
  releaseGrip(id: number): void { this.grips.delete(id); }
  releaseAll(): void { this.grips.clear(); }

  /** Leave the old assembly on the table, including its inertia, damage and remaining pieces. */
  replace(): boolean {
    if (this.retiredPhones.length >= 6) return false;
    const offset = this.findSpawnOffset();
    if (!offset) return false;
    this.releaseAll();
    for (const body of this.bodies) {
      // A released spring must not remain as a persistent external force on a retired body.
      body.resetForces(false); body.resetTorques(false);
    }
    this.currentPhone.joint = this.joint;
    this.oldPhones.push(this.currentPhone);
    this.retiredPhones.push(this.currentPhone);
    this.colliderOwners.clear();
    this.createPhone(offset);
    this.lastScreen = 100;
    this.strain = 0;
    this.syncPoses();
    return true;
  }

  /** Explicit cleanup removes only earlier phones and loose fragments; the current damage is unchanged. */
  clearDesk(): void {
    for (const phone of this.oldPhones) {
      if (phone.joint) this.world.removeImpulseJoint(phone.joint, true);
      for (const body of phone.bodies) this.world.removeRigidBody(body);
    }
    for (const fragment of this.fragmentBodies) this.world.removeRigidBody(fragment.body);
    this.oldPhones = [];
    this.retiredPhones = [];
    this.fragmentBodies = [];
    this.fragments = [];
    for (const [handle, owner] of this.allColliderOwners) {
      if (owner.phone !== this.currentPhone) this.allColliderOwners.delete(handle);
    }
    this.pairFeedback.clear();
    this.syncPoses();
  }

  private findSpawnOffset(): Vector3 | null {
    const existing: RAPIER.Collider[] = [];
    this.world.colliders.forEach(c => {
      if (c.isEnabled() && (c.parent()?.isEnabled() ?? true)) existing.push(c);
    });
    // The extra depth includes the protruding rear cameras as well as a small separation margin.
    const shape = new RAPIER.Cuboid(PHONE.width / 2 + .012, PHONE.height / 2 + .012,
      PHONE.thickness / 2 + CAMERA.lensProtrusion + .012);
    const base = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
    const q0 = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -.22).multiply(base);
    const q1 = q0.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -.18));
    const candidates: Vector3[] = [];
    for (const x of [0, -.8, .8, -1.6, 1.6]) for (const z of [0, -.7, .7, -1.4, 1.4]) candidates.push(new Vector3(x, 0, z));
    candidates.sort((a, b) => a.lengthSq() - b.lengthSq());
    for (let lift = 0; lift <= 2.1; lift += .07) {
      for (const horizontal of candidates) {
        const offset = horizontal.clone().setY(lift);
        const p0 = new Vector3(-PHONE.width / 2, .12, 0).applyAxisAngle(new Vector3(0, 1, 0), -.22).add(offset);
        const hinge = new Vector3(PHONE.width / 2, 0, PHONE.hingeZ).applyQuaternion(q0).add(p0);
        const p1 = hinge.sub(new Vector3(-PHONE.width / 2, 0, PHONE.hingeZ).applyQuaternion(q1));
        if (existing.every(c => !c.contactShape(shape, p0, q0, 0) && !c.contactShape(shape, p1, q1, 0))) return offset;
      }
    }
    return null;
  }

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
    const before = this.bodies.map(b => ({ velocity: v3(b.linvel()), angular: v3(b.angvel()), position: v3(b.translation()) }));
    const allBefore = new Map<number, BeforeMotion>();
    for (const owner of this.allColliderOwners.values()) {
      const body = owner.fragment?.body ?? owner.phone!.bodies[owner.half];
      if (body.isEnabled() && !allBefore.has(body.handle)) allBefore.set(body.handle, {
        velocity: v3(body.linvel()), angular: v3(body.angvel()), position: v3(body.translation()),
      });
    }
    const hingeAxis = new Vector3(0, 1, 0).applyQuaternion(this.poses[0].quaternion);
    const angleBefore = this.foldAngle();
    let relativeTorque = 0;
    let springLoad = 0;
    for (const body of this.bodies) {
      body.resetForces(false);
      body.resetTorques(false);
    }
    for (const grip of this.grips.values()) {
      if (!this.activeVisible[grip.half]) continue;
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
    const detail = this.collectContacts(allBefore, dt);
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
      speed: Math.max(0, ...this.bodies.map((b, half) => this.activeVisible[half] ? v3(b.linvel()).length() : 0)),
      contacts: detail.contacts, scrape: detail.scrape, fractures: detail.fractures,
    };
  }

  /** Read manifolds after solving; this observational path never changes the legacy damage sample. */
  private collectContacts(before: Map<number, BeforeMotion>, dt: number): {
    contacts: ContactSample[]; scrape?: ContactSample; fractures: ContactSample[];
  } {
    const visited = new Set<string>();
    const hits: Array<{ sample: ContactSample; owners: ColliderOwner[] }> = [];
    let scrape: ContactSample | undefined;
    for (const [handle, originalOwner] of this.allColliderOwners) {
      const original = this.world.getCollider(handle);
      const originalBody = originalOwner.fragment?.body ?? originalOwner.phone!.bodies[originalOwner.half];
      if (!original || !originalBody.isEnabled()) continue;
      this.world.contactPairsWith(original, partner => {
        const key = [handle, partner.handle].sort((a, b) => a - b).join(':');
        if (visited.has(key)) return;
        visited.add(key);
        let own = original, other = partner, owner = originalOwner;
        const partnerOwner = this.allColliderOwners.get(partner.handle);
        // A phone/fragment collision is represented once, favouring the currently held phone.
        if (partnerOwner && ((partnerOwner.phone === this.currentPhone && owner.phone !== this.currentPhone)
          || (owner.fragment && partnerOwner.phone))) {
          own = partner; other = original; owner = partnerOwner;
        }
        const body = owner.fragment?.body ?? owner.phone!.bodies[owner.half];
        const motion = before.get(body.handle);
        if (!motion) return;
        let strongest: ContactSample | undefined;
        this.world.contactPair(own, other, (manifold, flipped) => {
          if (manifold.numSolverContacts() === 0) return;
          const normal = v3(manifold.normal()).multiplyScalar(flipped ? -1 : 1).normalize();
          let impulse = 0;
          for (let i = 0; i < manifold.numContacts(); i++) impulse += Math.max(0, manifold.contactImpulse(i));
          if (impulse <= .00001) return;
          const otherBody = other.parent();
          const otherMotion = otherBody ? before.get(otherBody.handle) : undefined;
          for (let i = 0; i < manifold.numSolverContacts(); i++) {
            if (manifold.solverContactDist(i) > .004) continue;
            const point = v3(manifold.solverContactPoint(i));
            const velocity = motion.angular.clone().cross(point.clone().sub(motion.position)).add(motion.velocity);
            if (otherMotion) velocity.sub(otherMotion.angular.clone().cross(point.clone().sub(otherMotion.position)).add(otherMotion.velocity));
            const normalSpeed = velocity.dot(normal);
            const tangentialSpeed = velocity.clone().addScaledVector(normal, -normalSpeed).length();
            const sample: ContactSample = {
              id: 0, half: owner.half, material: this.contactMaterial(owner, normal),
              point, normal, table: other.handle === this.floorHandle,
              speed: Math.max(0, normalSpeed), tangentialSpeed, impulse, fragment: !!owner.fragment,
            };
            if (!strongest || sample.speed > strongest.speed || (sample.speed === strongest.speed && sample.tangentialSpeed > strongest.tangentialSpeed)) strongest = sample;
          }
        });
        if (!strongest) return;
        const sample = strongest as ContactSample;
        const previous = this.pairFeedback.get(key);
        const newlyTouching = !previous || this.time - previous.lastSeen > dt * 1.6;
        const pair = previous ?? { id: ++this.contactSerial, lastSeen: -Infinity, lastHit: -Infinity, lastSpeed: 0 };
        const retrigger = sample.speed > pair.lastSpeed + .55 && this.time - pair.lastHit > .09;
        if (sample.speed > .2 && this.time - pair.lastHit > .075 && (newlyTouching || retrigger)) {
          sample.id = ++this.contactSerial;
          pair.lastHit = this.time;
          const otherOwner = this.allColliderOwners.get(other.handle);
          hits.push({ sample, owners: [owner, ...(otherOwner ? [otherOwner] : [])] });
        }
        pair.lastSeen = this.time;
        pair.lastSpeed = sample.speed;
        this.pairFeedback.set(key, pair);
        if (sample.tangentialSpeed > .12 && sample.speed < .8 && (!scrape || sample.tangentialSpeed > scrape.tangentialSpeed)) {
          scrape = { ...sample, id: pair.id };
        }
      });
    }
    const fractures: ContactSample[] = [];
    for (const hit of hits) this.applySecondaryDamage(hit.sample, hit.owners, fractures);
    for (const [key, pair] of this.pairFeedback) if (this.time - pair.lastSeen > 2) this.pairFeedback.delete(key);
    this.syncPoses();
    return { contacts: hits.map(hit => hit.sample).sort((a, b) => b.speed - a.speed).slice(0, 12), scrape, fractures };
  }

  private contactMaterial(owner: ColliderOwner, normal: Vector3): ContactMaterial {
    if (owner.fragment) return owner.fragment.material;
    if (owner.camera) return 'metal';
    const local = normal.clone().applyQuaternion(owner.phone!.poses[owner.half].quaternion.clone().invert());
    if (Math.abs(local.z) < .72) return 'metal';
    return local.z > 0 || owner.half === 1 ? 'glass' : 'back';
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
    Object.assign(this.currentPhone.damage, { screen: damage.screen, hinge: damage.hinge, broken: damage.broken });
    this.joint?.configureMotorVelocity(0, 0.008 + damage.hinge / 100 * 0.017);
  }

  breakHinge(): void {
    if (!this.joint) return;
    this.detach(this.currentPhone);
    this.joint = null;
  }

  private detach(phone: PhoneRecord): void {
    if (!phone.joint) return;
    this.world.removeImpulseJoint(phone.joint, true);
    phone.joint = null;
    phone.damage.broken = true;
    phone.detachedAt = this.time;
    if (phone === this.currentPhone) this.joint = null;
    this.spawnFragments(12, phone);
    phone.bodies.forEach(body => body.wakeUp());
  }

  private applySecondaryDamage(sample: ContactSample, owners: ColliderOwner[], fractures: ContactSample[]): void {
    const damaged = new Set<number>();
    for (const [index, owner] of owners.entries()) {
      const normal = index === 0 ? sample.normal : sample.normal.clone().negate();
      const ownContact = { ...sample, normal, half: owner.half, material: this.contactMaterial(owner, normal) };
      const phone = owner.phone;
      if (phone && phone !== this.currentPhone && !damaged.has(phone.id) && sample.speed > 5 && sample.impulse > .08) {
        damaged.add(phone.id);
        const excess = sample.speed - 5;
        const previous = phone.damage.screen;
        phone.damage.screen = Math.max(0, phone.damage.screen - excess * excess * 2.4);
        phone.damage.hinge = Math.max(0, phone.damage.hinge - excess * excess * .85);
        if ((previous > 65 && phone.damage.screen <= 65) || (previous > 25 && phone.damage.screen <= 25)) this.spawnFragments(4, phone);
        if (phone.damage.hinge === 0) this.detach(phone);
      }
      if (phone?.damage.broken && phone.visible[owner.half] && this.time - phone.detachedAt > .22 && sample.speed > 5.2 && sample.impulse > .14) {
        if (this.fractureHalf(phone, owner.half, ownContact)) fractures.push({ ...ownContact, id: ++this.contactSerial, fragment: false });
      }
      const fragment = owner.fragment;
      if (fragment && this.fragmentBodies.includes(fragment) && this.time - fragment.createdAt > .22
        && fragment.generation < 3 && Math.max(fragment.size.x, fragment.size.y) > .12 && sample.speed > 5.2 && sample.impulse > .025) {
        if (this.fractureFragment(fragment, ownContact)) fractures.push({ ...ownContact, id: ++this.contactSerial, fragment: true });
      }
    }
  }

  private random(): number {
    this.seed = (Math.imul(1664525, this.seed) + 1013904223) >>> 0;
    return this.seed / 0x100000000;
  }

  private spawnFragments(count: number, phone = this.currentPhone): void {
    let decorative = this.fragmentBodies.filter(fragment => fragment.generation === 0).length;
    // Keep half the shared budget available for structural chunks and their later subdivision.
    for (let i = 0; i < count && this.fragments.length < MAX_FRAGMENTS && decorative < 12; i++) {
      const half = (i % 2) as HalfId;
      if (!phone.visible[half]) continue;
      const transform = phone.poses[half];
      const location = new Vector3((this.random() - 0.5) * PHONE.width * 0.8, (this.random() - 0.5) * PHONE.height * 0.8, PHONE.thickness)
        .applyQuaternion(transform.quaternion).add(transform.position);
      location.y = Math.max(location.y, 0.06);
      this.addFragment(location, transform.quaternion, new Vector3(.05, .07, .012), 'glass', 0, half,
        v3(phone.bodies[half].linvel()).multiplyScalar(.4).add(new Vector3((this.random() - .5) * 1.5, this.random() + .4, (this.random() - .5) * 1.5)),
        new Vector3(this.random() * 8, this.random() * 8, this.random() * 8), .003);
      decorative++;
    }
  }

  private addFragment(position: Vector3, quaternion: Quaternion, size: Vector3, material: ContactMaterial,
    generation: number, half: HalfId, velocity: Vector3, angular: Vector3, mass: number): void {
    if (this.fragments.length >= MAX_FRAGMENTS) return;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z).setRotation(quaternion)
      .setCcdEnabled(true).setLinearDamping(.3).setAngularDamping(.35));
    const collider = this.world.createCollider(RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
      .setMass(mass).setFriction(.6).setRestitution(.25), body);
    body.setLinvel(velocity, true); body.setAngvel(angular, true);
    const id = ++this.fragmentSerial;
    const fragmentPose: FragmentPose = { position: position.clone(), quaternion: quaternion.clone(), id, material, size: size.clone(), generation };
    const record: FragmentRecord = { id, half, body, collider, pose: fragmentPose, material, size, generation, createdAt: this.time };
    this.fragmentBodies.push(record); this.fragments.push(fragmentPose);
    this.allColliderOwners.set(collider.handle, { half, fragment: record });
  }

  private fractureHalf(phone: PhoneRecord, half: HalfId, contact: ContactSample): boolean {
    const count = Math.min(4, MAX_FRAGMENTS - this.fragments.length);
    if (count < 2) return false;
    const body = phone.bodies[half];
    const transform = phone.poses[half];
    const velocity = v3(body.linvel()), angular = v3(body.angvel());
    const columns = count === 4 ? 2 : count, rows = count === 4 ? 2 : 1;
    const size = new Vector3(PHONE.width / columns * .94, PHONE.height / rows * .94, PHONE.thickness * .8);
    for (let i = 0; i < count; i++) {
      const offset = new Vector3(((i % columns + .5) / columns - .5) * PHONE.width,
        ((Math.floor(i / columns) + .5) / rows - .5) * PHONE.height, 0).applyQuaternion(transform.quaternion);
      const location = transform.position.clone().add(offset); location.y = Math.max(location.y, size.z / 2 + .012);
      const material: ContactMaterial = i % 3 === 0 ? 'metal' : (i % 3 === 1 || half === 1 ? 'glass' : 'back');
      const kick = contact.normal.clone().multiplyScalar(-.15).add(new Vector3((this.random() - .5) * .15, .12, (this.random() - .5) * .15));
      this.addFragment(location, transform.quaternion, size.clone(), material, 1, half,
        angular.clone().cross(offset).add(velocity).add(kick), angular.clone().multiplyScalar(.7), .18 / count);
    }
    phone.visible[half] = false;
    body.resetForces(false); body.resetTorques(false); body.setEnabled(false);
    if (phone === this.currentPhone) for (const [id, grip] of this.grips) if (grip.half === half) this.releaseGrip(id);
    for (const [handle, owner] of this.allColliderOwners) {
      if (owner.phone === phone && owner.half === half) {
        this.allColliderOwners.delete(handle); this.colliderOwners.delete(handle);
      }
    }
    return true;
  }

  private fractureFragment(fragment: FragmentRecord, contact: ContactSample): boolean {
    if (this.fragments.length >= MAX_FRAGMENTS) return false;
    const size = fragment.size.clone();
    const splitX = size.x >= size.y;
    const axis = splitX ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
    const extent = splitX ? size.x : size.y;
    if (splitX) size.x *= .47; else size.y *= .47;
    const position = fragment.pose.position.clone(), quaternion = fragment.pose.quaternion.clone();
    const velocity = v3(fragment.body.linvel()), angular = v3(fragment.body.angvel()), mass = fragment.body.mass() / 2;
    this.allColliderOwners.delete(fragment.collider.handle);
    this.world.removeRigidBody(fragment.body);
    this.fragmentBodies.splice(this.fragmentBodies.indexOf(fragment), 1);
    this.fragments.splice(this.fragments.indexOf(fragment.pose), 1);
    for (const sign of [-1, 1]) {
      const offset = axis.clone().multiplyScalar(sign * extent / 4).applyQuaternion(quaternion);
      const kick = contact.normal.clone().multiplyScalar(-.08).add(new Vector3(sign * .06, .08, 0));
      this.addFragment(position.clone().add(offset), quaternion, size.clone(), fragment.material, fragment.generation + 1, fragment.half,
        angular.clone().cross(offset).add(velocity).add(kick), angular.clone().multiplyScalar(.75), mass);
    }
    return true;
  }

  private syncPoses(): void {
    for (const phone of [this.currentPhone, ...this.oldPhones]) phone.bodies.forEach((body, i) => {
      phone.poses[i].position.copy(body.translation());
      phone.poses[i].quaternion.copy(body.rotation());
      if (i === 1) phone.poses[i].quaternion.multiply(RIGHT_MODEL_FRAME);
    });
    this.fragmentBodies.forEach(fragment => {
      fragment.pose.position.copy(fragment.body.translation());
      fragment.pose.quaternion.copy(fragment.body.rotation());
    });
  }

  dispose(): void { this.releaseAll(); this.queue.free(); this.world.free(); }
}
