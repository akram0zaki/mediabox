/** Named looks. Values are deltas on the neutral colour settings; strength scales them. */
import type { ColorValues } from './adjust';

export interface Preset {
  id: string;
  name: string;
  values: Partial<ColorValues>;
}

export const PRESETS: Preset[] = [
  { id: 'vivid', name: 'Vivid', values: { saturation: 25, contrast: 12, vibrance: 20 } },
  { id: 'pop', name: 'Pop', values: { vibrance: 55, contrast: 15, saturation: 10 } },
  { id: 'warm', name: 'Warm', values: { temperature: 35, saturation: 8, brightness: 3 } },
  { id: 'golden', name: 'Golden', values: { temperature: 45, tint: 5, exposure: 5, saturation: 10, vignette: 15 } },
  { id: 'cool', name: 'Cool', values: { temperature: -35, tint: -5 } },
  { id: 'chrome', name: 'Chrome', values: { contrast: 25, saturation: 12, temperature: -8, highlights: -10 } },
  { id: 'crisp', name: 'Crisp', values: { sharpen: 45, contrast: 8, vibrance: 15 } },
  { id: 'dramatic', name: 'Dramatic', values: { contrast: 30, shadows: -35, highlights: -20, vignette: 25, saturation: -5 } },
  { id: 'matte', name: 'Matte', values: { fade: 45, contrast: -8, saturation: -10 } },
  { id: 'pastel', name: 'Pastel', values: { brightness: 8, saturation: -25, fade: 20, contrast: -12 } },
  { id: 'film', name: 'Film', values: { fade: 25, grain: 35, contrast: 8, saturation: -12, temperature: 8, vignette: 20 } },
  { id: 'vintage', name: 'Vintage', values: { temperature: 22, saturation: -25, fade: 40, vignette: 30, grain: 25, contrast: -5 } },
  { id: 'mono', name: 'Mono', values: { saturation: -100, contrast: 12 } },
  { id: 'noir', name: 'Noir', values: { saturation: -100, contrast: 35, vignette: 45, shadows: -15 } },
];

export const PRESET_BY_ID = new Map(PRESETS.map((p) => [p.id, p]));
