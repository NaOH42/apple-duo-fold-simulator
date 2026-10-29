import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceClock } from '../src/clock';

test('lock-screen time uses the local device calendar, an unpadded hour and a padded minute', () => {
  assert.deepEqual(deviceClock(new Date(2026, 9, 29, 9, 5, 12)), {
    time: '9:05', date: '10月29日 星期四', key: '2026-10-29T09:05',
  });
});

test('one minute updates both the displayed time and its texture refresh key', () => {
  const before = deviceClock(new Date(2026, 9, 29, 9, 59, 59, 999));
  const after = deviceClock(new Date(2026, 9, 29, 10, 0));
  assert.equal(before.time, '9:59');
  assert.equal(after.time, '10:00');
  assert.notEqual(before.key, after.key);
  assert.equal(before.date, after.date);
});

test('crossing local midnight updates time, date and weekday together', () => {
  const before = deviceClock(new Date(2026, 9, 29, 23, 59, 59));
  const after = deviceClock(new Date(2026, 9, 30, 0, 0));
  assert.equal(before.date, '10月29日 星期四');
  assert.equal(after.time, '0:00');
  assert.equal(after.date, '10月30日 星期五');
  assert.notEqual(before.key, after.key);
});

test('Sunday and a new year retain their real local calendar labels', () => {
  assert.equal(deviceClock(new Date(2026, 10, 1, 12, 0)).date, '11月1日 星期日');
  const before = deviceClock(new Date(2026, 11, 31, 23, 59));
  const after = deviceClock(new Date(2027, 0, 1, 0, 0));
  assert.equal(after.date, '1月1日 星期五');
  assert.equal(after.key, '2027-01-01T00:00');
  assert.notEqual(before.key, after.key);
});

test('seconds do not trigger a screen texture refresh within a local minute', () => {
  const first = deviceClock(new Date(2026, 9, 29, 9, 5, 0));
  const last = deviceClock(new Date(2026, 9, 29, 9, 5, 59, 999));
  assert.deepEqual(first, last);
});

test('manual backwards clock and calendar changes are visible rather than hidden by monotonic time', () => {
  const initial = deviceClock(new Date(2026, 9, 29, 14, 30));
  const earlier = deviceClock(new Date(2026, 9, 29, 8, 30));
  const otherDate = deviceClock(new Date(2027, 9, 29, 14, 30));
  assert.equal(earlier.time, '8:30');
  assert.notEqual(initial.key, earlier.key);
  assert.notEqual(initial.key, otherDate.key);
});

test('the clock reads local getters even when the underlying UTC instant is different', () => {
  class DeviceDate extends Date {
    override getFullYear() { return 2027; }
    override getMonth() { return 0; }
    override getDate() { return 1; }
    override getDay() { return 5; }
    override getHours() { return 7; }
    override getMinutes() { return 6; }
    override getUTCFullYear(): number { throw new Error('UTC must not drive the device screen'); }
    override toISOString(): string { throw new Error('UTC must not drive the device screen'); }
  }
  const date = new DeviceDate('2026-12-31T23:06:00Z');
  assert.deepEqual(deviceClock(date), {
    time: '7:06', date: '1月1日 星期五', key: '2027-01-01T07:06',
  });
});
