import { app, BrowserWindow, ipcMain, net, protocol, shell } from 'electron';
import { join, dirname, normalize } from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NeuralSwapEngine } from './neural/engine.js';
import { downloadModels } from './neural/models.js';

const here = dirname(fileURLToPath(import.meta.url));
/** Built web app (vite build → dist/). */
const distDir = join(here, '..', '..', 'dist');
const SMOKE = process.env.MEDIABOX_SMOKE === '1';

// The web app is served from a privileged custom scheme so module scripts, fetch() of WASM/models
// and dynamic import() all behave like on a normal origin (file:// would block several of them).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let engine: NeuralSwapEngine;
let downloadAbort: AbortController | null = null;

function modelDir(): string {
  return process.env.MEDIABOX_MODEL_DIR || join(app.getPath('userData'), 'models');
}

function registerIpc(win: BrowserWindow) {
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('neural:status', () => engine.status());
  ipcMain.handle('neural:load', async () => {
    await engine.load();
    return engine.status();
  });
  ipcMain.handle('neural:download', async () => {
    if (downloadAbort) throw new Error('Download already in progress');
    downloadAbort = new AbortController();
    try {
      await downloadModels(modelDir(), (p) => win.webContents.send('neural:progress', p), downloadAbort.signal);
    } finally {
      downloadAbort = null;
    }
    return engine.status();
  });
  ipcMain.handle('neural:cancelDownload', () => {
    downloadAbort?.abort();
  });
  ipcMain.handle('neural:embed', (_e, rgb: Float32Array) => engine.embed(rgb));
  ipcMain.handle('neural:swap', (_e, rgb: Float32Array, embedding: Float32Array) => engine.swap(rgb, embedding));
}

async function createWindow() {
  engine = new NeuralSwapEngine(modelDir());
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    let path = decodeURIComponent(url.pathname);
    if (path === '/' || path === '') path = '/index.html';
    const file = normalize(join(distDir, path));
    if (!file.startsWith(distDir)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 380,
    minHeight: 600,
    show: !SMOKE,
    backgroundColor: '#0f1115',
    title: 'MediaBox',
    webPreferences: {
      preload: join(here, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  registerIpc(win);
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  await win.loadURL(SMOKE ? 'app://mediabox/index.html?devtools' : 'app://mediabox/index.html');

  if (SMOKE) {
    const script = process.env.MEDIABOX_SMOKE_SCRIPT ?? 'JSON.stringify({ title: document.title })';
    try {
      const result = await win.webContents.executeJavaScript(`(async () => { ${script} })()`, true);
      // A returned { imageDataUrl } is written to MEDIABOX_SMOKE_OUT for inspection.
      const parsed = typeof result === 'string' ? (JSON.parse(result) as { imageDataUrl?: string }) : (result as { imageDataUrl?: string });
      if (parsed?.imageDataUrl && process.env.MEDIABOX_SMOKE_OUT) {
        writeFileSync(process.env.MEDIABOX_SMOKE_OUT, Buffer.from(parsed.imageDataUrl.split(',')[1], 'base64'));
        parsed.imageDataUrl = `(written to ${process.env.MEDIABOX_SMOKE_OUT})`;
      }
      console.log('SMOKE_RESULT ' + JSON.stringify(parsed));
      app.exit(0);
    } catch (err) {
      console.error('SMOKE_ERROR', err);
      app.exit(1);
    }
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || SMOKE) app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
