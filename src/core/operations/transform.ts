import { createCanvas, getCtx, clamp } from '../canvas';
import { registerOperation } from '../registry';
import type { OperationHandler } from '../types';

export type Rotation = 0 | 90 | 180 | 270;

export interface TransformParams {
  rotate: Rotation;
  flipH: boolean;
  flipV: boolean;
  /** Crop insets as fractions (0..1) of the source dimensions. */
  crop: { left: number; top: number; right: number; bottom: number };
}

export const TRANSFORM_TYPE = 'transform';

export const defaultTransform: TransformParams = {
  rotate: 0,
  flipH: false,
  flipV: false,
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
};

function cropRect(w: number, h: number, p: TransformParams) {
  const left = clamp(p.crop.left, 0, 0.95);
  const top = clamp(p.crop.top, 0, 0.95);
  const right = clamp(p.crop.right, 0, 0.95 - left);
  const bottom = clamp(p.crop.bottom, 0, 0.95 - top);
  const sx = Math.round(w * left);
  const sy = Math.round(h * top);
  const sw = Math.max(1, Math.round(w * (1 - left - right)));
  const sh = Math.max(1, Math.round(h * (1 - top - bottom)));
  return { sx, sy, sw, sh };
}

export const transformOperation: OperationHandler<TransformParams> = registerOperation<TransformParams>({
  type: TRANSFORM_TYPE,
  label: 'Transform',
  defaultParams: defaultTransform,
  isIdentity: (p) =>
    p.rotate === 0 && !p.flipH && !p.flipV && !p.crop.left && !p.crop.top && !p.crop.right && !p.crop.bottom,
  outputSize: (w, h, p) => {
    const { sw, sh } = cropRect(w, h, p);
    return p.rotate % 180 === 0 ? { width: sw, height: sh } : { width: sh, height: sw };
  },
  apply: (input, p) => {
    const { sx, sy, sw, sh } = cropRect(input.width, input.height, p);
    const rotated = p.rotate % 180 !== 0;
    const ow = rotated ? sh : sw;
    const oh = rotated ? sw : sh;
    const out = createCanvas(ow, oh);
    const ctx = getCtx(out);
    ctx.translate(ow / 2, oh / 2);
    ctx.rotate((p.rotate * Math.PI) / 180);
    ctx.scale(p.flipH ? -1 : 1, p.flipV ? -1 : 1);
    ctx.drawImage(input, sx, sy, sw, sh, -sw / 2, -sh / 2, sw, sh);
    return out;
  },
});
