import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureTime, suggestPosition } from './match.mjs';

test('校正相机墙上时间后按拍摄偏移解释为 UTC', () => {
  assert.equal(captureTime('2026:11:17 23:59:50', '+08:00', 20), Date.parse('2026-11-17T16:00:10Z'));
  assert.equal(captureTime('2026:11:17 10:00:00', '-05:30'), Date.parse('2026-11-17T15:30:00Z'));
  assert.equal(captureTime('2026:11:17 10:00:00'), undefined);
  assert.equal(captureTime('2026:02:30 10:00:00', '+00:00'), undefined);
  assert.equal(captureTime('2026:11:17 10:00:00', '+18:00'), undefined);
});

test('窗口内取最近实测参考点，多个不同地点需要人工复核', () => {
  const a = { time: 5000, latitude: 25, longitude: 100 };
  const b = { time: 12000, latitude: 25.00001, longitude: 100 };
  const distant = { time: 6000, latitude: 26, longitude: 100 };
  assert.deepEqual(suggestPosition(10000, [a, b], 5), { reference: b, seconds: 2 });
  assert.equal(suggestPosition(10000, [a], 5).reference, a);
  assert.equal(suggestPosition(10001, [a], 5).reason, '窗口内没有参考照片');
  assert.equal(suggestPosition(10000, [a, distant], 5).reason, '窗口内参考位置冲突');
  assert.equal(suggestPosition(undefined, [a], 5).reason, '缺少可靠的拍摄时间或时区');
});
