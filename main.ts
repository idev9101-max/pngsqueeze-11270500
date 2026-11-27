import { mkdirSync, readdirSync, readFileSync, writeFileSync, chmodSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';

const inputRoot = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputRoot = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const binaryPath = '/tmp/pngsqueeze-oxipng-bin';
const ectPath = '/tmp/pngsqueeze-ect-bin';
for (const [asset, target] of [['oxipng.gz', binaryPath], ['ect.gz', ectPath]]) {
  if (!existsSync(target)) {
    const packed = readFileSync(new URL('./' + asset, import.meta.url));
    writeFileSync(target, gunzipSync(packed), { mode: 0o755 });
    chmodSync(target, 0o755);
  }
}
function runOx(level, source, target, extra = []) {
  const scratch = `/tmp/${target.replaceAll('/', '_')}-${level}-${extra.join('-')}.png`;
  const args = ['-o', level, '--nb', '--threads', '1', ...extra, '--out', scratch, source];
  const run = spawnSync(binaryPath, args, { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`oxipng failed ${run.stderr || run.stdout}`);
  return scratch;
}
function runEct(source, id) {
  const scratch = `/tmp/${id}-ect.png`;
  copyFileSync(source, scratch);
  const run = spawnSync(ectPath, ['-6', '--strict', '--reuse', '-quiet', scratch], { encoding: 'utf8' });
  if (run.status !== 0) return source;
  return statSync(scratch).size < statSync(source).size ? scratch : source;
}
function colorType(path) {
  return readFileSync(path)[25];
}
const ids = readdirSync(inputRoot).sort();
for (const id of ids) {
  mkdirSync(join(outputRoot, id), { recursive: true });
  copyFileSync(join(inputRoot, id, 'image.png'), join(outputRoot, id, 'image.png'));
}
for (const id of ids) {
  const source = join(inputRoot, id, 'image.png');
  const target = join(outputRoot, id, 'image.png');
  copyFileSync(runOx('4', source, id), target);
}
const refine = ids.filter((id) => {
  const target = join(outputRoot, id, 'image.png');
  return colorType(target) === 0 || statSync(target).size > 90000;
}).sort((a, b) => statSync(join(outputRoot, b, 'image.png')).size - statSync(join(outputRoot, a, 'image.png')).size);
for (const id of refine) {
  const source = join(inputRoot, id, 'image.png');
  const target = join(outputRoot, id, 'image.png');
  const candidate = runOx('5', source, `${id}-refine`);
  if (statSync(candidate).size < statSync(target).size) copyFileSync(candidate, target);
}
const ectOrder = [...ids].sort((a, b) => statSync(join(outputRoot, a, 'image.png')).size - statSync(join(outputRoot, b, 'image.png')).size);
for (const id of ectOrder) {
  const target = join(outputRoot, id, 'image.png');
  const candidate = runEct(target, id);
  if (candidate !== target && statSync(candidate).size < statSync(target).size) copyFileSync(candidate, target);
}

