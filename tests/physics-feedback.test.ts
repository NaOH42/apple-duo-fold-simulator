import test from 'node:test';
import assert from 'node:assert/strict';
import type { RigidBody } from '@dimforge/rapier3d-compat';
import { PerspectiveCamera, Vector3 } from 'three';
import { DuoPhysics } from '../src/physics';
import { FIXED_DT } from '../src/config';
import { GameRules } from '../src/rules';
import type { ContactSample, FragmentPose } from '../src/types';

const advance = (sim: DuoPhysics, count: number) => {
  for (let i = 0; i < count; i++) sim.step(FIXED_DT);
};

test('light real contacts provide separate material feedback without changing durability', async () => {
  const sim = await DuoPhysics.create(); const rules = new GameRules(); rules.reset('challenge');
  const contacts: ContactSample[] = [];
  for (let i = 0; i < 360; i++) {
    const sample = sim.step(FIXED_DT); rules.step(sample, FIXED_DT);
    contacts.push(...sample.contacts ?? []);
  }
  assert.ok(contacts.some(c => c.speed > .2 && c.speed < 5));
  assert.ok(contacts.some(c => c.material === 'metal'), 'protruding camera/edge contact has a metal response');
  assert.ok(contacts.some(c => c.material === 'glass'));
  assert.ok(contacts.some(c => c.material === 'back'));
  assert.ok(contacts.every(c => c.table && Math.abs(c.point.y) < .02 && c.normal.y < -.9));
  assert.equal(new Set(contacts.map(c => c.id)).size, contacts.length);
  assert.equal(rules.state.screen, 100); assert.equal(rules.state.hinge, 100);
  sim.dispose();
});

test('settled phones stay silent and actual sliding produces only a finite scrape', async () => {
  const sim = await DuoPhysics.create(); advance(sim, 360);
  for (let i = 0; i < 240; i++) {
    const sample = sim.step(FIXED_DT);
    assert.equal(sample.contacts?.length, 0); assert.equal(sample.scrape, undefined);
  }
  for (const body of sim.bodies) body.setLinvel({ x: 1, y: 0, z: 0 }, true);
  const scrapes: ContactSample[] = [];
  for (let i = 0; i < 120; i++) {
    const sample = sim.step(FIXED_DT); if (sample.scrape) scrapes.push(sample.scrape);
  }
  assert.ok(scrapes.length > 0 && scrapes.length < 120);
  assert.ok(scrapes.every(c => c.table && c.tangentialSpeed > .12));
  advance(sim, 360);
  const settled = sim.step(FIXED_DT);
  assert.equal(settled.scrape, undefined); assert.equal(settled.contacts?.length, 0);
  sim.dispose();
});

test('a real side-wall collision never becomes a table contact', async () => {
  const sim = await DuoPhysics.create(); sim.world.gravity = { x: 0, y: 0, z: 0 };
  for (const body of sim.bodies) {
    const p = body.translation(); body.setTranslation({ x: p.x, y: p.y + 2, z: p.z }, true);
    body.setLinvel({ x: 7, y: 0, z: 0 }, true);
  }
  const contacts: ContactSample[] = [];
  for (let i = 0; i < 150; i++) contacts.push(...sim.step(FIXED_DT).contacts ?? []);
  assert.ok(contacts.length > 0);
  assert.ok(contacts.every(c => !c.table && c.point.y > 1));
  assert.ok(contacts.some(c => c.material === 'metal' && Math.abs(c.normal.x) > .9));
  sim.dispose();
});

test('replacement archives the physical assembly and its damage without repairing or overlapping it', async () => {
  const sim = await DuoPhysics.create(); advance(sim, 240);
  const gameplayState = { screen: 35, hinge: 45, broken: false, mode: 'free', score: 900, sound: true };
  sim.setDamage(gameplayState); advance(sim, 180);
  const oldBodies = [...sim.bodies], oldPoses = sim.poses, oldFragments = sim.fragments.length;
  assert.equal(sim.replace(), true);
  assert.equal(sim.retiredPhones.length, 1);
  const old = sim.retiredPhones[0];
  assert.equal(old.poses, oldPoses);
  assert.deepEqual(old.damage, { screen: 35, hinge: 45, broken: false });
  assert.deepEqual(Object.keys(old.damage).sort(), ['broken', 'hinge', 'screen']);
  assert.ok(oldBodies.every(b => b.isEnabled()));
  assert.ok(sim.bodies.every(b => !oldBodies.some(oldBody => oldBody.handle === b.handle)));
  assert.equal(sim.fragments.length, oldFragments);
  for (const newBody of sim.bodies) for (const oldBody of oldBodies) {
    for (let i = 0; i < newBody.numColliders(); i++) for (let j = 0; j < oldBody.numColliders(); j++) {
      assert.ok((newBody.collider(i).contactCollider(oldBody.collider(j), 0)?.distance ?? 0) >= 0);
    }
  }
  const rules = new GameRules(); rules.reset('challenge');
  for (let i = 0; i < 240; i++) rules.step(sim.step(FIXED_DT), FIXED_DT);
  assert.equal(rules.state.screen, 100); assert.equal(rules.state.hinge, 100);
  assert.equal(sim.retiredPhones[0].id, old.id);
  sim.dispose();
});

