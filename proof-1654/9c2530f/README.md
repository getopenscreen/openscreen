# Proof for #1654 (agent studio, first lot) on head 9c2530f

**Head** 9c2530f1c267dc4c3bf9c6428ae21c6a4815d74b against **base** main 128ab637 (its merge base). The live head is now 9e4bb7f5. It adds one commit with no change under `crates/` or `src/native/`, so the compositor this proof ran is the same.

## Verdict

**Partial pass: no rendering or timing change found, but the preview frame rate was not measured in the real app.**

- **Export:** pixel-identical to main, light and heavy scenes. Export time is unchanged.
- **Preview path:** same per-frame cost as main, measured headless through the live view's `Player`, not in the app's window.
- **Preview against export:** the same composition and effects at the preview's size, identical between base and head. The animated parameter lands on its keyframe value, preview and export pixel for pixel.

## Setup

- **Host:** Windows 11, D3D11, headless (no window). This is the worker's own host.
- **Mac not usable:** leased and released. Its console session belongs to another user (`m1`), and the `rusuban` account has no cargo, ffmpeg or node.
- **Linux laptop:** offline.
- **Source:** `testsrc2`, 1920x1080, 60 fps, 20 s, H.264, with a synthetic `.cursor.json` (a sweep with clicks). Every frame differs from its neighbours.
- **Scenes** (12 s, output 1920x1080 at 30 fps, cursor shown with smoothing 0.5):
  - **light:** padding and a gradient background.
  - **heavy:** blurred background, shadow, roundness, motion blur 0.35, cursor motion blur, an auto-focus 1.8x zoom and a manual 1.6x zoom, and a static shader effect (`params.gain`, `ctx.time`) over 7 to 11 s.
  - **anim** (head only, `animate` is new): a shader effect over 2 to 10 s that paints the grey level `g`. Its track goes from 0.1 at 0 s, linear to 0.9 at 4 s, holds, then 0.3 at 6 s.
- **Harness:** [`proof_1654.rs`](proof_1654.rs), copied into `crates/compositor/tests/` of a base and a head worktree, built `--release`.
  - Export frames: `timeline_walk::render_frames`.
  - Export time: `pipeline::run_composited_multi`, the real MP4 export.
  - Preview: `live::Player` into a 960x540 compositor, read back with `readback_direct`, as the live loop does.

## Results

| point | result |
|---|---|
| 1. Export frames, light | **Pass.** 360 of 360 RGBA frames identical (`hashes-light.txt`). |
| 1. Export frames, heavy | **Pass.** 360 of 360 identical (`hashes-heavy.txt`). |
| 1. Encoded MP4 | **Pass.** Decoded `framemd5` identical for base and head, 720 frames each, both scenes. |
| 2. Export time | **Pass.** Medians of 9 interleaved runs. Heavy: 1.707 s base, 1.701 s head (−0.4 %). Light: 1.698 s, 1.687 s (−0.7 %). Two head heavy runs took 5.8 s and 7.5 s, and one base run took 5.7 s: load spikes on a shared host, dropped by the median. |
| 2. Preview, headless | **Pass.** Median per-frame time (step and readback) over 18 runs of 689 frames. Light: 2.078 ms base, 2.091 ms head (+0.6 %). Heavy: 2.137 ms, 2.133 ms (−0.2 %). |
| 2. Preview, real app | **Not measured**, see below. |
| 3. Preview against export | **Pass.** 11 instants per scene. Base and head give the same numbers to the last digit. The residue (mean 0.07 to 0.86 out of 255) is the 1080p frame resized to 960x540 against a frame rasterised at 960x540, at the test pattern's sharp edges (`preview-export-heavy.png`). |
| 3. Animated parameter | **Pass.** Preview and export are pixel-identical at 2 to 9 s. The centre pixel reads 25, 76, 127, 178, 229, 229, 76, 76, which is the track's 0.1, 0.3, 0.5, 0.7, 0.9, hold, 0.3 (`preview-export-anim.png`). |

**About the preview throughput:** the "fps capacity" lines in `preview-playback.txt` are unthrottled. They swing by 5x between runs on this shared host, so only the per-frame median is used.

## Not measured

- **Real-app preview frame rate.** No GUI session was reachable without a person:
  - the mac runs another user's console session, and `rusuban` has no toolchain there;
  - the Linux laptop is offline;
  - the Windows desktop is the owner's, and opening the app's window there needs their lease.
- **macOS and Linux export.** Not rerun here. The PR body reports 664 identical frames and the same export time on macOS.
- **Shader compile in preview.** The live view compiles an effect without blocking (`set_shader_fx_blocking(false)`) and skips it until it lands. The harness compiled it before measuring, so a first-frame skip was not looked at.
