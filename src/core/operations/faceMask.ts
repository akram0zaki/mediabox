import { registerOperation } from '../registry';
import type { FrameContext, OperationHandler } from '../types';
import { createCanvas, getCtx, type Canvas2D } from '../canvas';
import { faceDetection, type DetectionOptions, type FaceBox } from '../../faces/detector';
import { FaceTracker } from '../../faces/tracker';
import { drawFaceBoxes, drawFaceMasks, type MaskShape, type MaskStyle, type OverlayFace } from '../../faces/masks';
import { faceRecognizer } from '../../faces/recognizer';
import { getPeople, matchPerson } from '../../faces/people';

export type MaskMode = 'all' | 'except-people' | 'only-people';
export type FaceOverride = 'keep' | 'mask';

export interface FaceMaskParams {
  style: MaskStyle;
  shape: MaskShape;
  sizeScale: number;
  intensity: number;
  feather: number;
  color: string;
  emoji: string;
  detection: DetectionOptions;
  tracking: { enabled: boolean; smoothing: number; holdFrames: number };
  showBoxes: boolean;
  /** When false, faces are still detected/tracked (keeps the tracker warm) but not obscured. */
  applyMask: boolean;
  /** Who gets masked: everyone, everyone except the people gallery, or only the people gallery. */
  maskMode: MaskMode;
  /** Cosine-similarity threshold for recognising someone from the gallery. */
  matchThreshold: number;
  /** Per-photo manual decisions, keyed by normalised face position (see faceKey). */
  overrides: Record<string, FaceOverride>;
}

export const FACE_MASK_TYPE = 'faceMask';
/** Longest analysed side while playing; YuNet runs a single 640 px pass in ~30 ms on WebGPU. */
export const REALTIME_ANALYSIS_SIZE = 640;

export const defaultFaceMask: FaceMaskParams = {
  style: 'blur',
  shape: 'ellipse',
  sizeScale: 1.4,
  intensity: 70,
  feather: 35,
  color: '#000000',
  emoji: '🙂',
  detection: { engine: 'yunet', minConfidence: 0.5, analysisSize: 960, mode: 'thorough' },
  tracking: { enabled: true, smoothing: 0.45, holdFrames: 8 },
  showBoxes: false,
  applyMask: true,
  maskMode: 'except-people',
  matchThreshold: 0.45,
  overrides: {},
};

/** One face in a rendered frame, with the decision that was taken for it. */
export interface FrameFace {
  box: FaceBox;
  key: string;
  kept: boolean;
  reason: 'override' | 'person' | 'mode';
  personId?: string;
  personName?: string;
  similarity?: number;
}

export interface FrameFacesEvent {
  faces: FrameFace[];
  width: number;
  height: number;
  mode: 'preview' | 'export';
  timestamp: number;
  /** Copy of the frame before masking (preview + showBoxes only) — used for thumbnails and enrolment. */
  clean: Canvas2D | null;
}

type FrameListener = (event: FrameFacesEvent) => void;
const frameListeners = new Set<FrameListener>();
export function onFrameFaces(fn: FrameListener): () => void {
  frameListeners.add(fn);
  return () => frameListeners.delete(fn);
}

/** Observers get the number of faces found in the most recently processed frame. */
type FaceCountListener = (count: number, ctxMode: 'preview' | 'export') => void;
const countListeners = new Set<FaceCountListener>();
export function onFaceCount(fn: FaceCountListener): () => void {
  countListeners.add(fn);
  return () => countListeners.delete(fn);
}

/** Scale-independent key for a face: its centre in normalised frame coordinates. */
export function faceKey(box: FaceBox, width: number, height: number): string {
  return `${((box.x + box.w / 2) / width).toFixed(3)},${((box.y + box.h / 2) / height).toFixed(3)}`;
}

const OVERRIDE_TOLERANCE = 0.03;
function findOverride(overrides: Record<string, FaceOverride>, key: string): FaceOverride | undefined {
  const [x, y] = key.split(',').map(Number);
  let best: { d: number; v: FaceOverride } | null = null;
  for (const [k, v] of Object.entries(overrides)) {
    const [ox, oy] = k.split(',').map(Number);
    const d = Math.hypot(ox - x, oy - y);
    if (d <= OVERRIDE_TOLERANCE && (!best || d < best.d)) best = { d, v };
  }
  return best?.v;
}

