# AGENTS.md

Guidance for AI coding agents (and new contributors) working in this repository. The README explains *what* MediaBox is; this file explains *how to work on it* without breaking its promises.

## The one rule

MediaBox's whole point is privacy: media, faces, embeddings and the people list never leave the user's device. Do not add analytics, remote logging, uploads, or any network call that carries user data. The only network traffic allowed is downloading models and the app's own static assets.

## Quick orientation

- Web app: Vite + React + TypeScript in `src/`. Zustand store in `src/state/store.ts`.
- Desktop app: Electron in `desktop/src/` (main, preload, native neural engine), compiled with `tsconfig.desktop.json` to `desktop/dist/`.
- Package manager: **pnpm** (see `packageManager` in `package.json`). Do not use npm or yarn.
- Node 20+. `pnpm install` also runs `scripts/setup-assets.mjs`, which copies WASM runtimes into `public/` and downloads the detection/recognition models. Those folders are git-ignored on purpose; never commit them.

## Commands

```bash
pnpm dev                 # dev server (use --port if 5173 is taken)
pnpm build               # tsc -b && vite build → dist/
pnpm lint                # oxlint over src/ and desktop/src/
pnpm desktop:check       # type-check the Electron code
pnpm desktop:start       # build everything and launch the desktop app
pnpm desktop:smoke       # hidden-window end-to-end check of the built desktop app
pnpm desktop:dist[:win|:mac|:linux]   # installers into release/
```

CI (`.github/workflows/ci.yml`) runs install, lint, build and desktop:check. Keep all four green before opening a PR.

## Architecture in one paragraph

Everything visual goes through `renderPipeline()` in `src/core/pipeline.ts`: a source frame is drawn to a canvas, then each enabled *operation* (`src/core/operations/`: transform → faceMask → adjust) transforms it. The same pipeline renders stills, preview frames and export frames, so a change to an operation automatically applies everywhere. Operations receive a `FrameContext` (timestamp, `sequenceId` for temporal state, `cacheKey` for stills, `realtime` hint during playback). Face work lives in `src/faces/`: two detectors behind `detector.ts`, a recogniser, a tracker, mask renderers, the face-mesh landmarker, and the swap engines. Video decode/encode is mediabunny + WebCodecs (`src/media/`), with `<video>`/MediaRecorder fallbacks.

## Adding things

- **New editing feature**: new file in `src/core/operations/` calling `registerOperation({...})`; export it from `operations/index.ts`; add params to the store and to `buildOperations()` (array order = application order); add a panel under `src/ui/panels/` and a tab in `src/ui/Sidebar.tsx`. Prefer zero-centred params so presets can layer on top (see `adjust.ts`).
- **New model / engine**: put the download in `scripts/setup-assets.mjs` (or the desktop model manager for large native models), expose a `load()` + `status` like the existing engines, and run **every** onnxruntime-web call through `ortQueue` in `src/faces/ort.ts` — ORT Web cannot run two sessions concurrently and corrupts itself if you try.
- **Anything that persists**: localStorage only, with a versioned key (`mediabox.<thing>.v1`). Bump the version when the shape changes rather than migrating silently (embeddings from a different model are not compatible, for example).

## Conventions

- TypeScript strict; `erasableSyntaxOnly` is on (no parameter properties, no enums). `verbatimModuleSyntax` is on (use `import type`).
- Canvas helpers in `src/core/canvas.ts`; use `createCanvas()` (OffscreenCanvas first) rather than `document.createElement('canvas')` unless you need `toDataURL`.
- Colour math exists twice on purpose: `applyColorGl` (WebGL) and the CPU path in `adjust.ts`. Keep them in sync.
- Detection defaults to *masked*: an unknown or unclassified face must never be left exposed. Any new mask style needs a fallback path (see the blur fallback in `drawSwaps`).
- UI must work down to 380 px wide. Test narrow layouts with an iframe of that width if you can't resize the browser.
- Keep the first-visit notice, licence texts and the README licence table accurate whenever a model changes.

## Testing (there is no unit-test suite yet; verify in the browser)

- Drive the app from DevTools or automation via `window.__mediabox` (installed by `src/devtools.ts` in dev, or in production with `?devtools`). It exposes the store, `buildOperations`, export functions, detectors, recogniser, `onFrameFaces` and swap helpers.
- Do **not** `import('/src/...')` app modules from test scripts: Vite serves HMR-updated modules under new `?t=` URLs, so you get a second module instance (a second `faceMask` import even re-registers the operation). After editing store or operation modules, do a full reload before trusting state.
- Bundled samples: `public/samples/solvay.jpg` (29 faces) and `solvay.mp4`. The "Try the sample" buttons on the start screen load them.
- Desktop: `desktop/scripts/smoke.mjs` and `smoke-swap.mjs` launch a hidden window and run a script inside the page; the main process prints `SMOKE_RESULT`. Point `MEDIABOX_MODEL_DIR` at a folder with the neural models to exercise the native engine; `MEDIABOX_SMOKE_OUT` receives an exported image for inspection.
- Useful sanity check for masking: run the detector on the *exported* frame; masked faces should not be detectable, kept faces should.

## Gotchas learned the hard way

- `<video>` playback is not used for the WebCodecs preview path; the player decodes with mediabunny. Audio chunks must be scheduled gaplessly on the audio clock and the AudioContext must match the track's sample rate, or you get clicks.
- The YuNet ONNX has a fixed 640×640 input; larger frames are handled with overlapping windows. MobileFaceNet declares batch size 1 but accepts bigger batches; ORT logs a warning per run unless `logSeverityLevel: 3`.
- The inswapper model's embedding-mapping matrix is its last 512×512 initializer, read with the tiny protobuf reader in `desktop/src/neural/onnxInitializer.ts`.
- Electron serves the app from the privileged `app://` scheme; `file://` breaks WASM fetches and module imports.
- The packaged desktop app must ship only `onnxruntime-node` as a runtime dependency; all web dependencies are devDependencies because Vite bundles them.
- Static hosts cap files at 25 MiB: `pnpm build` splits the ORT WebGPU `.wasm` into parts and `src/faces/ort.ts` reassembles them into a Blob. Keep any new large asset under the limit or extend the split script.
- Deployment (`pnpm deploy:cloudflare`) reads credentials from `.env` only (see `.env.example`); never rely on a wrangler login.

## Licences and what may be shipped

- Code: MIT. Detectors (BlazeFace, YuNet, Face Landmarker): Apache-2.0.
- InsightFace models (MobileFaceNet for recognition; inswapper + ArcFace for the desktop neural swap): **non-commercial research use only**. Never bundle inswapper/ArcFace in a package; they are downloaded on demand behind a licence prompt. Do not introduce a commercial-use claim without swapping these models.

## Git workflow

- Work on a branch and open a pull request against `main`; CI must pass. Direct pushes to `main` are reserved for the repository owner.
- Commit messages: imperative subject line, body explaining *why*. Do not commit `.local/`, `release/`, `dist/`, `desktop/dist/`, or anything under `public/models`, `public/ort`, `public/mediapipe`.
