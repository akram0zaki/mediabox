/** Downloads the neural-swap models into the app's data folder, reporting progress. */
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { NEURAL_MODELS } from './engine.js';

export interface DownloadProgress {
  file: string;
  received: number;
  total: number;
  /** Overall fraction across all models. */
  overall: number;
}

export async function downloadModels(dir: string, onProgress: (p: DownloadProgress) => void, signal?: AbortSignal): Promise<void> {
  await mkdir(dir, { recursive: true });
  const totalAll = NEURAL_MODELS.reduce((a, m) => a + m.size, 0);
  let doneBefore = 0;
  for (const m of NEURAL_MODELS) {
    const dest = join(dir, m.file);
    const existing = await stat(dest).catch(() => null);
    if (existing && existing.size === m.size) {
      doneBefore += m.size;
      onProgress({ file: m.file, received: m.size, total: m.size, overall: doneBefore / totalAll });
      continue;
    }
    const res = await fetch(m.url, { signal });
    if (!res.ok || !res.body) throw new Error(`Download failed for ${m.file} (${res.status})`);
    const tmp = `${dest}.part`;
    let received = 0;
    const progress = new TransformStreamCounter((n) => {
      received += n;
      onProgress({ file: m.file, received, total: m.size, overall: (doneBefore + received) / totalAll });
    });
    try {
      await pipeline(Readable.fromWeb(res.body as never), progress.stream, createWriteStream(tmp), { signal });
      await rename(tmp, dest);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    doneBefore += m.size;
  }
}

class TransformStreamCounter {
  readonly stream: Transform;
  constructor(onChunk: (n: number) => void) {
    this.stream = new Transform({
      transform(chunk, _enc, cb) {
        onChunk(chunk.length);
        cb(null, chunk);
      },
    });
  }
}
