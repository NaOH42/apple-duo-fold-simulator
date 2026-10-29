import test from 'node:test';
import assert from 'node:assert/strict';
import { GameRules } from '../src/rules';
import type { PhysicsSample } from '../src/types';

const sample = (angle = 180, overrides: Partial<PhysicsSample> = {}): PhysicsSample => ({
  angle, angularSpeed: 0, strain: .1, impact: 0, hardStop: 0, speed: 0, ...overrides,
});
const tick = (rules: GameRules, angle = 180, extra: Partial<PhysicsSample> = {}) => rules.step(sample(angle, extra), 1 / 120);
const fold = (rules: GameRules) => { tick(rules, 180); tick(rules, 20); tick(rules, 160); };

test('initial angle, half folds and endpoint jitter do not give free cycles', () => {
  const r = new GameRules();
  [20, 20, 180, 150, 154, 156, 26, 30, 180].forEach(a => tick(r, a));
  assert.equal(r.state.folds, 0);
  tick(r, 24); tick(r, 155);
  assert.equal(r.state.folds, 1);
});

test('100 safe cycles and 60 seconds resting preserve health', () => {
  const r = new GameRules();
  r.reset('challenge');
  for (let i = 0; i < 100; i++) fold(r);
  for (let i = 0; i < 7200; i++) tick(r);
  assert.equal(r.state.folds, 100);
  assert.equal(r.state.screen, 100);
  assert.equal(r.state.hinge, 100);
  assert.equal(r.state.multiplier, 1);
});

test('clean bonus, multiplier cap and a pause follow the stated score', () => {
  const r = new GameRules();
  fold(r);
  assert.equal(r.state.score, 125);
  fold(r);
  assert.equal(r.state.score, 125 + 138);
  for (let i = 0; i < 12; i++) fold(r);
  assert.equal(r.state.multiplier, 2);
  for (let i = 0; i < 725; i++) tick(r);
  const before = r.state.score;
  fold(r);
  assert.equal(r.state.score - before, 125);
});

test('unsafe but non damaging force loses the clean bonus', () => {
  const r = new GameRules();
  tick(r, 180); tick(r, 20, { strain: .8 }); tick(r, 160);
  assert.equal(r.state.score, 100);
  assert.equal(r.state.hinge, 100);
});

test('damage breaks the chain even when the same step completes a fold', () => {
  const r=new GameRules(); fold(r); fold(r);
  assert.equal(r.state.multiplier,1.1);
  tick(r,20);
  const before=r.state.score;
  tick(r,160,{impact:6});
  assert.equal(r.state.multiplier,1);
  assert.equal(r.state.score-before,100);
});

test('normal movements and resting contacts do not hurt; hard stops and speed do', () => {
  const r = new GameRules();
  for (let i = 0; i < 240; i++) tick(r, 180, { angularSpeed: 10, impact: 2, strain: .8 });
  assert.equal(r.state.hinge, 100);
  tick(r, 175, { hardStop: 3 });
  assert.ok(r.state.hinge < 100);
  const hinge = r.state.hinge;
  tick(r, 25, { angularSpeed: 25 });
  assert.ok(r.state.hinge < hinge);
});

test('banking keeps base score and adds the health weighted bonus once', () => {
  const r = new GameRules(); r.reset('challenge'); fold(r);
  r.state.hinge = 50;
  const result = r.finish()!;
  assert.equal(result.baseScore, 125);
  assert.equal(result.bonus, 13);
  assert.equal(result.score, 138);
  assert.equal(r.finish(), result);
  tick(r, 0, { impact: 20 });
  assert.equal(r.state.score, 125);
});

test('screen failure ends a challenge without detaching intact hinge or bonus', () => {
  const r = new GameRules(); r.reset('challenge'); fold(r);
  tick(r, 80, { impact: 12 });
  assert.equal(r.state.screen, 0);
  assert.equal(r.state.broken, false);
  assert.equal(r.state.running, false);
  assert.equal(r.state.result?.reason, 'screen');
  assert.equal(r.state.result?.score, 125);
  assert.equal(r.state.result?.bonus, 0);
});

test('free mode may break and keeps running without saving challenge records', () => {
  const r = new GameRules();
  const priorBest = r.state.bestScore;
  fold(r); tick(r, 20, { impact: 30 });
  assert.equal(r.state.broken, true);
  assert.equal(r.state.running, true);
  assert.equal(r.state.result, null);
  assert.equal(r.state.bestScore, priorBest);
  assert.equal(r.finish(), null);
});

test('reset clears damage, half cycle, result and timing', () => {
  const r = new GameRules(); r.reset('challenge');
  fold(r); tick(r, 20); r.finish(); r.reset('challenge');
  assert.equal(r.state.score, 0); assert.equal(r.state.folds, 0);
  assert.equal(r.state.result, null); assert.equal(r.state.hinge, 100);
  tick(r, 180); assert.equal(r.state.folds, 0);
});

test('damage integration is consistent at 30, 60 and 120 steps per second', () => {
  const remaining = [30, 60, 120].map(fps => {
    const r = new GameRules();
    for (let i = 0; i < fps; i++) r.step(sample(90, { angularSpeed: 15, hardStop: 1.3 }), 1 / fps);
    return r.state.hinge;
  });
  assert.ok(Math.abs(remaining[0] - remaining[2]) < 1e-8);
  assert.ok(Math.abs(remaining[1] - remaining[2]) < 1e-8);
});

test('persisted records are validated, and blocked storage does not stop play', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: () => JSON.stringify({ version: 1, bestScore: -5, bestFolds: '999', sound: false }),
      setItem: () => { throw new Error('Storage blocked'); },
    } });
    const r = new GameRules();
    assert.equal(r.state.bestScore, 0); assert.equal(r.state.bestFolds, 0);
    assert.equal(r.state.sound, false);
    r.reset('challenge'); fold(r); r.finish();
    assert.equal(r.state.bestScore, 150);
    r.toggleSound(); assert.equal(r.state.sound, true);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
