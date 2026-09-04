/**
 * Frame sources for the video preview.
 *  - WebCodecsFrameSource: decodes through mediabunny/WebCodecs. Frame-accurate, identical to the
 *    export path, and independent of what <video> can play (MKV, odd containers, …).
 *  - ElementFrameSource: <video>-based fallback for browsers without WebCodecs.
 */
import { ALL_FORMATS, AudioBufferSink, BlobSource, CanvasSink, Input } from 'mediabunny';
import type { VideoAsset } from '../core/types';
import { hasWebCodecs } from './loadAsset';

export type FrameCallback = (frame: CanvasImageSource, time: number) => Promise<void> | void;

export interface FrameSource {
  readonly kind: 'webcodecs' | 'element';
  /** Resolves with a drawable frame at (or just before) `time`, or null if unavailable. */
  seek(time: number): Promise<CanvasImageSource | null>;
  /** Starts playback from `from` until `until`, invoking `onFrame` per frame in real time. */
  play(from: number, until: number, onFrame: FrameCallback, onEnd: () => void): void;
  pause(): void;
  dispose(): void;
}

export async function createFrameSource(asset: VideoAsset): Promise<FrameSource> {
  if (hasWebCodecs() && asset.decodable !== false) {
    try {
      return await WebCodecsFrameSource.create(asset);
    } catch (err) {
      console.warn('[player] WebCodecs source failed, using <video> fallback', err);
    }
  }
  return new ElementFrameSource(asset);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Playback audio statistics (dev diagnostics). */
export const audioDebug = { scheduled: 0, resyncs: 0, dropped: 0, gapsOver1ms: 0 };

class WebCodecsFrameSource implements FrameSource {
  readonly kind = 'webcodecs' as const;
  private token = 0;
  private audioCtx: AudioContext | null = null;
  private audioGain: GainNode | null = null;
  private audioNodes: AudioBufferSourceNode[] = [];
  private startWall = 0;
  private playFrom = 0;

  private readonly input: Input;
  private readonly video: CanvasSink;
  private readonly audio: AudioBufferSink | null;
  private readonly sampleRate: number;

  private constructor(input: Input, video: CanvasSink, audio: AudioBufferSink | null, sampleRate: number) {
    this.input = input;
    this.video = video;
    this.audio = audio;
    this.sampleRate = sampleRate;
  }

  static async create(asset: VideoAsset): Promise<WebCodecsFrameSource> {
    const input = new Input({ source: new BlobSource(asset.file), formats: ALL_FORMATS });
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack || !(await videoTrack.canDecode())) {
      input.dispose();
      throw new Error('Video track cannot be decoded with WebCodecs');
    }
    const audioTrack = await input.getPrimaryAudioTrack();
    const audio = audioTrack && (await audioTrack.canDecode()) ? new AudioBufferSink(audioTrack) : null;
    const sampleRate = audio ? await audioTrack!.getSampleRate() : 48000;
    return new WebCodecsFrameSource(input, new CanvasSink(videoTrack, { poolSize: 3 }), audio, sampleRate);
  }

  async seek(time: number): Promise<CanvasImageSource | null> {
    const wrapped = await this.video.getCanvas(Math.max(0, time));
    return wrapped?.canvas ?? null;
  }

  /**
   * Seconds elapsed since play() started. Wall-clock based so playback keeps moving even when the
   * AudioContext is suspended (e.g. autoplay policy); audio is scheduled against the same origin.
   */
  private elapsed(): number {
    return (performance.now() - this.startWall) / 1000;
  }

  play(from: number, until: number, onFrame: FrameCallback, onEnd: () => void): void {
    this.pause();
    const token = ++this.token;
    this.playFrom = from;
    this.startWall = performance.now();

    if (this.audio) {
      if (!this.audioCtx) {
        // Match the track's sample rate: resampling hundreds of short chunks independently would
        // click at every chunk boundary. The context resamples the mixed output once instead.
        this.audioCtx = createAudioContext(this.sampleRate);
        this.audioGain = this.audioCtx.createGain();
        this.audioGain.connect(this.audioCtx.destination);
      }
      void this.audioCtx.resume().catch(() => undefined);
      this.audioGain!.gain.cancelScheduledValues(this.audioCtx.currentTime);
      this.audioGain!.gain.setValueAtTime(1, this.audioCtx.currentTime);
      void this.pumpAudio(token, from, until);
    }
    void this.pumpVideo(token, from, until, onFrame, onEnd);
  }

  /**
   * Decoded audio arrives as many short buffers. They are scheduled back-to-back on the audio
   * clock (gapless), and only re-anchored to the wall clock when drift exceeds RESYNC_THRESHOLD —
   * scheduling each chunk independently produces audible clicks.
   */
  private async pumpAudio(token: number, from: number, until: number): Promise<void> {
    const ctx = this.audioCtx!;
    const gain = this.audioGain!;
    const RESYNC_THRESHOLD = 0.08; // seconds
    const LOOKAHEAD = 1.5; // seconds of audio decoded ahead of the playhead
    let nextStart: number | null = null;
    try {
      for await (const { buffer, timestamp } of this.audio!.buffers(from, until)) {
        if (token !== this.token) break;
        const offset = timestamp - from;
        while (token === this.token && offset - this.elapsed() > LOOKAHEAD) await sleep(100);
        if (token !== this.token) break;
        // Suspended context (no user gesture yet): stay silent rather than piling up stale audio.
        if (ctx.state !== 'running') continue;

        const now = ctx.currentTime;
        // Where the wall-clock mapping says this chunk belongs on the audio clock.
        const ideal = now + (offset - this.elapsed());
        if (nextStart === null || Math.abs(ideal - nextStart) > RESYNC_THRESHOLD) {
          if (nextStart !== null) audioDebug.resyncs++;
          nextStart = Math.max(ideal, now + 0.02);
        }
        if (nextStart + buffer.duration <= now) {
          // Hopelessly late (e.g. the tab was throttled): drop and re-anchor on the next chunk.
          audioDebug.dropped++;
          nextStart = null;
          continue;
        }
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.connect(gain);
        if (nextStart >= now) node.start(nextStart);
        else node.start(now, now - nextStart); // slightly late: skip into the chunk, stay gapless
        if (audioDebug.scheduled > 0 && Math.abs(ideal - nextStart) > 0.001) audioDebug.gapsOver1ms++;
        audioDebug.scheduled++;
        nextStart += buffer.duration;
        node.onended = () => {
          this.audioNodes = this.audioNodes.filter((n) => n !== node);
        };
        this.audioNodes.push(node);
      }
    } catch (err) {
      if (token === this.token) console.warn('[player] audio pump failed', err);
    }
  }

  private async pumpVideo(token: number, from: number, until: number, onFrame: FrameCallback, onEnd: () => void): Promise<void> {
    let lastShown = -Infinity;
    try {
      for await (const wrapped of this.video.canvases(from, until)) {
        if (token !== this.token) return;
        const target = wrapped.timestamp - from;
        const early = target - this.elapsed();
        if (early > 0) await sleep(Math.min(1000, early * 1000));
        if (token !== this.token) return;
        // If processing can't keep up, drop late frames to catch up — but always show something
        // at least every ~250 ms so the preview never freezes.
        const late = this.elapsed() - target;
        const starving = performance.now() - lastShown > 250;
        if (late > Math.max(0.05, wrapped.duration * 1.5) && !starving) continue;
        lastShown = performance.now();
        await onFrame(wrapped.canvas, wrapped.timestamp);
      }
      if (token === this.token) onEnd();
    } catch (err) {
      if (token === this.token) {
        console.error('[player] video pump failed', err);
        onEnd();
      }
    }
  }

  pause(): void {
    this.token++;
    const nodes = this.audioNodes;
    this.audioNodes = [];
    if (this.audioCtx && this.audioGain && nodes.length > 0) {
      // Short fade instead of a hard cut, which would pop.
      const now = this.audioCtx.currentTime;
      this.audioGain.gain.cancelScheduledValues(now);
      this.audioGain.gain.setValueAtTime(this.audioGain.gain.value, now);
      this.audioGain.gain.linearRampToValueAtTime(0, now + 0.03);
      for (const n of nodes) {
        try {
          n.stop(now + 0.035);
        } catch {
          /* already stopped */
        }
      }
    }
  }

  dispose(): void {
    this.pause();
    this.input.dispose();
    void this.audioCtx?.close();
    this.audioCtx = null;
  }

  /** Current playhead during playback (seconds in media time). */
  get playhead(): number {
    return this.playFrom + this.elapsed();
  }
}

