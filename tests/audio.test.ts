import assert from 'node:assert/strict';
import test from 'node:test';
import { frictionResponse } from '../src/audio';
import { mechanicalNoise, responseGain, synthesizeTransient } from '../src/audioSynthesis';
import type { ContactMaterial, FeedbackFrame, FeedbackKind } from '../src/types';

const kinds: FeedbackKind[] = ['close', 'open', 'impact', 'chip', 'crack', 'break'];
const frame: FeedbackFrame = { angularSpeed: 0, signedSpeed: 0, strain: 0, hingeHealth: 100,
  broken: false, pan: 0, scrapeSpeed: 0, scrapeMaterial: 'metal' };
const rms = (data: Float32Array) => Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
const roughness = (data: Float32Array) => {
  let power = 0;
  for (let i = 1; i < data.length; i++) power += (data[i] - data[i - 1]) ** 2;
  return Math.sqrt(power / (data.length - 1));
};

test('mechanical transients are finite, bounded, nonempty and end without a waveform step', () => {
  for (const kind of kinds) for (const material of ['metal', 'glass', 'back'] as ContactMaterial[]) {
    const sound = synthesizeTransient(kind, material, 48000, 19);
    assert.ok(sound.length > 3000 && sound.length < 24000);
    assert.equal(sound[0], 0); assert.equal(sound.at(-1), 0);
    assert.ok(sound.every(value => Number.isFinite(value) && Math.abs(value) <= .721));
    assert.ok(rms(sound) > .015 && rms(sound) < .4);
    assert.ok(rms(sound.subarray(sound.length - 480)) < .0015, kind + ' tail must settle quietly');
  }
});

test('glass, metal and rear-panel impacts retain measurably different pressure and brightness', () => {
  const glass = synthesizeTransient('impact', 'glass', 48000, 19, false);
  const metal = synthesizeTransient('impact', 'metal', 48000, 19, false);
  const back = synthesizeTransient('impact', 'back', 48000, 19, false);
  assert.ok(roughness(glass) > roughness(back) * 3);
  assert.ok(roughness(metal) > roughness(back) * 2);
  assert.ok(Math.abs(roughness(glass) - roughness(metal)) > .005);
  assert.notDeepEqual(glass, metal);
});

test('close, opening stop, loose glass and structural failure have different temporal responses', () => {
  const close = synthesizeTransient('close'), open = synthesizeTransient('open');
  const chip = synthesizeTransient('chip'), crack = synthesizeTransient('crack'), broken = synthesizeTransient('break');
  assert.ok(open.length < close.length && close.length < chip.length && chip.length < crack.length && crack.length < broken.length);
  assert.ok(rms(broken.subarray(4800, 9600)) > rms(close.subarray(4800)) * 10);
});

test('impact level responds continuously to force without arbitrary random gain jumps', () => {
  for (const kind of kinds) {
    let previous = responseGain(kind, 0);
    for (let i = 1; i <= 100; i++) {
      const gain = responseGain(kind, i / 100);
      assert.ok(gain > previous && gain - previous < .015);
      previous = gain;
    }
    assert.equal(responseGain(kind, -1), responseGain(kind, 0));
    assert.equal(responseGain(kind, 9), responseGain(kind, 1));
    assert.ok(Number.isFinite(responseGain(kind, NaN)));
  }
});

test('stillness and detached hinges do not synthesize an idle hum or hinge motion', () => {
  const still = frictionResponse(frame);
  assert.equal(still.hinge, 0); assert.equal(still.scrape, 0);
  const moving = frictionResponse({ ...frame, signedSpeed: 4, angularSpeed: 4 });
  assert.ok(moving.hinge > 0);
  assert.equal(frictionResponse({ ...frame, signedSpeed: 4, broken: true }).hinge, 0);
  assert.ok(frictionResponse({ ...frame, signedSpeed: 4, hingeHealth: 20 }).hinge > moving.hinge);
});

test('table sliding follows tangential motion and material; it remains available for detached bodies', () => {
  const glass = frictionResponse({ ...frame, broken: true, scrapeSpeed: 1, scrapeMaterial: 'glass' });
  const back = frictionResponse({ ...frame, scrapeSpeed: 1, scrapeMaterial: 'back' });
  assert.ok(glass.scrape > 0 && glass.hinge === 0);
  assert.ok(glass.scrapeFrequency > back.scrapeFrequency);
  assert.equal(glass.scrape, back.scrape);
});

test('sample-rate bounds and deterministic small response variants remain safe', () => {
  assert.deepEqual(synthesizeTransient('impact', 'metal', 48000, 1), synthesizeTransient('impact', 'metal', 48000, 1));
  assert.notDeepEqual(synthesizeTransient('impact', 'metal', 48000, 1), synthesizeTransient('impact', 'metal', 48000, 2));
  for (const sampleRate of [NaN, -200, 192000]) {
    const noise = mechanicalNoise(sampleRate);
    const sound = synthesizeTransient('chip', 'glass', sampleRate);
    assert.ok(noise.length >= 8000 && noise.length <= 96000);
    assert.ok(sound.every(Number.isFinite));
  }
});
