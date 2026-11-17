import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGpx, suggestTrackPosition } from './gpx.mjs';

const point = (time, lon = 100) => `<trkpt lat="25" lon="${lon}">${time ? `<time>${time}</time>` : ''}</trkpt>`;
const document = (...segments) => `<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk>${segments.map(segment => `<trkseg>${segment}</trkseg>`).join('')}</trk></gpx>`;
const at = seconds => Date.parse(`2026-11-18T00:00:${String(seconds).padStart(2, '0')}Z`);
const stamp = seconds => new Date(at(seconds)).toISOString();
const match = (track, time, window = 20, gap = 30) => suggestTrackPosition(time, track, window, gap);

test('解析显式时区，区分实测、插值与窗口内最近点', () => {
  const track = parseGpx(document(point('2026-11-18T08:00:00+08:00') + point(stamp(20), 100.002)));
  assert.equal(match(track, at(0), 0).method, '精确实测点');
  const interpolated = match(track, at(10));
  assert.equal(interpolated.method, '插值估计');
  assert.ok(Math.abs(interpolated.longitude - 100.001) < 1e-9);
  assert.equal(match(track, at(2), 5).method, '最近实测点');
  assert.ok(match(track, at(30)).reason);
});

test('不跨段、断档、异常跳点、无时间点或无效坐标定位', () => {
  assert.ok(match(parseGpx(document(point(stamp(0)), point(stamp(20)))), at(10)).reason);
  assert.ok(match(parseGpx(document(point(stamp(0)) + point(stamp(40)))), at(5), 20, 30).reason);
  assert.ok(match(parseGpx(document(point(stamp(0)) + point(stamp(20), 120))), at(10)).reason);
  const track = parseGpx(document(point(stamp(0)) + point() + point(stamp(20)) + point(stamp(30), 200)));
  assert.equal(track.skipped, 2);
  assert.ok(match(track, at(10)).reason);
  assert.ok(match(track, undefined).reason);
});

test('同刻冲突、横跨日期变更线与非法 XML', () => {
  assert.match(match(parseGpx(document(point(stamp(0)) + point(stamp(0), 100.002))), at(0)).reason, /冲突/);
  assert.match(match(parseGpx(document(point(stamp(0)), point(stamp(0), 100.002))), at(0)).reason, /冲突/);
  const track = parseGpx(document(point(stamp(0), 179.999) + point(stamp(20), -179.999)));
  assert.equal(Math.abs(match(track, at(10)).longitude), 180);
  assert.throws(() => parseGpx('<gpx><trk></gpx>'));
  assert.throws(() => parseGpx('<!DOCTYPE gpx><gpx/>'));
  assert.throws(() => parseGpx('<not-gpx/>'));
});

test('识别带前缀的 GPX，忽略路线、航点和扩展中的同名元素', () => {
  const track = parseGpx(`<g:gpx xmlns:g="http://www.topografix.com/GPX/1/1" xmlns:x="urn:extension">
    <g:wpt lat="1" lon="2"><g:time>${stamp(0)}</g:time></g:wpt>
    <g:rte><g:rtept lat="1" lon="2"><g:time>${stamp(0)}</g:time></g:rtept></g:rte>
    <g:trk><g:trkseg><g:trkpt lat="25" lon="100"><x:time>${stamp(0)}</x:time><g:time>${stamp(5)}</g:time></g:trkpt>
    <g:trkpt lat="25" lon="100"><g:time>2026-11-18T00:00:15</g:time></g:trkpt></g:trkseg></g:trk>
  </g:gpx>`);
  assert.equal(track.usable, 1);
  assert.equal(track.skipped, 1);
  assert.equal(match(track, at(5), 0).method, '精确实测点');
  assert.ok(match(track, at(0)).reason);
});

test('超过连续间隔的冲突点不影响另一段的精确实测点', () => {
  const track = parseGpx(document(point(stamp(0)) + point(stamp(0), 100.002) + point(stamp(50)), point(stamp(10))));
  assert.equal(match(track, at(10), 20, 30).method, '精确实测点');
  assert.match(match(track, at(0)).reason, /冲突/);
});
