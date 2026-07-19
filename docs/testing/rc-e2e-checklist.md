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
- [ ] Tray icon "Stop Recording" works while recording (right-click → Stop, or left/double-click to refocus the HUD if it's minimized) — not exercised in the 2026-07-19 pass, worth covering next run
- [ ] Opening an existing video file works from the launch window — not exercised in the 2026-07-19 pass
- [x] Opening an existing project works from the launch window
- [x] **HUD drag tracks the cursor** with no drift, including a long drag across most of the screen (regression check for #100) — drag it, release, and confirm it doesn't jump afterward
- [ ] Countdown overlay (if enabled) shows before recording starts and doesn't block the source — not exercised in the 2026-07-19 pass

## Audio

- [x] Mic toggle on/off works before recording
- [x] Mic device selection (if multiple mics available) works
- [x] System audio toggle works — verify with **two separate recordings in opposite toggle states** (one with it enabled, one disabled), and confirm each recording's playback actually matches its state (audible system audio only in the enabled one) rather than just checking the toggle isn't sticky/stale
- [ ] Mic-only recording produces audible mic audio on playback — only the combined mic+system-audio path was exercised this pass
- [ ] System-audio-only recording produces audible system audio on playback — only the combined path was exercised this pass
- [x] Mic + system audio together: both are audible and levels are reasonably balanced (not one drowning out the other)
- [x] **Exported video has audio** matching what was audible in the editor preview (regression check for #108: mic/system audio used to be silently dropped on export) — check this for at least one mic+system-audio recording

## Editor Load + Playback

- [x] Recording stop opens the editor automatically with the correct video (and webcam PiP, if recorded) loaded
- [x] Playback, pause, seek all work from the transport controls
- [x] **Playhead tracks actual video position with no visible lag**, including while dragging the playhead during playback (regression check for #111)
- [ ] Cursor telemetry overlay (highlight/spotlight, if enabled during capture) renders correctly and stays aligned with the actual cursor position throughout playback — cursor mode was inadvertently left on "editable cursor" rather than "highlight" during capture in the 2026-07-19 pass; re-run with highlight mode explicitly enabled

## Webcam / Full Camera

- [x] Webcam PiP renders during playback in the position/size/shape configured (rectangle vs. other mask shapes)
- [ ] Webcam mirroring toggle works — not exercised in the 2026-07-19 pass
- [ ] Webcam reactive zoom (PiP grows on cursor activity, if enabled) behaves reasonably — not exercised in the 2026-07-19 pass
- [x] **Full Camera segment**: press `C` (or the equivalent UI action) to add a Full Camera segment on the timeline; scrubbing through it grows the webcam to fullscreen with an ease-in, and eases back out at the segment's end

## Timeline

- [x] Add / edit / remove each element type: **zoom region**, **annotation**, **trim region**, **speed region** — confirm each behaves correctly in preview playback (speed region only added/removed, not scrubbed through)
- [ ] **Auto-zoom regions follow the cursor for their whole span**, not just a static frozen point at the start (regression check for #72) — only a *manual* zoom region was tested in the 2026-07-19 pass; auto-zoom itself was verified separately when #72 was fixed (see PR #118) but not re-run as part of this full pass
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

- [ ] No crash immediately after stopping a recording (regression check for #21 — a known unresolved shutdown-path crash; if it reproduces, note the crash reporter output) — macOS hardware *was* available for the 2026-07-19b pass, but no computer-use/GUI-automation tool or interactive desktop session was reachable from that environment (see Results log), so this still couldn't be exercised live
- [ ] Recording survives an macOS Spaces switch while the HUD is visible — same environment gap as above, still not testable

---

## Results log

| Date | Build / commit tested | Platform | Tester | Findings |
|------|------------------------|----------|--------|----------|
| 2026-07-19 | `release/v1.7.0` (post-#124 cherry-pick, pre-#125/#127) | Windows | Claude (computer-use) | 2 bugs found and fixed: (1) annotation placeholder text baked into content instead of being empty — PR #127; (2) post-reload duration capped at last element's end time — PR #127. Everything else checked above passed. macOS section untestable without hardware. A few items (mic-only/system-audio-only isolation, webcam mirroring/reactive zoom, auto-zoom live re-verification, tray stop, countdown overlay, existing-video-file import) weren't exercised this pass and are called out inline above for next time. |
| 2026-07-19b | `v1.7.0-rc.3` (`b9a144f`) | macOS (arm64), automated only — **no computer-use/GUI-automation tool was available in this environment, and no interactive desktop session was reachable** (`osascript`/System Events hung with no Aqua session visible to the shell), so none of the manual checklist items above could be exercised live; none were (re)checked off in this pass. Packaged rc.3 installer wasn't available yet either (GitHub Actions build for the tag was still in progress at test time), so `npm run dev`-equivalent (`npm install` + `npm run build-vite`) was used for what automated testing was possible. | Claude (automated tests + code review only, no GUI access) | No blocking regressions found in what could be tested. (1) Typecheck (`tsc --noEmit`) clean. (2) Lint (`biome check .`) clean, 361 files. (3) Unit tests: 427/427 passed (54 files). (4) Browser tests (Vitest+Playwright): 8/8 passed. (5) Electron e2e (`playwright test`): `windows-native-checklist.spec.ts` self-skips off-Windows (by design); `gif-export.spec.ts`'s 2 tests both failed with `firstWindow` timeout — traced to the same missing-GUI-session issue above (Electron's main process never got a display to open a window against), not a product bug, so not filed as one. (6) `npm run i18n:check` **FAILED**: ~50 missing/extra translation keys across 11 non-English locales spanning `dialogs.json`, `editor.json`, `launch.json`, `settings.json`, `shortcuts.json`, and `timeline.json` (notably the auto-zoom/auto-focus timeline button labels added in `a371658`, and several fields already missing as far back as `v1.6.0` stable). Confirmed via `git log -S` that this is **pre-existing debt, not a regression introduced during the rc.3 cherry-pick window** — filed as a GitHub issue (see PR description) rather than blocking the release, but it directly explains why the "Language switcher" item in the 2026-07-19 Windows pass didn't surface it (a French UI spot-check wouldn't hit an unlabeled auto-zoom button unless that exact control was clicked). (7) Code review (not live testing) of all 10 commits unique to the rc.3 window (`v1.7.0-rc.2..v1.7.0-rc.3`) found each fix well-scoped, correctly targeted at its stated root cause, and backed by either a unit test or a documented computer-use verification in the commit message; no evidence of a blocking issue. None of those 10 commits touch tray icon, countdown overlay, mic-only/system-audio-only isolation, webcam mirroring/reactive zoom, or the macOS shutdown-crash path (#21) — those checklist gaps from the 2026-07-19 pass remain **fully open** and need an actual computer-use-capable environment to close. |
