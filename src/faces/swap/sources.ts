/**
 * Substitute faces for the mesh swap: a small library of source faces (image crop + mesh),
 * persisted by the store and read by the render pipeline through this registry.
 */
import { createCanvas, getCtx, type Canvas2D } from '../../core/canvas';
import type { FaceBox } from '../common';
import { faceLandmarker, LANDMARK_COUNT, type Mesh } from '../landmarker';

export interface SwapSource {
  id: string;
  name: string;
  /** Small JPEG data URL for the UI. */
  thumb: string;
  /** JPEG data URL of the face crop used as texture. */
  image: string;
  width: number;
  height: number;
  /** Mesh in crop pixel coordinates (flat x,y pairs). */
  mesh: number[];
}

const MAX_CROP = 512;

let sources: SwapSource[] = [];
const bitmaps = new Map<string, Promise<ImageBitmap>>();

export function setSwapSources(next: SwapSource[]): void {
  sources = next;
  for (const id of [...bitmaps.keys()]) if (!next.some((s) => s.id === id)) bitmaps.delete(id);
}

export function getSwapSource(id: string | null | undefined): SwapSource | undefined {
  return id ? sources.find((s) => s.id === id) : undefined;
}

/** Decoded texture for a source (cached). */
export function swapSourceBitmap(source: SwapSource): Promise<ImageBitmap> {
  let p = bitmaps.get(source.id);
  if (!p) {
    p = fetch(source.image)
      .then((r) => r.blob())
      .then((b) => createImageBitmap(b));
    bitmaps.set(source.id, p);
  }
  return p;
}

export function newSwapSourceId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Builds a source from a face in `frame`: crops around it, meshes it, and encodes the crop. */
export async function buildSwapSource(frame: Canvas2D, face: FaceBox, name: string): Promise<SwapSource> {
  const mesh = await faceLandmarker.meshFor(frame, face);
  if (!mesh) throw new Error('Could not find facial features in that face. Try a clearer, more frontal photo.');
  const size = Math.max(face.w, face.h) * 2.2;
  const cx = face.x + face.w / 2;
  const cy = face.y + face.h / 2;
  const sx = cx - size / 2;
  const sy = cy - size / 2;
  const out = Math.min(MAX_CROP, Math.round(size));
  const scale = out / size;

  const crop = document.createElement('canvas');
  crop.width = out;
  crop.height = out;
  crop.getContext('2d')!.drawImage(frame, sx, sy, size, size, 0, 0, out, out);

  const local: number[] = new Array(LANDMARK_COUNT * 2);
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    local[i * 2] = (mesh[i * 2] - sx) * scale;
    local[i * 2 + 1] = (mesh[i * 2 + 1] - sy) * scale;
  }

  const thumbCanvas = createCanvas(96, 96);
  getCtx(thumbCanvas).drawImage(crop, out * 0.2, out * 0.2, out * 0.6, out * 0.6, 0, 0, 96, 96);
  const thumb = thumbCanvas instanceof HTMLCanvasElement ? thumbCanvas.toDataURL('image/jpeg', 0.82) : await blobToDataUrl(await thumbCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 }));

  return { id: newSwapSourceId(), name, thumb, image: crop.toDataURL('image/jpeg', 0.9), width: out, height: out, mesh: local };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function sourceMesh(source: SwapSource): Mesh {
  return Float32Array.from(source.mesh);
}
