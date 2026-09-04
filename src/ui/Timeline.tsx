import { useEditor } from '../state/store';
import { formatTime } from './format';

export function Timeline() {
  const asset = useEditor((s) => s.asset);
  const currentTime = useEditor((s) => s.currentTime);
  const playing = useEditor((s) => s.playing);
  const trimStart = useEditor((s) => s.trimStart);
  const trimEnd = useEditor((s) => s.trimEnd);
  const setCurrentTime = useEditor((s) => s.setCurrentTime);
  const setPlaying = useEditor((s) => s.setPlaying);
  const setTrim = useEditor((s) => s.setTrim);
  const exporting = useEditor((s) => s.exportJob.active);
  if (asset?.kind !== 'video') return null;

  const duration = asset.duration;
  const pct = (t: number) => `${(duration ? (t / duration) * 100 : 0).toFixed(3)}%`;

  return (
    <footer className="timeline">
      <div className="transport">
        <button
          className="btn btn-icon"
          onClick={() => setPlaying(!playing)}
          disabled={exporting}
          title="Play / pause (Space)"
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="time-display">
          {formatTime(currentTime)} <span className="dim">/ {formatTime(duration)}</span>
        </span>
      </div>

      <div className="scrubber">
        <div className="scrubber-track">
          <div className="scrubber-trim" style={{ left: pct(trimStart), width: pct(trimEnd - trimStart) }} />
          <div className="scrubber-head" style={{ left: pct(currentTime) }} />
        </div>
        <input
          type="range"
          className="scrubber-input"
          min={0}
          max={duration}
          step={0.001}
          value={currentTime}
          disabled={exporting}
          onChange={(e) => {
            if (playing) setPlaying(false);
            setCurrentTime(Number(e.target.value));
          }}
          aria-label="Playhead"
        />
      </div>

      <div className="trim-controls">
        <button className="btn btn-small" onClick={() => setTrim(Math.min(currentTime, trimEnd - 0.05), trimEnd)} disabled={exporting}>
          Set start
        </button>
        <span className="trim-range">
          {formatTime(trimStart)} → {formatTime(trimEnd)}
        </span>
        <button className="btn btn-small" onClick={() => setTrim(trimStart, Math.max(currentTime, trimStart + 0.05))} disabled={exporting}>
          Set end
        </button>
        <button className="btn btn-small btn-ghost" onClick={() => setTrim(0, duration)} disabled={exporting}>
          Reset
        </button>
      </div>
    </footer>
  );
}
