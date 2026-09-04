import type { Canvas2D } from './canvas';

export interface ImageAsset {
  kind: 'image';
  id: string;
  name: string;
  file: File;
  width: number;
  height: number;
  bitmap: ImageBitmap;
}

export interface VideoAsset {
  kind: 'video';
  id: string;
  name: string;
  file: File;
  /** Object URL for HTMLVideoElement playback. */
  url: string;
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
  /** Whether WebCodecs can decode the primary video track (null = unknown). */
  decodable: boolean | null;
}

export type MediaAsset = ImageAsset | VideoAsset;

/** Per-frame context handed to every operation. */
export interface FrameContext {
  /** Dimensions of the canvas the operation receives. */
  width: number;
  height: number;
  /** Presentation time in seconds (0 for still images). */
  timestamp: number;
  frameIndex: number;
  /**
   * Identifies a contiguous stream of frames (playback run or export job).
   * Temporal operations (e.g. face tracking) reset their state when this changes.
   * Undefined for isolated single-frame renders.
   */
  sequenceId?: string;
  /** Stable key for the source frame's content; lets operations cache expensive analysis. */
  cacheKey?: string;
  mode: 'preview' | 'export';
  /** True while frames must keep up with playback; operations may trade precision for speed. */
  realtime?: boolean;
  signal?: AbortSignal;
}

/**
 * An operation transforms one canvas into another. Handlers are registered in the
 * operation registry, so adding a new editing feature = one new handler + one panel.
 */
export interface OperationHandler<P> {
  type: string;
  label: string;
  defaultParams: P;
  /** Returns true when the params leave the frame untouched (lets the pipeline skip work). */
  isIdentity?(params: P): boolean;
  /** Output size for a given input size (defaults to unchanged). */
  outputSize?(width: number, height: number, params: P): { width: number; height: number };
  apply(input: Canvas2D, params: P, ctx: FrameContext): Promise<Canvas2D> | Canvas2D;
}

export interface Operation<P = unknown> {
  type: string;
  enabled: boolean;
  params: P;
}
