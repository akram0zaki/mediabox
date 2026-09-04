/** Canvas helpers shared by the preview and export paths. */

export type Canvas2D = HTMLCanvasElement | OffscreenCanvas;
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function createCanvas(width: number, height: number): Canvas2D {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function getCtx(canvas: Canvas2D, settings?: CanvasRenderingContext2DSettings): Ctx2D {
  const ctx = canvas.getContext('2d', settings) as Ctx2D | null;
  if (!ctx) throw new Error('Could not acquire a 2D canvas context');
  return ctx;
}

let filterSupport: boolean | null = null;
/** Whether `ctx.filter` (CSS filters on canvas) is supported by this browser. */
export function supportsCanvasFilter(): boolean {
  if (filterSupport !== null) return filterSupport;
  try {
    const ctx = getCtx(createCanvas(1, 1));
    filterSupport = 'filter' in ctx;
  } catch {
    filterSupport = false;
  }
  return filterSupport;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export async function canvasToBlob(canvas: Canvas2D, type: string, quality?: number): Promise<Blob> {
  if (canvas instanceof HTMLCanvasElement) {
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), type, quality),
    );
  }
  return canvas.convertToBlob({ type, quality });
}
