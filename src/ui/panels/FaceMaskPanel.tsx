import { useEffect, useState } from 'react';
import { faceDetection, type DetectorState, type FaceEngineId } from '../../faces/detector';
import { faceRecognizer } from '../../faces/recognizer';
import { faceLandmarker } from '../../faces/landmarker';
import { buildSwapSource } from '../../faces/swap/sources';
import { hasMeshWarp } from '../../faces/swap/warp';
import { createCanvas, getCtx } from '../../core/canvas';
import { cancelNeuralDownload, downloadNeuralModels, isNeuralAvailable, loadNeural, refreshNeuralStatus, subscribeNeural, type NeuralUiState } from '../../faces/swap/neural';
import { useEditor } from '../../state/store';
import { Segmented } from '../controls/Segmented';
import { Slider } from '../controls/Slider';
import { Toggle } from '../controls/Toggle';

function useDetectorState(engine: FaceEngineId): DetectorState {
  const [state, setState] = useState<DetectorState>(faceDetection.getState(engine));
  useEffect(() => {
    faceDetection.load(engine).catch(() => undefined);
    return faceDetection.subscribe(engine, setState);
  }, [engine]);
  return state;
}

const ENGINE_LABEL: Record<FaceEngineId, string> = { yunet: 'YuNet', blazeface: 'BlazeFace' };

function useLandmarkerState(active: boolean): DetectorState {
  const [state, setState] = useState<DetectorState>(faceLandmarker.status.get());
  useEffect(() => {
    if (active) faceLandmarker.load().catch(() => undefined);
    return faceLandmarker.status.subscribe(setState);
  }, [active]);
  return state;
}

function useNeuralState(active: boolean): NeuralUiState {
  const [state, setState] = useState<NeuralUiState>(() => ({ available: isNeuralAvailable(), status: null, phase: 'idle', progress: null, error: null }));
  useEffect(() => {
    if (!isNeuralAvailable()) return;
    void refreshNeuralStatus().then((st) => {
      if (active && st?.modelsPresent) void loadNeural();
    });
    return subscribeNeural(setState);
  }, [active]);
  return state;
}

function useRecognizerState(active: boolean): DetectorState {
  const [state, setState] = useState<DetectorState>(faceRecognizer.status.get());
  useEffect(() => {
    if (active) faceRecognizer.load().catch(() => undefined);
    return faceRecognizer.status.subscribe(setState);
  }, [active]);
  return state;
}

