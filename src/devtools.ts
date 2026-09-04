/** Dev-only console handle for poking at the editor (window.__mediabox). Tree-shaken from builds. */
import { buildOperations, useEditor } from './state/store';
import { exportImage } from './media/exportImage';
import { exportVideo } from './media/exportVideo';
import { faceDetection } from './faces/detector';
import { faceRecognizer, cosine } from './faces/recognizer';
import { onFrameFaces } from './core/operations/faceMask';
import { audioDebug } from './media/player';
import { buildSwapSource } from './faces/swap/sources';
import { loadNeural, neuralState } from './faces/swap/neural';

export function installDevtools(): void {
  // Also available in production when the page is opened with ?devtools (used by the desktop smoke test).
  if (!import.meta.env.DEV && !new URLSearchParams(location.search).has('devtools')) return;
  (window as unknown as { __mediabox: unknown }).__mediabox = { useEditor, buildOperations, exportImage, exportVideo, faceDetection, faceRecognizer, cosine, onFrameFaces, audioDebug, buildSwapSource, loadNeural, neuralState };
}
