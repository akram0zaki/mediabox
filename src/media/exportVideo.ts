import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_LOW,
  QUALITY_MEDIUM,
  WebMOutputFormat,
  canEncodeVideo,
  type VideoCodec,
} from 'mediabunny';
import { createCanvas, getCtx } from '../core/canvas';
import { pipelineOutputSize, renderPipeline } from '../core/pipeline';
import type { Operation, VideoAsset } from '../core/types';
import { hasWebCodecs } from './loadAsset';

export type VideoContainer = 'mp4' | 'webm';
export type VideoQuality = 'low' | 'medium' | 'high';

export interface VideoExportOptions {
  container: VideoContainer;
  quality: VideoQuality;
  keepAudio: boolean;
  trimStart: number;
  trimEnd: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number, message: string) => void;
}

export interface VideoExportResult {
  blob: Blob;
  extension: string;
  method: 'webcodecs' | 'realtime';
}

const CODEC_PREFERENCE: Record<VideoContainer, VideoCodec[]> = {
  mp4: ['avc', 'hevc', 'av1'],
  webm: ['vp9', 'vp8', 'av1'],
};

export async function exportVideo(asset: VideoAsset, ops: Operation[], options: VideoExportOptions): Promise<VideoExportResult> {
  if (hasWebCodecs() && asset.decodable !== false) {
    try {
      return await exportWithWebCodecs(asset, ops, options);
    } catch (err) {
      if (options.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err;
      console.warn('[export] WebCodecs export failed, falling back to realtime capture', err);
    }
  }
  return exportRealtime(asset, ops, options);
}

async function pickCodec(container: VideoContainer, width: number, height: number): Promise<VideoCodec | null> {
  for (const codec of CODEC_PREFERENCE[container]) {
    if (await canEncodeVideo(codec, { width, height })) return codec;
  }
  return null;
}

function qualityOf(q: VideoQuality) {
  return q === 'low' ? QUALITY_LOW : q === 'high' ? QUALITY_HIGH : QUALITY_MEDIUM;
}

/** Frame-accurate, faster-than-realtime path: decode → pipeline → encode via WebCodecs. */
async function exportWithWebCodecs(asset: VideoAsset, ops: Operation[], options: VideoExportOptions): Promise<VideoExportResult> {
  const { onProgress, signal } = options;
  onProgress?.(0, 'Preparing encoder…');

  const outSize = pipelineOutputSize(asset.width, asset.height, ops);
  const codec = await pickCodec(options.container, outSize.width, outSize.height);
  if (!codec) throw new Error(`No ${options.container.toUpperCase()} video encoder available in this browser.`);

  const input = new Input({ source: new BlobSource(asset.file), formats: ALL_FORMATS });
  const format = options.container === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat();
  const output = new Output({ format, target: new BufferTarget() });

  const sequenceId = `export-${Date.now()}`;
  let frameIndex = 0;
  let frameCanvas = createCanvas(asset.width, asset.height);

  const conversion = await Conversion.init({
    input,
    output,
    trim: { start: options.trimStart, end: options.trimEnd },
    video: {
      codec,
      quality: qualityOf(options.quality),
      forceTranscode: true,
      allowRotationMetadata: false,
      processedWidth: outSize.width,
      processedHeight: outSize.height,
      process: async (sample) => {
        if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
        const w = sample.displayWidth;
        const h = sample.displayHeight;
        if (frameCanvas.width !== w || frameCanvas.height !== h) frameCanvas = createCanvas(w, h);
        sample.drawWithFit(getCtx(frameCanvas), { fit: 'fill' });
        const result = await renderPipeline(frameCanvas, w, h, ops, {
          timestamp: sample.timestamp,
          frameIndex: frameIndex++,
          sequenceId,
          mode: 'export',
          signal,
        });
        return result;
      },
    },
    audio: options.keepAudio ? {} : { discard: true },
  });

  if (!conversion.isValid) {
    const reasons = conversion.discardedTracks.map((t) => `${t.track.type}: ${t.reason}`).join('; ');
    throw new Error(`Cannot convert this file (${reasons || 'no usable tracks'}).`);
  }

  conversion.onProgress = (p) => onProgress?.(p, `Encoding ${Math.round(p * 100)}%`);
  const onAbort = () => void conversion.cancel();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    await conversion.execute();
  } finally {
    signal?.removeEventListener('abort', onAbort);
    input.dispose();
  }
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');

  const buffer = output.target.buffer;
  if (!buffer) throw new Error('Encoder produced no output.');
  return {
    blob: new Blob([buffer], { type: format.mimeType }),
    extension: options.container,
    method: 'webcodecs',
  };
}

