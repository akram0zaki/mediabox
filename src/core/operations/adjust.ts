import { createCanvas, getCtx, supportsCanvasFilter, type Canvas2D } from '../canvas';
import { registerOperation } from '../registry';
import type { OperationHandler } from '../types';
import { PRESET_BY_ID } from './adjustPresets';
import { applyColorGl } from '../color/gl';

/**
 * Colour controls. Everything is zero-centred (0 = untouched) so a preset can be layered on top of
 * manual adjustments: effective = manual + preset × strength.
 */
export interface ColorValues {
  exposure: number; // -100..100  (±2 EV)
  brightness: number; // -100..100
  contrast: number; // -100..100
  highlights: number; // -100..100
  shadows: number; // -100..100
  fade: number; // 0..100   lifts blacks (matte look)
  temperature: number; // -100..100  cool ↔ warm
  tint: number; // -100..100  green ↔ magenta
  saturation: number; // -100..100
  vibrance: number; // -100..100  saturation that spares already-saturated colours
  hue: number; // -180..180 degrees
  vignette: number; // 0..100
  grain: number; // 0..100
  sharpen: number; // 0..100
  soften: number; // 0..20 (blur, relative to a 1000 px wide frame)
}

export interface AdjustParams extends ColorValues {
  preset: string | null;
  strength: number; // 0..100
}

export const ADJUST_TYPE = 'adjust';

export const neutralColor: ColorValues = {
  exposure: 0,
  brightness: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  fade: 0,
  temperature: 0,
  tint: 0,
  saturation: 0,
  vibrance: 0,
  hue: 0,
  vignette: 0,
  grain: 0,
  sharpen: 0,
  soften: 0,
};

export const COLOR_RANGES: Record<keyof ColorValues, [number, number]> = {
  exposure: [-100, 100],
  brightness: [-100, 100],
  contrast: [-100, 100],
  highlights: [-100, 100],
  shadows: [-100, 100],
  fade: [0, 100],
  temperature: [-100, 100],
  tint: [-100, 100],
  saturation: [-100, 100],
  vibrance: [-100, 100],
  hue: [-180, 180],
  vignette: [0, 100],
  grain: [0, 100],
  sharpen: [0, 100],
  soften: [0, 20],
};

export const COLOR_KEYS = Object.keys(neutralColor) as (keyof ColorValues)[];

export const defaultAdjust: AdjustParams = { ...neutralColor, preset: null, strength: 100 };

/** Manual values plus the active preset scaled by strength, clamped to each control's range. */
export function effectiveColor(p: AdjustParams): ColorValues {
  const preset = p.preset ? PRESET_BY_ID.get(p.preset) : undefined;
  const k = preset ? Math.max(0, Math.min(1, p.strength / 100)) : 0;
  const out = { ...neutralColor };
  for (const key of COLOR_KEYS) {
    const [lo, hi] = COLOR_RANGES[key];
    const v = (p[key] ?? 0) + (preset?.values[key] ?? 0) * k;
    out[key] = Math.max(lo, Math.min(hi, v));
  }
  return out;
}

export function isNeutral(c: ColorValues): boolean {
  return COLOR_KEYS.every((k) => c[k] === 0);
}

/** Applies colour values to a canvas. Uses WebGL when available, otherwise a CPU pass; soften is a canvas blur. */
export function applyColor(input: Canvas2D, c: ColorValues, frameIndex = 0): Canvas2D {
  let canvas = input;
  const w = canvas.width;
  const h = canvas.height;
  const needsPixels =
    c.exposure || c.brightness || c.contrast || c.highlights || c.shadows || c.fade || c.temperature || c.tint ||
    c.saturation || c.vibrance || c.hue || c.vignette || c.grain || c.sharpen;

  if (needsPixels) {
    const gpu = applyColorGl(canvas, c, frameIndex);
    if (gpu) {
      canvas = gpu;
    } else {
      const ctx = getCtx(canvas, { willReadFrequently: true });
      const img = ctx.getImageData(0, 0, w, h);
      processPixels(img.data, w, h, c, frameIndex);
      ctx.putImageData(img, 0, 0);
    }
  }

  if (c.soften > 0 && supportsCanvasFilter()) {
    const px = (c.soften * w) / 1000;
    const out = createCanvas(w, h);
    const octx = getCtx(out);
    octx.filter = `blur(${px.toFixed(2)}px)`;
    octx.drawImage(canvas, 0, 0);
    octx.filter = 'none';
    return out;
  }
  return canvas;
}

