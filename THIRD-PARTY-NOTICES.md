# Third-party notices

OpenScreen is MIT licensed (see [LICENSE](LICENSE)). The installers additionally
bundle the third-party components below. This file ships inside the
application resources and satisfies the attribution and source-offer obligations
that come with them.

npm dependencies are not listed here: they are resolved from `package.json` and
distributed by their own registries, not redistributed inside our binaries.

---

## FFmpeg — shared libraries (Windows only)

- **Components**: `avcodec-*.dll`, `avformat-*.dll`, `avutil-*.dll`,
  `swresample-*.dll`, `swscale-*.dll` and their siblings, under
  `resources/electron/native/bin/win32-*/`.
- **Used by**: the native D3D11 compositor addon, which links against them at
  load time.
- **License**: **GNU Lesser General Public License v2.1 or later**
  (<https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html>). FFmpeg's own
  licensing page: <https://ffmpeg.org/legal.html>.
- **This is an LGPL build, not a GPL one.** It is configured without
  `--enable-gpl` and without `--enable-nonfree`, and links no GPL-only library
  (x264, x265, xvid, vidstab, rubberband, frei0r, …). `scripts/fetch-ffmpeg.mjs`
  verifies this before vendoring — it reads `ffmpeg -L`, `-buildconf` and
  `-encoders` and refuses any binary that reports otherwise.
- **Upstream binaries**: BtbN/FFmpeg-Builds, release
  `autobuild-2026-07-31-14-10`, the `*-lgpl-shared-8.1` assets. Pinned by
  SHA-256 in `scripts/fetch-ffmpeg.mjs`; the digests there identify the exact
  artifacts we ship.
  <https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-07-31-14-10>
- **Corresponding source**: FFmpeg n8.1.2, commit `9b6c8969e0`, from
  <https://github.com/FFmpeg/FFmpeg>. The build configuration and scripts that
  produced these exact binaries are published at
  <https://github.com/BtbN/FFmpeg-Builds>.
- **Relinking**: as required by the LGPL, these are dynamic libraries. You may
  replace them with your own build of the same FFmpeg version by overwriting the
  DLLs in `resources/electron/native/bin/win32-*/`.

## web-demuxer — WebAssembly demuxer

- **Component**: `wasm/web-demuxer.wasm`, inside the application bundle.
- **Used by**: the editor's streaming decoder, audio waveforms and caption audio
  extraction, which demux recordings in the renderer with it.
- **License**: MIT for web-demuxer itself — Copyright (c) 2024 ForeverSc, under the
  same permission notice as OpenScreen's own [LICENSE](LICENSE). The module also
  contains FFmpeg code compiled to WebAssembly, under the **GNU Lesser General
  Public License v2.1 or later**, as web-demuxer's README states.
- **Upstream**: the npm package `web-demuxer` 4.0.0,
  <https://github.com/ForeverSc/web-demuxer>. The shipped file is byte-identical
  to that release's `dist/wasm-files/web-demuxer.wasm`.
- **Corresponding source**: the web-demuxer repository at the 4.0.0 release, whose
  `lib/` directory holds the FFmpeg-derived sources and their build scripts.
- **Replacing it**: the module is a separate file loaded at runtime, so it can be
  replaced with your own build of the same version.

## whisper.cpp and ggml

- **Components**: `whisper-stt-server` and its ggml backend sidecars, under
  `resources/electron/native/bin/<platform>-<arch>/`.
- **License**: MIT — <https://github.com/ggml-org/whisper.cpp> and
  <https://github.com/ggml-org/ggml>.
- Built from source by `scripts/build-whisper-stt.sh`; the pinned upstream
  revision is in `electron/native/whisper-stt/CMakeLists.txt`.
- The speech model (`ggml-*.bin`) is **not** bundled — it is downloaded into the
  user's data directory on first use by `electron/stt/modelManager.ts`.

## ONNX Runtime (Windows and Apple Silicon macOS)

- **Component**: `onnxruntime.dll` / `libonnxruntime.dylib`, under
  `resources/electron/native/bin/<platform>-<arch>/`.
- **License**: MIT — <https://github.com/microsoft/onnxruntime>.
- Not built here: the pinned upstream release archive is downloaded, SHA-256
  verified and unpacked by `scripts/fetch-onnxruntime.mjs`, which also checks the
  archive's own LICENSE really is MIT before vendoring anything.
- **Why it ships**: the native compositor segments the webcam subject with it, on
  the CPU execution provider, to drive the camera background cutout/blur/custom
  modes. The `gpu_cuda*` builds are deliberately not used — they are an order of
  magnitude larger and carry NVIDIA redistribution terms.
