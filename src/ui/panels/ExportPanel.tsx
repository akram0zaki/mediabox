import { useRef, useState } from 'react';
import { downloadBlob, exportImage, replaceExtension, type ImageFormat } from '../../media/exportImage';
import { hasWebCodecs } from '../../media/loadAsset';
import { exportVideo, type VideoContainer, type VideoQuality } from '../../media/exportVideo';
import { buildOperations, useEditor } from '../../state/store';
import { Segmented } from '../controls/Segmented';
import { Slider } from '../controls/Slider';
import { Toggle } from '../controls/Toggle';
import { formatTime } from '../format';

export function ExportPanel() {
  const asset = useEditor((s) => s.asset);
  const job = useEditor((s) => s.exportJob);
  const setJob = useEditor((s) => s.setExportJob);
  const trimStart = useEditor((s) => s.trimStart);
  const trimEnd = useEditor((s) => s.trimEnd);

  const [imageFormat, setImageFormat] = useState<ImageFormat>('png');
  const [imageQuality, setImageQuality] = useState(92);
  const [container, setContainer] = useState<VideoContainer>('mp4');
  const [quality, setQuality] = useState<VideoQuality>('medium');
  const [keepAudio, setKeepAudio] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  if (!asset) return null;

  const start = async () => {
    const state = useEditor.getState();
    state.setPlaying(false);
    const ops = buildOperations(state);
    const controller = new AbortController();
    abortRef.current = controller;
    setJob({ active: true, progress: 0, message: 'Starting…', error: null, done: null });
    try {
      if (asset.kind === 'image') {
        setJob({ message: 'Rendering…' });
        const blob = await exportImage(asset, ops, imageFormat, imageQuality / 100);
        const name = replaceExtension(asset.name, imageFormat === 'jpeg' ? 'jpg' : imageFormat);
        downloadBlob(blob, name);
        setJob({ active: false, progress: 1, message: '', done: { name, size: blob.size, method: 'canvas' } });
      } else {
        const result = await exportVideo(asset, ops, {
          container,
          quality,
          keepAudio: keepAudio && asset.hasAudio,
          trimStart,
          trimEnd,
          signal: controller.signal,
          onProgress: (progress, message) => setJob({ progress, message }),
        });
        const name = replaceExtension(asset.name, result.extension);
        downloadBlob(result.blob, name);
        setJob({ active: false, progress: 1, message: '', done: { name, size: result.blob.size, method: result.method } });
      }
    } catch (err) {
      const cancelled = err instanceof DOMException && err.name === 'AbortError';
      setJob({ active: false, message: '', error: cancelled ? null : err instanceof Error ? err.message : String(err) });
    } finally {
      abortRef.current = null;
    }
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Export</h2>
      </div>

      {asset.kind === 'image' ? (
        <>
          <Segmented
            label="Format"
            value={imageFormat}
            disabled={job.active}
            onChange={setImageFormat}
            options={[
              { value: 'png', label: 'PNG' },
              { value: 'jpeg', label: 'JPEG' },
              { value: 'webp', label: 'WebP' },
            ]}
          />
          {imageFormat !== 'png' && (
            <Slider label="Quality" value={imageQuality} min={40} max={100} disabled={job.active} format={(v) => `${v}%`} onChange={setImageQuality} />
          )}
        </>
      ) : (
        <>
          <Segmented
            label="Container"
            value={container}
            disabled={job.active}
            onChange={setContainer}
            options={[
              { value: 'mp4', label: 'MP4 (H.264)' },
              { value: 'webm', label: 'WebM (VP9)' },
            ]}
          />
          <Segmented
            label="Quality"
            value={quality}
            disabled={job.active}
            onChange={setQuality}
            options={[
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
            ]}
          />
          <Toggle
            label={asset.hasAudio ? 'Keep audio' : 'Keep audio (source has none)'}
            checked={keepAudio && asset.hasAudio}
            disabled={job.active || !asset.hasAudio}
            onChange={setKeepAudio}
          />
          <p className="hint">
            Range {formatTime(trimStart)} → {formatTime(trimEnd)} ({formatTime(trimEnd - trimStart)}). Adjust it on the timeline.
          </p>
          <p className="hint">
            {hasWebCodecs() && asset.decodable !== false
              ? 'Frame-accurate export via WebCodecs. Runs faster than real time on most machines.'
              : 'This browser lacks WebCodecs, so the video will be recorded in real time (WebM).'}
          </p>
        </>
      )}

      {job.active ? (
        <div className="export-progress">
          <div className="progress">
            <div className="progress-bar" style={{ width: `${Math.round(job.progress * 100)}%` }} />
          </div>
          <div className="progress-row">
            <span>{job.message}</span>
            <button className="btn btn-small btn-ghost" onClick={() => abortRef.current?.abort()}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button className="btn btn-primary btn-block" onClick={() => void start()}>
          Export {asset.kind === 'image' ? 'image' : 'video'}
        </button>
      )}

      {job.error && <div className="status status-error">{job.error}</div>}
      {job.done && !job.active && (
        <div className="status status-ready">
          Saved {job.done.name} ({(job.done.size / 1_048_576).toFixed(2)} MB)
        </div>
      )}
    </div>
  );
}
