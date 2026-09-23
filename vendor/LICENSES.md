# Vendored third-party files

Everything here is downloaded once from its original publisher and served from this repo, so the
site keeps working offline and never calls a CDN. The Line art files load only when Line art is
used.

## mp4-muxer

`vendor/mp4-muxer.mjs`: see `vendor/mp4-muxer.LICENSE` (MIT).

## Line art

| File | Size | Source | Version | Licence |
|---|---|---|---|---|
| `vendor/models/informative_drawings.onnx` | 17,193,338 B | https://huggingface.co/rocca/informative-drawings-line-art-onnx/resolve/d38eccbd448cdcd228fb81d708506e5e60b41ccb/model.onnx (ONNX port by Joseph Rocca, https://github.com/josephrocca/image-to-line-art-js) | HF commit d38eccbd (2022-03-12); weights = `model.pth` ("style 1") of the authors' Space carolineec/informativedrawings, 3 residual blocks, opset 12, dynamic H x W | MIT |
| `vendor/models/face_landmarker.task` | 3,758,596 B | https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task | float16 / 1 | Apache-2.0 |
| `vendor/mediapipe/vision_bundle.mjs` | 155,439 B | npm `@mediapipe/tasks-vision` (https://www.npmjs.com/package/@mediapipe/tasks-vision) | 1.0.1 | Apache-2.0 |
| `vendor/mediapipe/wasm/vision_wasm_internal.js` | 323,377 B | same package, `wasm/` | 1.0.1 | Apache-2.0 |
| `vendor/mediapipe/wasm/vision_wasm_internal.wasm` | 11,756,954 B | same package, `wasm/` (SIMD build only; the no-SIMD build is not shipped) | 1.0.1 | Apache-2.0 |
| `vendor/ort/ort.wasm.bundle.min.mjs` | 68,628 B | npm `onnxruntime-web` (https://www.npmjs.com/package/onnxruntime-web), `dist/` | 1.23.2 | MIT |
| `vendor/ort/ort-wasm-simd-threaded.wasm` | 11,905,541 B | same package, `dist/` (run with one thread: no SharedArrayBuffer needed) | 1.23.2 | MIT |
| `vendor/ort/ort.min.mjs` | 357,488 B | same package, `dist/` (JSEP build: WebGPU backend, used only when the device has WebGPU) | 1.23.2 | MIT |
| `vendor/ort/ort-wasm-simd-threaded.jsep.mjs` | 49,998 B | same package, `dist/` | 1.23.2 | MIT |
| `vendor/ort/ort-wasm-simd-threaded.jsep.wasm` | 23,824,254 B | same package, `dist/` | 1.23.2 | MIT |

SHA-256:

```
1fef40b8f7126d827e30fbebccf95ae9b0b391795df926bf9366a821bad4f498  models/informative_drawings.onnx
64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff  models/face_landmarker.task
d885630c297c0b20b1fe86096cb06291c4c8080876f27852e724f24ac603713f  mediapipe/vision_bundle.mjs
e170ee67dd4e16c1a6fcd8840a206687e5a59b22c20e4a902bc445b095454d73  mediapipe/wasm/vision_wasm_internal.js
8da277a733926eacd0474b8704b36742d6ec3231c57a860c5b889dff8f1df886  mediapipe/wasm/vision_wasm_internal.wasm
cace3b98bee45c1c40ed04e07b984fb66012acacb702e6aecd9008239bf35e99  ort/ort.wasm.bundle.min.mjs
45eaee27761ad883742a8d4b8fce1538d60ce43b51adf1726fafccc59b8c1a15  ort/ort-wasm-simd-threaded.wasm
```

### Credits

- **Informative Drawings**: Caroline Chan, Frédo Durand, Phillip Isola, "Learning to generate line
  drawings that convey geometry and semantics", CVPR 2022. Code and weights:
  https://github.com/carolineec/informative-drawings (MIT). ONNX conversion: Joseph Rocca,
  https://github.com/josephrocca/image-to-line-art-js (MIT).
- **MediaPipe Face Landmarker**: Google, https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker
  (Apache License 2.0, https://www.apache.org/licenses/LICENSE-2.0).
- **ONNX Runtime Web**: Microsoft, https://github.com/microsoft/onnxruntime (MIT License,
  Copyright (c) Microsoft Corporation).

### MIT License (ONNX Runtime Web; Informative Drawings)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
