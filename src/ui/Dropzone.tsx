import { useRef, useState } from 'react';
import { useEditor } from '../state/store';
import { useOpenFile } from './useOpenFile';

const SAMPLES = [
  { label: 'Try the sample photo', file: 'solvay.jpg', type: 'image/jpeg' },
  { label: 'Try the sample video', file: 'solvay.mp4', type: 'video/mp4' },
];

export function Dropzone() {
  const openFile = useOpenFile();
  const loading = useEditor((s) => s.loading);
  const error = useEditor((s) => s.loadError);
  const setLoading = useEditor((s) => s.setLoading);

  const openSample = async (sample: (typeof SAMPLES)[number]) => {
    setLoading(true);
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}samples/${sample.file}`);
      if (!res.ok) throw new Error(`Could not load the sample (${res.status}).`);
      const blob = await res.blob();
      await openFile(new File([blob], sample.file, { type: sample.type }));
    } catch (err) {
      setLoading(false, err instanceof Error ? err.message : String(err));
    }
  };
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      className={`dropzone${over ? ' is-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const file = e.dataTransfer.files[0];
        if (file) void openFile(file);
      }}
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*,.mkv,.mov,.mp4,.webm"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void openFile(file);
          e.target.value = '';
        }}
      />
      <div className="dropzone-inner">
        <img className="dropzone-icon" src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={72} height={72} />
        <h1>Drop a photo or video</h1>
        <p>or click to browse. Everything stays on this device — faces are detected and masked locally.</p>
        <div className="dropzone-formats">JPG · PNG · WebP · MP4 · MOV · WebM · MKV</div>
        <div className="dropzone-samples" onClick={(e) => e.stopPropagation()}>
          <span className="dim small">No file handy?</span>
          {SAMPLES.map((sample) => (
            <button key={sample.file} type="button" className="btn btn-small" disabled={loading} onClick={() => void openSample(sample)}>
              {sample.label}
            </button>
          ))}
        </div>
        {loading && <div className="dropzone-status">Loading…</div>}
        {error && <div className="dropzone-error">{error}</div>}
      </div>
    </div>
  );
}
