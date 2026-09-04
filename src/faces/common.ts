/** Five facial landmarks: right eye, left eye, nose tip, right mouth corner, left mouth corner (image order). */
export type Landmarks = [[number, number], [number, number], [number, number], [number, number], [number, number]];

export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  landmarks?: Landmarks;
  /** Set by the tracker: stable id across frames within a playback/export sequence. */
  trackId?: number;
  /** Set by the tracker: false when the box is being held from an earlier frame (no fresh detection). */
  fresh?: boolean;
  /** Recognition embedding (L2-normalised), attached lazily. */
  embedding?: Float32Array;
}

export type DetectorStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface DetectorState {
  status: DetectorStatus;
  /** Which backend the engine ended up on (e.g. GPU / CPU / WebGPU / WASM). */
  backend: string | null;
  error: string | null;
}

type Listener = (state: DetectorState) => void;

/** Shared status plumbing for detection engines. */
export class EngineStatus {
  private state: DetectorState = { status: 'idle', backend: null, error: null };
  private listeners = new Set<Listener>();

  get(): DetectorState {
    return this.state;
  }

  set(patch: Partial<DetectorState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => void this.listeners.delete(fn);
  }
}

export function iou(a: FaceBox, b: FaceBox): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Intersection over the smaller box: catches the same face detected at two scales. */
function overlapRatio(a: FaceBox, b: FaceBox): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const smaller = Math.min(a.w * a.h, b.w * b.h);
  return smaller > 0 ? inter / smaller : 0;
}

/** Non-maximum suppression. */
export function mergeBoxes(boxes: FaceBox[], iouThreshold = 0.35, containThreshold = 0.6): FaceBox[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const kept: FaceBox[] = [];
  for (const box of sorted) {
    if (kept.some((k) => iou(k, box) > iouThreshold || overlapRatio(k, box) > containThreshold)) continue;
    kept.push(box);
  }
  return kept;
}

/** Serialises calls to a non re-entrant engine. */
export class CallQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
