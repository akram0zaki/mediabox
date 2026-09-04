/** Dev-only console handle for poking at the editor (window.__mediabox). Tree-shaken from builds. */
import { buildOperations, useEditor } from './state/store';
import { exportImage } from './media/exportImage';
import { exportVideo } from './media/exportVideo';
import { faceDetection } from './faces/detector';
import { faceRecognizer, cosine } from './faces/recognizer';
import { onFrameFaces } from './core/operations/faceMask';
import { audioDebug } from './media/player';

export function installDevtools(): void {
  if (!import.meta.env.DEV) return;
  (window as unknown as { __mediabox: unknown }).__mediabox = { useEditor, buildOperations, exportImage, exportVideo, faceDetection, faceRecognizer, cosine, onFrameFaces, audioDebug };
}
