# Performance A/B between two packaged builds

How to compare the smoothness and speed of two OpenScreen builds on one Windows machine, and the
log of every comparison run so far. The scripts live in [`scripts/perf-ab/`](../../scripts/perf-ab/).

## Results log

### 2.0.0 against main `9dc48b5c7`, Windows, 15/10/2026

**Verdict: main is as smooth and as fast as 2.0.0, at 279 Hz and at 60 Hz, except that it takes
47 ms longer to show the HUD.**

- **One regression over 5%**: from process start to a ready HUD, 625 → 672 ms (+7.5%, p < 0.001,
  12 sessions each). The editor-open slowdown first logged here (+53 ms) did not survive a
  controlled rerun: 1143 → 1136 ms. See [the bisection](#bisecting-the-startup-slowdown).
- **No preview regression established.** The light project is identical. On the heavy project,
  late paints are 17% higher at the median but not significantly so (see below).
- **Two improvements.** GIF export is 30 times faster. A recorded screen video keeps a regular
  60 fps clock, where 2.0.0's timestamps wander.
- **Three defects both versions share.** On a 60 Hz display the preview paints 55 to 57 frames a
  second and the cursor steps backwards dozens of times: the fidget a tester reported on 2.1 is
  already in 2.0.0. The heavy preview alternates between a smooth and a stuttering mode from one
  session to the next. The GPU process's dedicated GPU memory grows by 80 to 105 MB per second of
  playback, past the card's 12 GB.

**Setup**

- Machine: Ryzen 7 5800X, RTX 4070 Ti 12 GB, 32 GB RAM, one 1920×1080 display at 279 Hz,
  Windows 11 build 26200, 100% scaling.
- 2.0.0: the release's `Openscreen.Setup.2.0.0.exe`. main: `9dc48b5c7`, built by `build.yml` run
  38758703830. Both extracted and run side by side, never installed.
- Sessions interleaved between the two builds. Light project: 3 per build. Heavy: 12 per build,
  memory read on 3 of them. Exports: 3 per case, 2 for the 2.0.0 GIF (8 min each). Takes: 3.
- Background load: other sessions' Electron processes (an `openscreen mcp` set and a dev build of
  #1189) stayed open and idle. Early runs where another window covered the editor were discarded
  and run again with the editor pinned on top.
- 60 Hz: the same display switched to 60 Hz by hand, 3 light and 6 heavy sessions per build.
- Not covered: macOS and Linux.

**Flags**

| # | Finding | Status | Likely cause | Next step |
|---|---|---|---|---|
| 1 | Startup to a ready HUD +47 ms (625 → 672 ms). Editor open unchanged (1143 → 1136 ms) | Startup: regression, p < 0.001. Editor open: retracted | No single commit found, bisection to rerun on a quiet machine. +18 ms before the HUD page starts, which is not main-process JavaScript; +12 ms of CPU in the HUD's first render, spread over a dozen modules | Try a HUD entry of its own, without the editor's code, and measure it |
| 2 | Heavy preview: 87 → 102 paints later than 25 ms per 30 s (+17%) | Within noise, p ≈ 0.2 | Both builds land in a slow mode (paint p95 28.5 ms instead of 22 ms) in about half the sessions: 2.0.0 6 of 12, main 7 of 12. The mode follows the session, not the build. | Find what sets the mode |
| 3 | At 60 Hz the preview paints 51 to 58 frames a second, and the picture and the cursor step back one frame tens of times in 18 s | Pre-existing, both builds: over 8 pairs main has more steps back 4 times, 2.0.0 3 times | The shared-texture ring wrote a slot again as soon as Chromium released it, before the GPU had copied it into the canvas: the painted frames' times never go back, the screen does | Fixed in #1285: the slot is handed back 40 ms later, no step back at 60 or 280 Hz |
| 4 | GPU process dedicated memory, one traced session each: 0.8 GB (2.0.0) and 1.4 GB (main) at 11 s of playback, 9.8 GB and 12.8 GB at 2 min | Pre-existing, both builds | Grows linearly with playback, so something per frame is kept: the shared-texture preview path is the first suspect | Trace the shared frames' lifetime |

#### Preview, light project (3 sessions each)

| Metric | 2.0.0 | main | Delta | Verdict |
|---|---|---|---|---|
| Preview paints per second | 60.0 [60.0–60.0] | 60.0 [60.0–60.0] | +0.0% | same |
| Paint interval p95 (ms) | 21.9 [21.8–21.9] | 21.8 [21.8–22.0] | -0.5% | same |
| Paint interval p99 (ms) | 22.7 [22.7–22.8] | 22.7 [22.4–22.9] | -0.0% | same |
| Paints later than 25 ms, per 30 s | 2 [0–2] | 1 [0–1] | -50.0% | within noise |
| UI rAF interval p99 (ms) | 3.70 [3.70–3.70] | 3.70 [3.70–3.70] | +0.0% | same |
| UI rAF over 1.5 vsync (%) | 0.02 [0.01–0.33] | 0.06 [0.02–0.10] | +150.2% | within noise |
| CPU, all processes (% of one core) | 148.8 [148.4–151.6] | 145.8 [140.2–155.2] | -2.0% | same |
| CPU, main process (%) | 18.2 [17.7–19.1] | 16.9 [16.4–18.1] | -7.0% | within noise |
| GPU, all engines of the app (%) | 9.6 [9.1–9.7] | 9.6 [9.5–9.8] | +0.3% | same |
| On screen: preview updates per second | 57.5 [46.6–60.0] | 58.4 [51.6–59.9] | +1.5% | same |
| On screen: update interval p99 (ms) | 30.0 [25.0–39.6] | 29.5 [24.3–37.0] | -1.6% | same |
| On screen: updates skipping a video frame (%) | 4.36 [0.09–17.88] | 2.86 [0.28–16.27] | -34.4% | within noise |
| On screen: cursor off its path, RMS (source px) | 5.83 [5.71–31.12] | 5.86 [5.57–7.43] | +0.6% | same |
| On screen: cursor off its path, p99 (source px) | 20.34 [20.12–128.20] | 20.54 [20.32–22.92] | +1.0% | same |
| On screen: cursor steps backwards | 0 [0–52] | 0 [0–0] | +0.0% | same |

The cursor follows its recorded path equally closely in both builds: no fidget on Windows. The
residual of about 6 px RMS is the cursor smoothing's lag, the same in both. The ranges of the
on-screen rows are wide because the desktop capture itself misses frames now and then (one
2.0.0 session and one main session).

#### Preview, heavy project (12 sessions each; memory on 3)

| Metric | 2.0.0 | main | Delta | Verdict |
|---|---|---|---|---|
| Preview paints per second | 60.0 [59.8–60.0] | 60.0 [59.7–60.0] | +0.0% | same |
| Paint interval p95 (ms) | 24.7 [22.1–28.5] | 27.9 [22.1–28.5] | +13.0% | within noise (p ≥ 0.05) |
| Paint interval p99 (ms) | 35.5 [28.8–35.8] | 35.4 [29.0–35.7] | -0.1% | same |
| Paints later than 25 ms, per 30 s | 87 [53–113] | 102 [54–119] | +16.7% | within noise (p ≥ 0.05) |
| UI rAF interval p99 (ms) | 3.70 [3.70–3.70] | 3.70 [3.70–3.70] | +0.0% | same |
| Long tasks over 50 ms, per 30 s | 0 [0–0] | 0 [0–0] | +0.0% | same |
| CPU, all processes (% of one core) | 141.6 [130.6–162.2] | 144.2 [131.0–161.5] | +1.8% | same |
| CPU, main process (%) | 19.7 [15.4–23.7] | 18.2 [15.7–20.0] | -7.7% | within noise (p ≥ 0.05) |
| CPU, GPU process (%) | 45.0 [41.7–51.6] | 47.0 [42.9–50.1] | +4.5% | same |
| CPU, renderer (%) | 77.2 [72.4–89.5] | 78.9 [72.2–92.4] | +2.2% | same |
| GPU 3D, main process / compositor (%) | 3.0 [2.4–4.0] | 3.5 [2.6–4.2] | +16.4% | within noise (p ≥ 0.05) |
| GPU video decode (%) | 10.8 [10.6–10.9] | 10.8 [10.6–20.6] | +0.8% | same |
| GPU, all engines of the app (%) | 15.8 [14.7–17.4] | 16.7 [15.1–26.8] | +5.7% | within noise (p ≥ 0.05) |
| Private memory after 2 min (MB) | 1202 [1201–1213] | 1199 [1168–1218] | -0.3% | same |
| Private memory, main process (MB) | 634 [633–641] | 624 [623–639] | -1.6% | same |
| Private memory, renderer (MB) | 337 [337–344] | 329 [305–343] | -2.4% | same |
| GPU dedicated memory, GPU process, after 2 min (MB) | 9252 [8989–12847] | 8567 [8009–11063] | -7.4% | within noise |
| Editor open to first preview frame (ms) | 1025 [991–1101] | 1078 [1025–1244] | +5.2% | not confirmed, see below |

Late paints per session, sorted: 2.0.0 `53 61 67 71 76 84 90 105 106 107 111 113`, main
`54 75 76 83 88 92 111 111 111 112 114 119`. Sessions in the slow mode also use more GPU 3D in
the main process (about 4% against 2.5 to 3%), in both builds.

#### Preview at 60 Hz, light project (3 sessions each)

| Metric | 2.0.0 | main | Delta | Verdict |
|---|---|---|---|---|
| Preview paints per second | 54.8 [53.6–57.9] | 57.2 [51.5–57.9] | +4.3% | same |
| Paint interval p95 (ms) | 33.4 [18.0–33.4] | 18.4 [18.1–33.6] | -44.9% | within noise |
| Paint interval p99 (ms) | 33.9 [33.6–33.9] | 33.8 [33.5–34.3] | -0.3% | same |
| Paints later than 25 ms, per 30 s | 154 [62–190] | 76 [64–253] | -50.6% | within noise |
| UI rAF interval p99 (ms) | 16.90 [16.80–16.90] | 16.90 [16.90–16.90] | +0.0% | same |
| UI rAF over 1.5 vsync (%) | 0.00 [0.00–0.00] | 0.00 [0.00–0.06] | +0.0% | same |
| CPU, all processes (% of one core) | 59.9 [57.6–59.9] | 60.9 [59.5–64.1] | +1.7% | same |
| GPU, all engines of the app (%) | 16.7 [15.5–20.1] | 17.3 [13.4–22.7] | +4.0% | same |
| On screen: preview updates per second | 54.0 [50.2–57.2] | 53.8 [53.5–55.7] | -0.3% | same |
| On screen: updates skipping a video frame (%) | 17.87 [13.08–24.44] | 13.87 [13.79–42.87] | -22.4% | within noise |
| On screen: cursor off its path, RMS (source px) | 8.30 [8.14–12.88] | 9.68 [9.22–10.46] | +16.6% | within noise |
| On screen: cursor off its path, p99 (source px) | 27.20 [27.11–36.81] | 28.69 [23.44–32.60] | +5.5% | within noise |
| On screen: cursor steps backwards | 31 [24–97] | 53 [40–153] | +71.0% | within noise |

#### Preview at 60 Hz, heavy project (6 sessions each)

| Metric | 2.0.0 | main | Delta | Verdict |
|---|---|---|---|---|
| Preview paints per second | 56.6 [55.8–58.0] | 56.4 [55.5–57.7] | -0.3% | same |
| Paint interval p95 (ms) | 32.9 [17.7–33.3] | 33.0 [17.8–33.2] | +0.2% | same |
| Paint interval p99 (ms) | 33.7 [33.4–33.8] | 33.6 [33.6–33.8] | -0.3% | same |
| Paints later than 25 ms, per 30 s | 101 [57–125] | 107 [70–135] | +5.4% | within noise (p ≥ 0.05) |
| UI rAF interval p99 (ms) | 16.90 [16.90–16.90] | 16.90 [16.80–16.90] | +0.0% | same |
| UI rAF over 1.5 vsync (%) | 0.00 [0.00–0.00] | 0.00 [0.00–0.00] | +0.0% | same |
| CPU, all processes (% of one core) | 47.8 [45.5–57.9] | 49.8 [48.1–53.9] | +4.0% | same |
| GPU, all engines of the app (%) | 31.7 [27.9–36.6] | 30.3 [26.8–33.7] | -4.4% | same |

At 60 Hz both builds miss frames: a paint interval p95 of 33 ms means a frame held for two vsyncs.
Sessions again split into a good mode (p95 18 ms) and a bad one (33 ms) in both builds. The cursor
residual grows from 6 px to 8 to 10 px and backward steps appear: that is the fidget, and 2.0.0
shows it too.

#### Bisecting the startup slowdown

The editor-open and startup timings above came from sessions where the editor opened behind
whatever window was in front. A dedicated bench (`open-bench.mjs`: no playback, every window of the
app pinned on top from its first frame, phases read from inside each page) reran the two packages,
12 sessions each, interleaved:

| Metric | 2.0.0 | main | Delta | z |
|---|---|---|---|---|
| Process start to HUD navigation (ms) | 449 | 467 | +18 | 2.19 |
| HUD page: navigation to DOMContentLoaded (ms) | 129 | 134 | +4 | 1.36 |
| HUD page: navigation to first React render (ms) | 173 | 205 | +32 | 3.84 |
| Process start to HUD ready (ms) | 625 | 672 | **+47** | 3.81 |
| Editor open to first preview frame (ms) | 1143 | 1136 | -7 | -0.06 |

Another session's dev build ran an A/B in its editor from 21:45 to 22:29 that evening. The table
above (22:35), the deferred-channel test (22:32) and the source-mapped HUD profiles (22:42) came
after it. The per-build bisection, the grafts and the main-process profile came during it: treat
them as leads to rerun, not results.

Where the 47 ms go:

- **Before the HUD page starts (+18 ms): probably not JavaScript (to rerun).** A CPU profile of the main process from
  its first line to the HUD (`profile-startup.mjs`, `--inspect-brk`) gives the same busy time,
  507 ms for 2.0.0 and 510 ms for main.
- **In the HUD's first render (+12 ms of CPU): many small costs.** Profiles of the HUD renderer
  mapped through source maps (`profile-hud.mjs`, `attribute-hud.cjs`), 8 each: 194 → 206 ms busy.
  `LaunchWindow` +2.5 ms, i18next +2.4, the HUD's own toaster (`3a77ef890`) +1.7, zod +1.5,
  tailwind-merge +1.0, Radix +1.0. The bundle itself barely grew (index chunk 1.33 → 1.37 MB).
- **No commit owns it, as far as the noisy runs go (to rerun).** The HUD-ready time per CI build of main (10 sessions each) moves by
  steps within the noise: 695 (2.0.0), 755 (`b519f236e`), 708 (`e3bde938a`), 675 (`cb8f89c9d`),
  743 (`b668b2c8d`), 782 (`4f4bb997c`), 725 ms (`9dc48b5c7`). The largest step, between
  `cb8f89c9d` and `b668b2c8d` (first React render, z = 2.80), gave contradictory grafts: on a
  package built from `b668b2c8d`, its main process and `65444df3e` alone cost 100 to 140 ms, but on
  a package built from `9dc48b5c7` the same main process started as fast as 2.0.0's (688 ms).
  Opening the MCP app channel only after the HUD has loaded was built and measured there:
  688 → 687 ms, no gain, so it was not kept.

The lever large enough to win the 47 ms back is untested: the HUD evaluates the editor's whole
bundle (the 1.37 MB index chunk, every zod schema, i18next) to draw a bar of buttons. A HUD entry
of its own would skip most of it; trimming the dozen small costs above one by one would not.

#### Startup (15 sessions each)

| Metric | 2.0.0 | main | Delta | Verdict |
|---|---|---|---|---|
| Process start to HUD ready (ms) | 620 [595–678] | 651 [635–684] | +4.9% | under 5%, but significant |

This is the first measure, taken with the editor sometimes behind other windows. The verdict uses
the controlled rerun in [the bisection](#bisecting-the-startup-slowdown): 625 → 672 ms, +7.5%,
p < 0.001.

#### Recording, 60 s full screen with the webcam (3 takes each)

| Metric | 2.0.0 | main | Delta | Verdict |
|---|---|---|---|---|
| Screen video, frames per second | 60.05 [60.04–60.06] | 60.00 [60.00–60.00] | -0.1% | info |
| Screen video, longest gap between frames (ms) | 25.0 [22.7–26.2] | 18.6 [18.3–18.6] | -25.8% | improvement |
| Screen video, frames repeating the previous picture | 660 [626–674] | 648 [645–664] | -1.8% | same |
| Webcam video, frames per second | 29.99 [29.99–30.01] | 30.00 [30.00–30.00] | +0.0% | info |
| Webcam video, longest gap (ms) | 37.3 [36.9–37.8] | 35.1 [35.0–35.3] | -6.1% | improvement |
| Webcam video, byte-identical consecutive frames | 2 [2–3] | 2 [1–3] | +0.0% | same |
| CPU, wgc-capture.exe (% of one core) | 46.8 [46.2–49.8] | 48.5 [47.6–48.6] | +3.8% | same |
| CPU, main process (%) | 3.0 [2.9–3.5] | 3.4 [2.8–3.5] | +13.8% | within noise |
| CPU, all processes (%) | 51.3 [50.7–55.4] | 53.2 [52.6–53.6] | +3.8% | same |

No take lost a frame: no gap reaches twice the frame interval. 2.0.0's screen timestamps are
irregular enough that `ffprobe` guesses its rate as 56 or 120 fps, where main's read a clean 60
(`13366ebad`, `e8b85444f`, `4ebe3ce7b`). The repeated pictures come from the pattern player, which
does not present every one of its 120 frames per second; it is the same in both builds. The
camera, a Logitech StreamCam, delivers 1080p at 30 fps under the default 2160p request.

#### Export, heavy project (60 s)

| Metric | 2.0.0 | main | Delta | Verdict |
|---|---|---|---|---|
| MP4 1080p 60 fps: wall time (s) | 12.9 [12.8–13.0] | 12.9 [12.8–13.0] | +0.1% | same |
| MP4 1080p 60 fps: frames written | 3600 [3600–3600] | 3600 [3600–3600] | +0.0% | info |
| MP4 1080p 30 fps: wall time (s) | n/a | 11.6 [11.6–12.2] | n/a | n/a |
| MP4 1080p 30 fps: frames written | n/a | 1800 [1800–1800] | n/a | n/a |
| GIF 720p 15 fps: wall time (s) | 488.7 [484.3–493.0] | 16.2 [15.9–16.3] | -96.7% | improvement |
| GIF 720p 15 fps: frames written | 900 [900–900] | 900 [900–900] | +0.0% | info |

These wall times ran up to about 1.3 s long: the bench took a synchronous process sample
(~0.8 s) and slept 500 ms before it noticed an export had ended. Both builds carry the same
overshoot, so the comparison holds; `export-bench.mjs` now times the exit event itself.

2.0.0 exports MP4 at 60 fps only (its CLI has no `--fps`, its dialog no frame rate), so 1080p30 has
no baseline. Both builds write the same frames at nearly the same size (MP4 144.9 MB each, GIF 475.2
against 475.5 MB). 2.0.0's GIF runs on one core (492 CPU
seconds in 493 s); main spreads it over about ten (#952: `0a814fbe7`, `528ce5d9f`).

## What is measured

| Area | Metric | Source |
|---|---|---|
| Editor preview | Interval between two paints of the preview canvas: p50, p95, p99, count over 25 ms | `drawImage` on the canvas `useNativeCompositorView` marks `data-painted`, hooked over CDP |
| Editor UI | rAF interval: p50, p99, share over 1.5 vsync | rAF loop injected over CDP |
| What the screen showed | Preview updates per second, screen frames skipped or repeated, cursor deviation from its straight path | Desktop capture of the preview (`ddagrab`), analysed by `analyze_capture.py` |
| Resources | CPU % per process role (main, GPU process, renderer), GPU engine % per process | `Win32_Process` CPU times; `\GPU Engine(*)\Utilization Percentage` |
| Memory | Private bytes per role and GPU memory after 2 min of playback | `Win32_Process`; `\GPU Process Memory(*)` |
| Startup | Process start to HUD ready; editor open to first preview frame | CDP polling |
| Export | Wall time, frames written | `Openscreen.exe export`, `ffprobe` |
| Recording | Frame cadence and gaps of both videos, CPU of `wgc-capture.exe` and the app | 60 s take over a 120 fps pattern, `analyze_recording.py` |

`window.__uiProbe` is not used: a production build strips `console.*` (`drop_console` in
`vite.config.ts`), so its reports never reach the console. The injected rAF loop records the same
intervals as raw data.

A change over 5% in the bad direction is a regression when it is real: a Mann-Whitney test at
p < 0.05 with 6 sessions or more per build, non-overlapping [min–max] ranges with fewer.

## Inputs

Both builds read the same two projects (schema 8), generated by `gen-projects.mjs` from synthetic
media, so neither build's recorder decides the input:

- **screen.mp4**: 1920×1080, 60 fps, H.264 High, 14 Mb/s like a real Windows take. Grey noise, and a
  white bar that moves 16 px per frame in the top band.
- **screen.mp4.cursor.json**: a horizontal sweep at constant speed, 0.15 → 0.85 → 0.15 of the width
  every 4 s, sampled every 8 ms.
- **webcam.mp4**: 1920×1080, 30 fps, 16 Mb/s.
- **Light project**: the take, one 2× zoom, plain wallpaper, no cursor motion blur.
- **Heavy project**: webcam picture-in-picture, five zooms of which three are 3D (orbit, left,
  right), a text, an arrow and a blur annotation, captions on (a word every 0.5 s), a music bed,
  the wallpaper, shadow, motion blur and depth of field of a real project.

## How to run

1. Extract each build instead of installing it: `7z e <installer> $PLUGINSDIR/app-64.7z`, then
   `7z x app-64.7z -o<scratch>/app-<label>`. The installed OpenScreen stays untouched, and each
   build runs with its own `--user-data-dir`, so they never share a profile or the
   single-instance lock.
2. Generate the media (commands in the header of `gen-projects.mjs`), then
   `node gen-projects.mjs <mediaDir> <scratch>/projects`.
3. Preview sessions: `run-gui.sh <scratch> <outDir> <hz> light heavy`. Each session launches the
   build with `--remote-debugging-port`, opens the editor through `electronAPI.switchToEditor()`
   (the editor reopens the profile's only project), pins its window on top, plays with Space and
   kills the process tree.
4. `node export-bench.mjs <scratch> 3`, then `run-record.sh <scratch> record 1 2 3`. Each take is
   analysed and deleted at once: it holds the webcam picture.
5. `node summarize-gui.mjs <outDir>`, `node summarize-record.mjs <scratch>/out/record`, then
   `node doc-tables.mjs` on the three summaries prints these tables.
6. Startup and editor open alone: `open-bench.mjs` (about 10 s a session) and
   `summarize-open.mjs`. To see where the time goes, `profile-startup.mjs` profiles the main
   process and `profile-hud.mjs` the HUD renderer from their first line; `attribute-hud.cjs` maps
   the HUD profiles onto the sources of a `vite build --sourcemap` of the same commit.

Keep the desktop to the bench while it runs. A window a background process opens lands behind
the foreground one, which is why `topmost.ps1` pins the editor and the pattern player. A covered
editor still renders, but the capture films the cover. A fully covered one is throttled to one
rAF per second, and its session is discarded.
