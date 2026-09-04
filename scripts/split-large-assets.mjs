// Cloudflare Pages / Workers reject single files over 25 MiB. The ONNX Runtime WebGPU build is
// larger, so after `vite build` it is split into numbered parts that src/faces/ort.ts reassembles
// in the browser. Run automatically by `pnpm build`.
import { readFileSync, writeFileSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LIMIT = 20 * 1024 * 1024; // keep parts comfortably under 25 MiB
const dist = join(process.cwd(), 'dist');
const targets = ['ort/ort-wasm-simd-threaded.jsep.wasm'];

for (const rel of targets) {
  const file = join(dist, rel);
  if (!existsSync(file)) continue;
  const size = statSync(file).size;
  if (size <= LIMIT) continue;
  const data = readFileSync(file);
  const parts = Math.ceil(size / LIMIT);
  for (let i = 0; i < parts; i++) writeFileSync(`${file}.part${i}`, data.subarray(i * LIMIT, (i + 1) * LIMIT));
  writeFileSync(`${file}.parts.json`, JSON.stringify({ parts, size }));
  unlinkSync(file);
  console.log(`split ${rel} (${(size / 1048576).toFixed(1)} MB) into ${parts} parts`);
}
