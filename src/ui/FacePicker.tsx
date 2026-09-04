import { useEffect, useMemo, useRef, useState } from 'react';
import type { Canvas2D } from '../core/canvas';
import type { FrameFace } from '../core/operations/faceMask';
import type { PersonSample } from '../faces/people';
import { faceRecognizer } from '../faces/recognizer';
import { useEditor } from '../state/store';

export interface PickedFace {
  face: FrameFace;
  /** Frame before masking, in the same pixel space as `face.box`. */
  clean: Canvas2D;
  /** Popover anchor, in preview-section coordinates. */
  x: number;
  y: number;
}

interface Props {
  picked: PickedFace;
  onClose: () => void;
}

/** Popover shown after clicking a detected face: keep/mask it here, or enrol the person. */
export function FacePicker({ picked, onClose }: Props) {
  const asset = useEditor((s) => s.asset);
  const people = useEditor((s) => s.people);
  const overrides = useEditor((s) => s.faceOverrides);
  const setFaceOverride = useEditor((s) => s.setFaceOverride);
  const addPerson = useEditor((s) => s.addPerson);
  const addPersonSample = useEditor((s) => s.addPersonSample);
  const removePerson = useEditor((s) => s.removePerson);
  const [name, setName] = useState(`Person ${people.length + 1}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const { face, clean } = picked;
  const isImage = asset?.kind === 'image';
  const override = overrides[face.key];
  const matched = face.personId ? people.find((p) => p.id === face.personId) : undefined;
  const thumb = useThumb(clean, face);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose]);

  const makeSample = async (): Promise<PersonSample> => {
    const embedding = await faceRecognizer.embed(clean, face.box);
    return { embedding: Array.from(embedding), thumb };
  };

  const enrol = async () => {
    setBusy(true);
    setError(null);
    try {
      const sample = await makeSample();
      if (matched) addPersonSample(matched.id, sample);
      else addPerson(name.trim() || `Person ${people.length + 1}`, sample);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Keep the popover inside the preview area.
  const style: React.CSSProperties = { left: Math.max(8, picked.x - 130), top: picked.y + 12 };

  return (
    <div className="face-picker" ref={ref} style={style} role="dialog" aria-label="Face options">
      <div className="face-picker-head">
        {thumb && <img src={thumb} alt="" className="face-thumb" />}
        <div>
          <div className="face-picker-title">
            {matched ? matched.name : 'Unknown face'}
            {face.similarity !== undefined && matched && <span className="dim"> · {Math.round(face.similarity * 100)}% match</span>}
          </div>
          <div className="dim small">{face.kept ? 'Currently kept clear' : 'Currently masked'}</div>
        </div>
      </div>

      {isImage && (
        <div className="face-picker-row">
          <button className={`btn btn-small${override === 'keep' ? ' is-active' : ''}`} onClick={() => { setFaceOverride(face.key, override === 'keep' ? null : 'keep'); onClose(); }}>
            Keep clear in this photo
          </button>
          <button className={`btn btn-small${override === 'mask' ? ' is-active' : ''}`} onClick={() => { setFaceOverride(face.key, override === 'mask' ? null : 'mask'); onClose(); }}>
            Mask in this photo
          </button>
        </div>
      )}

      <div className="face-picker-section">
        {matched ? (
          <>
            <button className="btn btn-small btn-block" disabled={busy} onClick={() => void enrol()}>
              {busy ? 'Adding…' : `Add as another sample of ${matched.name}`}
            </button>
            <button className="btn btn-small btn-ghost btn-block" onClick={() => { removePerson(matched.id); onClose(); }}>
              Remove {matched.name} from my people
            </button>
          </>
        ) : (
          <>
            <label className="field">
              <span className="field-label">Add to my people (kept clear everywhere)</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void enrol()}
                autoFocus
              />
            </label>
            <button className="btn btn-primary btn-small btn-block" disabled={busy} onClick={() => void enrol()}>
              {busy ? 'Adding…' : 'Add person'}
            </button>
          </>
        )}
        <p className="hint">Add a few samples per person (different photos, angles, lighting) for reliable recognition.</p>
        {error && <div className="status status-error">{error}</div>}
      </div>
    </div>
  );
}

/** JPEG thumbnail of the face (slightly enlarged box) from the clean frame. */
function useThumb(clean: Canvas2D, face: FrameFace): string {
  return useMemo(() => {
    const { x, y, w, h } = face.box;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const s = Math.max(w, h) * 1.4;
    const c = document.createElement('canvas');
    c.width = 96;
    c.height = 96;
    c.getContext('2d')!.drawImage(clean, cx - s / 2, cy - s / 2, s, s, 0, 0, 96, 96);
    return c.toDataURL('image/jpeg', 0.82);
  }, [clean, face]);
}
