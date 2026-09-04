/**
 * Shared onnxruntime-web configuration. ORT Web cannot execute two sessions concurrently
 * ("Session already started" corrupts the runtime), so every engine funnels its `session.run`
 * through this single queue.
 */
import * as ort from 'onnxruntime-web';
import { CallQueue } from './common';

const BASE = import.meta.env.BASE_URL;

// Runtime files are copied to /public/ort by scripts/setup-assets.mjs. An absolute (origin-qualified)
// URL is used on purpose: it keeps the dev server from rewriting the runtime's dynamic import().
ort.env.wasm.wasmPaths = new URL(`${BASE}ort/`, globalThis.location?.href ?? 'http://localhost/').href;
// The OpenCV Zoo exports trigger hundreds of benign "initializer appears in graph inputs" warnings.
ort.env.logLevel = 'error';

export const ortQueue = new CallQueue();

export async function createSession(model: ArrayBuffer, label: string): Promise<{ session: ort.InferenceSession; backend: string }> {
  const attempts: { backend: string; providers: ort.InferenceSession.ExecutionProviderConfig[] }[] = [];
  if (typeof navigator !== 'undefined' && 'gpu' in navigator) attempts.push({ backend: 'WebGPU', providers: ['webgpu'] });
  attempts.push({ backend: 'WASM', providers: ['wasm'] });
  let lastErr: unknown = null;
  for (const attempt of attempts) {
    try {
      const session = await ortQueue.run(() =>
        ort.InferenceSession.create(model, {
          executionProviders: attempt.providers,
          graphOptimizationLevel: 'all',
          // The native logger ignores ort.env.logLevel; without this every run prints benign warnings
          // (e.g. batch-size shape notes) with a full WASM stack trace.
          logSeverityLevel: 3,
        }),
      );
      return { session, backend: attempt.backend };
    } catch (err) {
      console.warn(`[faces/${label}] ${attempt.backend} unavailable`, err);
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('No ONNX execution provider available');
}

export { ort };
