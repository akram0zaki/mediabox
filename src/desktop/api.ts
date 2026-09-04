/** Bridge exposed by the Electron preload (desktop build only). */
export interface NeuralStatus {
  modelsPresent: boolean;
  missing: string[];
  loaded: boolean;
  backend: string | null;
}

export interface DownloadProgress {
  file: string;
  received: number;
  total: number;
  overall: number;
}

export interface DesktopApi {
  platform: string;
  version(): Promise<string>;
  neural: {
    status(): Promise<NeuralStatus>;
    downloadModels(): Promise<NeuralStatus>;
    cancelDownload(): Promise<void>;
    load(): Promise<NeuralStatus>;
    embed(rgb: Float32Array): Promise<Float32Array>;
    swap(rgb: Float32Array, embedding: Float32Array): Promise<Float32Array>;
    onDownloadProgress(cb: (p: DownloadProgress) => void): () => void;
  };
}

export function desktopApi(): DesktopApi | null {
  return (window as unknown as { mediaboxDesktop?: DesktopApi }).mediaboxDesktop ?? null;
}

export function isDesktop(): boolean {
  return desktopApi() !== null;
}