// Small LRU so slider tweaks on a still image / paused frame don't re-run the detector.
const cache = new Map<string, FaceBox[]>();
const CACHE_LIMIT = 12;
function cacheGet(key: string) {
  const v = cache.get(key);
  if (v) {
    cache.delete(key);
    cache.set(key, v);
  }
  return v;
}
function cacheSet(key: string, v: FaceBox[]) {
  cache.set(key, v);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
}

let tracker: FaceTracker | null = null;

/** Per-track recognition verdicts for the current sequence. */
interface Identity {
  personId: string | null;
  personName?: string;
  similarity: number;
  checkedFrame: number;
}
let identitySequence = '';
const identities = new Map<number, Identity>();
/** Re-check cadence (frames): unknown faces are re-tried now and then, recognised ones occasionally. */
const RECHECK_UNKNOWN = 30;
const RECHECK_KNOWN = 60;
/** Max embeddings per frame during playback (never-checked tracks first). Keeps crowd scenes fluid. */
const EMBED_BUDGET_REALTIME = 4;
/** Max *re-checks* per frame on export; brand-new tracks are always classified right away. */
const RECHECK_BUDGET_EXPORT = 4;
/** Faces narrower than this (px, in the analysed frame) are too small to recognise; they stay "unknown". */
const MIN_RECOGNISABLE_FACE = 24;

let recognizerWarned = false;

async function embedSafely(source: Canvas2D, boxes: FaceBox[]): Promise<(Float32Array | null)[]> {
  try {
    return await faceRecognizer.embedMany(source, boxes);
  } catch (err) {
    if (!recognizerWarned) {
      recognizerWarned = true;
      console.warn('[faceMask] face recognition unavailable; people list ignored', err);
    }
    return boxes.map(() => null);
  }
}

export const faceMaskOperation: OperationHandler<FaceMaskParams> = registerOperation<FaceMaskParams>({
  type: FACE_MASK_TYPE,
  label: 'Face mask',
  defaultParams: defaultFaceMask,
  apply: async (input, p, ctx) => {
    // Nothing to draw on export when masking is off (boxes are preview-only).
    if (!p.applyMask && ctx.mode === 'export') return input;

    const detKey = ctx.cacheKey
      ? `${ctx.cacheKey}|${input.width}x${input.height}|${JSON.stringify(p.detection)}`
      : null;
    // During playback, cap the analysis so the preview stays fluid. Paused frames and exports use the full setting.
    const detection = ctx.realtime
      ? { ...p.detection, analysisSize: Math.min(p.detection.analysisSize, REALTIME_ANALYSIS_SIZE), mode: 'fast' as const }
      : p.detection;

    let faces = detKey ? cacheGet(detKey) : undefined;
    if (!faces) {
      try {
        faces = await faceDetection.detect(input, detection);
      } catch (err) {
        // Never silently export unmasked faces; in preview, show the frame and surface the error via status.
        if (ctx.mode === 'export') throw err;
        console.warn('[faceMask] detection failed in preview', err);
        return input;
      }
      if (detKey) cacheSet(detKey, faces);
    }

    let boxes = faces;
    const sequential = p.tracking.enabled && !!ctx.sequenceId;
    if (sequential) {
      if (!tracker || tracker.sequenceId !== ctx.sequenceId) tracker = new FaceTracker(ctx.sequenceId!);
      boxes = tracker.update(faces, p.tracking);
    }

    const decided = await decideFaces(input, boxes, p, ctx, sequential);
    for (const l of countListeners) l(faces.length, ctx.mode);

    let clean: Canvas2D | null = null;
    if (ctx.mode === 'preview' && p.showBoxes) {
      clean = createCanvas(input.width, input.height);
      getCtx(clean).drawImage(input, 0, 0);
    }

    if (p.applyMask) drawFaceMasks(input, decided.filter((f) => !f.kept).map((f) => f.box), p);
    if (p.showBoxes && ctx.mode === 'preview') {
      const overlay: OverlayFace[] = decided.map((f) => ({
        box: f.box,
        kept: f.kept,
        label: f.personName ? `${f.personName}${f.kept ? '' : ' · masked'}` : f.reason === 'override' ? (f.kept ? 'keep (photo)' : 'mask (photo)') : undefined,
      }));
      drawFaceBoxes(input, overlay, p.sizeScale);
    }

    const event: FrameFacesEvent = { faces: decided, width: input.width, height: input.height, mode: ctx.mode, timestamp: ctx.timestamp, clean };
    for (const l of frameListeners) l(event);
    return input;
  },
});

