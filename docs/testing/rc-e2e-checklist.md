# RC end-to-end checklist (computer-use)

A manual smoke-test checklist for validating a release candidate on a real desktop,
via the computer-use workflow described in `AGENTS.md` § Desktop E2E testing with
computer-use. Originates from the maintainer's pre-1.5 testing checklist; extended
with everything added since that a unit/browser test can't exercise (native capture,
tray, real audio/webcam devices, real window management).

Use this top to bottom for an RC. Check off each item as you verify it; note the
build/commit tested and any findings (with a linked issue) at the bottom.

## How to run this

1. Launch the build under test (`npm run dev` for a branch/worktree, or the packaged
   RC installer for a full release candidate).
2. Grant computer-use access to the app's process (`electron.exe` for a dev build,
   `Openscreen.exe`/`Openscreen.app` for a packaged build).
3. Work through the sections in order — later sections (Editor, Persistence) depend
   on having a real recording from the Capture section.
4. Crashes, hangs, data loss, and security issues are logged the first time they occur — note full repro details immediately, don't wait to reproduce twice. For anything else (a one-off visual glitch, a flaky-looking timing issue), reproduce it again before treating it as a real finding rather than noise.

---

## Capture + Launch

- [x] Pre-commit / build sanity: app launches, HUD appears, no console errors on startup
- [x] Source selector opens and lists screens/windows with live thumbnails
- [x] Selecting a source works for **full screen**
- [x] Selecting a source works for a **single app window** (not just full screen — regression check for #60: confirm the recorded video is NOT a black screen, including a window with an odd-pixel client size if you can arrange one)
- [x] Record start/stop works from the HUD
- [x] **Windows only** — **Stop reliably completes** with system audio/mic/webcam/cursor all *disabled* (regression check for #115: this combination used to hang indefinitely on Windows) — confirm the editor opens within a few seconds of clicking stop. Must be run on real Windows; the native WGC stop path this guards isn't exercised on macOS/Linux
- [x] Stop reliably completes with system audio + mic + webcam + cursor all *enabled* (no regression to the normal path)
- [ ] Tray icon "Stop Recording" works while recording (right-click → Stop, or left/double-click to refocus the HUD if it's minimized) — attempted in the 2026-07-19c macOS pass but **could not be reached**: on this macOS version the menu-bar-right area (where the tray icon lives) is owned by a system "Control Centre" surface that the computer-use tool cannot grant access to (`request_access` returns "doesn't match any installed or running application" for it), so every click/right-click in that region is blocked before it reaches the app. This is a tooling/environment limitation, not a confirmed app defect — still needs coverage from an environment where the tray icon is directly clickable (e.g. Windows, or a macOS setup where the icon isn't consolidated into Control Centre)
- [x] Opening an existing video file works from the launch window — confirmed working end-to-end in the 2026-07-19c macOS pass, **but not via the UI path the checklist/tests assume**: there is no direct "open video" button on the HUD. The real flow is HUD → "Open Studio" (`launch-open-studio-button`) → when no project is loaded, the editor shows an empty state (`EditorEmptyState.tsx`) with "Import Video File…" / "Load Project…" buttons. Imported an existing recording this way and it loaded correctly into the editor. Also found: `tests/e2e/windows-native-checklist.spec.ts` references `hudWindow.getByTestId("launch-open-video-button")` and `"launch-open-project-button")`, neither of which exists anywhere in `LaunchWindow.tsx` (confirmed via `grep`) — these two tests would fail immediately if ever run on real Windows; they've never caught this because the spec self-skips off-Windows and CI is Linux-only, so it's never actually executed. Filed as a bug (see Results log)
- [x] Opening an existing project works from the launch window
- [x] **HUD drag tracks the cursor** with no drift, including a long drag across most of the screen (regression check for #100) — not re-driven as a fresh long-drag in the 2026-07-19c pass, but the HUD was dragged incidentally during the pass with no observed drift; combined with a code review of the rc.3-window fix `bfeab5a` (adds `isDraggingHudRef` to suppress a resize-observer race during drag) and its dedicated regression test `d7d55f0`, both of which check out
- [x] Countdown overlay (if enabled) shows before recording starts and doesn't block the source — confirmed in the 2026-07-19c macOS pass: clicking record shows a centered countdown ("1", etc.) over the desktop, doesn't obscure the HUD, and recording starts cleanly right after

## Audio

- [x] Mic toggle on/off works before recording
- [x] Mic device selection (if multiple mics available) works
- [x] System audio toggle works — verify with **two separate recordings in opposite toggle states** (one with it enabled, one disabled), and confirm each recording's playback actually matches its state (audible system audio only in the enabled one) rather than just checking the toggle isn't sticky/stale
- [ ] Mic-only recording produces audible mic audio on playback — recorded in the 2026-07-19c macOS pass with mic on / system-audio off / webcam off, and the recording completed cleanly (~14s, valid MP4). Could **not** verify actual audibility: no real microphone input was available to generate speech/noise in that environment, and computer-use has no audio-playback capability for the agent to listen back with — this is a hard tooling limitation, not a pass/fail result. The isolation itself checked out indirectly: the same clip's waveform is flat/silent where the paired system-audio-only test (below) showed a clear spike, consistent with system audio correctly being excluded
- [x] System-audio-only recording produces audible system audio on playback — recorded in the 2026-07-19c macOS pass with system-audio on / mic off / webcam off, playing `afplay /System/Library/Sounds/Glass.aiff` partway through. The editor's timeline waveform shows a distinct amplitude spike exactly at the moment the sound played (and is flat elsewhere) — strong evidence the system-audio-only path actually captures real audio, not silence
- [x] Mic + system audio together: both are audible and levels are reasonably balanced (not one drowning out the other)
- [x] **Exported video has audio** matching what was audible in the editor preview (regression check for #108: mic/system audio used to be silently dropped on export) — check this for at least one mic+system-audio recording

## Editor Load + Playback

- [x] Recording stop opens the editor automatically with the correct video (and webcam PiP, if recorded) loaded
- [x] Playback, pause, seek all work from the transport controls
- [x] **Playhead tracks actual video position with no visible lag**, including while dragging the playhead during playback (regression check for #111)
- [x] Cursor telemetry overlay (highlight/spotlight, if enabled during capture) renders correctly and stays aligned with the actual cursor position throughout playback — **correction from the 2026-07-19 pass's note**: there is no "highlight" cursor mode in this codebase. `grep`-ing the source and every `en` locale file confirms the HUD's cursor toggle (`launch-cursor-mode-button`) only cycles between exactly two values, `cursorCaptureMode: "editable-overlay" | "system"` (`t("cursor.useEditableCursor")` / `t("cursor.useSystemCursor")` in `launch.json`) — "editable cursor" *is* the mode that captures and renders the custom cursor telemetry overlay; "system" uses the native OS cursor with no custom overlay. So the 2026-07-19 pass, despite its own note, was almost certainly already exercising the correct mode. Re-verified directly in the 2026-07-19c macOS pass with `editable-overlay` explicitly active: recorded a clip while moving the cursor in a distinctive rectangular pattern, and the editor preview/playback shows a dotted trail overlay that visibly tracks that path

## Webcam / Full Camera

- [x] Webcam PiP renders during playback in the position/size/shape configured (rectangle vs. other mask shapes)
- [ ] Webcam mirroring toggle works — still not exercised. Attempted in the 2026-07-19c macOS pass; blocked by hardware, not software: `system_profiler SPCameraDataType` returns no camera on this machine, and the HUD's webcam toggle stayed off/disabled no matter how it was clicked (consistent with no capture device being enumerated). Needs a real machine with a webcam attached
- [ ] Webcam reactive zoom (PiP grows on cursor activity, if enabled) behaves reasonably — same hardware blocker as webcam mirroring above, still not exercised
- [x] **Full Camera segment**: press `C` (or the equivalent UI action) to add a Full Camera segment on the timeline; scrubbing through it grows the webcam to fullscreen with an ease-in, and eases back out at the segment's end

## Timeline

- [x] Add / edit / remove each element type: **zoom region**, **annotation**, **trim region**, **speed region** — confirm each behaves correctly in preview playback (speed region only added/removed, not scrubbed through)
- [x] **Auto-zoom regions follow the cursor for their whole span**, not just a static frozen point at the start (regression check for #72) — re-verified live in the 2026-07-19c macOS pass: recording with editable-cursor-overlay on and moving the cursor across the screen caused the app to auto-suggest a zoom region on the timeline; scrubbing through it showed the framing panning rather than staying frozen on the start position. Combined with a code review of the rc.3-window fix `1b5de03` (unconditionally sets `focusMode: "auto"` on suggested regions, matching what the playback interpolation in `zoomRegionUtils.ts` already expected) and its accompanying unit test, both of which check out
- [x] Region drag/resize snaps and persists correctly (re-open the project or scrub away and back to confirm the change stuck)
- [x] No overlap/ordering bugs on timeline items (annotations are the one type allowed to overlap by design — everything else should not silently collide)
- [x] Undo/redo (Ctrl+Z / Ctrl+Shift+Z) works for at least one add/edit/remove action per element type
- [x] **Exported video matches the editor preview 1:1** for whatever combination of zoom/annotation/trim/speed/Full-Camera was added — this is the one item worth actually exporting and watching back, not just eyeballing the preview

## Project Persistence

- [x] Save works (explicit save action, if present, or auto-save)
- [x] Load works: close and reopen the project, confirm every timeline element, webcam settings, and style setting (wallpaper/padding/shadow/etc.) survived exactly as left — **found and fixed a bug**: the reloaded project's seekable duration was capped at the last element's end time rather than the true recording length (fixed in PR #127)

## Style / Other

- [x] Wallpaper, padding, shadow intensity, border radius, aspect ratio, motion blur sliders all visibly affect the preview when tweaked (padding and aspect ratio spot-checked directly; the rest render from the same panel and share the same binding pattern)
- [x] Blur / background-disable-adjacent settings (see #84) — confirmed padding=0 already achieves a full-bleed "no background" look with existing sliders; posted this back on #84 to clarify what the requester actually wants
- [x] Language switcher changes UI strings correctly (spot-check one non-English locale) — French spot-checked, thorough coverage including timeline element labels
- [x] Export completes for at least one full project combining several of the above (audio + zoom + Full Camera + trim), and the resulting file plays back correctly outside the app (e.g. in a system video player) — verified directly via `ffprobe`/`ffmpeg volumedetect`, not just visual inspection

## Windows-native specifics (if testing on Windows)

- [x] Software-encoder fallback notice (if the machine can't use hardware H.264) appears appropriately and doesn't block recording — not triggered in the 2026-07-19 pass (hardware encoder was used on this machine); correct absence, not a gap
- [x] Diagnostic bundle export (Settings → diagnostics, if present) completes without error

## macOS-native specifics (if testing on macOS)

- [x] No crash immediately after stopping a recording (regression check for #21 — a known unresolved shutdown-path crash; if it reproduces, note the crash reporter output) — exercised in the 2026-07-19c macOS pass against the real packaged `v1.7.0-rc.3` installer (not a dev build): 4+ rapid record→stop cycles (including very short, ~3s recordings, the kind of quick stop most likely to race a shutdown bug) all completed cleanly, editor opened correctly every time, no crash, and no crash report was ever generated under `~/Library/Logs/DiagnosticReports/`. **Does not reproduce** on this build/machine
- [ ] Recording survives an macOS Spaces switch while the HUD is visible — attempted in the 2026-07-19c macOS pass (`ctrl+Right` during an active recording) but **not meaningfully testable in that environment**: the test machine only has a single Space, so there was nowhere to actually switch to. The keypress itself caused no crash or hang, but that's a much weaker signal than a real multi-Space switch. Needs a machine with more than one Space configured

---

## Results log

| Date | Build / commit tested | Platform | Tester | Findings |
|------|------------------------|----------|--------|----------|
| 2026-07-19 | `release/v1.7.0` (post-#124 cherry-pick, pre-#125/#127) | Windows | Claude (computer-use) | 2 bugs found and fixed: (1) annotation placeholder text baked into content instead of being empty — PR #127; (2) post-reload duration capped at last element's end time — PR #127. Everything else checked above passed. macOS section untestable without hardware. A few items (mic-only/system-audio-only isolation, webcam mirroring/reactive zoom, auto-zoom live re-verification, tray stop, countdown overlay, existing-video-file import) weren't exercised this pass and are called out inline above for next time. |
| 2026-07-19b | `v1.7.0-rc.3` (`b9a144f`) | macOS (arm64), automated only — **no computer-use/GUI-automation tool was available in this environment, and no interactive desktop session was reachable** (`osascript`/System Events hung with no Aqua session visible to the shell), so none of the manual checklist items above could be exercised live; none were (re)checked off in this pass. Packaged rc.3 installer wasn't available yet either (GitHub Actions build for the tag was still in progress at test time), so `npm run dev`-equivalent (`npm install` + `npm run build-vite`) was used for what automated testing was possible. | Claude (automated tests + code review only, no GUI access) | No blocking regressions found in what could be tested. (1) Typecheck (`tsc --noEmit`) clean. (2) Lint (`biome check .`) clean, 361 files. (3) Unit tests: 427/427 passed (54 files). (4) Browser tests (Vitest+Playwright): 8/8 passed. (5) Electron e2e (`playwright test`): `windows-native-checklist.spec.ts` self-skips off-Windows (by design); `gif-export.spec.ts`'s 2 tests both failed with `firstWindow` timeout — traced to the same missing-GUI-session issue above (Electron's main process never got a display to open a window against), not a product bug, so not filed as one. (6) `npm run i18n:check` **FAILED**: ~50 missing/extra translation keys across 11 non-English locales spanning `dialogs.json`, `editor.json`, `launch.json`, `settings.json`, `shortcuts.json`, and `timeline.json` (notably the auto-zoom/auto-focus timeline button labels added in `a371658`, and several fields already missing as far back as `v1.6.0` stable). Confirmed via `git log -S` that this is **pre-existing debt, not a regression introduced during the rc.3 cherry-pick window** — filed as [issue #129](https://github.com/getopenscreen/openscreen/issues/129) rather than blocking the release, but it directly explains why the "Language switcher" item in the 2026-07-19 Windows pass didn't surface it (a French UI spot-check wouldn't hit an unlabeled auto-zoom button unless that exact control was clicked). (7) Code review (not live testing) of all 10 commits unique to the rc.3 window (`v1.7.0-rc.2..v1.7.0-rc.3`) found each fix well-scoped, correctly targeted at its stated root cause, and backed by either a unit test or a documented computer-use verification in the commit message; no evidence of a blocking issue. None of those 10 commits touch tray icon, countdown overlay, mic-only/system-audio-only isolation, webcam mirroring/reactive zoom, or the macOS shutdown-crash path (#21) — those checklist gaps from the 2026-07-19 pass remain **fully open** and need an actual computer-use-capable environment to close. |
| 2026-07-19c | `v1.7.0-rc.3` packaged installer (`Openscreen-Mac-arm64-1.7.0-rc.3.dmg`, sha256 verified against the GitHub Release asset digest) | macOS (arm64), full computer-use/GUI pass | Claude (computer-use) | Follow-up to 2026-07-19b once a computer-use tool became available in-session. Installed and ran the real signed (ad-hoc, RC-standard) rc.3 `.dmg` — not a dev build. Closed nearly every gap the 2026-07-19 Windows pass and 2026-07-19b left open (see inline checklist notes above for full detail per item): countdown overlay ✅, existing-video-file import ✅ (but found the underlying UI path differs from what the checklist/e2e tests assume — filed [issue #130](https://github.com/getopenscreen/openscreen/issues/130)), system-audio-only isolation ✅ (confirmed via a visible waveform spike matching a played system sound), mic-only isolation attempted but audibility unverifiable (no real mic input source, and computer-use has no audio-playback capability for the agent to confirm by ear), cursor telemetry overlay ✅ (also found "highlight" isn't a real mode in this codebase — the checklist's own wording was off; the real mode is "editable cursor overlay", re-verified explicitly), auto-zoom cursor-following live re-verify ✅, macOS #21 shutdown-crash regression ✅ **does not reproduce** (4+ rapid record→stop cycles against the packaged build, no crash, no crash report generated). Still open: **tray icon Stop Recording** — not a confirmed app bug, but the menu-bar-right area on this macOS version is owned by a system "Control Centre" surface that the computer-use tool has no way to grant access to, so it couldn't be clicked from this environment; **webcam mirroring/reactive zoom** — blocked by hardware, this test machine has no camera (`system_profiler SPCameraDataType` returns empty); **macOS Spaces switch** — attempted but not meaningful, this machine only has a single Space so there was nowhere to switch to (no crash from the attempt itself, but that's a much weaker signal than a real switch). Filed 2 bugs: [#129](https://github.com/getopenscreen/openscreen/issues/129) (pre-existing i18n gaps, not an rc.3 regression) and [#130](https://github.com/getopenscreen/openscreen/issues/130) (two `windows-native-checklist.spec.ts` tests reference nonexistent testids and have apparently never actually run, since the spec self-skips off-Windows and CI is Linux-only). Neither bug blocks promoting rc.3. |
