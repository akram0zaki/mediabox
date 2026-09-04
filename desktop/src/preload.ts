import { contextBridge, ipcRenderer } from 'electron';

const api = {
  platform: process.platform,
  version: (): Promise<string> => ipcRenderer.invoke('app:version'),
  neural: {
    status: () => ipcRenderer.invoke('neural:status'),
    downloadModels: () => ipcRenderer.invoke('neural:download'),
    cancelDownload: () => ipcRenderer.invoke('neural:cancelDownload'),
    load: () => ipcRenderer.invoke('neural:load'),
    embed: (rgb: Float32Array) => ipcRenderer.invoke('neural:embed', rgb),
    swap: (rgb: Float32Array, embedding: Float32Array) => ipcRenderer.invoke('neural:swap', rgb, embedding),
    onDownloadProgress: (cb: (p: unknown) => void) => {
      const handler = (_e: unknown, p: unknown) => cb(p);
      ipcRenderer.on('neural:progress', handler);
      return () => ipcRenderer.removeListener('neural:progress', handler);
    },
  },
};

contextBridge.exposeInMainWorld('mediaboxDesktop', api);
export type DesktopApi = typeof api;
