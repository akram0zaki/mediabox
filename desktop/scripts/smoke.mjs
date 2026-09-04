// Launches the built desktop app with a hidden window and runs an in-page check via the main process.
// Usage: node desktop/scripts/smoke.mjs   (set MEDIABOX_MODEL_DIR to test the neural engine with local models)
import { spawn } from 'node:child_process';
import electron from 'electron';

const script = `
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !(document.querySelector('.dropzone-samples') && window.__mediabox); i++) await wait(250);
  const out = { title: document.title, desktop: !!window.mediaboxDesktop, dev: !!window.__mediabox };
  const btn = [...document.querySelectorAll('.dropzone-samples button')].find((b) => /photo/.test(b.textContent));
  btn.click();
  for (let i = 0; i < 120; i++) { await wait(500); if (/ready/.test(document.querySelector('.status')?.textContent || '')) break; }
  await wait(3000);
  out.status = document.querySelector('.status')?.textContent;
  out.neural = await window.mediaboxDesktop.neural.status();
  if (out.neural.modelsPresent) {
    const t0 = performance.now();
    await window.mediaboxDesktop.neural.load();
    out.neuralLoadMs = Math.round(performance.now() - t0);
    const emb = await window.mediaboxDesktop.neural.embed(new Float32Array(3 * 112 * 112).fill(0.1));
    const t1 = performance.now();
    const sw = await window.mediaboxDesktop.neural.swap(new Float32Array(3 * 128 * 128).fill(0.5), emb);
    out.neuralSwapMs = Math.round(performance.now() - t1);
    out.embLen = emb.length; out.swapLen = sw.length;
  }
  return JSON.stringify(out);
`;

const child = spawn(electron, ['.'], {
  env: { ...process.env, MEDIABOX_SMOKE: '1', MEDIABOX_SMOKE_SCRIPT: script, ELECTRON_ENABLE_LOGGING: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));
const timer = setTimeout(() => {
  console.error('smoke: timeout');
  child.kill();
  process.exit(1);
}, 180000);
child.on('exit', (code) => {
  clearTimeout(timer);
  const line = out.split('\n').find((l) => l.startsWith('SMOKE_RESULT'));
  console.log(line ?? out.slice(-2000));
  process.exit(line ? 0 : code ?? 1);
});
