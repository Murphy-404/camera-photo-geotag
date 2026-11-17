export function validOffset(value) {
  return typeof value === 'string' && /^[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00)$/.test(value) && value !== '-00:00';
}

export function captureTime(value, offset, shiftSeconds = 0, fraction) {
  const match = typeof value === 'string' && /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match || !validOffset(offset)) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  const timestamp = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  const wallTime = Date.parse(`${timestamp}Z`);
  if (!Number.isFinite(wallTime) || !new Date(wallTime).toISOString().startsWith(timestamp)) return undefined;
  const milliseconds = /^\d+$/.test(String(fraction)) ? Number(String(fraction).padEnd(3, '0').slice(0, 3)) : 0;
  return Date.parse(`${timestamp}${offset}`) + shiftSeconds * 1000 + milliseconds;
}

function distanceMeters(a, b) {
  const radians = Math.PI / 180;
  const latitude = (b.latitude - a.latitude) * radians;
  const longitude = (b.longitude - a.longitude) * radians;
  const halfChord = Math.sin(latitude / 2) ** 2 +
    Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) * Math.sin(longitude / 2) ** 2;
  return 12_742_000 * Math.asin(Math.min(1, Math.sqrt(halfChord)));
}

export function suggestPosition(time, references, windowSeconds) {
  if (time === undefined) return { reason: '缺少可靠的拍摄时间或时区' };
  const candidates = references.map(reference => ({ reference, seconds: Math.abs(reference.time - time) / 1000 }))
    .filter(candidate => candidate.seconds <= windowSeconds)
    .sort((a, b) => a.seconds - b.seconds);
  const nearest = candidates[0];
  if (!nearest) return { reason: '窗口内没有参考照片' };
  if (candidates.some(candidate => distanceMeters(candidate.reference, nearest.reference) > 100)) {
    return { reason: '窗口内参考位置冲突' };
  }
  return nearest;
}
