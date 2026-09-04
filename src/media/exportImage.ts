import { canvasToBlob } from '../core/canvas';
import { renderPipeline } from '../core/pipeline';
import type { ImageAsset, Operation } from '../core/types';

export type ImageFormat = 'png' | 'jpeg' | 'webp';

export async function exportImage(
  asset: ImageAsset,
  ops: Operation[],
  format: ImageFormat,
  quality: number,
): Promise<Blob> {
  const result = await renderPipeline(asset.bitmap, asset.width, asset.height, ops, {
    timestamp: 0,
    frameIndex: 0,
    cacheKey: `${asset.id}:export`,
    mode: 'export',
  });
  return canvasToBlob(result, `image/${format}`, format === 'png' ? undefined : quality);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function replaceExtension(name: string, ext: string, suffix = '-edited'): string {
  const base = name.replace(/\.[^.]+$/, '');
  return `${base}${suffix}.${ext}`;
}
