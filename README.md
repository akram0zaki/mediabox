# MediaBox

**Mask every face except the ones you choose — photos and videos, entirely in your browser.**

MediaBox is a web-based photo and video editor whose headline feature is automatic, on-device face masking with face recognition: detect every face in every frame, keep the people you care about clear, blur or pixelate everyone else, and export. No uploads, no accounts, no server. The detectors, the face recogniser, and the video decode/encode pipeline all run inside the browser.

## Why this exists

We came back from a family holiday with a phone full of photos and videos taken in busy public places: beaches, museums, markets, queues. We wanted to share them, but every shot had strangers in the background whose faces had nothing to do with us. Blurring them by hand, frame by frame, was out of the question, and uploading our family's private media to some "AI blur" service to solve a privacy problem felt backwards.

So MediaBox does exactly that job, locally:

1. Open a photo or video.
2. Turn on "Show faces", click each family member once and add them to **My people**.
3. Everyone else is masked automatically — in that file and in every photo and video you open afterwards.
4. Export.

Everything else in the app (trimming, crop, filters, colour) is there so you don't need a second tool before sharing.

## Features

**Face masking**
- Detects faces in stills and in every video frame, with two on-device engines:
  - **Precise (YuNet)** via ONNX Runtime Web on WebGPU or WASM: finds small and distant faces, crowds, wide shots. Adjustable analysis resolution.
  - **Fast (BlazeFace)** via MediaPipe on the GPU: quickest, best for close-up faces; optional tiled search.
- Mask styles: blur, pixelate, solid colour, emoji sticker. Oval or rounded-box shape, adjustable size (60–300 % of the detected face), intensity and edge softness.
- Video tracking: masks are smoothed between frames and held for a few frames when the detector blinks — no flicker, no single-frame leaks.
- Hold-to-compare button (or the C key) shows the unmasked frame at any time, even during playback.

