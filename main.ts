import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync, constants } from 'node:zlib';

const inputRoot = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputRoot = process.env.MAKEFUN_OUTPUT_DIR || '/output';

function u32(b: Buffer, p: number) { return b.readUInt32BE(p); }
function paeth(a: number, b: number, c: number) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
function parsePng(buf: Buffer) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('bad png');
  let pos = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  const ids: Buffer[] = [];
  while (pos + 12 <= buf.length) {
    const len = u32(buf, pos), type = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = u32(data, 0); height = u32(data, 4); depth = data[8]; color = data[9]; interlace = data[12]; }
    if (type === 'IDAT') ids.push(Buffer.from(data));
    pos += len + 12;
    if (type === 'IEND') break;
  }
  if (depth !== 8 || color !== 6 || interlace !== 0) throw new Error('unsupported input png');
  const bpp = 4, stride = width * bpp, packed = inflateSync(Buffer.concat(ids));
  const raw = Buffer.alloc(width * height * bpp);
  let rp = 0, prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const ft = packed[rp++], row = packed.subarray(rp, rp + stride), out = raw.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0, v = row[x];
      out[x] = ft === 0 ? v : ft === 1 ? (v + a) & 255 : ft === 2 ? (v + b) & 255 : ft === 3 ? (v + ((a + b) >> 1)) & 255 : (v + paeth(a, b, c)) & 255;
    }
    prev = Buffer.from(out); rp += stride;
  }
  return { width, height, rgba: raw };
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
function crc32(parts: Buffer[]) {
  let c = 0xffffffff;
  for (const part of parts) for (let i = 0; i < part.length; i++) c = crcTable[(c ^ part[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const out = Buffer.alloc(12 + data.length), tb = Buffer.from(type, 'ascii');
  out.writeUInt32BE(data.length, 0); tb.copy(out, 4); data.copy(out, 8); out.writeUInt32BE(crc32([tb, data]), 8 + data.length);
  return out;
}

type Mode = { color: number, bpp: number, pixels: Buffer, palette?: Buffer, trns?: Buffer };
function modesFor(width: number, height: number, rgba: Buffer): Mode[] {
  const n = width * height;
  let alphaOpaque = true, gray = true;
  const seen = new Map<number, number>(); const counts = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const p = i * 4, r = rgba[p], g = rgba[p + 1], b = rgba[p + 2], a = rgba[p + 3];
    if (a !== 255) alphaOpaque = false;
    if (r !== g || r !== b) gray = false;
    const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
    if (!seen.has(key)) seen.set(key, seen.size); counts.set(key, (counts.get(key) || 0) + 1);
    if (seen.size > 256 && !alphaOpaque && !gray) break;
  }
  const modes: Mode[] = [];
  const canPal = seen.size <= 256;
  if (canPal) {
    const idx = Buffer.alloc(n), pal: number[] = [], al: number[] = [];
    const entries = [...seen.entries()].sort((a, b) => (counts.get(b[0])! - counts.get(a[0])!) || (a[1] - b[1]));
    const remap = new Map<number, number>(); entries.forEach(([key], i) => remap.set(key, i));
    for (const [key] of entries) { pal.push((key >>> 24) & 255, (key >>> 16) & 255, (key >>> 8) & 255); al.push(key & 255); }
    for (let i = 0; i < n; i++) {
      const p = i * 4, key = ((rgba[p] << 24) | (rgba[p + 1] << 16) | (rgba[p + 2] << 8) | rgba[p + 3]) >>> 0;
      idx[i] = remap.get(key)!;
    }
    let lastAlpha = -1; for (let i = 0; i < al.length; i++) if (al[i] !== 255) lastAlpha = i;
    modes.push({ color: 3, bpp: 1, pixels: idx, palette: Buffer.from(pal), trns: lastAlpha >= 0 ? Buffer.from(al.slice(0, lastAlpha + 1)) : undefined });
  }
  if (alphaOpaque && gray) {
    const g = Buffer.alloc(n);
    for (let i = 0; i < n; i++) g[i] = rgba[i * 4];
    modes.push({ color: 0, bpp: 1, pixels: g });
  } else if (alphaOpaque) {
    const rgb = Buffer.alloc(n * 3);
    for (let i = 0; i < n; i++) { rgba.copy(rgb, i * 3, i * 4, i * 4 + 3); }
    modes.push({ color: 2, bpp: 3, pixels: rgb });
  } else if (gray) {
    const ga = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) { ga[i * 2] = rgba[i * 4]; ga[i * 2 + 1] = rgba[i * 4 + 3]; }
    modes.push({ color: 4, bpp: 2, pixels: ga });
  }
  modes.push({ color: 6, bpp: 4, pixels: rgba });
  return [...new Map(modes.map(m => [m.color, m])).values()];
}

function filterImage(mode: Mode, width: number, height: number, fixed: number | null) {
  const stride = width * mode.bpp, out = Buffer.alloc((stride + 1) * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = mode.pixels.subarray(y * stride, (y + 1) * stride), op = y * (stride + 1);
    const rows: Uint8Array[] = [];
    let scores: number[] = [];
    for (let ft = 0; ft < 5; ft++) {
      const enc = new Uint8Array(stride);
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= mode.bpp ? row[x - mode.bpp] : 0, b = prev[x], c = x >= mode.bpp ? prev[x - mode.bpp] : 0;
        const pred = ft === 0 ? 0 : ft === 1 ? a : ft === 2 ? b : ft === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (row[x] - pred) & 255; enc[x] = v;
        score += v < 128 ? v : 256 - v;
      }
      rows.push(enc); scores.push(score);
    }
    const ft = fixed === null ? scores.indexOf(Math.min(...scores)) : fixed;
    out[op] = ft; Buffer.from(rows[ft]).copy(out, op + 1);
    prev = row as unknown as Uint8Array;
  }
  return out;
}

function encodePng(width: number, height: number, mode: Mode, filtered: Buffer) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = mode.color;
  const strategies = [constants.Z_DEFAULT_STRATEGY, constants.Z_FILTERED, constants.Z_RLE];
  let zbest: Buffer | null = null;
  for (const strategy of strategies) {
    const z = deflateSync(filtered, { level: 9, memLevel: 9, strategy });
    if (!zbest || z.length < zbest.length) zbest = z;
  }
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (mode.palette) parts.push(chunk('PLTE', mode.palette));
  if (mode.trns) parts.push(chunk('tRNS', mode.trns));
  parts.push(chunk('IDAT', zbest!), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function squeeze(file: string) {
  const src = parsePng(readFileSync(file));
  let best: Buffer | null = null;
  for (const mode of modesFor(src.width, src.height, src.rgba)) {
    const variants = [filterImage(mode, src.width, src.height, null), filterImage(mode, src.width, src.height, 4), filterImage(mode, src.width, src.height, 0)];
    for (const v of variants) {
      const png = encodePng(src.width, src.height, mode, v);
      if (!best || png.length < best.length) best = png;
    }
  }
  return best!;
}

for (const id of readdirSync(inputRoot)) {
  const out = squeeze(join(inputRoot, id, 'image.png'));
  mkdirSync(join(outputRoot, id), { recursive: true });
  writeFileSync(join(outputRoot, id, 'image.png'), out);
  console.log(id, out.length);
}
