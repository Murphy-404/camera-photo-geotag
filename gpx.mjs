import { SaxesParser } from 'saxes';
import { captureTime, distanceMeters } from './match.mjs';

const namespaces = new Set(['', 'http://www.topografix.com/GPX/1/0', 'http://www.topografix.com/GPX/1/1']);
const samePosition = (a, b) => a.latitude === b.latitude && (a.longitude === b.longitude || Math.abs(a.longitude - b.longitude) === 360);

function parseTime(text) {
  const stamp = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(text.trim());
  if (!stamp) return undefined;
  return captureTime(`${stamp[1].replaceAll('-', ':')} ${stamp[2]}`, stamp[4] === 'Z' ? '+00:00' : stamp[4], 0, stamp[3]);
}

function coordinate(attribute, limit) {
  const value = attribute?.value.trim();
  if (!value || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return undefined;
  const number = Number(value);
  return Math.abs(number) <= limit ? number : undefined;
}

export function parseGpx(xml) {
  const parser = new SaxesParser({ xmlns: true });
  const stack = [];
  const runs = [];
  let namespace;
  let segment = 0;
  let points = [];
  let point;
  let skipped = 0;
  let usable = 0;

  function endRun() {
    if (points.length) runs.push({ segment, points });
    points = [];
  }

  parser.on('doctype', () => { throw new Error('GPX 不支持文档类型声明'); });
  parser.on('opentag', tag => {
    if (!stack.length) {
      if (tag.local !== 'gpx' || !namespaces.has(tag.uri)) throw new Error('不是受支持的 GPX 文件');
      namespace = tag.uri;
    }
    stack.push(tag.uri === namespace ? tag.local : '');
    const path = stack.join('/');
    if (path === 'gpx/trk/trkseg') segment++;
    if (path === 'gpx/trk/trkseg/trkpt') {
      point = { latitude: coordinate(tag.attributes.lat, 90), longitude: coordinate(tag.attributes.lon, 180) };
    }
    if (path === 'gpx/trk/trkseg/trkpt/time') {
      point.timeText = '';
      point.timeCount = (point.timeCount ?? 0) + 1;
    }
  });
  function addTime(text) {
    if (stack.length === 5 && stack.join('/') === 'gpx/trk/trkseg/trkpt/time') point.timeText += text;
  }
  parser.on('text', addTime);
  parser.on('cdata', addTime);
  parser.on('closetag', () => {
    const path = stack.join('/');
    stack.pop();
    if (path === 'gpx/trk/trkseg') endRun();
    if (path !== 'gpx/trk/trkseg/trkpt') return;
    const { latitude, longitude, timeText, timeCount } = point;
    const time = timeCount === 1 ? parseTime(timeText) : undefined;
    if (latitude === undefined || longitude === undefined || time === undefined) {
      skipped++;
      endRun();
      return;
    }
    usable++;
    const next = { time, latitude, longitude };
    const previous = points.at(-1);
    if (previous && time < previous.time) endRun();
    if (previous && time === previous.time) {
      if (!samePosition(previous, next)) previous.conflict = true;
    } else {
      points.push(next);
    }
  });
  parser.write(xml).close();
  return { runs, segmentCount: segment, usable, skipped };
}

function findAtOrAfter(points, time) {
  let start = 0;
  let end = points.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (points[middle].time < time) start = middle + 1;
    else end = middle;
  }
  return start;
}

function matchRun(points, time, window, maxGap) {
  if (time < points[0].time || time > points.at(-1).time) return undefined;
  const index = findAtOrAfter(points, time);
  const after = points[index];
  if (after.time === time) return { ...after, seconds: 0, method: '精确实测点' };
  const before = points[index - 1];
  const elapsed = (time - before.time) / 1000;
  const remaining = (after.time - time) / 1000;
  const gap = (after.time - before.time) / 1000;
  if (gap > maxGap || (elapsed > window && remaining > window)) return undefined;
  if ((elapsed <= window && before.conflict) || (remaining <= window && after.conflict)) return { conflict: true };
  if (before.conflict || after.conflict || distanceMeters(before, after) / gap > 100) return undefined;
  if (elapsed <= window && remaining <= window) {
    const fraction = elapsed / gap;
    const delta = (after.longitude - before.longitude + 540) % 360 - 180;
    return {
      latitude: before.latitude + (after.latitude - before.latitude) * fraction,
      longitude: (before.longitude + delta * fraction + 540) % 360 - 180,
      seconds: Math.min(elapsed, remaining), method: '插值估计',
    };
  }
  if (elapsed <= window) return { ...before, seconds: elapsed, method: '最近实测点' };
  if (remaining <= window) return { ...after, seconds: remaining, method: '最近实测点' };
  return undefined;
}

export function suggestTrackPosition(time, track, window, maxGap) {
  if (time === undefined) return { reason: '缺少可靠的拍摄时间或时区' };
  const matches = [];
  for (const { points, segment } of track.runs) {
    const match = matchRun(points, time, window, maxGap);
    if (match?.conflict) return { reason: '轨迹位置冲突' };
    if (match) matches.push({ ...match, segment });
  }
  const exact = matches.filter(match => match.seconds === 0);
  const best = exact[0] ?? matches.sort((a, b) => a.seconds - b.seconds)[0];
  if (!best) return { reason: '轨迹范围外、断档或窗口内没有可用轨迹点' };
  if (exact.some(match => !samePosition(best, match)) || matches.some(match => distanceMeters(best, match) > 100)) {
    return { reason: '轨迹位置冲突' };
  }
  return best;
}