**Choose who gets masked**
- Click any detected face to keep it clear or mask it in that photo, or add the person to **My people**.
- People are recognised on-device (InsightFace MobileFaceNet embeddings aligned with the detector's landmarks) and stay clear in every file you open. Add a few samples per person for robustness.
- Modes: everyone except my people (default), everyone, only my people. Recognition strictness slider. The list lives in your browser's local storage — nowhere else.

**Editing**
- Rotate, flip, crop.
- Filters & colour (WebGL): 14 preset looks with live thumbnails and a strength slider, layered on top of manual exposure, brightness, contrast, highlights, shadows, fade, temperature, tint, saturation, vibrance, hue, vignette, grain, sharpen and soften.
- Video: frame-accurate scrubbing, real-time preview with masks, trim in/out, export to MP4 (H.264) or WebM (VP9) at full resolution with audio passed through.
- Images: export to PNG, JPEG or WebP.

**Runs anywhere**
- Desktop side-panel layout; on tablets and phones (down to 380 px wide) everything stacks with touch-sized controls.
- Works offline after the first load.

## Privacy

- Media never leaves the device. There is no backend and no analytics.
- Local storage holds only your acknowledgement of the first-visit notice and the people you add (a name, small face thumbnails and numeric face signatures). Remove people from the Faces panel, or clear the site's data in your browser, to delete them.
- Only edit media you own or are permitted to edit, and respect the privacy of the people in it.

## Getting started

Requires Node 20+ and [pnpm](https://pnpm.io).

```bash
pnpm install       # also copies the inference runtimes into /public and downloads the models
pnpm dev           # http://localhost:5173
pnpm build         # production build in dist/
pnpm preview       # serve the production build
```

`pnpm install` runs `scripts/setup-assets.mjs`, which copies the MediaPipe and ONNX Runtime WASM files out of `node_modules` and fetches three models into `public/models/`:

| Model | Purpose | Source |
| --- | --- | --- |
| `blaze_face_short_range.tflite` | Fast face detection | MediaPipe |
| `face_detection_yunet_2023mar.onnx` | Precise face detection + landmarks | OpenCV Zoo |
| `face_recognition_mobilefacenet_w600k.onnx` | Face recognition (extracted from InsightFace's `buffalo_sc.zip`) | InsightFace |

Re-run the step at any time with `pnpm setup:assets`. These files are git-ignored; after the first install the app works fully offline.

Try it with the bundled samples — the “Try the sample photo / video” buttons on the start screen load a public-domain 1927 group photo with 29 faces and a short clip generated from it (`public/samples/`, shipped with the build).

### Deploying

The build in `dist/` is static — any static host works. Two optional headers enable multi-threaded WASM for a faster CPU fallback on machines without WebGPU:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

### Browser support

- **Chrome / Edge 113+** (and other Chromium browsers): full experience — WebGPU inference, WebCodecs decode/encode, faster-than-realtime export.
- **Safari 17+ / Firefox**: inference falls back to WASM; video preview and export fall back to the `<video>` element + MediaRecorder path (real time, WebM output).

## How it works

```
src/
  core/
    canvas.ts          canvas helpers (OffscreenCanvas first, element fallback)
    types.ts           MediaAsset, FrameContext, OperationHandler
    registry.ts        operation registry
    pipeline.ts        renderPipeline(): source frame → operations in order → canvas
    operations/        transform, adjust (colour engine + presets), faceMask
    color/gl.ts        WebGL2 fragment shader for the colour controls
  faces/
    common.ts          FaceBox, landmarks, NMS, status plumbing
    engines/yunet.ts   ONNX Runtime Web detector (640 px windows over the frame)
    engines/blazeface.ts MediaPipe detector (+ multi-scale tiling)
    detector.ts        facade: pick an engine per call
    recognizer.ts      MobileFaceNet embeddings (landmark alignment, batched runs)
    people.ts          "my people" gallery + matching
    ort.ts             shared onnxruntime-web config and the single inference queue
    tracker.ts         IoU tracker: smoothing, hold-on-loss, stable track ids
    masks.ts           mask renderers and the detection overlay
  media/
    loadAsset.ts       file → ImageAsset | VideoAsset (probed with mediabunny)
    player.ts          preview frame sources: WebCodecs (mediabunny) or <video>
    exportImage.ts / exportVideo.ts
  state/store.ts       zustand store, persistence, buildOperations()
  ui/                  React components and panels
```

One `renderPipeline()` renders the still image, every preview frame and every exported frame, so what you see is what you get. Operations receive a `FrameContext` with the timestamp, a `sequenceId` (temporal state such as tracking resets when it changes), a `cacheKey` for stills and paused frames, and a `realtime` hint during playback so they can trade precision for speed.

Face identity in video is cached per tracked face and re-checked occasionally, with a per-frame budget so crowd scenes stay fluid. Unknown faces default to masked, so nobody is exposed while waiting to be classified.

### Extending

*New editing feature*: add `src/core/operations/<name>.ts` with a `registerOperation({...})` handler (`type`, `defaultParams`, `apply(input, params, ctx)`, optional `isIdentity` / `outputSize`), export it from `operations/index.ts`, add its params to the store and to `buildOperations()` (array order = application order), then add a panel under `src/ui/panels/` and a tab in `Sidebar.tsx`.

*New face detector or recogniser*: implement the small interface in `src/faces/engines/` (or `recognizer.ts`), run every ONNX call through the queue in `src/faces/ort.ts` — ONNX Runtime Web cannot execute two sessions concurrently — and add it to the engine selector.

## Performance notes

Measured on an Apple-silicon laptop in Chrome:

- Detection: ~30 ms/frame at 640 px, ~170 ms/frame at 960 px (YuNet, WebGPU). While playing, the preview analyses at 640 px; pause or export to use the configured resolution.
- Recognition: ~45 ms per face in batches of four, paid only when a face first appears and occasionally afterwards.
- Colour grading: ~1 ms per frame (WebGL).
- Export is frame-accurate and typically faster than real time for videos with a handful of faces.

Both detectors expect roughly upright faces. Transform runs before detection, so straightening a sideways-shot video makes detection work on the upright result; a frame deliberately rotated 90°/180° will not be masked.

## Licence

MediaBox is released under the [MIT Licence](LICENSE).

The models it downloads have their own terms:

| Model | Licence |
| --- | --- |
| MediaPipe BlazeFace | Apache-2.0 |
| OpenCV Zoo YuNet | Apache-2.0 |
| InsightFace `buffalo_sc` (MobileFaceNet w600k) | **Non-commercial research use only** (see the [InsightFace model zoo](https://github.com/deepinsight/insightface/tree/master/model_zoo)) |

If you need commercial use of face recognition, swap the recogniser for a permissively licensed model (OpenCV Zoo's SFace, Apache-2.0, works with the same alignment code but is about three times slower) — see `src/faces/recognizer.ts`.

Key dependencies: [mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0), [onnxruntime-web](https://onnxruntime.ai/) (MIT), [@mediapipe/tasks-vision](https://ai.google.dev/edge/mediapipe) (Apache-2.0), React and zustand (MIT).

## Contributing

Issues and pull requests are welcome. Before opening a PR run `pnpm lint` and `pnpm build`; CI runs the same. Please keep the privacy promise intact: nothing in MediaBox should ever send media, faces or people data anywhere.
