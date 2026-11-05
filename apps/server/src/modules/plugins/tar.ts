import { gunzipSync, gzipSync } from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface TarEntry {
  path: string;
  data: Buffer;
}

const MAX_FILES = 2000;
const MAX_TOTAL = 50 * 1024 * 1024;

function readString(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? len : nul).toString('utf8');
}

/**
 * Parse a gzip'd tarball (the format `npm pack` produces) in memory. Only
 * regular files are accepted: symlinks, hard links, devices, absolute paths and
 * `..` segments are rejected, so a package can never write outside its folder.
 */
export function parseTgz(archive: Buffer): TarEntry[] {
  const tar = gunzipSync(archive, { maxOutputLength: MAX_TOTAL });
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | null = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = readString(header, 0, 100);
    const size = parseInt(readString(header, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = readString(header, 345, 155);
    const dataStart = offset + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/, '');
      continue;
    }
    if (type === 'x' || type === 'g') continue; // pax headers
    const full = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;
    if (type === '5') continue; // directories are implied
    if (type !== '0' && type !== '\0' && type !== '7') throw new Error(`Unsupported entry type "${type}" for ${full} (links are not allowed)`);
    const normalized = path.posix.normalize(full.replace(/\\/g, '/'));
    if (normalized.startsWith('/') || normalized.split('/').includes('..') || /^[A-Za-z]:/.test(normalized)) {
      throw new Error(`Unsafe path in package: ${full}`);
    }
    entries.push({ path: normalized, data: Buffer.from(data) });
    if (entries.length > MAX_FILES) throw new Error('Package contains too many files');
  }
  return entries;
}

/** Strip the npm-pack `package/` prefix if every entry shares it. */
export function stripPackagePrefix(entries: TarEntry[]): TarEntry[] {
  if (entries.length && entries.every((e) => e.path.startsWith('package/'))) {
    return entries.map((e) => ({ ...e, path: e.path.slice('package/'.length) }));
  }
  return entries;
}

export async function writeEntries(dir: string, entries: TarEntry[]): Promise<void> {
  const root = path.resolve(dir);
  for (const e of entries) {
    const target = path.resolve(root, e.path);
    if (!target.startsWith(root + path.sep)) throw new Error(`Unsafe path in package: ${e.path}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, e.data);
  }
}

/** Build a .tgz from in-memory files (used by tests and the plugin SDK pack helper). */
export function buildTgz(files: Record<string, string | Buffer>, prefix = 'package/'): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(prefix + name, 0, 100, 'utf8');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