function createAudioContext(sampleRate: number): AudioContext {
  try {
    return new AudioContext({ sampleRate });
  } catch {
    return new AudioContext();
  }
}

type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

class ElementFrameSource implements FrameSource {
  readonly kind = 'element' as const;
  private readonly video: VideoWithRvfc;
  private handle = 0;
  private token = 0;

  constructor(asset: VideoAsset) {
    const v = document.createElement('video') as VideoWithRvfc;
    v.src = asset.url;
    v.preload = 'auto';
    v.playsInline = true;
    v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none';
    document.body.appendChild(v);
    this.video = v;
  }

  private ready(): Promise<void> {
    if (this.video.readyState >= 2) return Promise.resolve();
    return new Promise((res, rej) => {
      this.video.addEventListener('loadeddata', () => res(), { once: true });
      this.video.addEventListener('error', () => rej(new Error('Video failed to load')), { once: true });
    });
  }

  async seek(time: number): Promise<CanvasImageSource | null> {
    await this.ready();
    const v = this.video;
    if (Math.abs(v.currentTime - time) > 0.005) {
      await new Promise<void>((res) => {
        v.addEventListener('seeked', () => res(), { once: true });
        v.currentTime = time;
      });
    }
    return v;
  }

  play(from: number, until: number, onFrame: FrameCallback, onEnd: () => void): void {
    this.pause();
    const token = ++this.token;
    const v = this.video;
    let rendering = false;
    const tick = () => {
      if (token !== this.token) return;
      if (v.currentTime >= until || v.ended) {
        v.pause();
        onEnd();
        return;
      }
      if (!rendering) {
        rendering = true;
        Promise.resolve(onFrame(v, v.currentTime)).finally(() => (rendering = false));
      }
      schedule();
    };
    const schedule = () => {
      this.handle = v.requestVideoFrameCallback ? v.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
    };
    void this.seek(from)
      .then(() => v.play())
      .then(schedule, (err) => {
        console.warn('[player] play failed', err);
        onEnd();
      });
  }

  pause(): void {
    this.token++;
    const v = this.video;
    if (v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(this.handle);
    else cancelAnimationFrame(this.handle);
    v.pause();
  }

  dispose(): void {
    this.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.video.remove();
  }
}