test('portrait spawn bounds, six-phone archive cap and explicit desk cleanup preserve the current phone', async () => {
  const sim = await DuoPhysics.create();
  const camera = new PerspectiveCamera(35, 390 / 844, .05, 80);
  camera.position.set(3, 4.5, 5.8); camera.lookAt(0, .25, 0);
  const distance = camera.position.distanceTo(new Vector3(0, .25, 0));
  camera.fov = 2 * Math.atan((2.35 / camera.aspect) / (2 * distance)) * 180 / Math.PI;
  camera.updateProjectionMatrix(); sim.setViewBounds(camera);
  advance(sim, 240);
  for (let i = 0; i < 6; i++) assert.equal(sim.replace(), true, `replacement ${i + 1}`);
  const handles = sim.bodies.map(body => body.handle);
  const retiredIds = sim.retiredPhones.map(phone => phone.id);
  assert.equal(new Set(retiredIds).size, 6);
  assert.equal(sim.replace(), false);
  assert.deepEqual(sim.bodies.map(body => body.handle), handles);
  assert.deepEqual(sim.retiredPhones.map(phone => phone.id), retiredIds);
  sim.setDamage({ screen: 47, hinge: 62, broken: false });
  sim.clearDesk();
  assert.equal(sim.retiredPhones.length, 0); assert.equal(sim.fragments.length, 0);
  assert.equal(sim.world.bodies.len(), 2); assert.deepEqual(sim.activeVisible, [true, true]);
  assert.deepEqual(sim.bodies.map(body => body.handle), handles);
  assert.ok(sim.replace(), 'cleanup frees archive capacity');
  assert.deepEqual(sim.retiredPhones[0].damage, { screen: 47, hinge: 62, broken: false });
  sim.dispose();
});

test('a damaged detached half can fracture on a later real hit, and a resulting chunk can fracture again', async () => {
  const sim = await DuoPhysics.create(); advance(sim, 240);
  sim.setDamage({ screen: 0, hinge: 0, broken: true }); advance(sim, 120);
  assert.equal(sim.fragments.length, 12, 'small decorative glass reserves structural capacity');
  const half = sim.bodies[0];
  const position = half.translation();
  half.setTranslation({ x: position.x, y: position.y + 2.7, z: position.z }, true);
  half.setLinvel({ x: 0, y: 0, z: 0 }, true); half.setAngvel({ x: 0, y: 0, z: 0 }, true);
  const fractureIds: number[] = [];
  for (let i = 0; i < 300; i++) fractureIds.push(...(sim.step(FIXED_DT).fractures ?? []).map(c => c.id));
  assert.equal(sim.activeVisible[0], false); assert.equal(half.isEnabled(), false);
  assert.ok(Number.isFinite(half.translation().x), 'the active tuple retains a readable disabled body');
  assert.ok(sim.fragments.some(f => f.generation === 1 && f.size && f.size.y > .2));
  const chunk = sim.fragments.find(f => f.generation === 1)!;
  const chunkBody = findFragmentBody(sim, chunk);
  const oldId = chunk.id;
  chunkBody.setTranslation({ x: 0, y: 3, z: 0 }, true);
  chunkBody.setLinvel({ x: 0, y: -1, z: 0 }, true); chunkBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
  for (let i = 0; i < 300; i++) fractureIds.push(...(sim.step(FIXED_DT).fractures ?? []).map(c => c.id));
  assert.ok(!sim.fragments.some(f => f.id === oldId));
  assert.ok(sim.fragments.some(f => f.generation === 2));
  assert.ok(sim.fragments.length <= 24); assert.equal(new Set(fractureIds).size, fractureIds.length);
  assert.ok(sim.fragments.every(f => f.size && f.material && f.id));
  const remaining = [...sim.activeVisible]; sim.clearDesk();
  assert.deepEqual(sim.activeVisible, remaining, 'cleanup does not recreate the vanished half');
  assert.equal(sim.fragments.length, 0); assert.equal(sim.world.bodies.len(), 2);
  assert.ok(sim.replace());
  assert.equal(sim.retiredPhones[0].damage.screen, 0);
  assert.equal(sim.retiredPhones[0].damage.broken, true);
  assert.deepEqual(sim.retiredPhones[0].visible, remaining);
  sim.dispose();
});

test('retired hits damage only their own snapshot and fractured material remains physical', async () => {
  const sim = await DuoPhysics.create(); advance(sim, 240);
  const oldBodies = [...sim.bodies]; sim.replace(); advance(sim, 240);
  const old = sim.retiredPhones[0]; const id = old.id;
  for (const body of oldBodies) {
    const p = body.translation(); body.setTranslation({ x: p.x - 2, y: 3.6, z: p.z }, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true); body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }
  const rules = new GameRules(); rules.reset('challenge');
  for (let i = 0; i < 360; i++) rules.step(sim.step(FIXED_DT), FIXED_DT);
  assert.equal(old.id, id); assert.ok(old.damage.screen < 100);
  assert.equal(rules.state.screen, 100); assert.equal(rules.state.hinge, 100);
  sim.dispose();
});

function findFragmentBody(sim: DuoPhysics, fragment: FragmentPose): RigidBody {
  let found: RigidBody | undefined;
  sim.world.bodies.forEach(body => {
    if (sim.bodies.some(half => half.handle === body.handle)) return;
    const p = body.translation();
    if (fragment.position.distanceTo(new Vector3(p.x, p.y, p.z)) < 1e-6) found = body;
  });
  assert.ok(found, 'public fragment pose corresponds to a real dynamic body');
  return found;
}
