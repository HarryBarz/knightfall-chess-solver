import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'web/vendor/screenshot');
const notices = ['ONNXRUNTIME-LICENSE.txt', 'ONNXRUNTIME-ThirdPartyNotices.txt'];
// The npm runtime package omits these notices; the pinned upstream copies are committed.
for (const notice of notices) await readFile(resolve(output, notice));
await mkdir(resolve(output, 'ort'), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['scripts/screenshot_recognizer_entry.mjs'],
  outfile: resolve(output, 'recognizer.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  conditions: ['onnxruntime-web-use-extern-wasm'],
  target: ['chrome100', 'firefox110', 'safari16.4'],
  minify: true,
  legalComments: 'eof',
});

const assets = [
  ['@scoriiu/fenshot/model/chess-tiles-v2.onnx', 'chess-tiles-v2.onnx'],
  ['@scoriiu/fenshot/LICENSE', 'FENSHOT-LICENSE.txt'],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', 'ort/ort-wasm-simd-threaded.mjs'],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'ort/ort-wasm-simd-threaded.wasm'],
];
for (const [source, target] of assets) {
  await copyFile(resolve(root, 'node_modules', source), resolve(output, target));
}

const files = {};
for (const target of ['recognizer.mjs', ...assets.map(([, target]) => target), ...notices]) {
  const bytes = await readFile(resolve(output, target));
  files[target] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
await writeFile(resolve(output, 'manifest.json'), JSON.stringify({
  packages: { '@scoriiu/fenshot': '0.1.4', 'onnxruntime-web': '1.26.0', esbuild: '0.25.12' },
  files,
}, null, 2) + '\n');
console.log(`Built local screenshot recognition assets in ${output}`);
