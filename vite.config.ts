import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
// Same cross-origin isolation headers Cloudflare Pages applies from public/_headers: enables
// multi-threaded WASM inference in dev and preview too.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  preview: { headers: isolationHeaders },
  resolve: {
    // Use the onnxruntime-web build that loads its WASM from `ort.env.wasm.wasmPaths` (served from
    // /public/ort) instead of embedding a second 27 MB copy of the runtime in the bundle.
    conditions: ['onnxruntime-web-use-extern-wasm'],
  },
  server: {
    headers: isolationHeaders,
    // Optional extra directory the dev server may serve via /@fs/ (used for local test media).
    fs: { allow: ['.', ...(process.env.MEDIABOX_FS_ALLOW ? [process.env.MEDIABOX_FS_ALLOW] : [])] },
  },
});
