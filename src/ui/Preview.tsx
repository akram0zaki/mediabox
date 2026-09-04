import { useCallback, useEffect, useRef, useState } from 'react';
import { onFrameFaces, type FrameFacesEvent } from '../core/operations/faceMask';
import { TRANSFORM_TYPE } from '../core/operations/transform';
import { presentTo, renderPipeline } from '../core/pipeline';
import { FacePicker, type PickedFace } from './FacePicker';
import { createFrameSource, type FrameSource } from '../media/player';
import { buildOperations, useEditor } from '../state/store';

/** Longest side of the preview render (smaller on touch devices). Export always runs at full resolution. */
const MAX_PREVIEW_SIDE = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches ? 960 : 1280;
/** Width of the small frame copy used by the filter preset strip. */
const THUMB_WIDTH = 120;

export function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const { error } = usePreviewRenderer(canvasRef);
  const compare = useEditor((s) => s.compare);
  const setCompare = useEditor((s) => s.setCompare);
  const exporting = useEditor((s) => s.exportJob.active);
  const selecting = useEditor((s) => s.faceMask.showBoxes);
  const lastFrame = useRef<FrameFacesEvent | null>(null);
  const [picked, setPicked] = useState<PickedFace | null>(null);

  useEffect(() => onFrameFaces((e) => e.mode === 'preview' && (lastFrame.current = e)), []);

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const frame = lastFrame.current;
    const canvas = canvasRef.current;
    const section = sectionRef.current;
    if (!selecting || !frame?.clean || !canvas || !section) return;
    // Map the click from the CSS box (object-fit: contain) to canvas pixels.
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    const ox = (rect.width - canvas.width * scale) / 2;
    const oy = (rect.height - canvas.height * scale) / 2;
    const px = (e.clientX - rect.left - ox) / scale;
    const py = (e.clientY - rect.top - oy) / scale;
    const hit = frame.faces.find((f) => {
      const pad = Math.max(f.box.w, f.box.h) * 0.25;
      return px >= f.box.x - pad && px <= f.box.x + f.box.w + pad && py >= f.box.y - pad && py <= f.box.y + f.box.h + pad;
    });
    if (!hit) {
      setPicked(null);
      return;
    }
    const srect = section.getBoundingClientRect();
    if (useEditor.getState().playing) useEditor.getState().setPlaying(false);
    setPicked({ face: hit, clean: frame.clean, x: e.clientX - srect.left, y: e.clientY - srect.top });
  };

  return (
    <section className="preview" ref={sectionRef}>
      <div className="preview-stage">
        <canvas ref={canvasRef} className={`preview-canvas${selecting ? ' is-selecting' : ''}`} onClick={onCanvasClick} />
      </div>
      {picked && selecting && <FacePicker picked={picked} onClose={() => setPicked(null)} />}
      <button
        type="button"
        className={`btn compare-btn${compare ? ' is-active' : ''}`}
        title="Hold to see the frame without masks or adjustments (or hold C)"
        disabled={exporting}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          setCompare(true);
        }}
        onPointerUp={() => setCompare(false)}
        onPointerCancel={() => setCompare(false)}
        onLostPointerCapture={() => setCompare(false)}
        onContextMenu={(e) => e.preventDefault()}
      >
        {compare ? '◉ Original' : '◎ Hold to compare'}
      </button>
      {error && <div className="preview-error">{error}</div>}
    </section>
  );
}

