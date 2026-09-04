/**
 * Face detection facade. Two on-device engines, selected per call:
 *  - `yunet`     — precise, finds small/distant faces (ONNX Runtime Web, WebGPU/WASM)
 *  - `blazeface` — fastest, best for close-up faces (MediaPipe, GPU)
 * Nothing leaves the machine: models and runtimes are served from /public.
 */
import type { Canvas2D } from '../core/canvas';
import { BlazeFaceEngine } from './engines/blazeface';
import { YuNetEngine } from './engines/yunet';
import type { DetectorState, FaceBox } from './common';

export type { FaceBox, DetectorState } from './common';
export { iou, mergeBoxes } from './common';

export type FaceEngineId = 'yunet' | 'blazeface';

export interface DetectionOptions {
  engine: FaceEngineId;
  /** Shared sensitivity knob (0..1, higher = stricter). */
  minConfidence: number;
  /** YuNet: longest side of the analysed image. */
  analysisSize: number;
  /** BlazeFace: single pass or tiled multi-scale search. */
  mode: 'fast' | 'thorough';
}

class FaceDetectionService {
  readonly engines = {
    yunet: new YuNetEngine(),
    blazeface: new BlazeFaceEngine(),
  };

  load(engine: FaceEngineId): Promise<unknown> {
    return this.engines[engine].load();
  }

  getState(engine: FaceEngineId): DetectorState {
    return this.engines[engine].status.get();
  }

  subscribe(engine: FaceEngineId, fn: (s: DetectorState) => void): () => void {
    return this.engines[engine].status.subscribe(fn);
  }

  detect(source: Canvas2D, options: DetectionOptions): Promise<FaceBox[]> {
    if (options.engine === 'blazeface') {
      return this.engines.blazeface.detect(source, { mode: options.mode, minConfidence: options.minConfidence });
    }
    return this.engines.yunet.detect(source, { analysisSize: options.analysisSize, minConfidence: options.minConfidence });
  }
}

export const faceDetection = new FaceDetectionService();
