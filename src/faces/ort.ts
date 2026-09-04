/**
 * Shared onnxruntime-web configuration. ORT Web cannot execute two sessions concurrently
 * ("Session already started" corrupts the runtime), so every engine funnels its `session.run`
 * through this single queue.
 */
import * as ort from 'onnxruntime-web';
import { CallQueue } from './common';

const BASE = import.meta.env.BASE_URL;

// Runtime files are copied to /public/ort by scripts/setup-assets.mjs. Absolute (origin-qualified)
// URLs are used on purpose: they keep the dev server from rewriting the runtime's dynamic import().
const ORT_DIR = new URL(`${BASE}ort/`, globalThis.location?.href ?? 'http://localhost/').href;
const ORT_RUNTIME = 'ort-wasm-simd-threaded.jsep'; // one build serves both the WebGPU and WASM providers
// The OpenCV Zoo exports trigger hundreds of benign "initializer appears in graph inputs" warnings.
ort.env.logLevel = 'error';

export const ortQueue = new CallQueue();

let wasmReady: Promise<void> | null = null;
/**
 * Points ORT at its runtime. Production builds split the 26 MB WebGPU .wasm into parts (see
 * scripts/split-large-assets.mjs) because static hosts cap file sizes; they are fetched and
 * reassembled into a Blob here. Dev and desktop builds serve the whole file directly.
 */
function prepareRuntime(): Promise<void> {
  if (!wasmReady) {
    wasmReady = (async () => {
      const mjs = `${ORT_DIR}${ORT_RUNTIME}.mjs`;
      const manifest = await fetch(`${ORT_DIR}${ORT_RUNTIME}.wasm.parts.json`).catch(() => null);
      if (manifest?.ok) {
        const { parts } = (await manifest.json()) as { parts: number };
        const chunks = await Promise.all(
          Array.from({ length: parts }, (_, i) =>
            fetch(`${ORT_DIR}${ORT_RUNTIME}.wasm.part${i}`).then((r) => {
              if (!r.ok) throw new Error(`Failed to fetch ONNX runtime part ${i} (${r.status})`);
              return r.arrayBuffer();
            }),
          ),
        );
        const blob = new Blob(chunks, { type: 'application/wasm' });
        ort.env.wasm.wasmPaths = { mjs, wasm: URL.createObjectURL(blob) };
      } else {
        ort.env.wasm.wasmPaths = { mjs, wasm: `${ORT_DIR}${ORT_RUNTIME}.wasm` };
      }
    })();
  }
  return wasmReady;
}

export async function createSession(model: ArrayBuffer, label: string): Promise<{ session: ort.InferenceSession; backend: string }> {
  await prepareRuntime();
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
