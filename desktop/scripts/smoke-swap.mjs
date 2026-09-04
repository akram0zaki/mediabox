// End-to-end neural swap through the app's real pipeline inside Electron. Writes the export to MEDIABOX_SMOKE_OUT.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import electron from 'electron';

// Optional portrait used as the substitute face (defaults to the largest face in the sample photo).
const sourceB64 = process.env.MEDIABOX_SMOKE_SOURCE ? readFileSync(process.env.MEDIABOX_SMOKE_SOURCE).toString('base64') : '';

const script = `
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !(document.querySelector('.dropzone-samples') && window.__mediabox); i++) await wait(250);
  const { useEditor, onFrameFaces, buildSwapSource, exportImage, buildOperations, loadNeural, faceDetection } = window.__mediabox;
  const sourceB64 = ${JSON.stringify(sourceB64)};
  let last = null; onFrameFaces((e) => { if (e.mode === 'preview') last = e; });
  [...document.querySelectorAll('.dropzone-samples button')].find((b) => /photo/.test(b.textContent)).click();
  for (let i = 0; i < 120; i++) { await wait(500); if (/ready/.test(document.querySelector('.status')?.textContent || '')) break; }
  for (let i = 0; i < 40; i++) { await wait(500); if (last) break; }
  const s = useEditor.getState();
  // Substitute face: the largest face in the photo, taken from the full-resolution bitmap.
  const k = s.asset.width / last.width;
  const largest = [...last.faces].sort((a, b) => b.box.w - a.box.w)[0].box;
  const full = new OffscreenCanvas(s.asset.width, s.asset.height); full.getContext('2d').drawImage(s.asset.bitmap, 0, 0);
  let src;
  if (sourceB64) {
    const bmp = await createImageBitmap(await fetch('data:image/jpeg;base64,' + sourceB64).then((r) => r.blob()));
    const c = new OffscreenCanvas(bmp.width, bmp.height); c.getContext('2d').drawImage(bmp, 0, 0);
    const f = (await faceDetection.detect(c, { engine: 'yunet', minConfidence: 0.5, analysisSize: 1280, mode: 'fast' })).sort((a, b) => b.w - a.w)[0];
    src = await buildSwapSource(c, f, 'portrait');
  } else {
    src = await buildSwapSource(full, { ...largest, x: largest.x * k, y: largest.y * k, w: largest.w * k, h: largest.h * k }, 'test');
  }
  useEditor.getState().addSwapSource(src, true);
  useEditor.getState().setFaceMask({ style: 'swap', swapEngine: 'neural', maskMode: 'all', showBoxes: false });
  const ready = await loadNeural();
  const st = await window.mediaboxDesktop.neural.status();
  await wait(4000);
  const t0 = performance.now();
  const blob = await exportImage(useEditor.getState().asset, buildOperations(useEditor.getState()), 'jpeg', 0.9);
  const exportMs = Math.round(performance.now() - t0);
  const dataUrl = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
  return JSON.stringify({ neural: st, ready, faces: last.faces.length, exportMs, bytes: blob.size, imageDataUrl: dataUrl });
`;
const child = spawn(electron, ['.'], { env: { ...process.env, MEDIABOX_SMOKE: '1', MEDIABOX_SMOKE_SCRIPT: script }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));
const timer = setTimeout(() => { console.error('smoke: timeout'); child.kill(); process.exit(1); }, 300000);
child.on('exit', (code) => {
  clearTimeout(timer);
  const line = out.split('\n').find((l) => l.startsWith('SMOKE_RESULT'));
  console.log(line ?? out.slice(-3000));
  process.exit(line ? 0 : code ?? 1);
});
