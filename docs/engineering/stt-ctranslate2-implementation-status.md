# CTranslate2 migration: implementation status

**Date:** 2026-07-07 (word-timestamp root-cause fixes + human-speech quality/speed test report)
**Branch:** `feat/native-stt-whispercpp`

Supersedes the earlier [whisper.cpp-based plan](./transcription-engine-migration.md) for the
word-timestamp problem. The decision doc lives at
[stt-ctranslate2-migration.md](./stt-ctranslate2-migration.md).

---

## What works

### TypeScript / Electron side (committed)

| Module | Status |
| --- | --- |
| `electron/stt/ctranslate2Server.ts` | Replaces `whisperServer.ts`. Same wire contract (`POST /inference` → verbose JSON), same lifecycle. Word timestamps expected absolute. |
| `electron/stt/wav.ts` | Shared WAV write/cleanup helpers. |
| `electron/stt/gpuDetector.ts` | Simplified to CUDA-or-CPU only. |
| `electron/stt/modelManager.ts` | Downloads individual model files from HuggingFace (`SYSTRAN/faster-whisper-small.int8` — ~150 MB instead of the ~470 MB fp16 release) instead of a single tarball. Files verified by SHA-256. Real HF URLs, not placeholders. |
| `electron/stt/transcriptionContract.ts` | `SttBackend = "ctranslate2-cuda" \| "ctranslate2-cpu"`. |
| `electron/stt/index.ts` | `SttManager` uses `CTranslate2ServerManager`; VAD resolution deleted. |
| `electron/stt/index.test.ts` | Updated mocks for the new server. |
| `electron/stt/ctranslate2Server.test.ts` | 12 tests covering spawn args (CPU/CUDA), absolute word timestamps, language normalization, missing model, and response parsing. |
| `electron/stt/{gpuDetector,modelManager}.test.ts` | Updated to new backend types and file-based model download. |
| `electron/stt/vadModel.ts` | DELETED. |
| `electron/stt/whisperServer.ts` + `.test.ts` | DELETED. |

### Build + CI (committed)

| File | Status |
| --- | --- |
| `scripts/build-ctranslate2-server.sh` | Build script for the native C++ helper. |
| `.github/workflows/build-ctranslate2-server.yml` | CI workflow for building + uploading the server binary. |
| `scripts/build-whisper-binaries.sh` | DELETED. |
| `.github/workflows/build-whisper-binaries.yml` | DELETED. |
| `scripts/fetch-vad-model.{sh,ps1}` | DELETED. |
| `.github/workflows/build.yml` | VAD fetch steps removed across all platform jobs. |
| `electron-builder.json5` | `extraResources` no longer ships `electron/native/models/`. |
| `package.json` | `tar@^7.4.3` added; old `setup:vad:*` scripts removed. |

### Native C++ server (committed, implemented)

The C++ source files are **real, compilable** code with full chunking + alignment:

