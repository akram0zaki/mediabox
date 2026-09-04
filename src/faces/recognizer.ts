/**
 * On-device face recognition: InsightFace MobileFaceNet (w600k, from the "buffalo_sc" pack)
 * via onnxruntime-web. Faces are aligned to the 112×112 ArcFace template using their five
 * landmarks; the network returns a 512-d embedding and cosine similarity decides matches.
 */
import { createCanvas, getCtx, type Canvas2D } from '../core/canvas';
import { EngineStatus, type FaceBox, type Landmarks } from './common';
import { createSession, ort, ortQueue } from './ort';

const BASE = import.meta.env.BASE_URL;
const MODEL_PATH = `${BASE}models/face_recognition_mobilefacenet_w600k.onnx`;
const INPUT = 'input.1';
/**
 * Faces per inference run. Batches are padded to one of these sizes: WebGPU compiles shaders per
 * input shape, so using only two shapes avoids a stall every time the face count changes.
 */
const BATCH_SIZES = [4, 8];
const MAX_BATCH = BATCH_SIZES[BATCH_SIZES.length - 1];
const SIZE = 112;

/** ArcFace reference landmark positions for a 112×112 crop (same as cv::FaceRecognizerSF). */
const TEMPLATE: Landmarks = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

export class FaceRecognizer {
  readonly status = new EngineStatus();
  private loadPromise: Promise<ort.InferenceSession> | null = null;
  private aligned: Canvas2D | null = null;

  load(): Promise<ort.InferenceSession> {
    if (!this.loadPromise) {
      this.loadPromise = this.init().catch((err) => {
        this.loadPromise = null;
        this.status.set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
        throw err;
      });
    }
    return this.loadPromise;
  }

  private async init(): Promise<ort.InferenceSession> {
    this.status.set({ status: 'loading', error: null });
    const model = await fetch(MODEL_PATH).then((r) => {
      if (!r.ok) throw new Error(`Failed to load face recognition model (${r.status})`);
      return r.arrayBuffer();
    });
    const { session, backend } = await createSession(model, 'mobilefacenet');
    this.status.set({ status: 'ready', backend });
    return session;
  }

  /** Computes an L2-normalised embedding for one face in `source` (canvas pixel space). */
  async embed(source: Canvas2D, face: FaceBox): Promise<Float32Array> {
    return (await this.embedMany(source, [face]))[0];
  }

  /** Embeds several faces from the same frame, batched through the network. */
  async embedMany(source: Canvas2D, faces: FaceBox[]): Promise<Float32Array[]> {
    if (faces.length === 0) return [];
    const session = await this.load(); // outside the queue: session creation is itself queued
    const out: Float32Array[] = [];
    for (let i = 0; i < faces.length; i += MAX_BATCH) {
      const chunk = faces.slice(i, i + MAX_BATCH);
      out.push(...(await ortQueue.run(() => this.runBatch(session, source, chunk))));
    }
    return out;
  }

  private async runBatch(session: ort.InferenceSession, source: Canvas2D, faces: FaceBox[]): Promise<Float32Array[]> {
    const plane = SIZE * SIZE;
    const batch = BATCH_SIZES.find((n) => n >= faces.length) ?? MAX_BATCH;
    const input = new Float32Array(batch * plane * 3); // zero-padded slots are ignored
    this.aligned ??= createCanvas(SIZE, SIZE);
    const ctx = getCtx(this.aligned, { willReadFrequently: true });

    faces.forEach((face, n) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, SIZE, SIZE);
      if (face.landmarks) {
        const m = similarityTransform(face.landmarks, TEMPLATE);
        ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
        ctx.drawImage(source, 0, 0);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      } else {
        // No landmarks: square crop around the box, slightly enlarged.
        const cx = face.x + face.w / 2;
        const cy = face.y + face.h / 2;
        const s = Math.max(face.w, face.h) * 1.1;
        ctx.drawImage(source, cx - s / 2, cy - s / 2, s, s, 0, 0, SIZE, SIZE);
      }
      // NCHW, RGB, scaled to [-1, 1] as InsightFace expects.
      const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
      const base = n * plane * 3;
      for (let i = 0, p = 0; i < plane; i++, p += 4) {
        input[base + i] = (data[p] - 127.5) / 127.5;
        input[base + plane + i] = (data[p + 1] - 127.5) / 127.5;
        input[base + plane * 2 + i] = (data[p + 2] - 127.5) / 127.5;
      }
    });

    const out = await session.run({ [INPUT]: new ort.Tensor('float32', input, [batch, 3, SIZE, SIZE]) });
    const result = out[session.outputNames[0]];
    const raw = result.data as Float32Array;
    const dim = result.dims[1];
    return faces.map((_, n) => normalize(raw.subarray(n * dim, (n + 1) * dim)));
  }
}

function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const inv = sum > 0 ? 1 / Math.sqrt(sum) : 0;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}

/** Cosine similarity of two L2-normalised embeddings. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Least-squares non-reflective similarity transform (scale, rotation, translation) mapping
 * `src` points onto `dst` points, as a canvas matrix {a,b,c,d,e,f}: x' = a·x + c·y + e, y' = b·x + d·y + f.
 */
export function similarityTransform(src: Landmarks, dst: Landmarks) {
  // Unknowns p = [s·cosθ, s·sinθ, tx, ty]; rows: [x, -y, 1, 0]·p = x', [y, x, 0, 1]·p = y'.
  let sxx = 0, sx = 0, sy = 0, sux = 0, suy = 0, su = 0, sv = 0;
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    sxx += x * x + y * y;
    sx += x;
    sy += y;
    sux += x * u + y * v;
    suy += x * v - y * u;
    su += u;
    sv += v;
  }
  const A = [
    [sxx, 0, sx, sy],
    [0, sxx, -sy, sx],
    [sx, -sy, n, 0],
    [sy, sx, 0, n],
  ];
  const [a, b, tx, ty] = solve4(A, [sux, suy, su, sv]);
  return { a, b, c: -b, d: a, e: tx, f: ty };
}

function solve4(A: number[][], b: number[]): number[] {
  const m = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const p = m[col][col] || 1e-9;
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const f = m[r][col] / p;
      for (let c = col; c <= 4; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => row[4] / (row[i] || 1e-9));
}

export const faceRecognizer = new FaceRecognizer();