function buildLuts(c: ColorValues): { r: Uint8ClampedArray; g: Uint8ClampedArray; b: Uint8ClampedArray } {
  const exposure = Math.pow(2, (c.exposure / 100) * 2);
  const brightness = (c.brightness / 100) * 0.3;
  const contrast = Math.max(0.05, 1 + c.contrast / 100);
  const highlights = c.highlights / 100;
  const shadows = c.shadows / 100;
  const fade = (c.fade / 100) * 0.25;
  const t = c.temperature / 100;
  const tint = c.tint / 100;
  const mul = {
    r: (1 + t * 0.25) * (1 + tint * 0.08),
    g: 1 - tint * 0.2,
    b: (1 - t * 0.25) * (1 + tint * 0.08),
  };
  const tone = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    let x = v / 255;
    x *= exposure;
    x += brightness;
    x = (x - 0.5) * contrast + 0.5;
    x = Math.max(0, Math.min(1, x));
    x += shadows * x * (1 - x) * (1 - x); // lifts / deepens darks, leaves brights alone
    x += highlights * x * x * (1 - x); // brightens / recovers brights
    x = fade + x * (1 - fade);
    tone[v] = Math.max(0, Math.min(1, x));
  }
  const lut = (m: number) => {
    const out = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) out[v] = Math.round(Math.max(0, Math.min(1, tone[v] * m)) * 255);
    return out;
  };
  return { r: lut(mul.r), g: lut(mul.g), b: lut(mul.b) };
}

function hueMatrix(deg: number): number[] {
  const a = (deg * Math.PI) / 180;
  const cs = Math.cos(a);
  const sn = Math.sin(a);
  return [
    0.213 + 0.787 * cs - 0.213 * sn, 0.715 - 0.715 * cs - 0.715 * sn, 0.072 - 0.072 * cs + 0.928 * sn,
    0.213 - 0.213 * cs + 0.143 * sn, 0.715 + 0.285 * cs + 0.14 * sn, 0.072 - 0.072 * cs - 0.283 * sn,
    0.213 - 0.213 * cs - 0.787 * sn, 0.715 - 0.715 * cs + 0.715 * sn, 0.072 + 0.928 * cs + 0.072 * sn,
  ];
}

function processPixels(d: Uint8ClampedArray, w: number, h: number, c: ColorValues, frameIndex: number): void {
  const { r: lr, g: lg, b: lb } = buildLuts(c);
  const sat = c.saturation / 100;
  const vib = c.vibrance / 100;
  const doColor = sat !== 0 || vib !== 0;
  const hm = c.hue !== 0 ? hueMatrix(c.hue) : null;
  const vig = c.vignette / 100;
  const grain = (c.grain / 100) * 48;
  let seed = (frameIndex * 2654435761 + 12345) >>> 0;

  // Vignette: precomputed normalised squared distances per column / row.
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const nx2 = new Float32Array(w);
  const ny2 = new Float32Array(h);
  if (vig > 0) {
    for (let x = 0; x < w; x++) nx2[x] = ((x - cx) / (w / 2)) ** 2;
    for (let y = 0; y < h; y++) ny2[y] = ((y - cy) / (h / 2)) ** 2;
  }

  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      let r = lr[d[i]];
      let g = lg[d[i + 1]];
      let b = lb[d[i + 2]];

      if (doColor) {
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        let factor = 1 + sat;
        if (vib !== 0) {
          const mx = Math.max(r, g, b);
          const mn = Math.min(r, g, b);
          const s = mx > 0 ? (mx - mn) / mx : 0;
          factor *= 1 + vib * (1 - s);
        }
        r = luma + (r - luma) * factor;
        g = luma + (g - luma) * factor;
        b = luma + (b - luma) * factor;
      }
      if (hm) {
        const nr = hm[0] * r + hm[1] * g + hm[2] * b;
        const ng = hm[3] * r + hm[4] * g + hm[5] * b;
        const nb = hm[6] * r + hm[7] * g + hm[8] * b;
        r = nr;
        g = ng;
        b = nb;
      }
      if (vig > 0) {
        const d2 = nx2[x] + ny2[y];
        const f = 1 - vig * 0.9 * Math.max(0, Math.min(1, (d2 - 0.3) / 1.2));
        r *= f;
        g *= f;
        b *= f;
      }
      if (grain > 0) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const n = ((seed >>> 8) / 16777216 - 0.5) * grain;
        r += n;
        g += n;
        b += n;
      }
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
    }
  }

  if (c.sharpen > 0) sharpen(d, w, h, (c.sharpen / 100) * 0.7);
}

/** Cross-kernel unsharp mask. */
function sharpen(d: Uint8ClampedArray, w: number, h: number, amount: number): void {
  const src = new Uint8ClampedArray(d);
  const center = 1 + 4 * amount;
  const stride = w * 4;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const k = i + ch;
        d[k] = src[k] * center - amount * (src[k - 4] + src[k + 4] + src[k - stride] + src[k + stride]);
      }
    }
  }
}

export const adjustOperation: OperationHandler<AdjustParams> = registerOperation<AdjustParams>({
  type: ADJUST_TYPE,
  label: 'Colour',
  defaultParams: defaultAdjust,
  isIdentity: (p) => isNeutral(effectiveColor(p)),
  apply: (input, p, ctx) => applyColor(input, effectiveColor(p), ctx.frameIndex),
});