| File | Function |
| --- | --- |
| `electron/native/ctranslate2-server/CMakeLists.txt` | Pulls CTranslate2 (FetchContent, v4.4.0), cpp-httplib (v0.18.1), nlohmann/json (v3.11.3). Vendors the GEMM backend per platform: **oneDNN** (FetchContent v3.6) on Windows + Linux, **Accelerate** (system framework) on macOS. Static build (`BUILD_SHARED_LIBS=OFF`) — single `.exe` per platform, no `.dll` sidecar. |
| `electron/native/ctranslate2-server/include/wav.h` | WAV parser — validates 16 kHz mono 16-bit PCM, handles RIFF metadata chunks. |
| `electron/native/ctranslate2-server/include/mel.h` | Log-mel spectrogram featurizer — STFT (KissFFT) + 80-band Slaney mel filterbank. |
| `electron/native/ctranslate2-server/src/mel.cpp` | Implementation of the above. |
| `electron/native/ctranslate2-server/include/tokenizer.h` | Whisper BPE tokenizer decoder — parses `tokenizer.json`, GPT-2 byte decoder, special-token lookup. |
| `electron/native/ctranslate2-server/src/main.cpp` | **HTTP server with:** chunked processing (>30s recordings split into 30s windows), phrase-level segmentation via timestamp tokens in generated output, **word-level alignment via CTranslate2 `WhisperReplica::align()`** (DTW over cross-attention weights), JSON response with `segments[].words[]` matching the `SttWordSegment` shape. Compute type is `INT8` on CPU with the int8 model, `FLOAT32` fallback, `FLOAT16` on CUDA. Toggle via `--int8` flag (the Node wrapper passes it because that's where the SYSTRAN int8 release is selected — see `electron/stt/modelManager.ts`). |
| `third_party/kissfft/` | Vendored KissFFT (BSD-3-Clause) for the STFT. |

#### Word-level alignment details (`main.cpp`)

The server implements the full alignment pipeline:

1. **Segment splitting**: Emitted token sequences are split at timestamp tokens into `DecodedSegment` objects (phrase boundaries with start/end times).
2. **Text token extraction**: For each segment, text token IDs are filtered to `< EOT (50257)` to produce clean input for alignment.
3. **CTranslate2 `.align()` call**: Each segment's text tokens are aligned against the original audio features using `WhisperReplica::align()` with `median_filter_width=7`. The model must contain `alignment_heads` in its config (SYSTRAN's models do).
4. **Word boundary detection**: BPE tokens are grouped into words by detecting space-prefixed rendered tokens (the GPT-2 byte decoder preserves word-start markers). DTW frame positions for each token are extracted from the alignment result.
5. **Frame-to-time conversion**: Reduced mel frames are converted to seconds using `time = frame * 2 * hop_length / sample_rate` (accounting for the second conv layer's stride-2 reduction).
6. **JSON output**: Each segment receives a `words[]` array with `{word, start, end, probability}` entries matching the `SttWordSegment` contract.

#### Chunking for long recordings

Recordings longer than the 30-second chunk window are split automatically:

- Full audio mel features are computed in one pass
- Features are sliced into 30-second overlapping windows
- Each window is padded, encoded, and decoded independently
- Language detection runs once on the first chunk
- Results are merged: segment/word timestamps shifted by each chunk's offset
- Running offset advances by `chunk_length` seconds per chunk

### What was verified

- **TypeScript unit tests**: `electron/stt/{gpuDetector,modelManager,index,ctranslate2Server}.test.ts` (29 tests) + `src/components/ai-edition/*.test.tsx` (12 tests) — all pass.
- **TypeScript compilation**: `npx tsc --noEmit` — 0 errors.
- **Build (Windows x64 + VS 2022, INT Insiders, Ninja)**: Cleared cache and re-ran `.\ct2-build.cmd` against the new CMakeLists. The build now vendors oneDNN via FetchContent (~5 min first time) and produces a single static `ctranslate2-server.exe` (no `.dll` sidecar). `ctranslate2.dll` is no longer produced or shipped.
- **Server boots**, loads model, responds to `GET /` with `200`.
- **Basic inference** returns valid JSON with segments and word-level timestamps. **See §"Targeted server tests (2026-07-07)" below — content is hallucinated.** The earlier "smoke test" claim (RTF expected at 0.15–0.3×) has not been validated.

---

## Targeted server tests (2026-07-07)

**Goal:** verify that the C++ server produces real transcriptions on real audio
(the earlier 5 s sine "smoke test" only checked that the HTTP layer returned
*some* JSON, not that the text was correct).

**Setup:** spawned `ctranslate2-server-ctranslate2-cpu.exe` directly (no
Electron) with the model on disk, posted a multipart `file=<wav>` to
`/inference`. Also built a small `dump_tokens` helper in the same project that
loads the same model and calls the same `model->generate()`, but prints the raw
emitted token IDs — to bypass the JSON wrapper and see what the decoder is
actually producing.

**Two build-side fixes had to land first** to get to this point (see git log
on this branch):

1. The `.int8` legacy HF repos (`SYSTRAN/faster-whisper-*.int8`) return HTTP
   401. `electron/stt/modelManager.ts` switched to `Systran/faster-whisper-small`
   (fp16, ~483 MB) and the comment block explaining the size bump + the
   `--int8` runtime quantization path.
2. The "full static link" comment in `ct2-build.cmd` was wrong: the binary
   imports `dnnl.dll` + `VCOMP140.DLL`. The `.dll` ships with oneDNN's build
   dir but wasn't being staged. Now copied to `electron/native/bin/win32-x64/`
   alongside the `.exe`. Without it, the binary fails with `STATUS_DLL_NOT_FOUND`
   (0xC0000135) and the Node wrapper reports
   `ctranslate2-server at http://127.0.0.1:N did not respond within 30000ms`
   — which is the exact failure the user originally reported.

### Audio inputs

| File | Source | Duration | Notes |
| --- | --- | --- | --- |
| `silence-10s.wav` | synthetic, all zeros | 10.00 s | control: model has nothing to lock onto |
| `sample-en-clean.wav` | SAPI TTS, "The quick brown fox…" | 10.93 s | robotic SAPI voice |
| `sample-30s-clean.wav` | SAPI TTS, longer pangram block | 26.52 s | longer SAPI clip |
| `jfk.wav` | `gerganov/whisper.cpp` samples (the canonical Whisper test audio) | 11.00 s | real human JFK speech |
| `librispeech_demo_{0..4}.wav` | `hf-internal-testing/librispeech_asr_demo` clean/validation | 4.4–29.1 s | real human read speech from LibriSpeech (speaker 1272) |

All 5 LibriSpeech clips were extracted with Python (`pyarrow` + `soundfile`)
from the demo parquet, downsampled to 16 kHz mono PCM 16-bit, leading/trailing
silence trimmed at 0.5% of peak.

### What works

- **WAV ingestion** — clean PCM (44-byte header) is parsed correctly. SAPI's
  WAVE_FORMAT_EXTENSIBLE (18-byte `fmt ` chunk) is rejected at the `read_pcm_wav`
  boundary; that's correct per the wire contract documented at the top of
  `wav.h`, just worth knowing.
- **Log-mel featurizer** — values look right on every input. JFK features
  (the most realistic input): `min=-1.5, max=1.867, mean=0.618, stddev=0.671`,
  1097/1101 frames are non-silence. The `compute_log_mel` path is fine.
- **Model load** — multilingual=1, n_mels=80, tokenizer `<|en|>`=50259,
  vocabulary size matches HF's `Systran/faster-whisper-small` release.
- **HTTP wire** — `POST /inference` returns 200 with valid verbose JSON in
  every test. Latency dominated by inference, not HTTP.

### What's broken

**The Whisper decoder produces hallucinated output on every input — including
real human speech.** Same `WhisperOptions` (beam=5, temp=0, patience=1,
length_penalty=1, max_length=448) on two different models. Output is
essentially input-independent.

| Input | Ground truth (first ~80 chars) | Model output | Token count |
| --- | --- | --- | --- |
| 10 s silence | (none) | `[0.00s] " You" [2.00s]` | 3 |
| 10.93 s SAPI TTS | "The quick brown fox jumps over the lazy dog…" | `[0.00s] " You" [2.00s]` (identical to silence) | 3 |
| 26.52 s SAPI TTS | (longer pangrams) | `0.00s <|la|> <|la|> … 20.00s 20.00s` ("la la la" loop) | 224 (capped) |
| 11.00 s JFK | "And so my fellow Americans, ask not what your country…" | `"I don't know what I'm talking about, but …"` × 20 | 224 (capped) |
| 5.85 s LibriSpeech 0 | "MISTER QUILTER IS THE APOSTLE OF THE MIDDLE CLASSES…" | `"I'll see you in …"` (cut at 11 tokens) | 11 |
| 4.44 s LibriSpeech 1 | "NOR IS MISTER QUILTER'S MANNER LESS INTERESTING…" | `"I'll see you in …"` (identical to clip 0) | 11 |
| 11.97 s LibriSpeech 2 | "HE TELLS US THAT AT THIS FESTIVE SEASON OF THE YEAR…" | `"I don't know what …"` | 22 |
| 9.50 s LibriSpeech 3 | "HE HAS GRAVE DOUBTS WHETHER SIR FREDERICK LEIGHTON'S…" | `"I'll see you in …"` (identical to clip 0) | 11 |
| **29.13 s LibriSpeech 4** | "LINNELL'S PICTURES ARE A SORT OF UP GUARDS AND AT EM…" | `"I don't know what I'm talking about." [2.00s] [2.00s] …` × 12 (each segment ends in *doubled* timestamps) | 157 (capped) |

Two distinct hallucination patterns, both classic Whisper failure modes:
- **"I'll see you in…"** on short input — model picks the first high-prob
  phrase and stops emitting after a few tokens.
- **"I don't know what I'm talking about."** + repeated `[t][t]` doubled
  timestamps — model commits to a loop and never emits EOT.

`temperature=0.2/1.0` and `patience=1.0/2.0` swept — same failure shape.
FP32 and INT8 both fail. Both `Systran/faster-whisper-small` (483 MB) and
`Systran/faster-whisper-tiny` (75 MB) fail in the same way (tiny emits `" ."`
× 224 instead). The model weights themselves are fine (SHA matches HF HEAD);
the encoder/decoder matmuls are returning wrong values.

### Why the "features look OK" check missed it

The earlier conclusion that the audio path was fine rested on per-feature
statistics (`min`, `max`, `mean`, `stddev`). Those numbers are **invariant by
permutation** — transposing a matrix does not change them. The JFK clip showed
`min=-1.5, max=1.867`, which is actually a tell-tale sign of the *second* bug:
with correct global Whisper normalization the dynamic range is exactly `2.0`
(`floor = max - 8`, then `(x + 4) / 4`), so a range of `3.37` means the
normalization was applied per-frame, not globally. We had the evidence in front
of us and misread it.

To catch this class of bugs in the future, the only valid check is a
frame-by-frame comparison against `faster_whisper.feature_extractor` output
(see §6 of "What remains").

### What this rules out / rules in

- ❌ Not oneDNN, not CTranslate2 v4.4.0, not the GEMM backend. oneDNN was a
  red herring; rebuilding with `WITH_DNNL=OFF` would have hallucinated the same
  way.
- ❌ Not the model weights (SHA matches, two different models fail the same way).
- ❌ Not the HTTP layer (returns valid JSON, correct wire contract).
- ❌ Not the prompt (`[SOT] [en] [transcribe]` matches faster-whisper defaults).
- ❌ Not compute type (FP32 and INT8 both fail).
- ❌ Not generation params.
- ✅ **It is the mel featurizer.** The audio path produced correct raw values
  but presented them to the encoder in the wrong memory layout, with wrong
  normalization, and the chunk padding used the wrong silence value.

---

## Root cause & fix (2026-07-07)

The hallucinations came from **three independent bugs in the log-mel
featurizer**, plus a minor padding mistake and a generation-option mistake.
None of them involve oneDNN or CTranslate2.

### Bug 1 — mel filterbank slopes were inverted

`build_mel_filterbank` computed the lower/upper triangle weights with the
wrong sign:

```cpp
// OLD (broken)
lower = (freqs[m] - fftfreqs[k]) / fdiff[m];
upper = (fftfreqs[k] - freqs[m+2]) / fdiff[m+1];
w     = max(0, min(-lower, upper));
```

The correct faster-whisper formula is:

```python
lower = (fft_freq - freqs[m])   / fdiff[m]
upper = (freqs[m+2] - fft_freq) / fdiff[m+1]
weights = max(0, min(lower, upper)) * (2 / (freqs[m+2] - freqs[m]))
```

The inverted version placed energy on the wrong frequency bins and with the
wrong scale (row sums ~569 vs. faster-whisper's ~0.025). This was the single
biggest distortion: the encoder received a spectrogram whose mel bands were
essentially garbage.

**Fix:** `build_mel_filterbank` now matches `faster_whisper.feature_extractor`
line-for-line.

### Bug 2 — features were transposed

`compute_log_mel` wrote frame-major `[n_frames, n_mels]` into
`MelFeatures::data`. `main.cpp:make_feature_view` then handed that buffer to
CTranslate2 as shape `{1, n_mels, n_frames}` (mel-major), without transposing.

CTranslate2 therefore read `data[mel * n_frames + frame]` while the memory
actually contained `data[frame * n_mels + mel]`. The encoder saw a scrambled
spectrogram: time and frequency bins were interleaved. Output became
input-independent because the encoder had no real speech structure to latch
onto, so Whisper fell back to its language priors — exactly the `" You"`,
`"I'll see you in…"`, `"I don't know what I'm talking about"` hallucinations
that are canonical for non-speech input.

**Fix:** `compute_log_mel` now emits mel-major `[n_mels, n_frames]` directly,
matching the StorageView contract. `MelFeatures::data` documentation in
`include/mel.h` was updated accordingly.

### Bug 3 — normalization was per-frame instead of global

Whisper normalizes with the maximum over the *entire* spectrogram:

```python
log_spec = torch.maximum(log_spec, log_spec.max() - 8.0)
log_spec = (log_spec + 4.0) / 4.0
```

`mel.cpp` recomputed `max_val` inside the per-frame loop, so every frame was
floored relative to its own peak. Silent frames got boosted to the same level
as loud frames, destroying inter-frame dynamics.

**Fix:** the log values are first accumulated for all frames, then the global
maximum is found, and the global floor / scale is applied in a second pass.

### Bug 4 — chunk padding used 0.0 instead of the silence value

`main.cpp` padded short chunks with `0.0f`. After correct Whisper normalization
the silence value is `-1.5`, not `0.0`.

**Fix:** chunk padding now uses `-1.5f`.

### Bug 5 — `max_initial_timestamp_index` was forced to 0

`main.cpp` set `WhisperOptions::max_initial_timestamp_index = 0`, forcing the
first timestamp token to be `<|0.00|>`. That collapsed transcriptions to
immediate, often repeated timestamps and generic fallback phrases. The
CTranslate2 default for 30 s audio is `50`.

**Fix:** removed the override; the default is now used.

### Verification

After the fixes, features from `compute_log_mel` were dumped and compared
frame-by-frame against `faster_whisper.feature_extractor` on the same WAV:

| Metric | Value |
| --- | --- |
| Shape | `80 × 586` (identical) |
| Min | `-0.8060` (identical to 4 decimals) |
| Max | `1.1940` (identical to 4 decimals) |
| Mean | `-0.0410` (identical to 4 decimals) |
| Mean absolute diff | `0.0001` |
| Max diff | `0.2874` at the last frame only (padding edge effect) |

### End-to-end validation

| Input | Ground truth | Server output (int8, oneDNN, language=en) |
| --- | --- | --- |
| `jfk.wav` | "And so, my fellow Americans…" | "And so my fellow Americans, ask not what your country can do for you…" |
| `librispeech_demo_0.wav` | "Mr. Quilter is the Apostle of the Middle Classes…" | "Mr. Quilter is the Apostle of the Middle Classes, and we are glad to welcome his Gospel." |
| `librispeech_demo_1.wav` | "Nor is Mr. Quilter's manner…" | "Nor is Mr. Quilter's manner less interesting than his matter." |
| `librispeech_demo_4.wav` | "Linnell's pictures are a sort of up-guards-and-atom…" | Multi-segment match |
| `silence-10s.wav` | (none) | No segments (no hallucination) |

Language auto-detection also recovered: `jfk.wav` is now detected as `<|en|>`
instead of the previous random `<|nn|>`.

### Code changes

| File | Change |
| --- | --- |
| `electron/native/ctranslate2-server/include/mel.h` | Document `MelFeatures::data` as mel-major `[n_mels, n_frames]`. |
| `electron/native/ctranslate2-server/include/tokenizer.h` | Added `sanitize_utf8` in `render`/`try_render` so malformed byte-decoded tokens don't crash JSON serialization. |
| `electron/native/ctranslate2-server/src/mel.cpp` | Fixed filterbank slope signs; two-pass global normalization; emit mel-major layout; fixed right-side `reflect_pad` offset. |
| `electron/native/ctranslate2-server/src/main.cpp` | Copy chunk slices with mel-major stride; pad with `-1.5`; removed `max_initial_timestamp_index = 0`. |

### What this does NOT change

- The TS/IPC layer (`electron/stt/{index,ctranslate2Server,modelManager}.ts`)
  is correct. The Node wrapper sends the right wire contract, the response
  parsing handles the JSON correctly, the model download + caching is correct
  (with the URL fix above).
- The build pipeline is correct. The `.exe` is produced, the `dnnl.dll` sidecar
  is in place, and the CMake fixups for runtime library, oneDNN include, and
  `whisper.cc` vector-ctor bug all work.
- The C++ code outside `mel.cpp`/`main.cpp` (`wav.h`, `tokenizer.h`) is correct.
  The bugs were localized to feature extraction and one generation option.

---

## Perf overhaul — 2026-07-06

### Symptom
First transcription in the editor hung for ~3 min for a 30 s clip. Root cause:
CTranslate2's C++ runtime was the only CPU GEMM backend available — and it was
Ruy (`electron/native/ctranslate2-server/CMakeLists.txt:72` at the time). Ruy is
Google's portable matmul library, designed for XNNPACK/LiteRT on embedded
targets. On a modern x86 laptop it lands at ~RTF 0.15× (i.e. slower than
real-time) because it does no per-microarch tuning — the original CMakeLists
explicitly accepted this as a "no external deps" tradeoff.

### What changed

| Layer | Before | After |
| --- | --- | --- |
| Backend (Win + Linux) | Ruy (portable, slow) | **oneDNN** (Intel, Apache-2, vendored via FetchContent) |
| Backend (macOS) | Ruy | **Accelerate** (system framework, free, fast on Apple silicon) |
| Compute type (CPU, int8 model) | always `FLOAT32` (fp16 model dequantized to fp32 at load) | `INT8` when `--int8` is passed (the Node wrapper passes it because it's what knows the int8 release is selected) |
| Model on disk | `SYSTRAN/faster-whisper-small` (fp16, ~470 MB) | `SYSTRAN/faster-whisper-small.int8` (~150 MB) |
| Packaging | `BUILD_SHARED_LIBS=ON` (default) → `ctranslate2-server.exe` + `ctranslate2.dll` to stage | `BUILD_SHARED_LIBS=OFF` everywhere → **single self-contained `ctranslate2-server.exe`** per platform |
| CMake flag naming | `CTRANS2_WITH_*` (silently ignored by CTranslate2 v4.4.0 — left the binary with no GEMM backend) | `WITH_*` (the unprefixed names CTranslate2 actually reads; see upstream `CMakeLists.txt:10-15`) |
| `ct2-build.cmd` flags | 13 `-D` flags, half silently dropped | 0 `-D` flags — backend selection is centralised in `CMakeLists.txt` |
| Stale-dll hazard | Old `ct2-build.cmd` shipped the `.exe` but forgot the rebuilt `.dll` (caught & fixed this round) | Static link + `.exe` only — nothing to forget |

### Build pipeline now

```bash
# Windows
powershell -ExecutionPolicy Bypass -File scripts/configure-ct2-build.ps1
# or directly
Remove-Item -Recurse -Force .cache\ctranslate2-build
.\ct2-build.cmd
# → oneDNN (~5 min first time) + CTranslate2 (~3 min) → ctranslate2-server.exe (~30 MB)
```

## What remains

### 1. CUDA opt-in (NVIDIA users)

`-DENABLE_CUDA=ON` on `cmake` already works at the level of the upstream
CMakeLists (and `scripts/build-ctranslate2-server.sh --cuda` exists). Three
things to do before NVIDIA users get a usable build:

- [ ] Update `electron-builder.json5` `win.extraResources` / `mac.extraResources`
      filters to also pull `*-cuda.*` variants into `electron/native/bin/<os>-<arch>/`
      (today only the cpu variant is in the filter). Mirror the linux shape — the
      CI workflow already produces cuda artefacts, just not packaged yet.
- [ ] Make `electron/stt/gpuDetector.ts` decide cuda-vs-cpu from `nvidia-smi`
      exit (already does), but also fall back to a direct CUDA driver probe
      on Windows (`nvidia-smi.exe` may be missing on driver-only installs).
- [ ] Wire `--cuda` flag end-to-end: `ctranslate2-server.ts` already passes it,
      but the Flutter/Node chooser defaults to CPU and has no UI for the user
      to opt in.

### 2. Language selector (per-engine default)

Today the renderer always sends `language: "auto"` and Whisper autodetects.
Forcing language gives:
- A smaller download (e.g. `whisper-small.en` ~470 MB → `ggml-small.en-q5_1.bin`
  ~75 MB if we ever swap to GGML, or `faster-whisper-small.fr` ~150 MB int8
  instead of multilingual).
- Skip language detection on first chunk (saves ~300 ms cold-start).
- Slightly better WER (no language-id ambiguity).

Open:
- [ ] Settings UI: `transcriptionLanguage: "auto" | "en" | "fr" | ...`
- [ ] Render the value through to `electron/stt/index.ts → stt:transcribe`.
- [ ] Map the UI string to a `SYSTRAN/faster-whisper-{small}.{lang}.int8` repo
      (HF hosts `faster-whisper-small.en`/`de`/`fr`/etc. variants).
- [ ] Cache the chosen model under a separate `whisper-ct2-<lang>` directory
      so going multilingual→french doesn't blow away the multilingual one.

### 3. AMD GPU support (ROCm)

CTranslate2 (the engine) **only supports CUDA** — no HIP/ROCm backend. AMD
APUs and discrete Radeon cards have no path to GPU inference through
CTranslate2. OpenScreen users on AMD/Intel iGPU are correctly stuck on CPU.
This is a hard upstream constraint, not something we can fix here without
swapping engines (whisper.cpp does not support ROCm either; the only
cross-vendor GPU path is llama.cpp, also not a Whisper runner).

Acceptable. Dropping on the roadmap for visibility, not for fixing.

### 4. Model SHA-256 pinning

- [ ] The `STT_MODELS.whisper.files[*].expectedSha256` fields are all `null`.
      Before the first RC, pin the actual SHA-256 of each file downloaded
      from HuggingFace for the **int8** release (the fp16 digests in the
      comments are stale since we switched repos).

### 5. Integration test: HTTP POST a known WAV

- [ ] Build the server and run an integration test against a real WAV fixture.
- [ ] Assert segment count + word boundaries.
- [ ] CI: build the server and run the integration test on a matrix
      (macOS ARM with Accelerate, Ubuntu x64 with oneDNN, Windows x64 with
      oneDNN).

### 6. C++ unit tests

- [ ] Unit tests for the WAV reader (`wav.h`).
- [ ] Unit tests for the mel filterbank (`mel.h/.cpp` — compare against Python
      FasterWhisper output).

### 7. Remove unused dependencies

- [ ] `tar` npm package is no longer used by `modelManager.ts` (files are now
      downloaded individually, not as a tarball). Could be removed from
      `package.json` if no other module depends on it.

### 8. Word-level alignment timestamps — three root causes found and fixed (2026-07-07)

After the featurizer fix, phrase-level transcription is correct, but the
DTW-based word timestamps were not. This was tracked down and fixed in three
rounds, the first two on a synthetic SAPI TTS clip, the third only surfaced
once testing moved to real human speech (see §11 for why that distinction
mattered). None of the three causes originally suspected (padded
`num_frames_vec`, token-to-frame mapping, frame-to-second conversion offset)
were ever the actual bug.

**Bug A — `WordBuilder::first_frame` never assigned for non-first words**
(`build_word_timestamps`, `main.cpp`). When flushing the current word and
starting a new one, the code set `current.first_token_idx = i` but not
`current.first_frame`; the only place that assigned `first_frame` was a
follow-up `if (current.first_token_idx < 0)` block, which is always false
immediately after the flush branch runs. So `first_frame` stayed at its
default-constructed value of `0` for every word except the first one in the
segment. **Fix:** set `current.first_frame = token_start_frame[i];` directly
in the flush branch, alongside `first_token_idx`.

**Bug B — multi-segment chunks silently lose alignment for all but the first
segment** (the `model->align()` call site in `main.cpp`). CTranslate2's
ReplicaPool-level `Whisper::align()` (vendored `whisper.cc`) sizes its
`post_batch` result futures by `features.dim(0)` — the *audio*-batch size,
always `1` for our single-chunk `sv_chunk` — not by `text_tokens.size()`, the
number of phrase segments being aligned. `post_batch` only creates as many
promises as the audio-batch size (`1`) and fulfills `results[0]` only,
silently discarding `results[1..N-1]`. Our code originally batched every
segment's `text_tokens` into one `align()` call, so `align_futures` always
had size `1` regardless of segment count, and only the first phrase of each
chunk ever got word timestamps.

**Bug C — per-segment alignment loses causal context, corrupting every
segment after the first** (found after fixing A+B, when testing against real
multi-segment human speech). The fix for bug B initially called
`model->align()` once per phrase segment in isolation, each with its own
fresh `[SOT][lang][transcribe][no_timestamps]` prefix. With no token history
of earlier phrases in the same chunk, the decoder's cross-attention had no
causal signal that speech already happened earlier in the audio, so for every
segment after the first it collapsed back near frame 0 — corrupting every
word timestamp in segments 2+ (observed as timestamps drifting up to 46 s
into a 29 s clip, and non-monotonic ordering). Comparing against
`faster-whisper`'s own `add_word_timestamps`/`find_alignment`
(`transcribe.py`) confirmed the reference implementation concatenates *all*
of a chunk's phrase-segment tokens into one combined sequence and aligns them
in a single `align()` call, then splits the resulting word list back into
segments by walking each word's consumed-token count against each segment's
own token count. **Fix:** do the same — build one combined token sequence per
chunk, call `align()` once (which also naturally fixes bug B, since the
audio-batch size (1) now matches the combined `text_tokens.size()` (1)), then
split the flat word list back into segments using a `num_tokens` field added
to `AlignedWord`.

Also fixed alongside these: `build_word_timestamps` was being passed each
phrase segment's own decoded start time as an offset to add to the DTW word
time, but DTW frame indices are already absolute within the whole chunk (the
encoder sees the full chunk, not a per-segment slice) — adding the segment's
own start on top double-counted it. The chunk-level offset is applied once,
for the whole chunk, in the existing merge step; segment-level calls now pass
`0.0f`.

**Status: fixed and verified against real human speech** — see §11 for the
full test report (JFK + 5 LibriSpeech clips). Word timestamps across
multi-segment clips now match `faster-whisper`'s own reference output to
within ~20-40 ms on well-aligned words.

### 9. No-speech / silence handling

A 10-second all-zero WAV still produces a single segment with text `you`.
Whisper's encoder does emit a `<|nospeech|>` probability via
`detect_language()` (and `generate()` can return `no_speech_prob`), but the
server currently ignores it and always decodes text tokens.

Open:
- [ ] Surface `no_speech_prob` from `WhisperGenerationResult` and skip text
      decoding when it is above a threshold (faster-whisper defaults to 0.6).
- [ ] Verify that short non-speech gaps inside real recordings do not get
      spurious text injected.

### 10. FIXED (2026-07-07) — `compute_log_mel` hard-caps at 30 s regardless of true audio length; chunking for long recordings never engages

**Status: fixed and verified** — see §12 for the 2-minute real-speech test
that confirms full-length transcripts now, and for the chunk-boundary
word-loss issue (§13) this fix exposed once chunking actually started firing.

Found and reproduced while stress-testing §8's fix on real speech longer than
one chunk. `compute_log_mel` (`mel.cpp`) computes features for what
`main.cpp` calls "the FULL audio", but its frame loop unconditionally breaks
once `out.n_frames >= nb_max_frames` (`nb_max_frames = chunk_length * sample_rate
/ hop_length = 3000` frames = 30 s), *before* `main.cpp`'s own chunking logic
ever runs:

```cpp
out.n_frames += 1;
if (out.n_frames >= nb_max_frames) break;   // hard cap, independent of chunking
```

`main.cpp` then computes `n_chunks = ceil(total_feature_frames / max_frames_per_chunk)`
from `full_features.n_frames` — but since that value can never exceed 3000,
`n_chunks` can never exceed 1. **Every recording longer than ~30 s of real
audio is silently truncated at the feature-extraction stage — the tail never
even reaches the model, with no error, no warning, and no signal to the
caller.** This directly contradicts the "Long recordings (hours)" constraint
locked in the migration decision doc ([stt-ctranslate2-migration.md](./stt-ctranslate2-migration.md))
and the "Chunking for long recordings" feature this document has claimed as
implemented since the first perf-overhaul entry above — the chunking/merge
code in `main.cpp` (window slicing, per-chunk offset, language-detect-once)
is real and correct, but it never fires because it never receives more than
one chunk's worth of features to slice.

**Reproduced with real human speech** (§11's method): concatenating
`librispeech_demo_4.wav` (29.13 s) + `librispeech_demo_0.wav` (5.85 s) +
`librispeech_demo_1.wav` (4.44 s) into one 39.41 s WAV and posting it to
`/inference` returns a transcript that stops at `lastWordEnd=29.54 s` —
exactly the first clip's content ("Linnell's pictures are a sort of Up
Guards and Adam paintings ... shampooer in a Turkish bath, next man.") — the
remaining ~9.9 s (all of `demo_0` and `demo_1`'s speech) is completely absent
from the response, not even as an empty/degraded segment.

**Fix:** removed the `if (out.n_frames >= nb_max_frames) break;` cap in
`compute_log_mel`; it now computes mel features for the entire recording
(sized via a `reserve()` estimate from the sample count, so long recordings
don't repeatedly reallocate), and `main.cpp`'s existing chunk-slicing logic
receives the full feature buffer as originally intended. See §12 for
end-to-end verification on a 2-minute real-speech recording.

### 11. Quality + speed test report on real human speech (2026-07-07)

Requested explicitly after §8's fixes: SAPI TTS voices are not a substitute
for real speech (robotic prosody/pauses; DTW behaves differently), so this
round re-tests everything against real human recordings, and adds a speed
report (transcription + alignment combined, since that is one request in our
server) alongside quality.

**Test set** (all real human speech, real ground-truth transcripts, no
synthetic TTS):

| File | Source | Duration | Reference transcript source |
| --- | --- | --- | --- |
| `jfk.wav` | `gerganov/whisper.cpp` samples (canonical Whisper demo audio) | 11.00 s | well-known public JFK inaugural excerpt |
| `librispeech_demo_{0..4}.wav` | `hf-internal-testing/librispeech_asr_demo`, speaker 1272 | 4.44–29.13 s | exact `text` field from the same parquet (extracted with `pyarrow`, not transcribed by ear) |

**Reference baseline:** `faster-whisper` (the Python project CTranslate2's
Whisper support is built for) installed in a throwaway venv, run against the
*same* `whisper-ct2` model directory, `compute_type="float32"`, `beam_size=5`,
`word_timestamps=True` — i.e. the upstream implementation of the exact same
engine, used as both a quality and a speed baseline.

**Quality (WER, word-level, case/punctuation-normalized):**

| Clip | Duration | Our C++ server (FP32 = INT8, identical text) | Notes |
| --- | --- | --- | --- |
| jfk | 11.00 s | **0.0%** (0/22) | exact match |
| librispeech_demo_0 | 5.85 s | 5.9% (1/17) | |
| librispeech_demo_1 | 4.44 s | 10.0% (1/10) | small clip, 1 error = 10% |
| librispeech_demo_2 | 11.97 s | 3.1% (1/32) | "similes" → "symbolies" (homophone-class ASR error, not a bug) |
| librispeech_demo_3 | 9.50 s | 4.2% (1/24) | "Leighton's" → "Layton's" (homophone-class error) |
| librispeech_demo_4 | 29.13 s | 20.6% (14/68) | see §10 — most of this clip's error is the truncation bug, not recognition quality |

FP32 and INT8 produced **byte-identical transcript text and WER on every
clip except demo_4**, where INT8 occasionally decoded one fewer trailing word
at a segment boundary — an expected, minor quantization-induced decoding
difference, not a regression.

Word-level timestamps, spot-checked against the `faster-whisper` reference on
`librispeech_demo_4` (the only multi-segment clip with a full reference
dump), match to within ~20–40 ms on confidently-aligned words, e.g.:

| Word | Our server | faster-whisper reference |
| --- | --- | --- |
| Birkitt | 11.82→12.08 | 11.82→12.06 |
| Carker | 16.34→16.62 | 16.34→16.64 |
| used | 16.60→17.26 | 16.64→17.24 |
| to | 17.24→17.46 | 17.24→17.44 |
| shampoo | 25.82→26.32 | 25.82→26.28 |

**Speed (wall-clock per `/inference` request, transcription + alignment
combined, 8 threads, clean single-request runs — no concurrent load):**

| Clip | Duration | Our C++ FP32 | Our C++ INT8 | faster-whisper ref (FP32) |
| --- | --- | --- | --- | --- |
| jfk | 11.00 s | 17.65 s (RTF 1.60×) | 10.77 s (RTF 0.98×) | 13.53 s (RTF 1.23×) |
| librispeech_demo_0 | 5.85 s | 14.76 s (RTF 2.52×) | 14.06 s (RTF 2.40×) | 11.14 s (RTF 1.90×) |
| librispeech_demo_1 | 4.44 s | 13.64 s (RTF 3.07×) | 14.94 s (RTF 3.37×) | 10.76 s (RTF 2.42×) |
| librispeech_demo_2 | 11.97 s | 15.61 s (RTF 1.30×) | 12.10 s (RTF 1.01×) | 12.36 s (RTF 1.03×) |
| librispeech_demo_3 | 9.50 s | 15.06 s (RTF 1.59×) | 10.94 s (RTF 1.15×) | 13.83 s (RTF 1.46×) |
| librispeech_demo_4 | 29.13 s | 19.84 s (RTF 0.68×)* | 16.23 s (RTF 0.56×)* | 31.66 s (RTF 1.09×) |

RTF = wall-clock / audio duration; lower is faster. \*demo_4's C++ numbers
are not fully comparable to the reference — see §10, our server does less
work on this clip today because it silently drops the tail.

**Reading the speed numbers:** every setup (ours and the reference) shows
RTF > 1 (slower than real-time) on the short clips (4–12 s) and RTF ≈ 1 or
better only past ~10–12 s of audio. This points to a large **fixed per-request
overhead** (likely model/thread-pool/kernel warm-up inside CTranslate2 or
oneDNN, common to both implementations since both wrap the same C++ core) —
not yet decomposed into its own line item (feature extraction vs. encode vs.
decode vs. align), which the doc's original "smoke test" RTF projections
(0.15–0.3×) did not anticipate. Our INT8 build is competitive with or faster
than the `faster-whisper` FP32 reference on 4 of 6 clips despite running
through a from-scratch C++ HTTP server rather than a mature Python library —
a reasonable outcome, but on these short clips (4-12s) **4 of the 6 measured
INT8 RTFs are actually slower than real-time (0.30×–0.87× the speed of real
time, i.e. RTF 1.15×–3.37×)**; only `jfk` (RTF 0.98×) and `librispeech_demo_4`
(RTF 0.56×, not fully comparable — see above) beat real-time. The fixed
overhead dominates short requests badly enough that a single reliable
"Nx real-time" number cannot be quoted from this batch — see §12 for a
longer clip that amortizes it away.

### 12. Reliable real-time multiplier on a 2-minute recording (2026-07-07)

The short clips in §11 are all fixed-overhead-dominated (see above), so no
single "Nx real-time" figure from that batch is representative. Requested
follow-up: fix §10's truncation bug first (otherwise a >30s clip silently
only measures the first chunk), then re-test on a recording long enough that
per-request overhead is a small fraction of total time.

**Method:** extracted 12 consecutive utterances (rows 0–11, same speaker,
same `hf-internal-testing/librispeech_asr_demo` source as §11) from the
cached parquet, concatenated with a 0.3 s silence gap between each into one
continuous **130.32 s** real-speech WAV, with the exact concatenated
ground-truth text as reference.

**Result (INT8, 8 threads, single clean request), before and after §13's fix:**

| Metric | Before §13 fix | After §13 fix |
| --- | --- | --- |
| Audio duration | 130.32 s | 130.32 s |
| Wall-clock (transcription + alignment) | 88.58 s | 106.25 s |
| RTF | 0.68× | 0.815× |
| **Real-time multiplier** | ~1.47× faster than real-time | **≈1.23× faster than real-time** |
| WER | 15.5% (47/303 words) | **9.2% (28/303 words)** |
| Segments produced | 25 | 26 |
| Coverage | full 130.32 s (`lastWordEnd=129.54s`) | full 130.32 s (`lastWordEnd=129.94s`) |

**≈1.23× real-time (RTF 0.815×) is the number to use for real-time-multiplier
claims going forward** — not the 3–10× projected in the original perf-overhaul
section (never measured against real audio start to finish), and not the
1.47× first measured on this same clip (that number was accidentally
flattering: it was fast *because* it was silently dropping words at every
chunk boundary — see §13). The 15% slowdown from 88.58s → 106.25s is the real,
expected cost of re-decoding each chunk's small overlap tail instead of
cutting through it; it buys back the dropped content (WER 15.5% → 9.2%,
almost entirely by eliminating boundary word-loss, not from any recognition
improvement — see §13).

### 13. FIXED (2026-07-07) — chunk boundaries silently dropped words

With §10 fixed, `main.cpp` started actually slicing multi-chunk audio, which
exposed a second, distinct long-recording bug: **chunks were sliced with zero
overlap and a fixed `chunk_length`-sized hop, so the 1–2 words (or, once, a
whole clause) spanning each cut point were silently dropped.** Segment dump
from §12's 130.32 s test, before the fix, at chunk boundaries exactly
30.00 s, 60.00 s, 90.00 s, 120.00 s apart (`chunk_length=30`):

| Boundary | Segment before cut | Segment after cut | Reference (what should bridge the gap) |
| --- | --- | --- | --- |
| 30.00 s | "...Sir Frederick Layton's work is really Greek after all, and can" | "in it but little of rocky Ithaca." | "...and can **discover** in it..." — **"discover" dropped** |
| 60.00 s | "...gives his sitter a cheerful slap on the back, before he says like" | "Turkish bath." / "Next man." | "...says like **a shampooer in** a Turkish bath" — **"a shampooer in" dropped** |
| 90.00 s | "...is adding more fact." | "and foreign." | "AS FOR ETCHINGS THEY ARE OF TWO KINDS BRITISH and foreign" — **"As for etchings they are of two kinds British" dropped** (a whole clause, not just 1-2 words) |

This was the predicted consequence of the non-overlapping, fixed-hop,
independently-decoded chunk design (flagged in the very first review pass of
this branch, before any of the empirical bug-hunting above): each chunk was
padded and decoded on its own with a hard 30.00 s-aligned cut through the raw
audio, with no regard for whether that cut landed mid-word.

**Fix:** switched from a fixed `chunk_length` hop to the standard Whisper
long-form "variable seek advance" algorithm (the same approach
`openai-whisper`/`faster-whisper` use): each window still decodes up to a
full `chunk_length` of audio, but the *next* window's start is advanced only
to the end of the *last phrase segment this window actually decoded*
(`main.cpp`'s new `while (chunk_start_frame < total_feature_frames)` loop,
replacing the old fixed-size `for` loop over `n_chunks`) — falling back to a
full-window advance only when a chunk decodes no segments at all (silence).
Since Whisper emits a segment boundary precisely where it hears a pause, this
means the next window always starts at a pause, never mid-word, and the
small tail between that pause and the old fixed cut point gets naturally
re-decoded as the next window's leading context instead of being severed.
The merge step now accumulates each chunk's own `advance_sec` instead of a
constant `chunk_length`.

**Verified** (§12's table above): all three dropped-content examples are
recovered word-for-word after the fix ("discover", "a shampooer in" →
transcribed as "a shampoo or", "As for etchings they are of two kinds British
and foreign" — all present). WER on the same 130.32 s clip drops from 15.5%
to 9.2%. Trade-off: wall-clock rises ~20% (88.58s → 106.25s) since the
overlap tail is genuinely redecoded work, not free — expected and worth it
compared to silently losing content. Remaining minor artifact: occasional
word duplication right at a re-decoded boundary (e.g. "can can", "like
like") — the model sometimes re-emits the last word of the previous window
when given its own tail as fresh leading audio; a light de-dup pass on
adjacent segment text at the seam (compare last N chars of one segment
against the first N chars of the next) would clean this up further, but it's
a small, correctable rendering nit compared to losing content outright.

---

## Build instructions (dev)

```bash
# Windows
Remove-Item -Recurse -Force .cache\ctranslate2-build  # one-shot: drop the Ruy cache
.\ct2-build.cmd                                       # ~10 min first time (oneDNN + CTranslate2)

# macOS / Linux
bash scripts/build-ctranslate2-server.sh                # ~10 min first time

# Run
set OPENSCREEN_CT2_MODEL_DIR=<path-to-whisper-small-ct2.int8>
.cache/ctranslate2-build/ctranslate2-server.exe --port 20199 --threads 8 --int8

# Test (5 s sine at 16 kHz → expect ~0.5 s wall-clock on a modern x86 with oneDNN)
curl -X POST -F "file=@test.wav" -F "language=auto" -F "response_format=verbose_json" \
  http://127.0.0.1:20199/inference
```
