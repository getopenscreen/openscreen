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
4. A finding is a bug only if it reproduces twice. Note the repro steps.

---

## Capture + Launch

- [ ] Pre-commit / build sanity: app launches, HUD appears, no console errors on startup
- [ ] Source selector opens and lists screens/windows with live thumbnails
- [ ] Selecting a source works for **full screen**
- [ ] Selecting a source works for a **single app window** (not just full screen — regression check for #60: confirm the recorded video is NOT a black screen, including a window with an odd-pixel client size if you can arrange one)
- [ ] Record start/stop works from the HUD
- [ ] **Stop reliably completes** with system audio/mic/webcam/cursor all *disabled* (regression check for #115: this combination used to hang indefinitely on Windows) — confirm the editor opens within a few seconds of clicking stop
- [ ] Stop reliably completes with system audio + mic + webcam + cursor all *enabled* (no regression to the normal path)
- [ ] Tray icon "Stop Recording" works while recording (right-click → Stop, or left/double-click to refocus the HUD if it's minimized)
- [ ] Opening an existing video file works from the launch window
- [ ] Opening an existing project works from the launch window
- [ ] **HUD drag tracks the cursor** with no drift, including a long drag across most of the screen (regression check for #100) — drag it, release, and confirm it doesn't jump afterward
- [ ] Countdown overlay (if enabled) shows before recording starts and doesn't block the source

## Audio

- [ ] Mic toggle on/off works before recording
- [ ] Mic device selection (if multiple mics available) works
- [ ] System audio toggle works — verify across **two separate recordings** (toggle state isn't sticky/stale between them)
- [ ] Mic-only recording produces audible mic audio on playback
- [ ] System-audio-only recording produces audible system audio on playback
- [ ] Mic + system audio together: both are audible and levels are reasonably balanced (not one drowning out the other)
- [ ] **Exported video has audio** matching what was audible in the editor preview (regression check for #108: mic/system audio used to be silently dropped on export) — check this for at least one mic+system-audio recording

## Editor Load + Playback

- [ ] Recording stop opens the editor automatically with the correct video (and webcam PiP, if recorded) loaded
- [ ] Playback, pause, seek all work from the transport controls
- [ ] **Playhead tracks actual video position with no visible lag**, including while dragging the playhead during playback (regression check for #111)
- [ ] Cursor telemetry overlay (highlight/spotlight, if enabled during capture) renders correctly and stays aligned with the actual cursor position throughout playback

## Webcam / Full Camera

- [ ] Webcam PiP renders during playback in the position/size/shape configured (rectangle vs. other mask shapes)
- [ ] Webcam mirroring toggle works
- [ ] Webcam reactive zoom (PiP grows on cursor activity, if enabled) behaves reasonably
- [ ] **Full Camera segment**: press `C` (or the equivalent UI action) to add a Full Camera segment on the timeline; scrubbing through it grows the webcam to fullscreen with an ease-in, and eases back out at the segment's end

## Timeline

- [ ] Add / edit / remove each element type: **zoom region**, **annotation**, **trim region**, **speed region** — confirm each behaves correctly in preview playback
- [ ] **Auto-zoom regions follow the cursor for their whole span**, not just a static frozen point at the start (regression check for #72) — record a clip with the cursor moving/typing across the screen, let auto-zoom place a region, confirm the pan tracks the movement
- [ ] Region drag/resize snaps and persists correctly (re-open the project or scrub away and back to confirm the change stuck)
- [ ] No overlap/ordering bugs on timeline items (annotations are the one type allowed to overlap by design — everything else should not silently collide)
- [ ] Undo/redo (Ctrl+Z / Ctrl+Shift+Z) works for at least one add/edit/remove action per element type
- [ ] **Exported video matches the editor preview 1:1** for whatever combination of zoom/annotation/trim/speed/Full-Camera was added — this is the one item worth actually exporting and watching back, not just eyeballing the preview

## Project Persistence

- [ ] Save works (explicit save action, if present, or auto-save)
- [ ] Load works: close and reopen the project, confirm every timeline element, webcam settings, and style setting (wallpaper/padding/shadow/etc.) survived exactly as left

## Style / Other

- [ ] Wallpaper, padding, shadow intensity, border radius, aspect ratio, motion blur sliders all visibly affect the preview when tweaked
- [ ] Blur / background-disable-adjacent settings (see #84 — if a dedicated "disable background" control exists by the time you're testing, verify it; otherwise skip)
- [ ] Language switcher changes UI strings correctly (spot-check one non-English locale)
- [ ] Export completes for at least one full project combining several of the above (audio + zoom + Full Camera + trim), and the resulting file plays back correctly outside the app (e.g. in a system video player)

## Windows-native specifics (if testing on Windows)

- [ ] Software-encoder fallback notice (if the machine can't use hardware H.264) appears appropriately and doesn't block recording
- [ ] Diagnostic bundle export (Settings → diagnostics, if present) completes without error

## macOS-native specifics (if testing on macOS)

- [ ] No crash immediately after stopping a recording (regression check for #21 — a known unresolved shutdown-path crash; if it reproduces, note the crash reporter output)
- [ ] Recording survives an macOS Spaces switch while the HUD is visible

---

## Results log

| Date | Build / commit tested | Tester | Findings |
|------|------------------------|--------|----------|
|      |                        |        |          |
