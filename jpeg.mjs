import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, link, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { exiftoolPath } from 'exiftool-vendored';

const run = promisify(execFile);
const preservedTags = ['File:ImageDataHash', 'IFD0:Orientation', 'ExifIFD:DateTimeOriginal',
  'ExifIFD:OffsetTimeOriginal', 'ExifIFD:SubSecTimeOriginal', 'IFD0:Artist'];

async function exif(...args) {
  if (args.some(arg => /[\r\n]/.test(arg))) throw new Error('ExifTool 参数含换行符');
  const command = run(await exiftoolPath(), ['-config', '', '-charset', 'filename=UTF8', '-@', '-'], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
    env: { ...process.env, LC_ALL: 'C' },
  });
  command.child.stdin.on('error', () => {});
  command.child.stdin.end(`${args.join('\n')}\n`, 'utf8');
  return command;
}

export async function readPhoto(file, reference = false) {
  const { stdout } = await exif('-j', '-G1', '-n', '-api', 'ImageHashType=SHA256', '-FileType',
    '-Error', '-Warning', '-GPS:all', '-XMP-exif:GPS*', ...preservedTags.map(tag => `-${tag}`), file);
  const [tags] = JSON.parse(stdout);
  const fileType = tags['File:FileType'];
  if (fileType !== 'JPEG' && !(reference && fileType === 'HEIC')) {
    throw new Error(reference ? '无法读取 JPEG/HEIC 参考照片' : '无法读取 JPEG');
  }
  if (!tags['File:ImageDataHash'] || Object.keys(tags).some(key => key.endsWith(':Error'))) {
    throw new Error('图像编码数据不可读取');
  }
  return tags;
}

export function hasGps(tags) {
  return Object.keys(tags).some(key => /^(?:GPS|XMP-exif):GPS(?:Latitude|Longitude|DestLatitude|DestLongitude)/.test(key));
}

export function position(tags) {
  const latitude = tags['GPS:GPSLatitude'];
  const longitude = tags['GPS:GPSLongitude'];
  const ns = tags['GPS:GPSLatitudeRef'];
  const ew = tags['GPS:GPSLongitudeRef'];
  const datum = tags['GPS:GPSMapDatum'];
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !/^[NS]$/.test(ns) ||
      !Number.isFinite(longitude) || Math.abs(longitude) > 180 || !/^[EW]$/.test(ew) ||
      (datum && !/^WGS[ -]?84$/i.test(datum))) return undefined;
  return {
    latitude: Math.abs(latitude) * (ns === 'S' ? -1 : 1),
    longitude: Math.abs(longitude) * (ew === 'W' ? -1 : 1),
  };
}

export async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function exportCopy(row, directory) {
  const temp = await mkdtemp(join(directory, '.geotag-'));
  const staged = join(temp, 'photo.jpg');
  const { latitude, longitude } = row.reference;
  try {
    await copyFile(row.file, staged);
    if (await fileHash(staged) !== row.hash) throw new Error('源文件在预览后已变化，请重新扫描');
    const { stderr } = await exif('-overwrite_original', `-GPS:GPSLatitude=${Math.abs(latitude)}`,
      `-GPS:GPSLatitudeRef=${latitude < 0 ? 'S' : 'N'}`, `-GPS:GPSLongitude=${Math.abs(longitude)}`,
      `-GPS:GPSLongitudeRef=${longitude < 0 ? 'W' : 'E'}`, '-GPS:GPSMapDatum=WGS-84', staged);
    if (stderr.trim()) throw new Error('写入时出现元数据警告');
    const verified = await readPhoto(staged);
    const result = position(verified);
    if (!result || Math.abs(result.latitude - latitude) > 1e-7 || Math.abs(result.longitude - longitude) > 1e-7 ||
        preservedTags.some(tag => verified[tag] !== row.tags[tag])) {
      throw new Error('坐标、图像数据或原有元数据回验失败');
    }
    await link(staged, join(directory, row.name));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
