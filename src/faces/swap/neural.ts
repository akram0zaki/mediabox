/**
 * Renderer side of the neural face swap (desktop build). Alignment and paste-back happen here on
 * canvases; the models run in the Electron main process (see desktop/src/neural).
 */
import { desktopApi, type DownloadProgress, type NeuralStatus } from '../../desktop/api';
import { createCanvas, getCtx, supportsCanvasFilter, type Canvas2D } from '../../core/canvas';
import type { FaceBox, Landmarks } from '../common';
import { similarityTransform } from '../recognizer';
import { swapSourceBitmap, type SwapSource } from './sources';

const EMBED_SIZE = 112;
const SWAP_SIZE = 128;
const TEMPLATE: Landmarks = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

export interface NeuralUiState {
  available: boolean;
  status: NeuralStatus | null;
  phase: 'idle' | 'downloading' | 'loading' | 'ready' | 'error';
  progress: DownloadProgress | null;
  error: string | null;
}

type Listener = (s: NeuralUiState) => void;
let state: NeuralUiState = { available: desktopApi() !== null, status: null, phase: 'idle', progress: null, error: null };
const listeners = new Set<Listener>();
function setState(patch: Partial<NeuralUiState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l(state);
}
export function neuralState(): NeuralUiState {
  return state;
}
export function subscribeNeural(fn: Listener): () => void {
  listeners.add(fn);
  fn(state);
  return () => void listeners.delete(fn);
}

export function isNeuralAvailable(): boolean {
  return state.available;
}

export async function refreshNeuralStatus(): Promise<NeuralStatus | null> {
  const api = desktopApi();
  if (!api) return null;
  const status = await api.neural.status();
  setState({ status, phase: status.loaded ? 'ready' : state.phase === 'downloading' ? 'downloading' : 'idle' });
  return status;
}

export async function downloadNeuralModels(): Promise<void> {
  const api = desktopApi();
  if (!api) return;
  setState({ phase: 'downloading', error: null, progress: null });
  const off = api.neural.onDownloadProgress((progress) => setState({ progress }));
  try {
    const status = await api.neural.downloadModels();
    setState({ status, phase: 'idle', progress: null });
    await loadNeural();
  } catch (err) {
    setState({ phase: 'error', error: err instanceof Error ? err.message : String(err), progress: null });
  } finally {
    off();
  }
}

export function cancelNeuralDownload(): void {
  void desktopApi()?.neural.cancelDownload();
}

let loadPromise: Promise<boolean> | null = null;
/** Loads the models in the main process (once). Resolves true when ready. */
export function loadNeural(): Promise<boolean> {
  const api = desktopApi();
  if (!api) return Promise.resolve(false);
  if (!loadPromise) {
    setState({ phase: 'loading', error: null });
    loadPromise = api.neural
      .load()
      .then((status) => {
        setState({ status, phase: 'ready' });
        return true;
      })
      .catch((err) => {
        loadPromise = null;
        setState({ phase: 'error', error: err instanceof Error ? err.message : String(err) });
        return false;
      });
  }
  return loadPromise;
}

export function isNeuralReady(): boolean {
  return state.phase === 'ready';
}

/** Five ArcFace landmarks derived from a 478-point mesh (eye centres, nose tip, mouth corners). */
export function landmarksFromMesh(mesh: ArrayLike<number>): Landmarks {
  const pt = (i: number): [number, number] => [mesh[i * 2], mesh[i * 2 + 1]];
  const mid = (a: number, b: number): [number, number] => [(mesh[a * 2] + mesh[b * 2]) / 2, (mesh[a * 2 + 1] + mesh[b * 2 + 1]) / 2];
  return [mid(33, 133), mid(362, 263), pt(1), pt(61), pt(291)];
}

