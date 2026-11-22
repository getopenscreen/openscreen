# Proof for #1651: cursor spring restarts at clip windows

**The live head is now 975a248: see [975a248/README.md](975a248/README.md).** This page covers the first head.

**Head** 6a20551a8dc67bc187af689012334e53eeff5fbd against **base** main 128ab637 (its merge base).

## Verdict

**No regression found, but the proof does not meet every point.**

- **Auto-focus zooms move too.** An auto-focus zoom that starts within about 1.5 s after a window start is framed differently for its whole span: about 8 px horizontally and 1 px vertically at 1080p. The cursor drives this, and it is a visible change beyond the cursor itself.
- **No real-app preview run.** Preview frame rate (point 3) and preview-versus-export (point 4) were not measured in the real app. The only GPU host was the owner's desktop, and opening the app's window there is not allowed.

## Setup

- **Host:** Windows 11, D3D11. This is the host the worker ran on, used headless with no window.
- **Mac not usable:** it was leased first, but it has no Rust toolchain and no ffmpeg.
- **Source:** a real 32 s 1920x1032 at 60 fps recording with its `.cursor.json`. The cursor moves a lot across the cut.
- **Scenes:**
  - "single": one untrimmed clip, 0 to 32 s.
  - "cut": two windows of the same file, 1.0 to 7.5 s and 18.5 to 30 s. The cut falls at output frame 195.
  - Output is 1080p at 30 fps. Cursor smoothing is 0.5.
  - "heavy" adds a blurred background, shadow, motion blur, cursor motion blur and two zooms at 1.8x and 1.6x. It runs once with auto focus and once with manual focus.
- **Frames:** `timeline_walk::render_frames` gives the export's own walk, read back as RGBA. Each frame is hashed and many are saved as PNG.
- **Timing:** `pipeline::run_composited_multi` is the real MP4 export.
- **Harness:** `proof_1651.rs` and `proof_bench.rs` in this folder.

## Results

### 1. One untrimmed clip: pass

- **Frames:** 960 of 960 RGBA frames are pixel-identical (`single-compare.txt`).
- **Encoded MP4:** decoded `framemd5` is identical for base and head.

### 2. Cut project: pass for the cursor, plus a wider auto-focus change

**Light scene** (`cut-compare.txt`):

- **Identical:** 447 of 540 frames are identical.
- **Where diffs fall:** the other 93 are the first ~1.3 s after each window start, at frames 0 to 39 and 195 to 251.
- **Diff size:** every diff fits inside one cursor-sized box, about 120x60 px at most.

**Cursor position against the raw pointer**, rendered with smoothing 0. Distances are between cursor centroids at 1080p (`cut_montage.png`):

| frame | base to raw | head to raw |
|---|---|---|
| 195 (first after the cut) | 80.4 px | **0.0 px** |
| 196 | 77.8 | 12.9 |
| 200 | 75.7 | 48.4 |
| 214 | 33.8 | 32.2 |

- **Head:** starts on the real pointer, then follows it with the normal spring lag.
- **Base:** starts 80 px off, where the hidden footage had dragged the spring.
- **Frame 0** (the first window starts at 1.0 s): head is pixel-identical to raw, base is about 4 px off.

**Heavy scene, manual focus** (`heavyman-compare.txt`): 106 frames differ. They all fall right after a window start, and the largest diff box is 6954 px², the size of a cursor.

**Heavy scene, auto focus** (`heavy-compare.txt`, `autofocus_montage.png`):

- **Scope:** 299 frames differ. Frames 240 to 442 differ over the whole frame.
- **Cause:** the auto-focus zoom over 20 to 26 s source follows the smoothed cursor (`regions.rs` `resolve_focus` → `follow_in_view`). Its filter starts at the ease-in, at about 19 s, while the restarted spring is still settling. The dead zone then keeps that offset.
- **Size:** the frame is shifted about 8 px horizontally and 1 px vertically. It is the same picture, panned slightly.

### 3. Performance: export passes, preview measured only by proxy

**Export wall time:** 3 interleaved rounds × 3 exports each (`export-times.txt`).

| case | base median | head median | delta |
|---|---|---|---|
| heavy, cut, 1080 frames | 2.514 s | 2.528 s | +0.6 % |
| light, single, 1920 frames | 4.122 s | 4.094 s | −0.7 % |

**Preview, new work in `live.rs`:** `cursor_breaks` plus the `!=` against `last_breaks`, run every render-loop iteration (`bench.txt`).

| clips | cost per iteration |
|---|---|
| 1 or 2 | 36 ns |
| 20 | 0.24 µs |
| 200 | 1.2 µs |

- **Against the frame budget:** a 60 fps frame lasts 16.7 ms, so even 200 clips cost under 0.01 % of it.
- **Re-smoothing** runs only when the smoothing or the breaks change:

| track | `smoothed` | 2 breaks | 200 breaks |
|---|---|---|---|
| 32 s | 0.56 ms | 0.60 ms | 0.64 ms |
| 77 s | 1.39 ms | 1.40 ms | 1.54 ms |

- **Not done:** preview frame rate in the real app.

### 4. Preview against export after a cut: shown in code, not run

- **Same track on both sides:** both build it with `smoothed_with_breaks(smoothing, scene.cursor_breaks_for(path))` over the full scene:
  - preview: `live.rs`, `full_scene` and `active_screen_path`;
  - export: `timeline_walk.rs`, the scene snapshot and `clip.screen`.
- **Turned clips:** both turn the track before smoothing it.
- **What follows:** the same source instant gets the same cursor position.
- **Not done:** a real-app capture.

### 5. Tests: pass

- **Lib tests:** `cargo test -p openscreen-compositor --release --lib` gives 516 passed and 0 failed. The PR's two new tests are among them.
- **AGENTS.md checks:** the TypeScript typechecks, Biome lint and vitest have nothing to check here, because the PR changes Rust only.
- **rustfmt:** the crate is not rustfmt-clean on base either, so rustfmt is not a gate.