function usePreviewRenderer(canvasRef: React.RefObject<HTMLCanvasElement | null>) {
  const asset = useEditor((s) => s.asset);
  const transform = useEditor((s) => s.transform);
  const adjust = useEditor((s) => s.adjust);
  const faceMask = useEditor((s) => s.faceMask);
  const faceMaskEnabled = useEditor((s) => s.faceMaskEnabled);
  const playing = useEditor((s) => s.playing);
  const currentTime = useEditor((s) => s.currentTime);
  const compare = useEditor((s) => s.compare);
  const people = useEditor((s) => s.people);
  const faceOverrides = useEditor((s) => s.faceOverrides);

  const sourceRef = useRef<FrameSource | null>(null);
  const [sourceVersion, setSourceVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const pending = useRef(false);
  const frameIndex = useRef(0);
  const sequenceId = useRef<string>('');

  /** Runs the pipeline on one frame and presents it. Serialised by the callers. */
  const renderFrame = useCallback(
    async (frame: CanvasImageSource, time: number, sequential: boolean) => {
      const s = useEditor.getState();
      const canvas = canvasRef.current;
      if (!s.asset || !canvas) return;
      const { width, height } = s.asset;
      const scale = Math.min(1, MAX_PREVIEW_SIDE / Math.max(width, height));
      const result = await renderPipeline(frame, width * scale, height * scale, buildOperations(s, s.compare), {
        timestamp: time,
        frameIndex: frameIndex.current++,
        sequenceId: sequential ? sequenceId.current : undefined,
        cacheKey: sequential ? undefined : `${s.asset.id}:${time.toFixed(3)}`,
        mode: 'preview',
        realtime: sequential,
      });
      if (canvasRef.current) presentTo(canvasRef.current, result);
      if (!sequential) {
        // Paused / still: refresh the thumbnail the filter strip uses (transform only, no masks or colour).
        const geometry = buildOperations(s).filter((op) => op.type === TRANSFORM_TYPE);
        const tw = THUMB_WIDTH;
        const th = Math.max(1, Math.round((tw * height) / width));
        const small = await renderPipeline(frame, tw, th, geometry, { timestamp: time, frameIndex: 0, mode: 'preview' });
        const thumb = document.createElement('canvas');
        thumb.width = small.width;
        thumb.height = small.height;
        thumb.getContext('2d')!.drawImage(small, 0, 0);
        s.setPreviewThumb(thumb);
      }
    },
    [canvasRef],
  );

  /** Renders the still image or the paused video frame at the store's current time. */
  const renderCurrent = useCallback(async () => {
    const s = useEditor.getState();
    if (!s.asset) return;
    if (busy.current) {
      pending.current = true;
      return;
    }
    busy.current = true;
    try {
      if (s.asset.kind === 'image') {
        await renderFrame(s.asset.bitmap, 0, false);
      } else {
        const source = sourceRef.current;
        if (!source) return;
        const time = Math.min(Math.max(0, s.currentTime), Math.max(0, s.asset.duration - 0.001));
        const frame = await source.seek(time);
        if (frame) await renderFrame(frame, time, false);
      }
      setError(null);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        console.error('[preview]', err);
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      busy.current = false;
      if (pending.current) {
        pending.current = false;
        void renderCurrent();
      }
    }
  }, [renderFrame]);

  // Create / dispose the frame source when the asset changes.
  useEffect(() => {
    if (asset?.kind !== 'video') {
      sourceRef.current = null;
      return;
    }
    let alive = true;
    createFrameSource(asset).then(
      (source) => {
        if (!alive) {
          source.dispose();
          return;
        }
        sourceRef.current = source;
        setSourceVersion((v) => v + 1);
      },
      (err) => setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      alive = false;
      sourceRef.current?.dispose();
      sourceRef.current = null;
    };
  }, [asset]);

  // Re-render when the asset, any parameter, or the paused playhead changes.
  useEffect(() => {
    if (!playing) void renderCurrent();
  }, [asset, sourceVersion, transform, adjust, faceMask, faceMaskEnabled, playing, currentTime, compare, people, faceOverrides, renderCurrent]);

  // Playback.
  useEffect(() => {
    const source = sourceRef.current;
    if (!playing || asset?.kind !== 'video' || !source) return;
    const store = useEditor.getState();
    let from = store.currentTime;
    if (from >= store.trimEnd - 0.02 || from < store.trimStart) from = store.trimStart;
    sequenceId.current = `play-${Date.now()}`;

    source.play(
      from,
      store.trimEnd,
      async (frame, time) => {
        useEditor.getState().setCurrentTime(time);
        try {
          await renderFrame(frame, time, true);
        } catch (err) {
          console.error('[preview]', err);
        }
      },
      () => {
        const s = useEditor.getState();
        s.setCurrentTime(s.trimEnd);
        s.setPlaying(false);
      },
    );
    return () => source.pause();
  }, [asset, playing, renderFrame]);

  return { error };
}
