import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { DuoPhysics } from '../src/physics';
import { GameRules } from '../src/rules';
import { FIXED_DT, PHONE } from '../src/config';

test('actual physics: 60 seconds at rest causes no damage or phantom folds', async () => {
  const sim = await DuoPhysics.create(); const rules = new GameRules(); rules.reset('challenge');
  let peakImpact = 0;
  for (let i = 0; i < 60 / FIXED_DT; i++) {
    const sample = sim.step(FIXED_DT); peakImpact = Math.max(peakImpact, sample.impact);
    rules.step(sample, FIXED_DT);
  }
  assert.equal(rules.state.screen, 100); assert.equal(rules.state.hinge, 100);
  assert.equal(rules.state.folds, 0);
  assert.ok(sim.poses.every(p => p.position.y > 0 && p.position.y < .2));
  assert.ok(peakImpact < 5); sim.dispose();
});

test('actual point spring changes fold angle and releases with existing inertia', async () => {
  const sim = await DuoPhysics.create();
  for (let i = 0; i < 60; i++) sim.step(FIXED_DT);
  const local = new Vector3(-PHONE.width * .42, PHONE.height * .25, PHONE.thickness / 2);
  const initial = local.clone().applyQuaternion(sim.poses[0].quaternion).add(sim.poses[0].position);
  const grip = { id: 1, half: 0 as const, localPoint: local, localNormal: new Vector3(0, 0, 1), target: initial.clone() };
  sim.setGrip(grip);
  let minAngle = 180, maxSpeed = 0;
  for (let i = 0; i < 180; i++) {
    const t = i * FIXED_DT;
    grip.target.set(initial.x + Math.sin(t * 7) * 1.1, initial.y + 1.1 + Math.sin(t * 5) * .6, initial.z);
    const s = sim.step(FIXED_DT); minAngle = Math.min(minAngle, s.angle); maxSpeed = Math.max(maxSpeed, s.speed);
  }
  assert.ok(minAngle < 140, `hinge must respond to real off-centre force, minimum ${minAngle}`);
  assert.ok(maxSpeed > 1);
  const before = sim.bodies[0].linvel(); sim.releaseAll();
  const after = sim.bodies[0].linvel(); assert.deepEqual(after, before);
  const atRelease = sim.poses[0].position.clone(); sim.step(FIXED_DT);
  assert.ok(atRelease.distanceTo(sim.poses[0].position) > .0001);
  sim.dispose();
});

test('a high fall reports an effective impact and damages the phone', async () => {
  const sim = await DuoPhysics.create(); const rules = new GameRules(); rules.reset('challenge');
  for (const b of sim.bodies) { const p = b.translation(); b.setTranslation({ x: p.x, y: p.y + 3.5, z: p.z }, true); }
  let impact = 0;
  for (let i = 0; i < 240; i++) { const s = sim.step(FIXED_DT); impact = Math.max(impact, s.impact); rules.step(s, FIXED_DT); }
  assert.ok(impact > 5, `observed collision speed ${impact}`);
  assert.ok(rules.state.screen < 100); sim.dispose();
});

test('detachment remains physical; reset clears all grips, fragments and motion', async () => {
  const sim = await DuoPhysics.create();
  sim.setGrip({ id: 2, half: 0, localPoint: new Vector3(), localNormal: new Vector3(0, 0, 1), target: new Vector3(0, 2, 0) });
  sim.breakHinge();
  assert.equal(sim.fragments.length, 12);
  sim.bodies[1].applyImpulse({ x: 1, y: 1, z: 0 }, true);
  for (let i = 0; i < 30; i++) sim.step(FIXED_DT);
  assert.ok(sim.poses[0].position.distanceTo(sim.poses[1].position) > 1);
  sim.setDamage({ screen: 0, hinge: 0, broken: true }); assert.ok(sim.fragments.length <= 24);
  sim.reset(); assert.equal(sim.grips.size, 0); assert.equal(sim.fragments.length, 0);
  assert.equal(sim.world.bodies.len(), 2);
  assert.ok(sim.bodies.every(b => Math.hypot(b.linvel().x, b.linvel().y, b.linvel().z) === 0));
  sim.dispose();
});

test('camera-frustum walls keep a forcefully thrown phone reachable on a portrait screen', async () => {
  const sim=await DuoPhysics.create();
  const camera=new PerspectiveCamera(35,390/844,.05,80);
  camera.position.set(3,4.5,5.8); camera.lookAt(0,.25,0);
  const distance=camera.position.distanceTo(new Vector3(0,.25,0));
  camera.fov=2*Math.atan((2.35/camera.aspect)/(2*distance))*180/Math.PI;
  camera.updateProjectionMatrix(); sim.setViewBounds(camera);
  for(const b of sim.bodies) b.applyImpulse({x:2,y:1,z:1},true);
  let maxEdge=0;
  for(let i=0;i<600;i++) {
    sim.step(FIXED_DT);
    for(const pose of sim.poses) { const p=pose.position.clone().project(camera); maxEdge=Math.max(maxEdge,Math.abs(p.x),Math.abs(p.y)); }
  }
  assert.ok(maxEdge<1.05,`projected extent ${maxEdge}`);
  sim.dispose();
});
