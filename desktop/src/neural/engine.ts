/**
 * Neural face swap for the desktop build: InsightFace inswapper_128 driven by ArcFace (w600k_r50)
 * identity embeddings, run with onnxruntime-node in the Electron main process.
 *
 * Models are NOT bundled — they are downloaded into the user's data folder after the user accepts
 * their licence (non-commercial research use, see InsightFace). See models.ts.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as ort from 'onnxruntime-node';
import { findInitializer, listInitializers } from './onnxInitializer.js';

export const NEURAL_MODELS = [
  {
    file: 'arcface_w600k_r50.onnx',
    url: 'https://github.com/facefusion/facefusion-assets/releases/download/models-3.0.0/arcface_w600k_r50.onnx',
    size: 174388474,
    purpose: 'identity embedding (ArcFace ResNet-50)',
  },
  {
    file: 'inswapper_128.onnx',
    url: 'https://github.com/facefusion/facefusion-assets/releases/download/models-3.0.0/inswapper_128.onnx',
    size: 555303150,
    purpose: 'face swapper (InsightFace inswapper 128)',
  },
] as const;

export const EMBED_SIZE = 112;
export const SWAP_SIZE = 128;

export interface EngineStatus {
  modelsPresent: boolean;
  missing: string[];
  loaded: boolean;
  backend: string | null;
}

async function createSession(path: string): Promise<{ session: ort.InferenceSession; backend: string }> {
  const attempts: { backend: string; providers: string[] }[] = [];
  if (process.platform === 'darwin') attempts.push({ backend: 'CoreML', providers: ['coreml', 'cpu'] });
  if (process.platform === 'win32') attempts.push({ backend: 'DirectML', providers: ['dml', 'cpu'] });
  attempts.push({ backend: 'CPU', providers: ['cpu'] });
  let lastErr: unknown;
  for (const a of attempts) {
    try {
      const session = await ort.InferenceSession.create(path, {
        executionProviders: a.providers as ort.InferenceSession.ExecutionProviderConfig[],
        graphOptimizationLevel: 'all',
        logSeverityLevel: 3,
      });
      return { session, backend: a.backend };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('No execution provider available');
}

export class NeuralSwapEngine {
  private embedder: ort.InferenceSession | null = null;
  private swapper: ort.InferenceSession | null = null;
  private emap: Float32Array | null = null;
  private backend: string | null = null;
  private loading: Promise<void> | null = null;

  constructor(readonly modelDir: string) {}

  status(): EngineStatus {
    const missing = NEURAL_MODELS.filter((m) => !existsSync(join(this.modelDir, m.file))).map((m) => m.file);
    return { modelsPresent: missing.length === 0, missing, loaded: this.swapper !== null, backend: this.backend };
  }

  load(): Promise<void> {
    if (!this.loading) {
      this.loading = this.init().catch((err) => {
        this.loading = null;
        throw err;
      });
    }
    return this.loading;
  }

  private async init(): Promise<void> {
    const st = this.status();
    if (!st.modelsPresent) throw new Error(`Missing models: ${st.missing.join(', ')}`);
    const embedPath = join(this.modelDir, NEURAL_MODELS[0].file);
    const swapPath = join(this.modelDir, NEURAL_MODELS[1].file);
    // inswapper carries a 512×512 "emap" matrix that maps ArcFace embeddings into its latent space.
    // (It is the graph's last 512×512 initializer; InsightFace's reference code reads initializer[-1].)
    const bytes = new Uint8Array(await readFile(swapPath));
    const candidates = listInitializers(bytes).filter((t) => t.dims.length === 2 && t.dims[0] === 512 && t.dims[1] === 512);
    const emapName = candidates.at(-1)?.name;
    const emap = emapName !== undefined ? findInitializer(bytes, emapName) : null;
    if (!emap || emap.data.length !== 512 * 512) throw new Error('inswapper model has no emap initializer');
    this.emap = emap.data;
    const e = await createSession(embedPath);
    const s = await createSession(swapPath);
    this.embedder = e.session;
    this.swapper = s.session;
    this.backend = s.backend;
  }

  /**
   * Identity embedding for an aligned 112×112 face.
   * @param rgb NCHW float32, values in [-1, 1] (pixel / 127.5 - 1), RGB order.
   */
  async embed(rgb: Float32Array): Promise<Float32Array> {
    await this.load();
    const session = this.embedder!;
    const input = new ort.Tensor('float32', rgb, [1, 3, EMBED_SIZE, EMBED_SIZE]);
    const out = await session.run({ [session.inputNames[0]]: input });
    return new Float32Array(out[session.outputNames[0]].data as Float32Array);
  }

  /** Latent for inswapper: embedding · emap, L2-normalised. */
  latentFor(embedding: Float32Array): Float32Array {
    const emap = this.emap!;
    const latent = new Float32Array(512);
    for (let j = 0; j < 512; j++) {
      let acc = 0;
      for (let i = 0; i < 512; i++) acc += embedding[i] * emap[i * 512 + j];
      latent[j] = acc;
    }
    let norm = 0;
    for (let j = 0; j < 512; j++) norm += latent[j] * latent[j];
    norm = Math.sqrt(norm) || 1;
    for (let j = 0; j < 512; j++) latent[j] /= norm;
    return latent;
  }

  /**
   * Swaps the identity in an aligned 128×128 target face.
   * @param rgb NCHW float32 in [0, 1], RGB order.
   * @returns NCHW float32 in [0, 1], RGB order (128×128).
   */
  async swap(rgb: Float32Array, embedding: Float32Array): Promise<Float32Array> {
    await this.load();
    const session = this.swapper!;
    const latent = this.latentFor(embedding);
    const feeds: Record<string, ort.Tensor> = {};
    for (const name of session.inputNames) {
      if (/source/i.test(name)) feeds[name] = new ort.Tensor('float32', latent, [1, 512]);
      else feeds[name] = new ort.Tensor('float32', rgb, [1, 3, SWAP_SIZE, SWAP_SIZE]);
    }
    const out = await session.run(feeds);
    return new Float32Array(out[session.outputNames[0]].data as Float32Array);
  }
}
