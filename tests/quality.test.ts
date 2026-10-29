import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BUFFER_PIXELS, renderQuality } from '../src/quality';

test('high-density phones render at a controlled resolution without losing normal shadows', () => {
  const q = renderQuality({ width: 390, height: 844, devicePixelRatio: 3, coarsePointer: true, deviceMemory: 8, hardwareConcurrency: 8 });
  assert.equal(q.tier, 'mobile');
  assert.equal(q.pixelRatio, 1.5);
  assert.equal(q.shadowMapSize, 1024);
  assert.ok(Math.floor(390 * q.pixelRatio) * Math.floor(844 * q.pixelRatio) < 390 * 844 * 3 * 3 / 3);
});

test('either a known small memory budget or a small core count reduces mobile raster and shadows', () => {
  for (const hints of [{ deviceMemory: 4, hardwareConcurrency: 8 }, { deviceMemory: 8, hardwareConcurrency: 4 }]) {
    const q = renderQuality({ width: 430, height: 932, devicePixelRatio: 3, coarsePointer: true, ...hints });
    assert.equal(q.tier, 'low');
    assert.equal(q.pixelRatio, 1.25);
    assert.equal(q.shadowMapSize, 512);
  }
});

test('unknown Safari-style hardware hints do not silently select the low-end tier', () => {
  const q = renderQuality({ width: 390, height: 844, devicePixelRatio: 3, coarsePointer: true });
  assert.equal(q.tier, 'mobile');
  assert.equal(q.shadowMapSize, 1024);
  const missing = renderQuality({ width: 390, height: 844, devicePixelRatio: 3, coarsePointer: true, deviceMemory: 0, hardwareConcurrency: 0 });
  assert.deepEqual(missing, q);
});

test('a phone rotation keeps its rendering budget and changes no quality tier', () => {
  const portrait = renderQuality({ width: 390, height: 844, devicePixelRatio: 3, coarsePointer: true, deviceMemory: 8 });
  const landscape = renderQuality({ width: 844, height: 390, devicePixelRatio: 3, coarsePointer: true, deviceMemory: 8 });
  assert.deepEqual(portrait, landscape);
});

test('large desktop and tablet viewports cannot allocate more than the pixel budget', () => {
  for (const [width, height, coarsePointer] of [[3840, 2160, false], [2048, 2732, true]] as const) {
    const q = renderQuality({ width, height, devicePixelRatio: 3, coarsePointer, deviceMemory: 16, hardwareConcurrency: 16 });
    const rasterPixels = Math.floor(width * q.pixelRatio) * Math.floor(height * q.pixelRatio);
    assert.ok(rasterPixels <= MAX_BUFFER_PIXELS);
    assert.ok(rasterPixels > MAX_BUFFER_PIXELS * .995, 'preserve as much resolution as the budget permits');
  }
  const desktop = renderQuality({ width: 1000, height: 800, devicePixelRatio: 2, coarsePointer: false, deviceMemory: 16, hardwareConcurrency: 16 });
  assert.equal(desktop.tier, 'desktop');
  assert.equal(desktop.pixelRatio, 1.75);
});

test('invalid or hidden-viewport hints never produce a non-finite renderer ratio', () => {
  const q = renderQuality({ width: 0, height: Number.NaN, devicePixelRatio: Number.POSITIVE_INFINITY, coarsePointer: false });
  assert.ok(Number.isFinite(q.pixelRatio) && q.pixelRatio > 0);
  assert.equal(q.pixelRatio, 1);
});
