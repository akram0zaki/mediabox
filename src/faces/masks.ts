/** Mask renderers. Each style fills a face region; a shape mask with optional feathering is then applied. */
import { createCanvas, getCtx, clamp, lerp, supportsCanvasFilter, type Canvas2D } from '../core/canvas';
import type { FaceBox } from './common';

export type MaskStyle = 'blur' | 'pixelate' | 'solid' | 'emoji' | 'swap';
export type MaskShape = 'ellipse' | 'rect';

export interface MaskRenderParams {
  style: MaskStyle;
  shape: MaskShape;
  /** Multiplier applied to the detected face box (1 = detector box, 2 = twice as large). */
  sizeScale: number;
  /** 0..100 – blur radius, pixel block size, or solid opacity depending on style. */
  intensity: number;
  /** 0..100 – edge softness. */
  feather: number;
  color: string;
  emoji: string;
}

export interface MaskRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Expands the detector box into the region that will actually be masked. */
export function maskRegionFor(face: FaceBox, sizeScale: number, canvasW: number, canvasH: number): MaskRegion {
  const cx = face.x + face.w / 2;
  // BlazeFace boxes stop at the forehead; bias upward so hair/forehead are covered.
  const cy = face.y + face.h / 2 - face.h * 0.06;
  const w = face.w * sizeScale;
  const h = face.h * sizeScale * 1.18;
  const x0 = clamp(cx - w / 2, 0, canvasW);
  const y0 = clamp(cy - h / 2, 0, canvasH);
  const x1 = clamp(cx + w / 2, 0, canvasW);
  const y1 = clamp(cy + h / 2, 0, canvasH);
  return { x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(x1 - x0), h: Math.ceil(y1 - y0) };
}

