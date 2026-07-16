# Native Core — moving the compositor out of the browser renderer

Status: **Exploratory / for decision.** This is a product-architecture proposal, not a perf patch.
Scope: the render/composite/encode core of the `.axcut` editor — preview *and* export.
Prerequisite reading: [`export-pipeline-v2-spec.md`](./export-pipeline-v2-spec.md) §3.1 and §4.4.1 — every number below comes from there.

---

## 1. Why this exists

The export pipeline was measured end‑to‑end (2026‑07‑16). After replacing the WebCodecs encoder with native ffmpeg, the bottleneck is **not** the encoder any more — it is the **renderer→main process crossing**:

| architecture | fps @1080p | vs today |
|---|---:|---:|
| today (WebCodecs) | 8 | — |
| Phase 3 — native ffmpeg, BGRA over IPC | 34 | 4.3× |
| Phase 4 — + GPU NV12 packing (halves the bytes) | 81 | 10× |
| **native compositor (no crossing)** | **~165** (encoder‑bound) | **20×** |
| native compositor + parallel encode sessions | >165 | >20× |

The crossing exists for one reason: **the compositor runs inside a sandboxed Chromium renderer**, so every finished frame must be copied across a process boundary to reach a native encoder. Electron offers no zero‑copy path out ([electron#34905](https://github.com/electron/electron/issues/34905): the transfer list accepts `MessagePortMain[]` only — an ArrayBuffer transfer silently drops the message). Every frame is structured‑cloned: ~390–420 MB/s, and attaching ffmpeg to the receiving process costs another ~40 % because one thread both receives IPC and writes stdin.

**Phase 4 works around the wall (10×). This document is about removing it (20×+).**

## 2. The trap this must avoid

> Moving compositing to Rust **for export only** would give us two implementations of the entire visual identity — zoom spring, auto‑focus follow, motion blur, three‑layer drop shadow, webcam masks, cursor smoothing/click‑bounce/motion‑blur, annotations, 3D rotation, gradients, border‑radius, padding, crop — that must agree **pixel‑for‑pixel, forever**, because the preview would stay in the browser.

We spent a full session validating parity for *one* path. Two paths means paying that validation on every visual change, indefinitely. **A native compositor is only worth building if it serves the preview too.** That is the whole argument of this document, and the reason it is an architecture decision rather than an optimisation.

## 3. Correcting the framing: "Electron for UI + Tauri for backend"

That combination does not exist. **Electron and Tauri are both application shells** — each provides the window, the webview and the native backend. Electron = web UI + Node backend; Tauri = web UI + Rust backend. You pick one.

The real question is not *Electron vs Tauri*. It is:

> **Where does the compositor live, and how does the preview display its output?**

| option | compositor | preview display | crossing? | parity risk |
|---|---|---|---|---|
| **A. status quo + Phase 4** | Pixi/WebGL in renderer | canvas in the webview | yes (3.0 MB/frame) | none — one compositor |
| **B. Rust compositor, export only** | Rust/wgpu in native | Pixi (unchanged) | export: no | **two compositors — rejected** |
| **C. Rust compositor + native preview surface** | Rust/wgpu | native surface layered in the window | no | none — one compositor |
| **D. Rust compositor, preview via webview** | Rust/wgpu | frames pushed to the webview | **yes, reversed** | none, but the crossing returns |

**Only C removes the crossing while keeping one compositor.** D is a trap: sending preview frames back to the webview reintroduces the exact bottleneck, just in the other direction. B is the parity trap of §2.

C is achievable in **either** shell — Electron with a napi‑rs addon plus a native child window, or Tauri natively. Tauri is the natural home (the backend already *is* Rust, and `wry` + a wgpu surface is a known pattern); Electron would be swimming against the process model. **This is what Cap (cap.so) does** — and why its native encoder crates make sense for it: Tauri/Rust, capture + composite + preview all native, no sandboxed renderer in the frame path.

## 4. Target architecture (option C)

```
┌─ Web UI (React) ─ unchanged ────────────────────────────────┐
│  timeline, inspector, dialogs, state (Zustand), i18n         │
│         │ commands (seek, set zoom, play…)  ▲ events         │
└─────────┼────────────────────────────────────┼──────────────┘
          ▼                                    │
┌─ Rust core ─────────────────────────────────────────────────┐
│  compositor (wgpu)  ← ONE implementation, used by both       │
│      ├── preview  → native surface layered in the window     │
│      └── export   → frame → encoder, in‑process, no crossing │
│  decode (ffmpeg/VideoToolbox/MF)                             │
│  encode (h264_nvenc / h264_qsv / h264_amf / videotoolbox /   │
│          vaapi — via ff-encode or vendor crates)             │
│  muxing, audio (WSOLA + AAC)                                 │
└─────────────────────────────────────────────────────────────┘
```

**Key property:** the compositor is a pure function of `(RenderPlan, time) → frame`. The preview draws it to a surface; the export hands it to an encoder. Same code, same pixels, by construction — parity stops being a thing we validate and becomes a thing we get for free.

### 4.1 What ports, and what does not

| layer | today | native core | effort |
|---|---|---|---|
| Web UI, timeline, state | React | **unchanged** | none |
| `RenderPlan` model | TS (`renderPlan.ts`) | port to Rust (pure data + logic, already unit‑tested) | S |
| geometry/timing SSOT (`compositeLayout`, `zoomTransform`, zoom spring, auto‑focus, cursor smoothing) | TS, pure | port to Rust — these are pure maths with tests, the cheapest part to move | M |
| compositor (Pixi/WebGL + Canvas2D layers) | TS | **rewrite in wgpu** — video sprite, wallpaper, 3‑layer shadow, webcam mask, cursor, annotations, 3D rotation, blur/motion‑blur | **L — the real cost** |
| preview display | `<canvas>` in webview | native wgpu surface in the window | M |
| decode | WebCodecs + web‑demuxer (WASM) | ffmpeg/native | M |
| encode | WebCodecs | native (this is the 20×) | S — mostly done in Phase 3 |
| audio (WSOLA, AAC, concat) | TS, pure + tested | port to Rust | M |
| capture (WGC, cursor sampler) | already native `.exe` | reuse as‑is or fold into the core | S |
| STT (whisper) | already native | unchanged | none |
| shell (IPC, updater, packaging, single‑instance, global shortcuts) | Electron | **rewrite for Tauri** | **L — the hidden cost** |

**The two big items are the wgpu compositor and the shell migration.** Everything the app already ships natively (`wgc-capture.exe`, `cursor-sampler.exe`, whisper) survives.

### 4.2 Why wgpu

One Rust codebase targeting Vulkan/Metal/D3D12 natively — and WebGPU in a browser, which keeps a web build possible. Effects map to shaders; the current 2D‑canvas layers (shadow, masks, cursor) become quads + fragment shaders. Alternative: per‑platform native APIs (Cap's `enc-avfoundation` / `enc-mediafoundation` model) — more code, no portability upside for compositing.

## 5. Honest cost / risk

- **This touches the product's entire visual identity.** Every effect must be re‑implemented and must look *right*, not merely *similar*. The frame‑diff harness from the export work is the gate, but the surface is large.
- **Shell migration is not free**: Electron APIs in use (`desktopCapturer`, `globalShortcut`, single‑instance lock, auto‑update, notarisation/packaging for 3 OSes, the whole `electron/ipc` surface) all need Tauri equivalents. Some are better in Tauri, some worse.
- **The team's language mix changes.** Today: TS + a little C++/native. After: a substantial Rust core that the whole team must be able to touch.
- **It is a months‑scale project**, and it competes with product work for the same 2× that Phase 4 does not deliver (10× → 20×).
- **Risk of a half‑migration**: option B (export‑only Rust compositor) is the tempting shortcut and it is the worst outcome — two compositors, permanent parity tax. If we start, we must reach C.

## 6. Recommendation & sequencing

1. **Do Phase 4 first, now** (§4.4.1 of the export spec): GPU NV12 packing + move the ffmpeg stdin write off the IPC‑receiving thread. Target ~81–100 fps (**10×**), no architecture change, one compositor. This is real, cheap, and it is *not* wasted if we later go native — the encoder selection, the LGPL ffmpeg bundling and the capability probe all survive into the Rust core.
2. **Measure 4K before deciding.** All numbers here are 1080p. A 4K BGRA frame is 33 MB (NV12: 12.4 MB) — the crossing scales linearly with pixels while the encoder degrades more gently, so at 4K the native gain could be well above 2×. **If most exports are 4K, this document gets much stronger.** 20‑minute measurement, not yet done.
3. **Then decide C vs status‑quo** on evidence: the 4K number, the share of long/4K exports in real usage, and appetite for a Rust core.
4. If we go: **spike first** — a wgpu compositor rendering *one* clip with zoom + shadow + webcam, frame‑diffed against the current export. If parity on that subset is achievable at reasonable cost, the rest is grind. If it is not, we learn cheaply.

**Bottom line:** Phase 4 buys 10× for weeks of work. This buys 20× for months and a different product architecture. The 4K measurement is what should decide it, and it has not been taken.