/** Fallback for browsers without WebCodecs: play through a hidden video and record the processed canvas. */
async function exportRealtime(asset: VideoAsset, ops: Operation[], options: VideoExportOptions): Promise<VideoExportResult> {
  const { onProgress, signal } = options;
  if (typeof MediaRecorder === 'undefined') throw new Error('This browser supports neither WebCodecs nor MediaRecorder.');
  onProgress?.(0, 'Recording in real time (browser lacks WebCodecs)…');

  const video = document.createElement('video');
  video.src = asset.url;
  video.muted = false;
  video.volume = 1;
  video.playsInline = true;
  video.crossOrigin = 'anonymous';
  await new Promise<void>((res, rej) => {
    video.onloadedmetadata = () => res();
    video.onerror = () => rej(new Error('Could not load video for recording.'));
  });

  const outSize = pipelineOutputSize(asset.width, asset.height, ops);
  const canvas = document.createElement('canvas');
  canvas.width = outSize.width;
  canvas.height = outSize.height;
  const cctx = canvas.getContext('2d')!;

  const stream = canvas.captureStream(30);
  let audioCtx: AudioContext | null = null;
  if (options.keepAudio && asset.hasAudio) {
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaElementSource(video);
    const dest = audioCtx.createMediaStreamDestination();
    src.connect(dest);
    dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  } else {
    video.muted = true;
  }

  const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
    .find((m) => MediaRecorder.isTypeSupported(m));
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: bitrateFor(options.quality, outSize) } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const sequenceId = `realtime-${Date.now()}`;
  let frameIndex = 0;
  let rendering = false;
  const span = Math.max(0.01, options.trimEnd - options.trimStart);

  const renderFrame = async () => {
    if (rendering) return;
    rendering = true;
    try {
      const result = await renderPipeline(video, asset.width, asset.height, ops, {
        timestamp: video.currentTime,
        frameIndex: frameIndex++,
        sequenceId,
        mode: 'export',
        signal,
      });
      cctx.drawImage(result, 0, 0);
      onProgress?.(Math.min(1, (video.currentTime - options.trimStart) / span), 'Recording…');
    } finally {
      rendering = false;
    }
  };

  video.currentTime = options.trimStart;
  await new Promise<void>((res) => (video.onseeked = () => res()));
  await renderFrame();

  const finished = new Promise<void>((resolve, reject) => {
    let raf = 0;
    const stop = () => {
      cancelAnimationFrame(raf);
      video.pause();
      if (recorder.state !== 'inactive') recorder.stop();
    };
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error('MediaRecorder failed.'));
    signal?.addEventListener('abort', () => {
      stop();
      reject(new DOMException('Export cancelled', 'AbortError'));
    });
    const tick = () => {
      if (video.currentTime >= options.trimEnd || video.ended) {
        stop();
        return;
      }
      void renderFrame();
      raf = requestAnimationFrame(tick);
    };
    recorder.start(250);
    video.play().then(() => (raf = requestAnimationFrame(tick)), reject);
  });

  try {
    await finished;
  } finally {
    video.removeAttribute('src');
    video.load();
    stream.getTracks().forEach((t) => t.stop());
    await audioCtx?.close();
  }

  const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
  return { blob, extension: blob.type.includes('mp4') ? 'mp4' : 'webm', method: 'realtime' };
}

function bitrateFor(q: VideoQuality, size: { width: number; height: number }): number {
  const pixels = size.width * size.height;
  const perPixel = q === 'low' ? 0.08 : q === 'high' ? 0.25 : 0.15;
  return Math.round(pixels * perPixel * 30);
}
