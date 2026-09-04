/**
 * Engine A: MediaPipe BlazeFace (short range). Very fast on the GPU; best for faces that fill
 * a reasonable part of the frame (selfies, vlogs, interviews). Small faces need the tiled
 * "thorough" mode, which runs the model on overlapping crops.
 */
import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';
import { createCanvas, getCtx, type Canvas2D } from '../../core/canvas';
import { CallQueue, EngineStatus, mergeBoxes, type FaceBox, type Landmarks } from '../common';

export interface BlazeFaceOptions {
  /** `fast` = one pass; `thorough` = adds overlapping tiles for small faces (slower). */
  mode: 'fast' | 'thorough';
  minConfidence: number;
}

const BASE = import.meta.env.BASE_URL;
const WASM_PATH = `${BASE}mediapipe/wasm`;
const MODEL_PATH = `${BASE}models/blaze_face_short_range.tflite`;

/** BlazeFace needs a face to cover roughly this fraction of the input's short side to fire. */
const MIN_FACE_FRACTION = 0.14;
/** Smallest face (px) the thorough mode tries to find. Governs tile size. */
const THOROUGH_MIN_FACE_PX = 36;

export class BlazeFaceEngine {
  readonly id = 'blazeface';
  readonly status = new EngineStatus();
  private loadPromise: Promise<FaceDetector> | null = null;
  private currentMinConfidence = 0.5;
  private scratch: Canvas2D | null = null;
  private queue = new CallQueue();

  load(): Promise<FaceDetector> {
    if (!this.loadPromise) {
      this.loadPromise = this.init().catch((err) => {
        this.loadPromise = null;
        this.status.set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
        throw err;
      });
    }
    return this.loadPromise;
  }

  private async init(): Promise<FaceDetector> {
    this.status.set({ status: 'loading', error: null });
    const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
    const build = (delegate: 'GPU' | 'CPU') =>
      FaceDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_PATH, delegate },
        runningMode: 'IMAGE',
        minDetectionConfidence: this.currentMinConfidence,
        minSuppressionThreshold: 0.3,
      });
    let detector: FaceDetector;
    let backend = 'GPU';
    try {
      detector = await build('GPU');
    } catch (gpuErr) {
      console.warn('[faces/blazeface] GPU delegate unavailable, falling back to CPU', gpuErr);
      backend = 'CPU';
      detector = await build('CPU');
    }
    this.status.set({ status: 'ready', backend });
    return detector;
  }

  detect(source: Canvas2D, options: BlazeFaceOptions): Promise<FaceBox[]> {
    return this.queue.run(() => this.detectInternal(source, options));
  }

  private async detectInternal(source: Canvas2D, options: BlazeFaceOptions): Promise<FaceBox[]> {
    const detector = await this.load();
    const minConf = Math.min(0.95, Math.max(0.05, options.minConfidence));
    if (minConf !== this.currentMinConfidence) {
      await detector.setOptions({ minDetectionConfidence: minConf });
      this.currentMinConfidence = minConf;
    }
    const w = source.width;
    const h = source.height;
    if (w < 8 || h < 8) return [];

    const boxes = this.runOnRegion(detector, source, 0, 0, w, h);
    if (options.mode === 'thorough') {
      for (const tile of planTiles(w, h)) {
        boxes.push(...this.runOnRegion(detector, source, tile.x, tile.y, tile.w, tile.h));
      }
    }
    return mergeBoxes(boxes);
  }

  private runOnRegion(detector: FaceDetector, source: Canvas2D, x: number, y: number, w: number, h: number): FaceBox[] {
    let image: Canvas2D = source;
    if (x !== 0 || y !== 0 || w !== source.width || h !== source.height) {
      if (!this.scratch || this.scratch.width !== w || this.scratch.height !== h) this.scratch = createCanvas(w, h);
      const ctx = getCtx(this.scratch);
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(source, x, y, w, h, 0, 0, w, h);
      image = this.scratch;
    }
    const result = detector.detect(image as unknown as HTMLCanvasElement);
    const out: FaceBox[] = [];
    for (const d of result.detections) {
      const bb = d.boundingBox;
      if (!bb || bb.width <= 0 || bb.height <= 0) continue;
      // MediaPipe keypoints: right eye, left eye, nose tip, mouth centre, right ear, left ear (normalised).
      let landmarks: Landmarks | undefined;
      const k = d.keypoints;
      if (k && k.length >= 4) {
        const px = (i: number): [number, number] => [k[i].x * w + x, k[i].y * h + y];
        const [re, le, nose, mouth] = [px(0), px(1), px(2), px(3)];
        const ex = le[0] - re[0];
        const ey = le[1] - re[1];
        // Mouth corners ≈ mouth centre ± 0.35 × eye distance along the eye axis.
        landmarks = [re, le, nose, [mouth[0] - ex * 0.35, mouth[1] - ey * 0.35], [mouth[0] + ex * 0.35, mouth[1] + ey * 0.35]];
      }
      out.push({ x: bb.originX + x, y: bb.originY + y, w: bb.width, h: bb.height, score: d.categories[0]?.score ?? 0, landmarks });
    }
    return out;
  }
}

/**
 * Multi-scale overlapping tiles. Tile size is chosen so that a face of THOROUGH_MIN_FACE_PX
 * covers MIN_FACE_FRACTION of a tile; a coarser level catches mid-sized faces that straddle tiles.
 */
export function planTiles(w: number, h: number): { x: number; y: number; w: number; h: number }[] {
  const tiles: { x: number; y: number; w: number; h: number }[] = [];
  const fine = Math.round(THOROUGH_MIN_FACE_PX / MIN_FACE_FRACTION); // ≈ 256 px
  for (const size of [fine, fine * 2]) {
    if (size >= Math.max(w, h)) continue;
    const tw = Math.min(w, size);
    const th = Math.min(h, size);
    const stride = size * 0.6; // 40 % overlap so faces on a seam still fit inside one tile
    const cols = Math.max(1, Math.ceil((w - tw) / stride) + 1);
    const rows = Math.max(1, Math.ceil((h - th) / stride) + 1);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const x = Math.min(w - tw, Math.round(i * stride));
        const y = Math.min(h - th, Math.round(j * stride));
        tiles.push({ x, y, w: tw, h: th });
      }
    }
  }
  return tiles;
}
