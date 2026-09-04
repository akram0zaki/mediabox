// Copies the on-device inference runtimes out of node_modules into /public and fetches the
// detection models if they are missing. Runs on `npm install`; safe to re-run at any time.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const root = dirname(fileURLToPath(new URL('.', import.meta.url)));
const pub = join(root, 'public');

const copies = [
  { from: 'node_modules/@mediapipe/tasks-vision/wasm', to: 'mediapipe/wasm', match: /^vision_wasm_(internal|nosimd_internal)\.(js|wasm)$/ },
  { from: 'node_modules/onnxruntime-web/dist', to: 'ort', match: /^ort-wasm-simd-threaded(\.jsep)?\.(mjs|wasm)$/ },
];

const models = [
  {
    file: 'models/blaze_face_short_range.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
  },
  {
    file: 'models/face_detection_yunet_2023mar.onnx',
    url: 'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
  },
  {
    file: 'models/face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  },
  {
    // InsightFace "buffalo_sc" pack; we only need the MobileFaceNet recogniser inside the zip.
    file: 'models/face_recognition_mobilefacenet_w600k.onnx',
    url: 'https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_sc.zip',
    zipMember: 'w600k_mbf.onnx',
  },
];

/** Extracts one file from a zip buffer (deflate or stored) without external dependencies. */
function unzipMember(zip, name) {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip file');
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory');
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLen = zip.readUInt16LE(offset + 28);
    const extraLen = zip.readUInt16LE(offset + 30);
    const commentLen = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const entryName = zip.toString('utf8', offset + 46, offset + 46 + nameLen);
    if (entryName === name || entryName.endsWith('/' + name)) {
      const lnameLen = zip.readUInt16LE(localOffset + 26);
      const lextraLen = zip.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lnameLen + lextraLen;
      const data = zip.subarray(start, start + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`unsupported zip compression ${method}`);
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${name} not found in zip`);
}

for (const c of copies) {
  const src = join(root, c.from);
  const dst = join(pub, c.to);
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    if (!c.match.test(name)) continue;
    const s = join(src, name);
    const d = join(dst, name);
    if (!existsSync(d) || statSync(d).size !== statSync(s).size) {
      copyFileSync(s, d);
      console.log(`copied ${c.to}/${name}`);
    }
  }
}

for (const m of models) {
  const dst = join(pub, m.file);
  if (existsSync(dst) && statSync(dst).size > 0) continue;
  mkdirSync(dirname(dst), { recursive: true });
  console.log(`downloading ${m.file}…`);
  const res = await fetch(m.url);
  if (!res.ok) {
    console.warn(`  failed (${res.status}); place the file manually at public/${m.file}`);
    continue;
  }
  const body = Buffer.from(await res.arrayBuffer());
  writeFileSync(dst, m.zipMember ? unzipMember(body, m.zipMember) : body);
}