- **Not on Intel macOS**: upstream publishes no `osx-x86_64` asset from 1.27 on,
  so the x64 DMG ships without it and the camera background effects are simply
  absent there. Not shipped on Linux either, where the compositor has no capture
  path for the mask yet.
- The segmentation model it runs is a separate component, immediately below.

## MediaPipe Selfie Segmentation — model weights

- **Components**: `selfie_segmentation.tflite`,
  `selfie_segmentation_landscape.tflite` and the `selfie_segmentation_landscape.onnx`
  derived from them, shipped under `resources/mediapipe/`.
- **License**: Apache-2.0 — <https://google.github.io/mediapipe/solutions/selfie_segmentation>.
  Copyright The MediaPipe Authors.
- The `.onnx` is a **derived work**, generated from the vendored `.tflite` by
  `scripts/convert-selfie-segmentation-to-onnx.py`. No third-party weights are
  downloaded at build time.
- **Why it is listed here**: these weights are redistributed inside the installer,
  and Apache-2.0 §4 asks that the attribution travel with them. The provenance note
  in `public/mediapipe/selfie_segmentation/README.md` does not — electron-builder's
  `"!*.md"` filter strips it from the package — so this file is the only copy a user
  ever receives.
- The MediaPipe **JavaScript** solution and its two ~5.6 MB WASM builds are no longer
  bundled: inference moved into the native compositor, and nothing loaded them.

## Microsoft Visual C++ runtime — `vcomp140.dll`, `msvcp140*.dll`, `vcruntime140*.dll` (Windows only)

- **Components**: under `resources/electron/native/bin/win32-x64/` —
  `vcomp140.dll`, `msvcp140.dll`, `msvcp140_1.dll`, `vcruntime140.dll`,
  `vcruntime140_1.dll`.
