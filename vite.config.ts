import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Use the onnxruntime-web build that loads its WASM from `ort.env.wasm.wasmPaths` (served from
    // /public/ort) instead of embedding a second 27 MB copy of the runtime in the bundle.
    conditions: ['onnxruntime-web-use-extern-wasm'],
  },
  server: {
    // Optional extra directory the dev server may serve via /@fs/ (used for local test media).
    fs: { allow: ['.', ...(process.env.MEDIABOX_FS_ALLOW ? [process.env.MEDIABOX_FS_ALLOW] : [])] },
  },
});