function alignedCrop(source: CanvasImageSource, landmarks: Landmarks, size: number) {
  const k = size / EMBED_SIZE;
  const dst = TEMPLATE.map(([x, y]) => [x * k, y * k]) as Landmarks;
  const t = similarityTransform(landmarks, dst);
  const c = createCanvas(size, size);
  const ctx = getCtx(c, { willReadFrequently: true });
  ctx.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
  ctx.drawImage(source, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { canvas: c, data: ctx.getImageData(0, 0, size, size).data, t };
}

function toNchw(rgba: Uint8ClampedArray, size: number, scale: number, offset: number): Float32Array {
  const plane = size * size;
  const out = new Float32Array(plane * 3);
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    out[i] = rgba[p] * scale + offset;
    out[plane + i] = rgba[p + 1] * scale + offset;
    out[plane * 2 + i] = rgba[p + 2] * scale + offset;
  }
  return out;
}

const embeddings = new Map<string, Promise<Float32Array>>();
/** ArcFace identity embedding of a substitute face (cached per source). */
export function sourceEmbedding(source: SwapSource): Promise<Float32Array> {
  let p = embeddings.get(source.id);
  if (!p) {
    p = (async () => {
      const api = desktopApi();
      if (!api) throw new Error('Neural swap needs the desktop app');
      const bitmap = await swapSourceBitmap(source);
      const { data } = alignedCrop(bitmap, landmarksFromMesh(source.mesh), EMBED_SIZE);
      return api.neural.embed(toNchw(data, EMBED_SIZE, 1 / 127.5, -1));
    })();
    embeddings.set(source.id, p);
    p.catch(() => embeddings.delete(source.id));
  }
  return p;
}

/**
 * Replaces the identity of one face in `canvas` (needs 5-point landmarks). Returns false if the
 * face can't be processed, so the caller can fall back to another mask.
 */
export async function neuralSwapFace(canvas: Canvas2D, box: FaceBox, embedding: Float32Array, feather: number): Promise<boolean> {
  const api = desktopApi();
  if (!api || !box.landmarks) return false;
  const { data, t } = alignedCrop(canvas, box.landmarks, SWAP_SIZE);
  const out = await api.neural.swap(toNchw(data, SWAP_SIZE, 1 / 255, 0), embedding);

  const result = createCanvas(SWAP_SIZE, SWAP_SIZE);
  const rctx = getCtx(result);
  const img = rctx.createImageData(SWAP_SIZE, SWAP_SIZE);
  const plane = SWAP_SIZE * SWAP_SIZE;
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    img.data[p] = out[i] * 255;
    img.data[p + 1] = out[plane + i] * 255;
    img.data[p + 2] = out[plane * 2 + i] * 255;
    img.data[p + 3] = 255;
  }
  rctx.putImageData(img, 0, 0);

  // Soft box mask in crop space (the swapper only reconstructs the inner face area).
  const pad = 10;
  const featherPx = 4 + (Math.max(0, Math.min(100, feather)) / 100) * 14;
  const mask = createCanvas(SWAP_SIZE, SWAP_SIZE);
  const mctx = getCtx(mask);
  if (supportsCanvasFilter()) mctx.filter = `blur(${featherPx / 2}px)`;
  mctx.fillStyle = '#fff';
  mctx.beginPath();
  mctx.roundRect(pad + featherPx / 2, pad + featherPx / 2, SWAP_SIZE - 2 * pad - featherPx, SWAP_SIZE - 2 * pad - featherPx, 10);
  mctx.fill();
  mctx.filter = 'none';
  rctx.globalCompositeOperation = 'destination-in';
  rctx.drawImage(mask, 0, 0);
  rctx.globalCompositeOperation = 'source-over';

  // Paste back with the inverse alignment transform.
  const det = t.a * t.d - t.b * t.c;
  if (!det) return false;
  const inv = { a: t.d / det, b: -t.b / det, c: -t.c / det, d: t.a / det, e: (t.c * t.f - t.d * t.e) / det, f: (t.b * t.e - t.a * t.f) / det };
  const ctx = getCtx(canvas);
  ctx.save();
  ctx.setTransform(inv.a, inv.b, inv.c, inv.d, inv.e, inv.f);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(result, 0, 0);
  ctx.restore();
  return true;
}
