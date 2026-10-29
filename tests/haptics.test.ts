import assert from 'node:assert/strict';
import test from 'node:test';
import { DuoHaptics, type HapticEnvironment } from '../src/haptics';
import type { FeedbackEvent } from '../src/types';

const event = (kind: FeedbackEvent['kind'], strength = .5, contactId?: number): FeedbackEvent => ({ kind, strength, contactId });

function harness(overrides: Partial<HapticEnvironment> = {}) {
  let time = 0, visible = true;
  const calls: VibratePattern[] = [];
  const saved = new Map<string, string>();
  const documentEvents = new EventTarget(), windowEvents = new EventTarget();
  const environment: HapticEnvironment = {
    supported: true, vibrate: pattern => { calls.push(pattern); return true; },
    now: () => time, visible: () => visible,
    storage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value); } },
    documentEvents, windowEvents, ...overrides,
  };
  return { environment, haptics: new DuoHaptics(environment), calls, saved, documentEvents, windowEvents,
    at: (value: number) => { time = value; }, visible: (value: boolean) => { visible = value; } };
}

test('unsupported devices, unactivated pages and hidden documents never request a pulse', () => {
  const unsupported = harness({ supported: false }); unsupported.haptics.unlock();
  assert.equal(unsupported.haptics.play([event('impact')]), false);
  assert.equal(unsupported.calls.length, 0);
  const h = harness();
  assert.equal(h.haptics.play([event('impact')]), false);
  h.haptics.unlock(); h.visible(false);
  assert.equal(h.haptics.play([event('impact')]), false);
  assert.equal(h.calls.length, 0);
  unsupported.haptics.dispose(); h.haptics.dispose();
});

test('a frame emits one highest-priority pattern with bounded fracture pulses', () => {
  const h = harness(); h.haptics.unlock();
  assert.equal(h.haptics.play([event('close'), event('impact', 1), event('break'), event('crack')]), true);
  assert.equal(h.calls.length, 1);
  assert.ok(Array.isArray(h.calls[0]));
  const pattern = h.calls[0] as number[];
  assert.ok(pattern.filter((_, i) => i % 2 === 0).reduce((sum, value) => sum + value, 0) <= 70);
  assert.ok(pattern.reduce((sum, value) => sum + value, 0) < 100);
  h.haptics.dispose();
});

test('cooldown and contact deduplication prevent vibrating on sustained or repeated contact samples', () => {
  const h = harness(); h.haptics.unlock();
  assert.equal(h.haptics.play([event('impact', .4, 7)]), true);
  h.at(80); assert.equal(h.haptics.play([event('impact', 1, 8)]), false);
  h.at(160); assert.equal(h.haptics.play([event('impact', .6, 7)]), false);
  assert.equal(h.haptics.play([event('impact', .6, 8)]), true);
  h.at(300); assert.equal(h.haptics.play([event('impact', .6, 7)]), true);
  assert.equal(h.calls.length, 3);
  h.haptics.dispose();
});

test('opening and closing feel distinct, and a harder impact lengthens the short pulse', () => {
  const h = harness(); h.haptics.unlock();
  h.haptics.play([event('open')]); h.at(200); h.haptics.play([event('close')]);
  h.at(400); h.haptics.play([event('impact', .1)]); h.at(600); h.haptics.play([event('impact', 1)]);
  assert.equal(h.calls[0], 6);
  assert.ok((h.calls[1] as number) > (h.calls[0] as number));
  assert.ok((h.calls[3] as number) > (h.calls[2] as number));
  assert.ok((h.calls[3] as number) <= 24);
  h.haptics.dispose();
});

test('tiny debris and invalid strengths do not buzz; a fracture can replace a recent light tap', () => {
  const h = harness(); h.haptics.unlock();
  assert.equal(h.haptics.play([event('impact', .01), event('chip', .1), event('crack', NaN)]), false);
  h.haptics.play([event('close')]); h.at(20);
  assert.equal(h.haptics.play([event('crack')]), true);
  h.at(40); assert.equal(h.haptics.play([event('break')]), false);
  assert.equal(h.calls.length, 2);
  h.haptics.dispose();
});

test('the independent haptic preference persists and disabling it immediately cancels the native pattern', () => {
  const h = harness(); h.haptics.unlock(); h.haptics.play([event('impact')]);
  assert.equal(h.haptics.toggle(), false);
  assert.equal(h.calls.at(-1), 0);
  assert.equal(h.haptics.enabled, false);
  assert.ok(![...h.saved.keys()].some(key => key === 'apple-duo:v1'));
  const next = new DuoHaptics(h.environment);
  assert.equal(next.enabled, false);
  next.unlock(); assert.equal(next.play([event('break')]), false);
  h.haptics.dispose(); next.dispose();
});

test('reset cancels current work, clears old contact ids and requires a fresh interaction', () => {
  const h = harness(); h.haptics.unlock(); h.haptics.play([event('impact', .5, 7)]);
  h.haptics.reset(); assert.equal(h.calls.at(-1), 0);
  assert.equal(h.haptics.play([event('impact', .5, 7)]), false);
  h.haptics.unlock(); assert.equal(h.haptics.play([event('impact', .5, 7)]), true);
  h.haptics.dispose();
});

test('blur, cancelled touches, background and disposal stop vibrations and remove event listeners', () => {
  const h = harness();
  for (const [target, kind] of [[h.windowEvents, 'blur'], [h.documentEvents, 'pointercancel'], [h.documentEvents, 'visibilitychange']] as const) {
    h.at(500 + h.calls.length * 200); h.haptics.unlock(); h.haptics.play([event('impact')]);
    if (kind === 'visibilitychange') h.visible(false);
    target.dispatchEvent(new Event(kind));
    assert.equal(h.calls.at(-1), 0);
    h.visible(true); assert.equal(h.haptics.play([event('break')]), false);
  }
  h.haptics.dispose(); const count = h.calls.length;
  h.windowEvents.dispatchEvent(new Event('blur')); h.haptics.unlock();
  assert.equal(h.haptics.play([event('break')]), false);
  assert.equal(h.calls.length, count);
});

test('rejected actuators and blocked storage remain silent and do not cause per-frame retries', () => {
  let attempts = 0;
  const h = harness({ vibrate: () => { attempts++; throw new Error('Actuator unavailable'); },
    storage: { getItem: () => { throw new Error('Storage unavailable'); }, setItem: () => { throw new Error('Storage unavailable'); } } });
  h.haptics.unlock(); assert.equal(h.haptics.play([event('impact')]), false);
  h.at(20); assert.equal(h.haptics.play([event('impact')]), false);
  assert.equal(attempts, 1);
  assert.equal(h.haptics.toggle(), false);
  h.haptics.dispose();
});