/** Applies masks for all faces directly onto `canvas`. */
export function drawFaceMasks(canvas: Canvas2D, faces: FaceBox[], p: MaskRenderParams): void {
  if (faces.length === 0) return;
  const ctx = getCtx(canvas);
  const t = clamp(p.intensity, 0, 100) / 100;
  const hasFilter = supportsCanvasFilter();

  for (const face of faces) {
    const r = maskRegionFor(face, p.sizeScale, canvas.width, canvas.height);
    if (r.w < 2 || r.h < 2) continue;

    // 1. Render the obscured content for this region into a temp canvas.
    const layer = createCanvas(r.w, r.h);
    const lctx = getCtx(layer);
    const faceSize = Math.max(r.w, r.h);

    switch (p.style) {
      case 'swap': // handled by the face-mask operation; reaching here means fallback
      case 'blur': {
        const radius = Math.max(1, lerp(faceSize * 0.03, faceSize * 0.35, t));
        if (hasFilter) {
          // Pad the source so the blur doesn't fade to transparent at the region edges.
          const pad = Math.ceil(radius * 3);
          const sx = Math.max(0, r.x - pad);
          const sy = Math.max(0, r.y - pad);
          const sw = Math.min(canvas.width, r.x + r.w + pad) - sx;
          const sh = Math.min(canvas.height, r.y + r.h + pad) - sy;
          const padded = createCanvas(sw, sh);
          const pctx = getCtx(padded);
          pctx.filter = `blur(${radius}px)`;
          pctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
          pctx.filter = 'none';
          lctx.drawImage(padded, r.x - sx, r.y - sy, r.w, r.h, 0, 0, r.w, r.h);
        } else {
          // Fallback: multi-pass downscale/upscale approximates a blur.
          drawDownscaled(lctx, canvas, r, Math.max(2, radius / 2));
        }
        break;
      }
      case 'pixelate': {
        const block = Math.max(2, lerp(faceSize / 40, faceSize / 4, t));
        drawDownscaled(lctx, canvas, r, block);
        break;
      }
      case 'solid': {
        lctx.globalAlpha = lerp(0.35, 1, t);
        lctx.fillStyle = p.color || '#000';
        lctx.fillRect(0, 0, r.w, r.h);
        lctx.globalAlpha = 1;
        break;
      }
      case 'emoji': {
        // Keep the original pixels underneath at low intensity, cover fully at high intensity.
        lctx.drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
        const size = Math.min(r.w, r.h) * 0.95;
        lctx.font = `${size}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
        lctx.textAlign = 'center';
        lctx.textBaseline = 'middle';
        lctx.globalAlpha = lerp(0.6, 1, t);
        lctx.fillText(p.emoji || '🙂', r.w / 2, r.h / 2 + size * 0.05);
        lctx.globalAlpha = 1;
        break;
      }
    }

    // 2. Cut the layer to the chosen shape (with feathered edges) and composite it.
    if (p.style !== 'emoji') {
      const featherPx = (clamp(p.feather, 0, 100) / 100) * Math.min(r.w, r.h) * 0.2;
      const shape = createCanvas(r.w, r.h);
      const sctx = getCtx(shape);
      if (featherPx > 0.5 && hasFilter) sctx.filter = `blur(${featherPx / 2}px)`;
      sctx.fillStyle = '#fff';
      const inset = featherPx > 0.5 && hasFilter ? featherPx : 0;
      pathForShape(sctx, p.shape, inset, inset, r.w - inset * 2, r.h - inset * 2);
      sctx.fill();
      sctx.filter = 'none';
      lctx.globalCompositeOperation = 'destination-in';
      lctx.drawImage(shape, 0, 0);
      lctx.globalCompositeOperation = 'source-over';
    }
    ctx.drawImage(layer, r.x, r.y);
  }
}

function pathForShape(ctx: ReturnType<typeof getCtx>, shape: MaskShape, x: number, y: number, w: number, h: number) {
  ctx.beginPath();
  if (shape === 'ellipse') {
    ctx.ellipse(x + w / 2, y + h / 2, Math.max(0.5, w / 2), Math.max(0.5, h / 2), 0, 0, Math.PI * 2);
  } else {
    const radius = Math.min(w, h) * 0.12;
    ctx.roundRect(x, y, Math.max(1, w), Math.max(1, h), radius);
  }
  ctx.closePath();
}

/** Draws a region through a tiny intermediate canvas with nearest-neighbour upscaling. */
function drawDownscaled(lctx: ReturnType<typeof getCtx>, source: Canvas2D, r: MaskRegion, block: number) {
  const sw = Math.max(1, Math.round(r.w / block));
  const sh = Math.max(1, Math.round(r.h / block));
  const small = createCanvas(sw, sh);
  const sctx = getCtx(small);
  sctx.imageSmoothingEnabled = true;
  sctx.drawImage(source, r.x, r.y, r.w, r.h, 0, 0, sw, sh);
  lctx.imageSmoothingEnabled = false;
  lctx.drawImage(small, 0, 0, sw, sh, 0, 0, r.w, r.h);
  lctx.imageSmoothingEnabled = true;
}

/** Overlay: outlines of detected faces, coloured by what will happen to them. */
export interface OverlayFace {
  box: FaceBox;
  kept: boolean;
  label?: string;
}

export function drawFaceBoxes(canvas: Canvas2D, faces: OverlayFace[], sizeScale: number): void {
  const ctx = getCtx(canvas);
  const lw = Math.max(1, Math.round(Math.max(canvas.width, canvas.height) / 600));
  const fontPx = Math.max(11, lw * 9);
  ctx.lineWidth = lw;
  ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
  ctx.textBaseline = 'bottom';
  for (const { box: f, kept, label } of faces) {
    const color = kept ? 'rgba(96, 165, 250, 0.95)' : 'rgba(80, 230, 140, 0.95)';
    ctx.strokeStyle = color;
    ctx.strokeRect(f.x, f.y, f.w, f.h);
    if (!kept) {
      const r = maskRegionFor(f, sizeScale, canvas.width, canvas.height);
      ctx.strokeStyle = 'rgba(255, 200, 60, 0.8)';
      ctx.setLineDash([lw * 4, lw * 3]);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([]);
    }
    const text = label ?? (kept ? 'keep' : `${Math.round(f.score * 100)}%`);
    const tw = ctx.measureText(text).width + lw * 6;
    const ty = Math.max(fontPx + lw * 2, f.y - lw * 2);
    ctx.fillStyle = kept ? 'rgba(37, 99, 235, 0.85)' : 'rgba(5, 46, 31, 0.8)';
    ctx.fillRect(f.x, ty - fontPx - lw * 2, tw, fontPx + lw * 2);
    ctx.fillStyle = kept ? '#fff' : 'rgba(110, 231, 183, 1)';
    ctx.fillText(text, f.x + lw * 3, ty);
  }
}

// ---------- mesh face swap ----------
import { faceOval, meshBounds, type Mesh } from './landmarker';
import { warpFace } from './swap/warp';

export interface SwapRender {
  sourceId: string;
  bitmap: ImageBitmap;
  sourceMesh: Mesh;
}

const SAMPLE = 24;

function ovalPath(ctx: ReturnType<typeof getCtx>, mesh: Mesh, ox: number, oy: number, sx = 1, sy = 1, inset = 0) {
  const oval = faceOval();
  // Shrink towards the centroid by `inset` pixels (approximate) for feathering.
  let cx = 0, cy = 0;
  for (const i of oval) {
    cx += mesh[i * 2];
    cy += mesh[i * 2 + 1];
  }
  cx /= oval.length;
  cy /= oval.length;
  ctx.beginPath();
  oval.forEach((i, n) => {
    let x = mesh[i * 2];
    let y = mesh[i * 2 + 1];
    if (inset > 0) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy) || 1;
      const k = Math.max(0, d - inset) / d;
      x = cx + dx * k;
      y = cy + dy * k;
    }
    const px = (x - ox) * sx;
    const py = (y - oy) * sy;
    if (n === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
}

/** Mean RGB of `img` inside the face oval, sampled at low resolution. */
function meanInOval(img: CanvasImageSource, region: { x: number; y: number; w: number; h: number }, mesh: Mesh, fromRegion: boolean): [number, number, number] {
  const c = createCanvas(SAMPLE, SAMPLE);
  const ctx = getCtx(c, { willReadFrequently: true });
  ovalPath(ctx, mesh, region.x, region.y, SAMPLE / region.w, SAMPLE / region.h);
  ctx.clip();
  if (fromRegion) ctx.drawImage(img, region.x, region.y, region.w, region.h, 0, 0, SAMPLE, SAMPLE);
  else ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
  const d = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    r += d[i];
    g += d[i + 1];
    b += d[i + 2];
    n++;
  }
  return n ? [r / n, g / n, b / n] : [128, 128, 128];
}

/**
 * Replaces the face described by `targetMesh` with the source face: mesh warp, colour match,
 * feathered oval blend. Returns false (nothing drawn) when the warp is unavailable.
 */
export function drawFaceSwap(canvas: Canvas2D, targetMesh: Mesh, swap: SwapRender, feather: number): boolean {
  const b = meshBounds(targetMesh, faceOval());
  const pad = Math.max(2, Math.max(b.w, b.h) * 0.12);
  const x0 = Math.max(0, Math.floor(b.x - pad));
  const y0 = Math.max(0, Math.floor(b.y - pad));
  const x1 = Math.min(canvas.width, Math.ceil(b.x + b.w + pad));
  const y1 = Math.min(canvas.height, Math.ceil(b.y + b.h + pad));
  const region = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  if (region.w < 4 || region.h < 4) return false;

  const base = { sourceId: swap.sourceId, source: swap.bitmap, sourceMesh: swap.sourceMesh, targetMesh, region };
  const first = warpFace(base);
  if (!first) return false;

  // Match the source's skin tone/lighting to the target's.
  const tm = meanInOval(canvas, region, targetMesh, true);
  const sm = meanInOval(first, region, targetMesh, false);
  const gain = tm.map((t, i) => clamp(t / Math.max(1, sm[i]), 0.5, 2)) as [number, number, number];
  const warped = warpFace({ ...base, gain }) ?? first;

  // Feathered oval mask.
  const featherPx = (clamp(feather, 0, 100) / 100) * Math.min(b.w, b.h) * 0.14;
  const mask = createCanvas(region.w, region.h);
  const mctx = getCtx(mask);
  if (featherPx > 0.5 && supportsCanvasFilter()) mctx.filter = `blur(${featherPx / 2}px)`;
  mctx.fillStyle = '#fff';
  ovalPath(mctx, targetMesh, region.x, region.y, 1, 1, featherPx);
  mctx.fill();
  mctx.filter = 'none';

  const wctx = getCtx(warped);
  wctx.globalCompositeOperation = 'destination-in';
  wctx.drawImage(mask, 0, 0);
  wctx.globalCompositeOperation = 'source-over';
  getCtx(canvas).drawImage(warped, region.x, region.y);
  return true;
}
