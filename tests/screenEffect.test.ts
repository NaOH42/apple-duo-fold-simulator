import test from 'node:test';
import assert from 'node:assert/strict';
import { ShaderLib, Texture, type WebGLRenderer } from 'three';
import { followScreen, FoldScreenMaterial, screenTarget, type ScreenEffect } from '../src/screenEffect';

test('closed and open endpoints hand the lock screen between exterior and interior', () => {
  assert.deepEqual(screenTarget(0, false, false), { power: 0, frost: 1 });
  assert.deepEqual(screenTarget(180, false, false), { power: 1, frost: 0 });
  assert.deepEqual(screenTarget(0, true, false), { power: 1, frost: 0 });
  assert.deepEqual(screenTarget(180, true, false), { power: 0, frost: 1 });
  assert.equal(screenTarget(65, true, false).power, 0, 'exterior has no residual glow when unfolded');
  assert.equal(screenTarget(12, false, false).power, 0, 'interior is off while nearly closed');
});

test('the handoff has a blurred intermediate display and remains continuous when reversed', () => {
  const inner = screenTarget(55, false, false);
  const outer = screenTarget(30, true, false);
  assert.ok(inner.power > .5 && inner.frost > .8);
  assert.ok(outer.power > .5 && outer.frost > .5);
  for (const exterior of [false, true]) {
    let previous = screenTarget(0, exterior, false);
    const forward: ScreenEffect[] = [];
    for (let angle = 0; angle <= 180; angle += .5) {
      const current = screenTarget(angle, exterior, false);
      assert.ok(Math.abs(current.power - previous.power) < .02);
      assert.ok(Math.abs(current.frost - previous.frost) < .02);
      assert.ok(exterior ? current.power <= previous.power : current.power >= previous.power);
      forward.push(current);
      previous = current;
    }
    for (let i = 0; i < forward.length; i++) {
      assert.deepEqual(screenTarget(180 - i * .5, exterior, false), forward[forward.length - i - 1]);
    }
  }
});

test('exponential following agrees at 30, 60 and 120 frames per second', () => {
  const target = { power: 1, frost: 0 };
  const results = [30, 60, 120].map(rate => {
    let state = { power: 0, frost: 1 };
    for (let i = 0; i < rate / 2; i++) state = followScreen(state, target, 1 / rate);
    return state;
  });
  const oneStep = followScreen({ power: 0, frost: 1 }, target, .5);
  for (const state of results) {
    assert.ok(Math.abs(state.power - oneStep.power) < 1e-14);
    assert.ok(Math.abs(state.frost - oneStep.frost) < 1e-14);
  }
  const settled = followScreen({ power: 0, frost: 1 }, target, .18);
  assert.ok(settled.power > .96 && settled.frost < .04);
});

test('a changing target reverses from the current visual state without a reset or overshoot', () => {
  const partial = followScreen({ power: 0, frost: 1 }, { power: 1, frost: 0 }, .04);
  const reversed = followScreen(partial, { power: 0, frost: 1 }, 1 / 60);
  assert.ok(reversed.power > 0 && reversed.power < partial.power);
  assert.ok(reversed.frost < 1 && reversed.frost > partial.frost);
  assert.deepEqual(followScreen(partial, { power: 0, frost: 1 }, 0), partial);
  assert.deepEqual(followScreen(partial, { power: 0, frost: 1 }, -.5), partial);
});

test('detached phone halves do not retain hinge-driven frosting', () => {
  for (const angle of [0, 25, 100, 180]) {
    assert.deepEqual(screenTarget(angle, false, true), { power: .8, frost: 0 });
    assert.deepEqual(screenTarget(angle, true, true), { power: .65, frost: 0 });
  }
});

test('invalid angles, delays and out-of-range visual states remain finite and bounded', () => {
  for (const angle of [-1000, 1000, NaN, Infinity, -Infinity]) {
    for (const exterior of [false, true]) {
      const state = screenTarget(angle, exterior, false);
      assert.ok(Object.values(state).every(v => Number.isFinite(v) && v >= 0 && v <= 1));
    }
  }
  for (const delay of [-Infinity, -1, NaN, 0, Infinity, 1e20]) {
    const state = followScreen({ power: NaN, frost: Infinity }, { power: -100, frost: 3 }, delay);
    assert.ok(Object.values(state).every(v => Number.isFinite(v) && v >= 0 && v <= 1));
  }
});

test('frost is a live shader uniform; brightness and disposable textures remain independent', () => {
  const sharp = new Texture(), blurred = new Texture();
  const material = new FoldScreenMaterial(sharp, blurred, false);
  material.color.setScalar(.42);
  const version = material.version;
  const cacheKey = material.customProgramCacheKey();
  material.setFrost(.7);
  const shader = {
    uniforms: {}, vertexShader: ShaderLib.basic.vertexShader, fragmentShader: ShaderLib.basic.fragmentShader,
  } as Parameters<FoldScreenMaterial['onBeforeCompile']>[0];
  material.onBeforeCompile(shader, {} as WebGLRenderer);
  assert.equal(shader.uniforms.duoGlassFrost.value, .7);
  assert.equal(shader.uniforms.duoBlurredMap.value, blurred);
  material.setFrost(.25);
  assert.equal(shader.uniforms.duoGlassFrost.value, .25);
  material.setFrost(NaN);
  assert.equal(shader.uniforms.duoGlassFrost.value, 0);
  assert.equal(material.version, version);
  assert.equal(material.customProgramCacheKey(), cacheKey);
  assert.equal(material.color.r, .42);
  assert.equal(material.map, sharp);
  assert.ok(Object.values(material).includes(blurred), 'generic scene disposal discovers the extra map');
  assert.equal(material.toneMapped, false);
  assert.equal(material.fog, false);
  assert.ok(!shader.fragmentShader.includes('#include <map_fragment>'));
  material.dispose(); sharp.dispose(); blurred.dispose();
});
