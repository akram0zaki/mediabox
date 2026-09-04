import type { Rotation } from '../../core/operations';
import { useEditor } from '../../state/store';
import { Slider } from '../controls/Slider';
import { Toggle } from '../controls/Toggle';

export function TransformPanel() {
  const p = useEditor((s) => s.transform);
  const set = useEditor((s) => s.setTransform);
  const reset = useEditor((s) => s.resetTransform);
  const rotateBy = (delta: number) => set({ rotate: (((p.rotate + delta) % 360) + 360) % 360 as Rotation });
  const crop = (patch: Partial<typeof p.crop>) => set({ crop: { ...p.crop, ...patch } });
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Transform</h2>
        <button className="btn btn-small btn-ghost" onClick={reset}>
          Reset
        </button>
      </div>

      <div className="field">
        <span className="field-label">Rotate</span>
        <div className="button-row">
          <button className="btn" onClick={() => rotateBy(-90)} title="Rotate left">
            ↺ 90°
          </button>
          <button className="btn" onClick={() => rotateBy(90)} title="Rotate right">
            ↻ 90°
          </button>
          <span className="dim">{p.rotate}°</span>
        </div>
      </div>

      <Toggle label="Flip horizontally" checked={p.flipH} onChange={(flipH) => set({ flipH })} />
      <Toggle label="Flip vertically" checked={p.flipV} onChange={(flipV) => set({ flipV })} />

      <h3 className="section-title">Crop</h3>
      <Slider label="Left" value={p.crop.left} min={0} max={0.9} step={0.005} format={pct} onChange={(left) => crop({ left })} />
      <Slider label="Right" value={p.crop.right} min={0} max={0.9} step={0.005} format={pct} onChange={(right) => crop({ right })} />
      <Slider label="Top" value={p.crop.top} min={0} max={0.9} step={0.005} format={pct} onChange={(top) => crop({ top })} />
      <Slider label="Bottom" value={p.crop.bottom} min={0} max={0.9} step={0.005} format={pct} onChange={(bottom) => crop({ bottom })} />
      <p className="hint">Crop and rotation are applied before face detection, so masks follow the edited frame.</p>
    </div>
  );
}
