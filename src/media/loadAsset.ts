import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import type { MediaAsset } from '../core/types';

const IMAGE_TYPES = /^image\//;
const VIDEO_TYPES = /^video\/|^application\/(x-matroska|mp4)/;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|ogv|avi)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif)$/i;

export function classifyFile(file: File): 'image' | 'video' | null {
  if (IMAGE_TYPES.test(file.type) || IMAGE_EXT.test(file.name)) return 'image';
  if (VIDEO_TYPES.test(file.type) || VIDEO_EXT.test(file.name)) return 'video';
  return null;
}

export function hasWebCodecs(): boolean {
  return typeof VideoDecoder !== 'undefined' && typeof VideoEncoder !== 'undefined';
}

export async function loadAsset(file: File): Promise<MediaAsset> {
  const kind = classifyFile(file);
  if (!kind) throw new Error(`Unsupported file type: ${file.type || file.name}`);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  if (kind === 'image') {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { kind, id, name: file.name, file, width: bitmap.width, height: bitmap.height, bitmap };
  }

  const url = URL.createObjectURL(file);
  let meta: { width: number; height: number; duration: number } | null = null;
  let hasAudio = true;
  let decodable: boolean | null = null;

  if (hasWebCodecs()) {
    try {
      const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
      const [video, audio] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
      if (!video) throw new Error('No video track found in this file.');
      hasAudio = audio !== null;
      decodable = await video.canDecode();
      const [width, height, duration] = await Promise.all([
        video.getDisplayWidth(),
        video.getDisplayHeight(),
        input.computeDuration(),
      ]);
      meta = { width, height, duration };
      input.dispose();
    } catch (err) {
      console.warn('[media] container probe failed, will use <video> fallback', err);
      decodable = false;
    }
  } else {
    decodable = false;
  }

  if (!meta) {
    meta = await probeWithVideoElement(url).catch((err) => {
      URL.revokeObjectURL(url);
      throw err;
    });
  }

  return { kind, id, name: file.name, file, url, ...meta, hasAudio, decodable };
}

function probeWithVideoElement(url: string): Promise<{ width: number; height: number; duration: number }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    const timer = setTimeout(() => reject(new Error('Timed out reading video metadata.')), 15_000);
    v.onloadedmetadata = () => {
      clearTimeout(timer);
      if (!v.videoWidth || !v.videoHeight) {
        reject(new Error('This browser cannot play the selected video.'));
        return;
      }
      resolve({ width: v.videoWidth, height: v.videoHeight, duration: v.duration });
      v.removeAttribute('src');
      v.load();
    };
    v.onerror = () => {
      clearTimeout(timer);
      reject(new Error('This browser cannot play the selected video.'));
    };
    v.src = url;
  });
}

export function releaseAsset(asset: MediaAsset | null): void {
  if (!asset) return;
  if (asset.kind === 'image') asset.bitmap.close();
  else URL.revokeObjectURL(asset.url);
}
