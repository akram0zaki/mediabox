// Node-only end-to-end check of the neural engine using two portraits and known 5-point landmarks.
// Usage: node desktop/scripts/test-swap.mjs <modelDir> <target.jpg> <source.jpg> <out.jpg>
import { readFileSync, writeFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { NeuralSwapEngine, EMBED_SIZE, SWAP_SIZE } from '../dist/neural/engine.js';

const [modelDir, targetPath, sourcePath, outPath] = process.argv.slice(2);
const LANDMARKS = {
  'einstein.jpg': [[628.5, 653.5], [891.9, 678.2], [771.8, 844.2], [626.3, 956.1], [837.7, 977.8]],
  'curie.jpg': [[454.7, 683.8], [684.3, 677.8], [548, 815.2], [486.8, 909.7], [673.7, 905.2]],
};
const TEMPLATE = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];

function similarity(src, dst) {
  let sxx = 0, sx = 0, sy = 0, sux = 0, suy = 0, su = 0, sv = 0;
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const [x, y] = src[i]; const [u, v] = dst[i];
    sxx += x * x + y * y; sx += x; sy += y; sux += x * u + y * v; suy += x * v - y * u; su += u; sv += v;
  }
  const A = [[sxx, 0, sx, sy], [0, sxx, -sy, sx], [sx, -sy, n, 0], [sy, sx, 0, n]];
  const b = [sux, suy, su, sv];
  const m = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 4; c++) {
    let p = c; for (let r = c + 1; r < 4; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < 4; r++) { if (r === c) continue; const f = m[r][c] / m[c][c]; for (let k = c; k <= 4; k++) m[r][k] -= f * m[c][k]; }
  }
  const [a, bb, tx, ty] = m.map((r, i) => r[4] / r[i]);
  return { a, b: bb, c: -bb, d: a, e: tx, f: ty }; // x' = a x + c y + e ; y' = b x + d y + f
}
function invert(t) {
  const det = t.a * t.d - t.b * t.c;
  return { a: t.d / det, b: -t.b / det, c: -t.c / det, d: t.a / det, e: (t.c * t.f - t.d * t.e) / det, f: (t.b * t.e - t.a * t.f) / det };
}
function sample(img, x, y, ch) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(img.width - 1, x0 + 1), y1 = Math.min(img.height - 1, y0 + 1);
  if (x0 < 0 || y0 < 0 || x0 >= img.width || y0 >= img.height) return 0;
  const fx = x - x0, fy = y - y0;
  const px = (xx, yy) => img.data[(yy * img.width + xx) * 4 + ch];
  return px(x0, y0) * (1 - fx) * (1 - fy) + px(x1, y0) * fx * (1 - fy) + px(x0, y1) * (1 - fx) * fy + px(x1, y1) * fx * fy;
}
/** Warps the image into an aligned size×size crop; returns {data: Float32 NCHW RGB raw 0..255, inv} */
function alignCrop(img, landmarks, size) {
  const k = size / 112;
  const dst = TEMPLATE.map(([x, y]) => [x * k, y * k]);
  const t = similarity(landmarks, dst);
  const inv = invert(t);
  const data = new Float32Array(3 * size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sx = inv.a * x + inv.c * y + inv.e, sy = inv.b * x + inv.d * y + inv.f;
    for (let ch = 0; ch < 3; ch++) data[ch * size * size + y * size + x] = sample(img, sx, sy, ch);
  }
  return { data, t, inv };
}

const target = jpeg.decode(readFileSync(targetPath), { useTArray: true });
const source = jpeg.decode(readFileSync(sourcePath), { useTArray: true });
const engine = new NeuralSwapEngine(modelDir);
let t0 = Date.now();
await engine.load();
console.log('loaded in', Date.now() - t0, 'ms; backend', engine.status().backend);

const s = alignCrop(source, LANDMARKS[sourcePath.split('/').pop()], EMBED_SIZE);
const sIn = s.data.map((v) => v / 127.5 - 1);
t0 = Date.now();
const embedding = await engine.embed(sIn);
console.log('embed', Date.now() - t0, 'ms; norm', Math.hypot(...embedding).toFixed(2));

const tg = alignCrop(target, LANDMARKS[targetPath.split('/').pop()], SWAP_SIZE);
const tIn = tg.data.map((v) => v / 255);
t0 = Date.now();
const out = await engine.swap(tIn, embedding);
console.log('swap', Date.now() - t0, 'ms; out range', Math.min(...out).toFixed(2), Math.max(...out).toFixed(2));

// Paste back: for every target pixel inside the crop's footprint, map into 128-space and blend with a soft box mask.
const res = { width: SWAP_SIZE, height: SWAP_SIZE, data: new Uint8ClampedArray(SWAP_SIZE * SWAP_SIZE * 4) };
for (let i = 0; i < SWAP_SIZE * SWAP_SIZE; i++) for (let ch = 0; ch < 3; ch++) res.data[i * 4 + ch] = Math.max(0, Math.min(255, out[ch * SWAP_SIZE * SWAP_SIZE + i] * 255));
const outImg = { width: target.width, height: target.height, data: new Uint8Array(target.data) };
const pad = 12, feather = 14;
for (let y = 0; y < target.height; y++) for (let x = 0; x < target.width; x++) {
  const cx = tg.t.a * x + tg.t.c * y + tg.t.e, cy = tg.t.b * x + tg.t.d * y + tg.t.f;
  if (cx < pad || cy < pad || cx > SWAP_SIZE - pad || cy > SWAP_SIZE - pad) continue;
  const dEdge = Math.min(cx - pad, cy - pad, SWAP_SIZE - pad - cx, SWAP_SIZE - pad - cy);
  const a = Math.min(1, dEdge / feather);
  const i = (y * target.width + x) * 4;
  for (let ch = 0; ch < 3; ch++) outImg.data[i + ch] = outImg.data[i + ch] * (1 - a) + sample(res, cx, cy, ch) * a;
}
writeFileSync(outPath, jpeg.encode(outImg, 90).data);
console.log('wrote', outPath);
