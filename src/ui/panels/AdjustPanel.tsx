import { useEffect, useMemo, useRef } from 'react';
import {
  COLOR_RANGES,
  applyColor,
  neutralColor,
  type AdjustParams,
  type ColorValues,
} from '../../core/operations/adjust';
import { PRESETS, type Preset } from '../../core/operations/adjustPresets';
import { useEditor } from '../../state/store';
import { Slider } from '../controls/Slider';

const GROUPS: { title: string; keys: (keyof ColorValues)[] }[] = [
  { title: 'Light', keys: ['exposure', 'brightness', 'contrast', 'highlights', 'shadows', 'fade'] },
  { title: 'Colour', keys: ['temperature', 'tint', 'saturation', 'vibrance', 'hue'] },
  { title: 'Effects', keys: ['vignette', 'grain', 'sharpen', 'soften'] },
];

const LABELS: Record<keyof ColorValues, string> = {
  exposure: 'Exposure',
  brightness: 'Brightness',
  contrast: 'Contrast',
  highlights: 'Highlights',
  shadows: 'Shadows',
  fade: 'Fade',
  temperature: 'Temperature',
  tint: 'Tint',
  saturation: 'Saturation',
  vibrance: 'Vibrance',
  hue: 'Hue',
  vignette: 'Vignette',
  grain: 'Grain',
  sharpen: 'Sharpen',
  soften: 'Soften',
};

export function AdjustPanel() {
  const p = useEditor((s) => s.adjust);
  const set = useEditor((s) => s.setAdjust);
  const reset = useEditor((s) => s.resetAdjust);
  const thumb = useEditor((s) => s.previewThumb);
  const fmt = (key: keyof ColorValues) => (v: number) => (key === 'hue' ? `${v}°` : v > 0 && COLOR_RANGES[key][0] < 0 ? `+${v}` : `${v}`);

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Filters</h2>
        <button className="btn btn-small btn-ghost" onClick={reset}>
          Reset all
        </button>
      </div>

      <div className="preset-strip" role="listbox" aria-label="Filter presets">
        <PresetTile preset={null} active={p.preset === null} thumb={thumb} onPick={() => set({ preset: null })} />
        {PRESETS.map((preset) => (
          <PresetTile key={preset.id} preset={preset} active={p.preset === preset.id} thumb={thumb} onPick={() => set({ preset: preset.id, strength: 100 })} />
        ))}
      </div>
      {p.preset && (
        <Slider label="Filter strength" value={p.strength} min={0} max={100} format={(v) => `${v}%`} onChange={(strength) => set({ strength })} />
      )}

      {GROUPS.map((group) => (
        <div key={group.title}>
          <h3 className="section-title">{group.title}</h3>
          {group.keys.map((key) => (
            <Slider
              key={key}
              label={LABELS[key]}
              value={p[key]}
              min={COLOR_RANGES[key][0]}
              max={COLOR_RANGES[key][1]}
              step={key === 'soften' ? 0.5 : 1}
              format={fmt(key)}
              onChange={(v) => set({ [key]: v } as Partial<AdjustParams>)}
            />
          ))}
        </div>
      ))}
      <p className="hint">Presets layer on top of your manual adjustments. Double-click a slider to reset it.</p>
    </div>
  );
}

function PresetTile({ preset, active, thumb, onPick }: { preset: Preset | null; active: boolean; thumb: HTMLCanvasElement | null; onPick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const values = useMemo<ColorValues>(() => ({ ...neutralColor, ...(preset?.values ?? {}) }), [preset]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (!thumb) {
      canvas.width = 120;
      canvas.height = 80;
      return;
    }
    canvas.width = thumb.width;
    canvas.height = thumb.height;
    canvas.getContext('2d')!.drawImage(thumb, 0, 0);
    const out = applyColor(canvas, values);
    if (out !== canvas) canvas.getContext('2d')!.drawImage(out, 0, 0);
  }, [thumb, values]);

  return (
    <button type="button" role="option" aria-selected={active} className={`preset-tile${active ? ' is-active' : ''}`} onClick={onPick}>
      <canvas ref={ref} className="preset-thumb" />
      <span className="preset-name">{preset?.name ?? 'Original'}</span>
    </button>
  );
}
