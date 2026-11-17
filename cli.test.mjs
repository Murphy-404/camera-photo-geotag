import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { exiftoolPath } from 'exiftool-vendored';
import { exportCopy, fileHash } from './jpeg.mjs';

const fixture = fileURLToPath(new URL('./fixtures/synthetic.jpg', import.meta.url));
const cli = fileURLToPath(new URL('./geotag.mjs', import.meta.url));

test('真实入口确认后仅导出选中副本，保留原片、已有位置与写入冲突', async t => {
  const root = await mkdtemp(join(tmpdir(), 'camera-geotag-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [phone, camera, output] = ['phone', 'camera', 'output'].map(name => join(root, name));
  for (const directory of [phone, camera, output]) await mkdir(directory);
  const executable = await exiftoolPath();
  function exif(...args) {
    const result = spawnSync(executable, ['-charset', 'filename=UTF8', '-@', '-'], {
      input: `${args.join('\n')}\n`, encoding: 'utf8', windowsHide: true, env: { ...process.env, LC_ALL: 'C' },
    });
    assert.equal(result.status, 0, result.stderr || result.error);
    return result.stdout;
  }
  async function create(directory, name, time, ...extra) {
    const path = join(directory, name);
    await copyFile(fixture, path);
    exif('-overwrite_original', `-DateTimeOriginal=${time}`, '-Orientation#=6', '-Artist=Trace test', ...extra, path);
    return path;
  }
  const gps = ['-GPSLatitude=25.125', '-GPSLatitudeRef=S', '-GPSLongitude=100.25', '-GPSLongitudeRef=W'];
  await create(phone, 'reference.jpg', '2026:11:17 10:00:00', '-OffsetTimeOriginal=+08:00', ...gps);
  const original = await create(camera, '01-相机.jpg', '2026:11:17 09:59:40');
  const untouched = await create(camera, '02-camera.jpg', '2026:11:17 09:59:41');
  await create(camera, '03-existing.jpg', '2026:11:17 09:59:40', ...gps);
  await create(camera, '04-too-late.jpg', '2026:11:17 10:59:40');
  await writeFile(join(camera, '05-broken.jpg'), 'broken');
  const input = await readFile(original);
  const other = await readFile(untouched);
  const args = [cli, '--phone', phone, '--camera', camera, '--out', output,
    '--camera-offset=+08:00', '--shift', '20', '--window', '10'];
  const run = (input, ...extra) => spawnSync(process.execPath, [...args, ...extra], { input, encoding: 'utf8', timeout: 20_000 });

  const preview = run('', '--preview');
  assert.equal(preview.status, 2, preview.stderr);
  assert.match(preview.stdout, /1.*01-相机\.jpg.*-25\.125.*-100\.25/);
  assert.match(preview.stdout, /已有 GPS/);
  assert.match(preview.stdout, /窗口内没有参考照片/);
  assert.match(preview.stdout, /05-broken\.jpg.*失败/);
  assert.deepEqual(await readdir(output), []);

  const cancelled = run('\n');
  assert.match(cancelled.stdout, /已取消/);
  assert.deepEqual(await readdir(output), []);

  const exported = run('1\n');
  assert.equal(exported.status, 2, exported.stderr);
  assert.match(exported.stdout, /导出成功 1/);
  assert.deepEqual(await readdir(output), ['01-相机.jpg']);
  assert.deepEqual(await readFile(original), input);
  assert.deepEqual(await readFile(untouched), other);
  const result = join(output, '01-相机.jpg');
  const [sourceMetadata, exportedMetadata] = JSON.parse(exif('-j', '-n', '-api', 'ImageHashType=SHA256', '-ImageDataHash', '-Orientation',
    '-DateTimeOriginal', '-Artist', '-GPSLatitude', '-GPSLongitude', original, result));
  for (const key of ['ImageDataHash', 'Orientation', 'DateTimeOriginal', 'Artist']) {
    assert.ok(sourceMetadata[key]);
    assert.equal(exportedMetadata[key], sourceMetadata[key]);
  }
  assert.equal(exportedMetadata.GPSLatitude, -25.125);
  assert.equal(exportedMetadata.GPSLongitude, -100.25);
  if (process.platform === 'win32') {
    const reader = spawnSync('powershell.exe', ['-NoProfile', '-Command', `
      Add-Type -AssemblyName System.Drawing
      $image = [Drawing.Image]::FromFile($env:GEOTAG_TEST_JPEG)
      try {
        if ($image.Width -ne 16 -or $image.Height -ne 16) { throw 'unexpected image dimensions' }
        $south = $image.GetPropertyItem(1).Value[0]
        $west = $image.GetPropertyItem(3).Value[0]
        if ($south -ne 83 -or $west -ne 87) { throw 'unexpected GPS directions' }
      } finally { $image.Dispose() }`], {
      encoding: 'utf8', env: { ...process.env, GEOTAG_TEST_JPEG: result },
    });
    assert.equal(reader.status, 0, reader.stderr || reader.error);
  }
  const beforeRetry = await readFile(result);
  assert.match(run('1\n').stdout, /目标已存在/);
  assert.deepEqual(await readFile(result), beforeRetry);

  const track = join(root, '旅途.gpx');
  const trackOutput = join(root, 'gpx-output');
  await writeFile(track, `<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>
    <trkpt lat="-25.125" lon="-100.251"><time>2026-11-17T01:59:55Z</time></trkpt>
    <trkpt lat="-25.125" lon="-100.249"><time>2026-11-17T02:00:05Z</time></trkpt>
  </trkseg></trk></gpx>`);
  const gpxArgs = [cli, '--gpx', track, '--camera', camera, '--out', trackOutput,
    '--camera-offset=+08:00', '--shift', '20', '--window', '10'];
  const gpxRun = spawnSync(process.execPath, gpxArgs, { input: '1\n', encoding: 'utf8', timeout: 20_000 });
  assert.equal(gpxRun.status, 2, gpxRun.stderr);
  assert.match(gpxRun.stdout, /旅途\.gpx.*第 1 段.*插值估计/);
  assert.match(gpxRun.stdout, /导出成功 1/);
  assert.deepEqual(await readdir(trackOutput), ['01-相机.jpg']);
  const [gpxMetadata] = JSON.parse(exif('-j', '-n', '-GPSLatitude', '-GPSLongitude', join(trackOutput, '01-相机.jpg')));
  assert.equal(gpxMetadata.GPSLatitude, -25.125);
  assert.equal(gpxMetadata.GPSLongitude, -100.25);
  assert.deepEqual(await readFile(original), input);

  const malformedTrack = join(root, 'malformed.gpx');
  const forbiddenOutput = join(root, 'must-not-exist');
  await writeFile(malformedTrack, '<gpx><trk></gpx>');
  const rejected = spawnSync(process.execPath, [cli, '--gpx', malformedTrack, '--camera', camera, '--out', forbiddenOutput],
    { input: 'all\n', encoding: 'utf8', timeout: 20_000 });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /GPX 读取失败/);
  await assert.rejects(readdir(forbiddenOutput), { code: 'ENOENT' });
  const repeatedTrack = spawnSync(process.execPath, [...gpxArgs, '--gpx', track], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(repeatedTrack.status, 1);
  assert.match(repeatedTrack.stderr, /每次只支持一个 GPX 文件/);

  const previousHash = await fileHash(untouched);
  await writeFile(untouched, 'changed after preview');
  await assert.rejects(exportCopy({ file: untouched, name: '02-camera.jpg', hash: previousHash,
    reference: { latitude: -25.125, longitude: -100.25 } }, output), /源文件在预览后已变化/);
  assert.deepEqual(await readdir(output), ['01-相机.jpg']);
});
