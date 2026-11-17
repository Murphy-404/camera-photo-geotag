import { mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { captureTime, suggestPosition, validOffset } from './match.mjs';
import { parseGpx, suggestTrackPosition } from './gpx.mjs';
import { exportCopy, fileHash, hasGps, position, readPhoto } from './jpeg.mjs';

const usage = `用法：node geotag.mjs (--phone <手机照片目录> | --gpx <轨迹文件>) --camera <相机JPEG目录> [--out <输出目录>]
  --camera-offset=+08:00  拍摄时区偏移，指定后覆盖相机元数据
  --phone-offset=+08:00   手机照片缺少时区时的拍摄偏移
  --shift 20              加到相机原始拍摄时间的秒数，慢 20 秒就填 20，默认 0
  --window 60             参考照片或轨迹点与校正后相机时间的窗口秒数，默认 60
  --max-gap 120           GPX 相邻采样点的最大连续间隔秒数，默认 120
  --preview               仅查看建议，可省略 --out`;

const display = name => JSON.stringify(name);

async function filesIn(directory, extensions) {
  return (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && extensions.includes(extname(entry.name).toLowerCase()))
    .map(entry => entry.name).sort();
}

function timeFrom(tags, offset, shift) {
  return captureTime(tags['ExifIFD:DateTimeOriginal'], offset, shift, tags['ExifIFD:SubSecTimeOriginal']);
}

async function readReferences(folder, fallback) {
  const references = [];
  for (const name of await filesIn(folder, ['.jpg', '.jpeg', '.heic'])) {
    try {
      const tags = await readPhoto(join(folder, name), true);
      const gps = position(tags);
      const time = timeFrom(tags, tags['ExifIFD:OffsetTimeOriginal'] ?? fallback);
      if (!gps || time === undefined) {
        console.log(`${display(name)}：参考照片跳过（缺少有效 GPS、拍摄时间或时区）`);
        continue;
      }
      references.push({ name, time, ...gps });
    } catch {
      console.log(`${display(name)}：参考照片读取失败`);
    }
  }
  return references;
}

async function readTrack(file) {
  try {
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file));
    return parseGpx(xml);
  } catch (error) {
    throw new Error(`GPX 读取失败：${error.message}`);
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    phone: { type: 'string' }, gpx: { type: 'string', multiple: true }, camera: { type: 'string' }, out: { type: 'string' },
    'phone-offset': { type: 'string' }, 'camera-offset': { type: 'string' },
    shift: { type: 'string', default: '0' }, window: { type: 'string', default: '60' },
    'max-gap': { type: 'string', default: '120' },
    preview: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) return console.log(usage);
  if (values.gpx?.length > 1) throw new Error('每次只支持一个 GPX 文件');
  const gpx = values.gpx?.[0];
  if (Boolean(values.phone) === Boolean(gpx) || !values.camera || (!values.preview && !values.out)) throw new Error(usage);
  const shift = Number(values.shift);
  const window = Number(values.window);
  const maxGap = Number(values['max-gap']);
  if (!values.shift.trim() || !Number.isFinite(shift) || Math.abs(shift) > 86400 ||
      !values.window.trim() || !Number.isFinite(window) || window < 0 || window > 86400) {
    throw new Error('校时和匹配窗口须为有效秒数，最大 86400 秒');
  }
  if (!Number.isFinite(maxGap) || maxGap <= 0 || maxGap > 86400) throw new Error('GPX 连续间隔须大于 0 且不超过 86400 秒');
  for (const value of [values['phone-offset'], values['camera-offset']]) {
    if (value !== undefined && !validOffset(value)) throw new Error('请输入有效的拍摄 UTC 偏移，例如 +08:00');
  }

  const phone = values.phone ? await realpath(resolve(values.phone)) : undefined;
  const camera = await realpath(resolve(values.camera));
  if (phone === camera) throw new Error('请把手机参考照片和相机照片放入不同目录');
  const track = gpx ? await readTrack(resolve(gpx)) : undefined;
  const references = phone ? await readReferences(phone, values['phone-offset']) : undefined;
  if (track && !track.usable) throw new Error(`GPX 没有带有效时间和坐标的轨迹点（跳过 ${track.skipped} 点）`);
  if (references && !references.length) throw new Error('没有可用的手机参考照片');
  const rows = [];
  let failed = 0;
  let skipped = 0;
  const source = track
    ? `GPX ${display(basename(gpx))}：${track.segmentCount} 段，有效轨迹点 ${track.usable} 个，跳过 ${track.skipped} 点，连续间隔上限 ${maxGap} 秒`
    : `有效参考照片 ${references.length} 张`;
  console.log(`${source}，相机时钟修正 ${shift} 秒，匹配窗口 ±${window} 秒`);
  for (const name of await filesIn(camera, ['.jpg', '.jpeg'])) {
    const file = join(camera, name);
    try {
      const hash = await fileHash(file);
      const tags = await readPhoto(file);
      if (hash !== await fileHash(file)) throw new Error('源照片正在变化');
      const time = timeFrom(tags, values['camera-offset'] ?? tags['ExifIFD:OffsetTimeOriginal'], shift);
      let suggestion;
      if (hasGps(tags)) suggestion = { reason: '已有 GPS，保留原位置' };
      else if (track) suggestion = suggestTrackPosition(time, track, window, maxGap);
      else suggestion = suggestPosition(time, references, window);
      if (suggestion.reason) {
        skipped++;
        console.log(`${display(name)}：跳过（${suggestion.reason}）`);
        continue;
      }
      const { seconds } = suggestion;
      const reference = track ? suggestion : suggestion.reference;
      const evidence = track
        ? `GPX ${display(basename(gpx))} 第 ${suggestion.segment} 段，${suggestion.method}，距最近采样 ${seconds} 秒`
        : `参考 ${display(reference.name)}，相差 ${seconds} 秒`;
      rows.push({ name, file, tags, hash, reference });
      console.log(`${rows.length}. ${display(name)} → ${reference.latitude}, ${reference.longitude}（${evidence}，匹配时间 ${new Date(time).toISOString()}）`);
    } catch {
      failed++;
      console.log(`${display(name)}：读取或校验失败`);
    }
  }

  console.log(`待确认 ${rows.length} 张，跳过 ${skipped} 张，读取失败 ${failed} 张`);
  if (failed) process.exitCode = 2;
  if (values.preview || !rows.length) return;

  const input = createInterface({ input: stdin, terminal: false });
  stdout.write('输入要导出的编号（例如 1,3），输入 all 确认全部，直接回车取消：');
  let answer = '';
  for await (const line of input) {
    answer = line.trim();
    break;
  }
  input.close();
  if (!answer) return console.log('\n已取消，未导出照片');
  const selected = answer === 'all' ? rows : [...new Set(answer.split(',').map(item => Number(item.trim())))].map(index => rows[index - 1]);
  if (selected.some(row => !row)) throw new Error('编号无效，未导出照片');

  const out = resolve(values.out);
  await mkdir(out, { recursive: true });
  const output = await realpath(out);
  if (output === camera || output === phone) throw new Error('输出目录必须与输入目录不同');
  let exported = 0;
  for (const row of selected) {
    try {
      await exportCopy(row, output);
      exported++;
      console.log(`\n${display(row.name)}：已写入副本并回验`);
    } catch (error) {
      failed++;
      const reason = error.code === 'EEXIST' ? '目标已存在，保留已有文件' : error.message.split('\n')[0];
      console.log(`\n${display(row.name)}：导出失败（${reason}）`);
    }
  }
  console.log(`导出成功 ${exported} 张，未确认 ${rows.length - selected.length} 张，失败 ${failed} 张。输出目录 ${display(output)}`);
  if (failed) process.exitCode = 2;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
