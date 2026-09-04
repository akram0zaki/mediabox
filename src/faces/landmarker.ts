/**
 * Dense face mesh (478 points) from MediaPipe Face Landmarker, run on a crop around each
 * detected face so it works for small faces in crowds (the landmarker's own detector only
 * finds large faces). Used by the mesh-based face swap.
 */
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { createCanvas, getCtx, type Canvas2D } from '../core/canvas';
import { CallQueue, EngineStatus, type FaceBox } from './common';

const BASE = import.meta.env.BASE_URL;
const WASM_PATH = `${BASE}mediapipe/wasm`;
const MODEL_PATH = `${BASE}models/face_landmarker.task`;
/** The crop fed to the landmarker: the detector box enlarged by this factor, made square. */
const CROP_SCALE = 1.9;
const CROP_SIZE = 256;
export const LANDMARK_COUNT = 478;

/** Flat [x0, y0, x1, y1, …] in the coordinate space of the analysed frame. */
export type Mesh = Float32Array;

export class FaceLandmarkerEngine {
  readonly status = new EngineStatus();
  private loadPromise: Promise<FaceLandmarker> | null = null;
  private scratch: Canvas2D | null = null;
  private queue = new CallQueue();

  load(): Promise<FaceLandmarker> {
    if (!this.loadPromise) {
      this.loadPromise = this.init().catch((err) => {
        this.loadPromise = null;
        this.status.set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
        throw err;
      });
    }
    return this.loadPromise;
  }

  private async init(): Promise<FaceLandmarker> {
    this.status.set({ status: 'loading', error: null });
    const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
    const build = (delegate: 'GPU' | 'CPU') =>
      FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_PATH, delegate },
        runningMode: 'IMAGE',
        numFaces: 1,
        minFaceDetectionConfidence: 0.3,
        minFacePresenceConfidence: 0.3,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
      });
    let lm: FaceLandmarker;
    let backend = 'GPU';
    try {
      lm = await build('GPU');
    } catch (err) {
      console.warn('[faces/landmarker] GPU delegate unavailable, falling back to CPU', err);
      backend = 'CPU';
      lm = await build('CPU');
    }
    this.status.set({ status: 'ready', backend });
    return lm;
  }

  /** Mesh for one detected face, or null if the landmarker finds no face in the crop. */
  meshFor(source: Canvas2D, face: FaceBox): Promise<Mesh | null> {
    return this.queue.run(async () => {
      const lm = await this.load();
      const size = Math.max(face.w, face.h) * CROP_SCALE;
      const cx = face.x + face.w / 2;
      const cy = face.y + face.h / 2;
      const sx = cx - size / 2;
      const sy = cy - size / 2;
      this.scratch ??= createCanvas(CROP_SIZE, CROP_SIZE);
      const ctx = getCtx(this.scratch);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, CROP_SIZE, CROP_SIZE);
      ctx.drawImage(source, sx, sy, size, size, 0, 0, CROP_SIZE, CROP_SIZE);
      const result = lm.detect(this.scratch as unknown as HTMLCanvasElement);
      const pts = result.faceLandmarks[0];
      if (!pts || pts.length < LANDMARK_COUNT) return null;
      const mesh = new Float32Array(LANDMARK_COUNT * 2);
      for (let i = 0; i < LANDMARK_COUNT; i++) {
        mesh[i * 2] = sx + pts[i].x * size;
        mesh[i * 2 + 1] = sy + pts[i].y * size;
      }
      return mesh;
    });
  }
}

export const faceLandmarker = new FaceLandmarkerEngine();

let triangleCache: Uint16Array | null = null;
/** Triangle index list derived from MediaPipe's tesselation edges (each edge + a shared neighbour). */
export function meshTriangles(): Uint16Array {
  if (triangleCache) return triangleCache;
  const adj = new Map<number, Set<number>>();
  const add = (a: number, b: number) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const { start, end } of FaceLandmarker.FACE_LANDMARKS_TESSELATION) {
    add(start, end);
    add(end, start);
  }
  const tris: number[] = [];
  for (const [a, na] of adj) {
    for (const b of na) {
      if (b <= a) continue;
      for (const c of na) {
        if (c <= b) continue;
        if (adj.get(b)!.has(c)) tris.push(a, b, c);
      }
    }
  }
  triangleCache = new Uint16Array(tris);
  return triangleCache;
}

let ovalCache: number[] | null = null;
/** Ordered loop of landmark indices around the face silhouette. */
export function faceOval(): number[] {
  if (ovalCache) return ovalCache;
  const next = new Map<number, number>();
  for (const { start, end } of FaceLandmarker.FACE_LANDMARKS_FACE_OVAL) next.set(start, end);
  const first = FaceLandmarker.FACE_LANDMARKS_FACE_OVAL[0].start;
  const loop = [first];
  let cur = next.get(first);
  while (cur !== undefined && cur !== first && loop.length < 100) {
    loop.push(cur);
    cur = next.get(cur);
  }
  ovalCache = loop;
  return loop;
}

/** Axis-aligned bounds of a set of mesh indices (or the whole mesh). */
export function meshBounds(mesh: Mesh, indices?: number[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const list = indices ?? Array.from({ length: LANDMARK_COUNT }, (_, i) => i);
  for (const i of list) {
    const x = mesh[i * 2];
    const y = mesh[i * 2 + 1];
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
