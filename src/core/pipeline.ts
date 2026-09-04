import { createCanvas, getCtx, type Canvas2D } from './canvas';
import { getOperation } from './registry';
import type { FrameContext, Operation } from './types';

export type PipelineContext = Omit<FrameContext, 'width' | 'height'>;

/**
 * Draws `source` at the requested size and runs every enabled operation over it, in order.
 * Works identically for still images, preview frames and export frames.
 */
export async function renderPipeline(
  source: CanvasImageSource,
  width: number,
  height: number,
  ops: Operation[],
  ctx: PipelineContext,
): Promise<Canvas2D> {
  let canvas = createCanvas(width, height);
  getCtx(canvas).drawImage(source, 0, 0, canvas.width, canvas.height);

  // Each stage's cache key covers the source frame *and* every upstream operation's params,
  // so cached analysis (e.g. detected faces) is never reused across a different crop/rotation.
  let upstream = `${width}x${height}`;
  for (const op of ops) {
    if (!op.enabled) continue;
    const handler = getOperation(op.type);
    if (!handler) continue;
    if (handler.isIdentity?.(op.params)) continue;
    if (ctx.signal?.aborted) throw new DOMException('Render aborted', 'AbortError');
    const cacheKey = ctx.cacheKey ? `${ctx.cacheKey}|${upstream}` : undefined;
    canvas = await handler.apply(canvas, op.params, { ...ctx, cacheKey, width: canvas.width, height: canvas.height });
    upstream += `|${op.type}:${JSON.stringify(op.params)}`;
  }
  return canvas;
}

/** Final output size of the pipeline for a given source size. */
export function pipelineOutputSize(width: number, height: number, ops: Operation[]): { width: number; height: number } {
  let size = { width, height };
  for (const op of ops) {
    if (!op.enabled) continue;
    const handler = getOperation(op.type);
    if (!handler?.outputSize || handler.isIdentity?.(op.params)) continue;
    size = handler.outputSize(size.width, size.height, op.params);
  }
  return size;
}

/** Copies a rendered canvas onto a visible canvas element, resizing it if needed. */
export function presentTo(target: HTMLCanvasElement, result: Canvas2D): void {
  if (target.width !== result.width || target.height !== result.height) {
    target.width = result.width;
    target.height = result.height;
  }
  const ctx = target.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, target.width, target.height);
  ctx.drawImage(result, 0, 0);
}