- **License**: redistributable under the Microsoft Visual C++ Redistributable
  terms accompanying Visual Studio; the copies shipped are taken from the
  `VC\Redist\MSVC\<version>\x64\Microsoft.VC<nnn>.OpenMP\` and
  `…\Microsoft.VC<nnn>.CRT\` directories of the Visual Studio installation that
  builds the release, never from `System32`.
- **Why they ship**: two prebuilt binaries in the payload import them, and
  neither is ours to recompile against the static CRT. The ggml backends above
  are compiled with OpenMP and import `vcomp140.dll`; the vendored ONNX Runtime
  imports the CRT proper. None of these are **part of Windows**, so without them
  `whisper-stt-server` dies in the loader before `main()` on any machine that has
  no Visual C++ Redistributable — transcription and captions fail with no usable
  error — and `onnxruntime.dll` fails to load, leaving the camera background
  silently inert. Staged by `scripts/stage-vcomp-runtime.mjs`;
  `scripts/before-pack.cjs` refuses to package if any is missing while something
  still imports it.

## PipeWire — headers (Linux only)

- **Components**: header sources under
  `electron/native/pipewire-capture/vendor/pipewire-1.0.5/include/`, compiled
  into `openscreen-pipewire-helper` (the Linux cursor/capture helper) under
  `resources/electron/native/bin/linux-*/`.
- **License**: **MIT** — <https://gitlab.freedesktop.org/pipewire/pipewire>.
  Every vendored file keeps its upstream `SPDX-License-Identifier: MIT` header,
  and the project's licence text is copied alongside them as `COPYING`.
- **Upstream**: PipeWire release 1.0.5. Only the header subset the helper
  includes was vendored; `vendor/README.md` records exactly what was copied and
  how to reproduce the selection.
- **No PipeWire binary is redistributed.** The helper resolves
  `libpipewire-0.3.so.0` with `dlopen` at runtime, from the user's own system,
  so nothing of PipeWire's ships inside our installers beyond the compiled
  result of its headers (inline functions and struct layouts).

## Fonts — Inter, Lora, Oswald, Caveat, IBM Plex Mono

- **Components**: the Regular and Bold `.ttf` of each family, under
  `resources/fonts/`.
- **Used by**: the native compositor, which draws captions and annotations with
  these files and nothing else (it registers them privately at start and never
  reads the fonts installed on the machine), and the editor's font picker.
- **License**: **SIL Open Font License 1.1** — <https://openfontlicense.org>.
  Each family's copyright notice and licence text ship beside its files as
  `<Family>-OFL.txt`, as the licence requires.
- **Unmodified**: every file is redistributed exactly as upstream publishes it,
  which is also why the Reserved Font Names "Lora" and "Plex" are kept.
- **Upstream**:
  - Inter — Copyright 2016 The Inter Project Authors. `extras/ttf/` of the v4.1
    release, <https://github.com/rsms/inter/releases/tag/v4.1>.
  - Lora 3.021 — Copyright 2011 The Lora Project Authors. `fonts/ttf/` of
    <https://github.com/cyrealtype/Lora-Cyrillic> at `2d53b449b6`.
  - Oswald 4.103 — Copyright 2016 The Oswald Project Authors. `fonts/ttf/` of
    <https://github.com/googlefonts/OswaldFont> at `89795261ac`.
  - Caveat 2.000 — Copyright 2014 The Caveat Project Authors. `fonts/ttf/` of
    <https://github.com/googlefonts/caveat> at `59745e818e`.
  - IBM Plex Mono 2.3 — Copyright © 2017 IBM Corp. `ofl/ibmplexmono/` of
    <https://github.com/google/fonts> at `23e54b51dd`.

## Recordly — helper code

- **Components**: parts of the zoom, motion-smoothing and custom-cursor code, and a
  few lines elsewhere, the native capture helpers included.
- **License**: MIT — Copyright (c) 2026 webadderall, under the same permission
  notice as OpenScreen's own [LICENSE](LICENSE). Published by Recordly under MIT,
  before its relicensing in March 2026.

## Rust crates — compiled into the compositor addon

- **Component**: `compositor_view.node`, under
  `resources/electron/native/bin/<platform>-<arch>/`.
- **What is listed**: every third-party crate in the addon's dependency graph in
  `crates/Cargo.lock`, across all platforms. Build-time crates (procedural macros,
  build scripts) are included even though none of their code ships.
- **Licenses**: as each crate publishes them on crates.io. Where a crate offers a
  choice, OpenScreen uses it under MIT or Apache-2.0. Each crate's licence text is
  in its source package at the version listed.
- **MIT OR Apache-2.0** (155): android_system_properties 0.1.5, anyhow 1.0.103,
  arrayvec 0.7.8, ash 0.38.0+1.3.281, autocfg 1.5.1, bit-set 0.8.0, bit-vec 0.8.0,
  bitflags 1.3.2, bitflags 2.13.1, bumpalo 3.20.3, cc 1.2.67, cexpr 0.6.0, cfg-if
  1.0.4, core-foundation 0.9.4, core-foundation-sys 0.8.7, core-graphics-types
  0.1.3, cosmic-text 0.19.0, crc32fast 1.5.0, ctor 0.2.9, document-features
  0.2.12, either 1.16.0, equivalent 1.0.2, fdeflate 0.3.7, find-msvc-tools 0.1.9,
  flate2 1.1.9, font-types 0.11.3, font-types 0.12.2, foreign-types 0.5.0,
  foreign-types-macros 0.2.4, foreign-types-shared 0.3.1, futures-core 0.3.33,
  futures-task 0.3.33, futures-util 0.3.33, glob 0.3.3, gpu-alloc 0.6.2,
  gpu-alloc-types 0.3.1, gpu-allocator 0.27.0, gpu-descriptor 0.3.2,
  gpu-descriptor-types 0.2.0, hashbrown 0.15.5, hashbrown 0.17.1, heck 0.5.0,
  image 0.25.10, indexmap 2.14.0, itertools 0.13.0, itoa 1.0.18, jni-sys 0.3.1,
  jni-sys 0.4.1, jni-sys-macros 0.4.1, js-sys 0.3.103, khronos-egl 6.0.0, libc
  0.2.186, linebender_resource_handle 0.1.1, litrs 1.0.0, lock_api 0.4.14, log
  0.4.33, matrixmultiply 0.3.11, memmap2 0.9.11, metal 0.29.0, metal 0.31.0,
  minimal-lexical 0.2.1, naga 24.0.0, ndarray 0.16.1, ndarray 0.17.2, ndk-sys
  0.5.0+25.2.9519653, num-complex 0.4.6, num-integer 0.1.47, num-traits 0.2.19,
  once_cell 1.21.4, ort 2.0.0-rc.13, ort-sys 2.0.0-rc.13, parking_lot 0.12.5,
  parking_lot_core 0.9.12, paste 1.0.15, pin-project-lite 0.2.17, pkg-config
  0.3.33, png 0.18.1, pollster 0.4.0, portable-atomic 1.15.0, portable-atomic-util
  0.2.7, presser 0.3.1, prettyplease 0.2.37, proc-macro2 1.0.106, profiling
  1.0.18, quote 1.0.46, range-alloc 0.1.5, rangemap 1.7.1, rawpointer 0.2.1,
  read-fonts 0.37.0, read-fonts 0.41.0, regex 1.13.1, regex-automata 0.4.16,
  regex-syntax 0.8.11, renderdoc-sys 1.1.0, roxmltree 0.20.0, rustc-hash 1.1.0,
  rustc-hash 2.1.3, rustversion 1.0.23, scopeguard 1.2.0, semver 1.0.28, serde
  1.0.228, serde_core 1.0.228, serde_derive 1.0.228, serde_json 1.0.150, shlex
  1.3.0, shlex 2.0.1, skrifa 0.40.0, skrifa 0.44.0, smallvec 1.15.2, smol_str
  0.3.6, static_assertions 1.1.0, swash 0.2.10, syn 2.0.119, syn 3.0.3, sys-locale
  0.3.2, thiserror 1.0.69, thiserror 2.0.19, thiserror-impl 1.0.69, thiserror-impl
  2.0.19, ttf-parser 0.25.1, unicode-bidi 0.3.18, unicode-script 0.5.8,
  unicode-segmentation 1.13.3, unicode-width 0.1.14, unicode-xid 0.2.6,
  version_check 0.9.5, wasm-bindgen 0.2.126, wasm-bindgen-futures 0.4.76,
  wasm-bindgen-macro 0.2.126, wasm-bindgen-macro-support 0.2.126,
  wasm-bindgen-shared 0.2.126, web-sys 0.3.103, wgpu 24.0.5, wgpu-core 24.0.5,
  wgpu-hal 24.0.4, wgpu-types 24.0.0, windows 0.58.0, windows_aarch64_gnullvm
  0.52.6, windows_aarch64_msvc 0.52.6, windows_i686_gnu 0.52.6,
  windows_i686_gnullvm 0.52.6, windows_i686_msvc 0.52.6, windows_x86_64_gnu
  0.52.6, windows_x86_64_gnullvm 0.52.6, windows_x86_64_msvc 0.52.6, windows-core
  0.58.0, windows-implement 0.58.0, windows-interface 0.58.0, windows-link 0.2.1,
  windows-result 0.2.0, windows-strings 0.1.0, windows-sys 0.61.2, windows-targets
  0.52.6, yazi 0.2.1, zeno 0.3.3.
- **MIT** (26): block 0.1.6, cfg_aliases 0.2.2, convert_case 0.6.0, core_maths
  0.1.1, fontconfig-parser 0.5.8, fontdb 0.23.0, harfrust 0.5.2, libm 0.2.16,
  malloc_buf 0.0.6, napi 2.16.17, napi-build 2.3.2, napi-derive 2.16.13,
  napi-derive-backend 1.0.75, napi-sys 2.4.0, nom 7.1.3, objc 0.2.7, ordered-float
  4.6.0, redox_syscall 0.5.18, simd-adler32 0.3.10, slab 0.4.12, strum 0.26.3,
  strum_macros 0.26.4, tracing 0.1.44, tracing-core 0.1.36, xml-rs 0.8.28, zmij
  1.0.23.
- **MIT OR Apache-2.0 OR Zlib** (9): bytemuck 1.25.1, bytemuck_derive 1.11.0,
  glow 0.16.0, miniz_oxide 0.8.9, raw-window-handle 0.6.2, tinyvec 1.12.0,
  tinyvec_macros 0.1.1, zune-core 0.5.1, zune-jpeg 0.5.15.
- **Apache-2.0** (7): clang-sys 1.8.1, codespan-reporting 0.11.1, gl_generator
  0.14.0, glutin_wgl_sys 0.6.1, khronos_api 3.1.0, spirv 0.3.0+sdk-1.3.268.0,
  unicode-linebreak 0.1.5.
- **Unlicense OR MIT** (5): aho-corasick 1.1.4, byteorder-lite 0.1.0, memchr
  2.8.3, termcolor 1.4.1, winapi-util 0.1.11.
- **Zlib** (2): foldhash 0.1.5, slotmap 1.1.1.
- **ISC** (2): libloading 0.8.9, libloading 0.9.0.
- **BSD-3-Clause OR Apache-2.0** (2): moxcms 0.8.1, pxfm 0.1.30.
- **0BSD OR MIT OR Apache-2.0** (1): adler2 2.0.1.
- **BSD-3-Clause** (1): bindgen 0.70.1.
- **CC0-1.0** (1): hexf-parse 0.2.1.
- **Apache-2.0 OR GPL-2.0-only** (1): self_cell 1.3.0.
- **(MIT OR Apache-2.0) AND Unicode-3.0** (1): unicode-ident 1.0.24.

## OpenScreen native helpers

`wgc-capture` (Windows Graphics Capture), the ScreenCaptureKit helper (macOS),
the PipeWire helper (Linux) and the compositor addon are part of this repository
and are covered by [LICENSE](LICENSE).

---

To report an omission or request source for anything bundled here, open an issue
at <https://github.com/getopenscreen/openscreen/issues>.