/** Applies overrides, recognition and the mask mode to each face. */
async function decideFaces(input: Canvas2D, boxes: FaceBox[], p: FaceMaskParams, ctx: FrameContext, sequential: boolean): Promise<FrameFace[]> {
  const people = getPeople();
  const needRecognition = people.length > 0 && (p.maskMode !== 'all' || p.showBoxes);
  if (sequential && identitySequence !== ctx.sequenceId) {
    identitySequence = ctx.sequenceId!;
    identities.clear();
  }

  // Video: refresh identities for the tracks that are due, newest/oldest-checked first, within a budget.
  if (needRecognition && sequential) {
    const candidates = boxes
      .filter((b) => b.trackId !== undefined && b.fresh !== false && b.w >= MIN_RECOGNISABLE_FACE)
      .map((b) => ({ b, id: identities.get(b.trackId!) }));
    const fresh = candidates.filter(({ id }) => !id);
    const rechecks = candidates
      .filter(({ id }) => id && ctx.frameIndex - id.checkedFrame >= (id.personId === null ? RECHECK_UNKNOWN : RECHECK_KNOWN))
      .sort((x, y) => x.id!.checkedFrame - y.id!.checkedFrame);
    const selected = ctx.realtime
      ? [...fresh, ...rechecks].slice(0, EMBED_BUDGET_REALTIME)
      : [...fresh, ...rechecks.slice(0, RECHECK_BUDGET_EXPORT)];
    if (selected.length > 0) {
      const embeddings = await embedSafely(input, selected.map(({ b }) => b));
      selected.forEach(({ b }, i) => {
        const embedding = embeddings[i];
        const match = embedding ? matchPerson(embedding, p.matchThreshold) : null;
        identities.set(b.trackId!, {
          personId: match?.person.id ?? null,
          personName: match?.person.name,
          similarity: match?.similarity ?? 0,
          checkedFrame: ctx.frameIndex,
        });
      });
    }
  }

  // Stills / paused frames: embed every recognisable face once, in batches (attached to the cached boxes).
  if (needRecognition && !sequential) {
    const missing = boxes.filter((b) => !b.embedding && b.w >= MIN_RECOGNISABLE_FACE);
    if (missing.length > 0) {
      const embeddings = await embedSafely(input, missing);
      missing.forEach((b, i) => (b.embedding = embeddings[i] ?? undefined));
    }
  }

  const out: FrameFace[] = [];
  for (const box of boxes) {
    const key = faceKey(box, input.width, input.height);
    let personId: string | undefined;
    let personName: string | undefined;
    let similarity: number | undefined;

    if (needRecognition) {
      if (sequential && box.trackId !== undefined) {
        const id = identities.get(box.trackId);
        if (id?.personId) {
          personId = id.personId;
          personName = id.personName;
          similarity = id.similarity;
        }
      } else if (box.embedding) {
        const match = matchPerson(box.embedding, p.matchThreshold);
        if (match) {
          personId = match.person.id;
          personName = match.person.name;
          similarity = match.similarity;
        }
      }
    }

    const override = findOverride(p.overrides, key);
    let kept: boolean;
    let reason: FrameFace['reason'];
    if (override) {
      kept = override === 'keep';
      reason = 'override';
    } else if (p.maskMode === 'except-people') {
      kept = personId !== undefined;
      reason = kept ? 'person' : 'mode';
    } else if (p.maskMode === 'only-people') {
      kept = personId === undefined;
      reason = kept ? 'mode' : 'person';
    } else {
      kept = false;
      reason = 'mode';
    }
    out.push({ box, key, kept, reason, personId, personName, similarity });
  }
  return out;
}
