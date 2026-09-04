import { iou, type FaceBox } from './common';

export interface TrackingOptions {
  /** 0 = follow detections exactly, 0.9 = very smooth/laggy. */
  smoothing: number;
  /** How many consecutive frames a lost face keeps its mask before it is dropped. */
  holdFrames: number;
}

interface Track {
  id: number;
  box: FaceBox;
  missed: number;
  hits: number;
}

/**
 * Lightweight multi-object tracker: matches detections to existing tracks by overlap,
 * smooths box motion, and keeps masks in place for a few frames when the detector blinks.
 * Purpose: no flicker, no single-frame gaps that would expose a face.
 */
export class FaceTracker {
  private tracks: Track[] = [];
  private nextId = 1;
  readonly sequenceId: string;

  constructor(sequenceId: string) {
    this.sequenceId = sequenceId;
  }

  reset(): void {
    this.tracks = [];
  }

  update(detections: FaceBox[], options: TrackingOptions): FaceBox[] {
    const alpha = 1 - Math.min(0.95, Math.max(0, options.smoothing));
    const unmatched = new Set(detections.map((_, i) => i));
    const matchedTracks = new Set<number>();

    // Greedy matching by descending IoU (with a centre-distance fallback for fast motion).
    const pairs: { t: number; d: number; s: number }[] = [];
    this.tracks.forEach((t, ti) => {
      detections.forEach((d, di) => {
        const s = matchScore(t.box, d);
        if (s > 0) pairs.push({ t: ti, d: di, s });
      });
    });
    pairs.sort((a, b) => b.s - a.s);
    for (const p of pairs) {
      if (matchedTracks.has(p.t) || !unmatched.has(p.d)) continue;
      const track = this.tracks[p.t];
      const det = detections[p.d];
      track.box = {
        x: track.box.x + (det.x - track.box.x) * alpha,
        y: track.box.y + (det.y - track.box.y) * alpha,
        w: track.box.w + (det.w - track.box.w) * alpha,
        h: track.box.h + (det.h - track.box.h) * alpha,
        score: det.score,
        landmarks: det.landmarks,
      };
      track.missed = 0;
      track.hits++;
      matchedTracks.add(p.t);
      unmatched.delete(p.d);
    }

    // Unmatched tracks: keep for a while, then drop.
    this.tracks = this.tracks.filter((t, i) => {
      if (matchedTracks.has(i)) return true;
      t.missed++;
      return t.missed <= options.holdFrames;
    });

    // New detections become tracks immediately (never leave a face unmasked on its first frame).
    for (const di of unmatched) {
      this.tracks.push({ id: this.nextId++, box: { ...detections[di] }, missed: 0, hits: 1 });
    }

    return this.tracks.map((t) => ({ ...t.box, trackId: t.id, fresh: t.missed === 0 }));
  }
}

function matchScore(a: FaceBox, b: FaceBox): number {
  const overlap = iou(a, b);
  if (overlap > 0.2) return overlap + 1;
  // Centre distance relative to face size, for fast-moving faces.
  const dx = a.x + a.w / 2 - (b.x + b.w / 2);
  const dy = a.y + a.h / 2 - (b.y + b.h / 2);
  const dist = Math.hypot(dx, dy) / Math.max(a.w, a.h, 1);
  const sizeRatio = Math.min(a.w / b.w, b.w / a.w);
  return dist < 0.8 && sizeRatio > 0.5 ? 1 - dist : 0;
}
