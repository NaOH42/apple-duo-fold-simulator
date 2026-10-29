import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { DuoFeedback } from '../src/feedback';
import type { PhysicsSample, ContactSample } from '../src/types';

const healthy = { screen: 100, hinge: 100, broken: false };
const sample = (angle = 180, extra: Partial<PhysicsSample> = {}): PhysicsSample => ({
  angle, angularSpeed: 0, strain: 0, impact: 0, hardStop: 0, speed: 0, contacts: [], ...extra,
});
const contact = (id: number): ContactSample => ({ id, half: 0, material: 'glass', point: new Vector3(), normal: new Vector3(0, 1, 0),
  table: true, speed: .8, tangentialSpeed: 0, impulse: .1 });

test('idle and initial endpoints never create a mechanical cue', () => {
  const f = new DuoFeedback();
  for (let i = 0; i < 600; i++) assert.deepEqual(f.step(sample(), healthy, [], 1 / 120), []);
  assert.equal(f.frame.angularSpeed, 0);
  f.reset(); assert.deepEqual(f.step(sample(0), healthy, [], 1 / 120), []);
});

test('only a real endpoint approach cues once; small angle jitter cannot chatter', () => {
  const f = new DuoFeedback(); const kinds: string[] = [];
  for (const angle of [180, 150, 80, 20, 6, 3, 7, 5, 8, 6, 25, 80, 160, 175, 172, 176, 174]) {
    kinds.push(...f.step(sample(angle, { angularSpeed: 2 }), healthy, [], .02).map(e => e.kind));
  }
  assert.deepEqual(kinds, ['close', 'open']);
});

test('a light physical contact is audible without requiring damage or score events', () => {
  const f = new DuoFeedback(); const c = contact(1);
  const events = f.step(sample(90, { contacts: [c] }), healthy, [], .01);
  assert.equal(events[0].kind, 'impact'); assert.ok(events[0].strength > 0 && events[0].strength < .25);
  assert.equal(events[0].point, c.point); assert.equal(events[0].material, 'glass');
  assert.deepEqual(f.step(sample(90, { contacts: [c] }), healthy, [], .01), []);
});

test('fractures and loose pieces have their own cue, broken hinges cannot make endpoint clicks', () => {
  const f = new DuoFeedback(); f.step(sample(180), healthy, [], .01);
  const c = contact(8); c.fragment = true;
  const events = f.step(sample(0, { contacts: [c] }), { ...healthy, broken: true }, ['break'], .01);
  assert.deepEqual(events.map(e => e.kind), ['break', 'chip']);
  assert.equal(f.frame.angularSpeed, 0);
});

test('reset clears endpoint history and score folds do not make electronic pings', () => {
  const f = new DuoFeedback(); f.step(sample(90), healthy, [], .01); f.reset();
  assert.deepEqual(f.step(sample(180), healthy, ['fold'], .01), []);
  assert.deepEqual(f.step(sample(180), healthy, [], -1), []);
});