export function FaceMaskPanel() {
  const asset = useEditor((s) => s.asset);
  const p = useEditor((s) => s.faceMask);
  const enabled = useEditor((s) => s.faceMaskEnabled);
  const setEnabled = useEditor((s) => s.setFaceMaskEnabled);
  const set = useEditor((s) => s.setFaceMask);
  const reset = useEditor((s) => s.resetFaceMask);
  const facesInFrame = useEditor((s) => s.facesInFrame);
  const detector = useDetectorState(p.detection.engine);
  const people = useEditor((s) => s.people);
  const overrides = useEditor((s) => s.faceOverrides);
  const clearFaceOverrides = useEditor((s) => s.clearFaceOverrides);
  const renamePerson = useEditor((s) => s.renamePerson);
  const removePerson = useEditor((s) => s.removePerson);
  const recognizer = useRecognizerState(people.length > 0 || p.showBoxes);
  const swapSources = useEditor((s) => s.swapSources);
  const addSwapSource = useEditor((s) => s.addSwapSource);
  const removeSwapSource = useEditor((s) => s.removeSwapSource);
  const renameSwapSource = useEditor((s) => s.renameSwapSource);
  const landmarker = useLandmarkerState(p.style === 'swap');
  const [swapBusy, setSwapBusy] = useState(false);
  const neural = useNeuralState(p.style === 'swap' && p.swapEngine === 'neural');
  const [licenceOk, setLicenceOk] = useState(false);
  const [swapError, setSwapError] = useState<string | null>(null);

  /** Loads a portrait photo, finds its largest face and turns it into a substitute face. */
  const loadFacePhoto = async (file: File) => {
    setSwapBusy(true);
    setSwapError(null);
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      const canvas = createCanvas(bitmap.width * scale, bitmap.height * scale);
      getCtx(canvas).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const faces = await faceDetection.detect(canvas, { engine: 'yunet', minConfidence: 0.5, analysisSize: 960, mode: 'fast' });
      if (faces.length === 0) throw new Error('No face found in that photo.');
      const largest = [...faces].sort((a, b) => b.w * b.h - a.w * a.h)[0];
      const source = await buildSwapSource(canvas, largest, file.name.replace(/\.[^.]+$/, '').slice(0, 24) || `Face ${swapSources.length + 1}`);
      addSwapSource(source, true);
    } catch (err) {
      setSwapError(err instanceof Error ? err.message : String(err));
    } finally {
      setSwapBusy(false);
    }
  };
  const isVideo = asset?.kind === 'video';
  const overrideCount = Object.keys(overrides).length;

  return (
    <div className="panel">
      <div className="panel-header">
        <Toggle label="Mask all faces" checked={enabled} onChange={setEnabled} />
        <button className="btn btn-small btn-ghost" onClick={reset}>
          Reset
        </button>
      </div>

      <div className={`status status-${detector.status}`}>
        {detector.status === 'loading' && `Loading ${ENGINE_LABEL[p.detection.engine]} on this device…`}
        {detector.status === 'ready' && (
          <>
            {ENGINE_LABEL[p.detection.engine]} ready · {detector.backend} ·{' '}
            {enabled || p.showBoxes ? `${facesInFrame} face${facesInFrame === 1 ? '' : 's'} in frame` : 'masking off'}
          </>
        )}
        {detector.status === 'error' && `Detector failed: ${detector.error}`}
        {detector.status === 'idle' && 'Detector idle'}
      </div>

      <Toggle
        label="Show faces & pick who to keep clear"
        hint="Draws detection boxes (preview only). Click a face to keep it clear, mask it, or add the person to your list."
        checked={p.showBoxes}
        onChange={(showBoxes) => set({ showBoxes })}
      />
      <p className="hint">
        {p.showBoxes
          ? 'Click a face in the preview to choose what happens to it. Blue = kept clear, green = masked.'
          : 'Hold the “compare” button under the preview (or the C key) to see the original frame, even during playback.'}
      </p>

      <h3 className="section-title">Who to mask</h3>
      <Segmented
        value={p.maskMode}
        onChange={(maskMode) => set({ maskMode })}
        options={[
          { value: 'except-people', label: 'All but my people', title: 'Mask everyone except the people listed below' },
          { value: 'all', label: 'Everyone' },
          { value: 'only-people', label: 'Only my people' },
        ]}
      />
      {people.length === 0 ? (
        <p className="hint">
          No people yet. Turn on “Show faces” above, then click a face in the preview and add the person. They will stay clear in every photo and video you open.
        </p>
      ) : (
        <ul className="people">
          {people.map((person) => (
            <li key={person.id} className="person">
              <img src={person.samples[0]?.thumb} alt="" className="face-thumb" />
              <div className="person-body">
                <input
                  className="person-name"
                  value={person.name}
                  onChange={(e) => renamePerson(person.id, e.target.value)}
                  aria-label="Name"
                />
                <span className="dim small">{person.samples.length} sample{person.samples.length === 1 ? '' : 's'}</span>
              </div>
              <button className="btn btn-small btn-ghost" onClick={() => removePerson(person.id)} title="Remove">
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {people.length > 0 && (
        <>
          <Slider
            label="Recognition strictness"
            value={Math.round(p.matchThreshold * 100)}
            min={30}
            max={70}
            format={(v) => `${v}`}
            onChange={(v) => set({ matchThreshold: v / 100 })}
          />
          <p className="hint">Higher = fewer strangers mistaken for your people (they get masked); lower = your people recognised more often. If someone in your list still gets masked, add another sample of them from that photo.</p>
          <div className={`status status-${recognizer.status}`}>
            {recognizer.status === 'loading' && 'Loading face recognition (SFace) on this device…'}
            {recognizer.status === 'ready' && `Face recognition ready · ${recognizer.backend}`}
            {recognizer.status === 'error' && `Face recognition failed: ${recognizer.error}`}
            {recognizer.status === 'idle' && 'Face recognition idle'}
          </div>
        </>
      )}
      {overrideCount > 0 && (
        <div className="panel-header">
          <span className="dim small">{overrideCount} manual choice{overrideCount === 1 ? '' : 's'} in this photo</span>
          <button className="btn btn-small btn-ghost" onClick={clearFaceOverrides}>
            Clear
          </button>
        </div>
      )}

      <fieldset disabled={!enabled}>
        <Segmented
          label="Mask style"
          value={p.style}
          onChange={(style) => set({ style })}
          options={[
            { value: 'blur', label: 'Blur' },
            { value: 'pixelate', label: 'Pixelate' },
            { value: 'solid', label: 'Solid' },
            { value: 'emoji', label: 'Emoji' },
            ...(hasMeshWarp() ? [{ value: 'swap' as const, label: 'Swap', title: 'Replace masked faces with a substitute face' }] : []),
          ]}
        />
        {p.style === 'swap' && (
          <div className="swap-section">
            <span className="field-label">Substitute face</span>
            {swapSources.length === 0 ? (
              <p className="hint">
                No substitute faces yet. Turn on “Show faces”, click a face and choose “Use this face as the substitute face”, or load a portrait photo below.
              </p>
            ) : (
              <div className="swap-sources" role="radiogroup" aria-label="Substitute face">
                {swapSources.map((src) => (
                  <div key={src.id} className={`swap-source${p.swapSourceId === src.id ? ' is-active' : ''}`}>
                    <button type="button" role="radio" aria-checked={p.swapSourceId === src.id} className="swap-source-pick" onClick={() => set({ swapSourceId: src.id })}>
                      <img src={src.thumb} alt="" className="face-thumb" />
                    </button>
                    <input className="swap-source-name" value={src.name} onChange={(e) => renameSwapSource(src.id, e.target.value)} aria-label="Name" />
                    <button type="button" className="btn btn-small btn-ghost" onClick={() => removeSwapSource(src.id)} title="Remove">
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            <label className={`btn btn-small${swapBusy ? ' is-disabled' : ''}`} style={{ textAlign: 'center' }}>
              {swapBusy ? 'Working…' : 'Load a face photo…'}
              <input
                type="file"
                accept="image/*"
                hidden
                disabled={swapBusy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void loadFacePhoto(f);
                  e.target.value = '';
                }}
              />
            </label>
            {swapError && <div className="status status-error">{swapError}</div>}
            <div className={`status status-${landmarker.status}`}>
              {landmarker.status === 'loading' && 'Loading face mesh model on this device…'}
              {landmarker.status === 'ready' && `Face mesh ready · ${landmarker.backend}`}
              {landmarker.status === 'error' && `Face mesh failed: ${landmarker.error}`}
              {landmarker.status === 'idle' && 'Face mesh idle'}
            </div>
            {neural.available && (
              <>
                <Segmented
                  label="Swap engine"
                  value={p.swapEngine}
                  onChange={(swapEngine) => set({ swapEngine })}
                  options={[
                    { value: 'mesh', label: 'Mesh (fast)', title: 'Warps the substitute face onto the target' },
                    { value: 'neural', label: 'Neural', title: 'Identity-preserving swap (InsightFace inswapper) — runs natively in the desktop app' },
                  ]}
                />
                {p.swapEngine === 'neural' && (
                  <div className="neural-box">
                    {neural.phase === 'ready' && <div className="status status-ready">Neural swap ready · {neural.status?.backend}</div>}
                    {neural.phase === 'loading' && <div className="status status-loading">Loading neural models…</div>}
                    {neural.phase === 'error' && <div className="status status-error">{neural.error}</div>}
                    {neural.phase === 'downloading' && (
                      <div className="export-progress">
                        <div className="progress">
                          <div className="progress-bar" style={{ width: `${Math.round((neural.progress?.overall ?? 0) * 100)}%` }} />
                        </div>
                        <div className="progress-row">
                          <span>
                            {neural.progress ? `${neural.progress.file} · ${(neural.progress.received / 1048576).toFixed(0)} / ${(neural.progress.total / 1048576).toFixed(0)} MB` : 'Starting…'}
                          </span>
                          <button className="btn btn-small btn-ghost" onClick={cancelNeuralDownload}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                    {(neural.phase === 'idle' || neural.phase === 'error') && neural.status && !neural.status.modelsPresent && (
                      <>
                        <p className="hint">
                          The neural engine needs two models (about 730 MB) downloaded to this computer: InsightFace <em>inswapper</em> and ArcFace. They are
                          licensed by InsightFace for <strong>non-commercial research use only</strong>.
                        </p>
                        <Toggle label="I understand and accept the model licence" checked={licenceOk} onChange={setLicenceOk} />
                        <button className="btn btn-primary btn-small btn-block" disabled={!licenceOk} onClick={() => void downloadNeuralModels()}>
                          Download models
                        </button>
                      </>
                    )}
                    {neural.phase === 'idle' && neural.status?.modelsPresent && (
                      <button className="btn btn-small btn-block" onClick={() => void loadNeural()}>
                        Load neural models
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
            <p className="hint">
              Faces too small or too turned to be meshed are blurred instead, so nobody is left exposed. Only use faces you have permission to use.
            </p>
          </div>
        )}
        {p.style === 'solid' && (
          <label className="field field-inline">
            <span className="field-label">Colour</span>
            <input type="color" value={p.color} onChange={(e) => set({ color: e.target.value })} />
          </label>
        )}
        {p.style === 'emoji' && (
          <label className="field field-inline">
            <span className="field-label">Emoji</span>
            <input
              type="text"
              className="emoji-input"
              value={p.emoji}
              maxLength={4}
              onChange={(e) => set({ emoji: e.target.value || '🙂' })}
            />
          </label>
        )}
        {p.style !== 'emoji' && p.style !== 'swap' && (
          <Segmented
            label="Mask shape"
            value={p.shape}
            onChange={(shape) => set({ shape })}
            options={[
              { value: 'ellipse', label: 'Oval' },
              { value: 'rect', label: 'Rounded box' },
            ]}
          />
        )}

        {p.style !== 'swap' && (
        <Slider
          label="Mask area size"
          value={Math.round(p.sizeScale * 100)}
          min={60}
          max={300}
          step={5}
          format={(v) => `${v}%`}
          onChange={(v) => set({ sizeScale: v / 100 })}
        />
        )}
        {p.style !== 'swap' && (
        <Slider
          label={p.style === 'blur' ? 'Blur strength' : p.style === 'pixelate' ? 'Pixel size' : p.style === 'solid' ? 'Opacity' : 'Opacity'}
          value={p.intensity}
          min={0}
          max={100}
          format={(v) => `${v}`}
          onChange={(intensity) => set({ intensity })}
        />
        )}
        {p.style !== 'emoji' && (
          <Slider label="Edge softness" value={p.feather} min={0} max={100} onChange={(feather) => set({ feather })} />
        )}

      </fieldset>

      <fieldset disabled={!enabled && !p.showBoxes}>
        <h3 className="section-title">Detection</h3>
        <Segmented
          label="Engine"
          value={p.detection.engine}
          onChange={(engine) => set({ detection: { ...p.detection, engine } })}
          options={[
            { value: 'yunet', label: 'Precise', title: 'YuNet — finds small and distant faces, crowds, wide shots' },
            { value: 'blazeface', label: 'Fast', title: 'MediaPipe BlazeFace — quickest, best for close-up faces' },
          ]}
        />
        {p.detection.engine === 'yunet' ? (
          <Slider
            label="Analysis resolution"
            value={p.detection.analysisSize}
            min={320}
            max={1920}
            step={160}
            format={(v) => `${v}px`}
            onChange={(analysisSize) => set({ detection: { ...p.detection, analysisSize } })}
          />
        ) : (
          <Segmented
            label="Search mode"
            value={p.detection.mode}
            onChange={(mode) => set({ detection: { ...p.detection, mode } })}
            options={[
              { value: 'fast', label: 'Single pass', title: 'One pass over the frame' },
              { value: 'thorough', label: 'Tiled', title: 'Scans overlapping tiles to catch smaller faces (much slower)' },
            ]}
          />
        )}
        {p.detection.engine === 'yunet' && isVideo && p.detection.analysisSize > 640 && (
          <p className="hint">While playing, the preview analyses at 640px to stay smooth. Pause or export to see the full setting.</p>
        )}
        <Slider
          label="Sensitivity"
          value={Math.round((1 - p.detection.minConfidence) * 100)}
          min={10}
          max={90}
          format={(v) => `${v}`}
          onChange={(v) => set({ detection: { ...p.detection, minConfidence: 1 - v / 100 } })}
        />

        {isVideo && (
          <>
            <h3 className="section-title">Tracking (video)</h3>
            <Toggle
              label="Smooth & hold masks between frames"
              hint="Reduces flicker and keeps a mask in place when the detector misses a frame"
              checked={p.tracking.enabled}
              onChange={(enabled) => set({ tracking: { ...p.tracking, enabled } })}
            />
            <Slider
              label="Motion smoothing"
              value={Math.round(p.tracking.smoothing * 100)}
              min={0}
              max={90}
              disabled={!p.tracking.enabled}
              format={(v) => `${v}`}
              onChange={(v) => set({ tracking: { ...p.tracking, smoothing: v / 100 } })}
            />
            <Slider
              label="Hold after loss"
              value={p.tracking.holdFrames}
              min={0}
              max={30}
              disabled={!p.tracking.enabled}
              format={(v) => `${v} frames`}
              onChange={(holdFrames) => set({ tracking: { ...p.tracking, holdFrames } })}
            />
          </>
        )}

      </fieldset>

    </div>
  );
}
