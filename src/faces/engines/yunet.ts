/**
 * Engine B: YuNet (OpenCV Zoo, 2023mar) via onnxruntime-web. A ~230 KB anchor-free detector that
 * finds small and distant faces at native resolution — ideal for crowds and wide shots.
 * Runs on WebGPU when available, otherwise WASM. Everything is served from /public.
 */
import { createCanvas, getCtx, type Canvas2D } from '../../core/canvas';
import { EngineStatus, mergeBoxes, type FaceBox, type Landmarks } from '../common';
import { createSession, ort, ortQueue } from '../ort';

export interface YuNetOptions {
  /** Longest side (px) of the image fed to the network. Larger = smaller faces found, slower. */
  analysisSize: number;
  minConfidence: number;
}

const BASE = import.meta.env.BASE_URL;
const MODEL_PATH = `${BASE}models/face_detection_yunet_2023mar.onnx`;
const STRIDES = [8, 16, 32] as const;
/** The 2023mar ONNX export has a fixed 640×640 input. */
const NET = 640;
/** Overlap between detail windows so faces on a seam are whole in at least one window. */
const OVERLAP = 128;


export class YuNetEngine {
  readonly id = 'yunet';
  readonly status = new EngineStatus();
  private loadPromise: Promise<ort.InferenceSession> | null = null;
  private scratch: Canvas2D | null = null;
  private input: Float32Array | null = null;

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
      if (!r.ok) throw new Error(`Failed to load YuNet model (${r.status})`);
      return r.arrayBuffer();
    });
    const { session, backend } = await createSession(model, 'yunet');
    this.status.set({ status: 'ready', backend });
    return session;
  }

  async detect(source: Canvas2D, options: YuNetOptions): Promise<FaceBox[]> {
    const session = await this.load(); // outside the queue: session creation is itself queued
    return ortQueue.run(() => this.detectInternal(session, source, options));
  }

  private async detectInternal(session: ort.InferenceSession, source: Canvas2D, options: YuNetOptions): Promise<FaceBox[]> {
    const sw = source.width;
    const sh = source.height;
    if (sw < 8 || sh < 8) return [];

    // Work in a virtual "analysis" space whose longest side is analysisSize.
    const scale = Math.min(1, options.analysisSize / Math.max(sw, sh));
    const aw = sw * scale;
    const ah = sh * scale;
    const threshold = yunetThreshold(options.minConfidence);

    // 1. Coarse pass: whole frame letterboxed into the network (catches large faces).
    const windows: Window[] = [{ ax: 0, ay: 0, factor: Math.min(NET / aw, NET / ah) }];
    // 2. Detail passes: NET-sized windows over the analysis space when it is larger than NET.
    if (aw > NET || ah > NET) {
      const stride = NET - OVERLAP;
      const cols = Math.max(1, Math.ceil((aw - NET) / stride) + 1);
      const rows = Math.max(1, Math.ceil((ah - NET) / stride) + 1);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          windows.push({ ax: Math.min(Math.max(0, aw - NET), i * stride), ay: Math.min(Math.max(0, ah - NET), j * stride), factor: 1 });
        }
      }
    }

    if (!this.scratch) this.scratch = createCanvas(NET, NET);
    const ctx = getCtx(this.scratch, { willReadFrequently: true });
    if (!this.input) this.input = new Float32Array(NET * NET * 3);
    const boxes: FaceBox[] = [];

    for (const win of windows) {
      // Source-space rectangle covered by this window.
      const srcX = win.ax / scale;
      const srcY = win.ay / scale;
      const srcSize = NET / win.factor / scale;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, NET, NET);
      ctx.drawImage(source, srcX, srcY, srcSize, srcSize, 0, 0, NET, NET);
      fillTensor(ctx.getImageData(0, 0, NET, NET).data, this.input);

      const outputs = await session.run({ input: new ort.Tensor('float32', this.input, [1, 3, NET, NET]) });
      const netToSrc = 1 / (win.factor * scale);
      for (const b of decode(outputs, threshold)) {
        boxes.push({
          x: b.x * netToSrc + srcX,
          y: b.y * netToSrc + srcY,
          w: b.w * netToSrc,
          h: b.h * netToSrc,
          score: b.score,
          landmarks: b.landmarks?.map(([px, py]) => [px * netToSrc + srcX, py * netToSrc + srcY]) as Landmarks,
        });
      }
    }
    return mergeBoxes(boxes, 0.3, 0.7);
  }
}

interface Window {
  /** Offset of the window in analysis space. */
  ax: number;
  ay: number;
  /** analysis-space → network-space scale factor. */
  factor: number;
}

/** NCHW, BGR, 0..255 — matches cv::dnn::blobFromImage as used by cv::FaceDetectorYN. */
function fillTensor(rgba: Uint8ClampedArray, out: Float32Array): void {
  const plane = NET * NET;
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    out[i] = rgba[p + 2];
    out[plane + i] = rgba[p + 1];
    out[plane * 2 + i] = rgba[p];
  }
}

/** Anchor-free decoding of the three stride heads, in network pixel space. */
function decode(outputs: ort.InferenceSession.OnnxValueMapType, threshold: number): FaceBox[] {
  const boxes: FaceBox[] = [];
  for (const stride of STRIDES) {
    const cls = outputs[`cls_${stride}`].data as Float32Array;
    const obj = outputs[`obj_${stride}`].data as Float32Array;
    const bbox = outputs[`bbox_${stride}`].data as Float32Array;
    const kps = outputs[`kps_${stride}`].data as Float32Array;
    const cols = NET / stride;
    const rows = NET / stride;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const score = Math.sqrt(clamp01(cls[idx]) * clamp01(obj[idx]));
        if (score < threshold) continue;
        const cx = (c + bbox[idx * 4]) * stride;
        const cy = (r + bbox[idx * 4 + 1]) * stride;
        const w = Math.exp(bbox[idx * 4 + 2]) * stride;
        const h = Math.exp(bbox[idx * 4 + 3]) * stride;
        const landmarks = [0, 1, 2, 3, 4].map((k) => [
          (c + kps[idx * 10 + k * 2]) * stride,
          (r + kps[idx * 10 + k * 2 + 1]) * stride,
        ]) as Landmarks;
        boxes.push({ x: cx - w / 2, y: cy - h / 2, w, h, score, landmarks });
      }
    }
  }
  return boxes;
}

/** YuNet scores are sharply bimodal; map the shared 0..1 sensitivity onto its useful range. */
function yunetThreshold(minConfidence: number): number {
  return 0.55 + 0.4 * Math.min(1, Math.max(0, minConfidence));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
