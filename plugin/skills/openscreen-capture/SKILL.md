---
name: openscreen-capture
description: Gets a clean, repeatable take for an OpenScreen video. Covers staging the window, choosing between a real recording (startRecording) and a scripted take, logging the pointer for setPointerTrack, and a bundled headless recipe that captures a web page frame by frame at twice the display scale, encodes it and turns it into an OpenScreen project with its cursor and click zooms, with no window opening on the user's desktop. Use when the user asks to record, film, capture or re-take a screen, to record a web app without a window, to script or automate a take with Playwright, to get a take with no hesitation, when a take has no cursor or no zooms, or when a take came out blurry once zoomed. Not for editing, effects, sound, reviewing or exporting a video.
---

# Capture a clean take

A take is cheaper to redo than to repair. Aim for one that needs no cut: the first frame already shows the result, every action happens once, and every result stays on screen about 1 s before the next action.

<!-- directory-plugin
This edition of the plugin carries the skills only. If `startRecording` and OpenScreen's other tools are not in your tool list, they are not available in this session: say so in plain words, point the user to OpenScreen's documentation, https://getopenscreen.com/docs/ai-editing, and stop. Never install anything or change the agent's settings for it yourself.

-->
## Choose how to capture

| Situation | Capture | Cursor and zooms |
|---|---|---|
| A desktop app, a native window, anything a browser cannot show | `startRecording`, real mouse | Recorded with the take |
| A web app the user wants filmed as they use it | `startRecording`, real mouse | Recorded with the take |
| A web app, a repeatable take, nothing on the user's screen | <!-- full-plugin -->Headless script (below)<!-- /full-plugin --><!-- directory-plugin Not in this edition (below) --> | `setPointerTrack` from the script's log |
| A web app shown in a real window, driven by Playwright or CDP | `startRecording`, script drives the page | `setPointerTrack` from the script's log |
| A video file that already exists | `createProject` with its `videoPath` | `setPointerTrack` if you know the clicks |

**Prefer a real recording** when the thing to show is not a web page, needs the user's real data or session, involves sound from the app (`startRecording` with `systemAudio: true`), needs the webcam (`camera`) or a narration (`microphone: true`), or when the user wants to drive it themselves. <!-- full-plugin -->Everything else in a browser is cleaner headless: same timing on every run, no hesitation, the user's screen untouched.<!-- /full-plugin -->

## Stage the app

- **One clean state per beat.** Seed believable sample data before the take: a short input that fits the view, a list with five to ten realistic rows. Never real customer data, secrets, tokens, real names or personal notifications.
- **One window, about 1600×1000** for a real recording, or a viewport of 1280×720 headless. For a web app in a real window, open it without browser chrome: `chrome --app=<url> --window-size=1600,1000 --user-data-dir=<a temp folder>`. Its title is the page's `<title>`; call `listSources` and pass a unique part of it as `window`.
- **Nothing but the app.** No address bar, bookmarks bar, tabs, local file path, user name, translation prompt, cookie banner or notification. Dismiss banners in the page's state before the take.
- **English, unless the user asks otherwise.** Numbers then read `0.2 ms`, not `0,2 ms`.
- **Someone else's code** (a CLI, a desktop app from a repository) runs only with the user's agreement, in an isolated directory or a container. A hosted web page is safe to open headless: nothing of it runs on the machine outside the browser.

## Choreograph the take

- **Beat 1 opens on the result**, for the first 2.5 s, with nothing moving: the title will sit over it, and OpenScreen keeps the first 2.5 s wide. Start the first action after that.
- **Move deliberately:** 700 to 900 ms per pointer move, a click, then a hold of at least 1 s after the result has finished redrawing. Pages debounce: the result lands later than the keystroke.
- **Space the clicks.** Clicks less than 3 s apart share one zoom when they fit in it together. Two results that deserve their own zoom need their clicks more than 3 s apart. A click in the last second of the take gets no zoom.
- **Type at 55 to 70 ms per character**, short strings only. Paste long text in the page's prepared state instead.
- **Park the pointer** off every label and number once the last result shows, and end with a 2 s hold.

## Record a real take

1. `startRecording` with `window` (or `display`). Add `camera`, `microphone` or `systemAudio` only when the video needs them.
2. Play the choreography.
3. `stopRecording` with a `title`. Keep `projectId`, `checkpointId`, `videoPath` and `recordingStartedAt`.

The take has the pointer as data (`cursor: "editable-overlay"`, the default), so the export draws a clean cursor and plans zooms on the clicks. `cursor: "system"` burns the system pointer in, with no zooms and no `setPointerTrack`: avoid it.

On macOS, a take driven with the real mouse needs the Accessibility permission for its clicks; without it, log the clicks and hand them over with `setPointerTrack` as for a script.

## Log the pointer for a scripted take

A script moves no real pointer, so the take has no cursor and no zoom until you give OpenScreen the path. In the script, log every action as it runs:

- `at`: `Date.now()` at the action.
- `x`, `y`: the point as fractions (0 to 1) of the recorded window or viewport.
- `click: true` for a click.

Log where each move starts and ends, and each click; OpenScreen glides between them. Then call `setPointerTrack` with the `projectId`, the `events`, and:

- for a take from `stopRecording`: nothing more, it knows when it started;
- for a video given to `createProject` and timed on your clock: `recordingStartedAt`, the `Date.now()` of its first frame;
- for a video captured frame by frame: `recordingStartedAt: 0`, and each `at` in milliseconds into the video.

For a page shown in a real window, the tool's description gives the formula from a page point (`clientX`, `clientY`) to window fractions. `setPointerTrack` replaces the pointer the take had, then plans zooms on the new clicks (`autoZoomsAdded`). On a project not open in the editor it needs a checkpoint, which `stopRecording` and `createProject` make; `restoreCheckpoint` undoes it.

<!-- full-plugin -->
## The headless recipe

`scripts/capture.mjs` captures a web page in a browser with no window: a screenshot loop at twice the display scale (2560×1440 from a 1280×720 viewport, about 20 frames a second, enough for an interface), encoded to an H.264 MP4 at 30 fps, plus the pointer log in video time. Twice the scale is what keeps text sharp under a 1.5× to 2.2× zoom.

**Requirements.** Node 18 or later; Playwright (`playwright` or `playwright-core`) installed where the script can find it; ffmpeg on the PATH; Chrome, Edge or Playwright's own Chromium. The script checks each one and says what is missing. Install nothing without the user's agreement; ask, then for instance `npm install --no-save playwright` in the working directory, or `npx playwright install chromium` when no Chrome or Edge is installed.

**Run it**, from the working directory:

1. Write a storyboard module next to the take, starting from `scripts/storyboard.example.mjs` (read it: 24 lines). It exports `url`, optionally `viewport`, `scale`, `colorScheme`, `prepare(page)` (sets up the first beat before capture starts) and `run(s)`. In `run`, use `s.move(x, y, ms)`, `s.moveTo(selector, ms)`, `s.click()`, `s.type(text, msPerChar)` and `s.wait(ms)`; `s.page` is the Playwright page for anything else. Click with `s.click()`, never `page.click()`: only `s` logs the pointer.
2. `node <skill dir>/scripts/capture.mjs storyboard.mjs <dir>/take.mp4`. It prints the duration, the captured frame rate and the second of each click, and writes `take.mp4` and `take.mp4.pointer.json`.
3. `createProject` with the take's absolute `videoPath` and a `title`. Keep `projectId` and `checkpointId`.
4. `setPointerTrack` with the `projectId` and the `recordingStartedAt` and `events` from `take.mp4.pointer.json`, passed as they are.
5. Check the take (below), then edit as the `openscreen-demo` skill says.

Never write a `.cursor.json` file yourself: `setPointerTrack` writes it, and a checkpoint keeps the old one.

**Pitfalls.**
- A captured frame rate under 12 means the page is heavy: lower `scale` to 1.5 or shorten the take.
- Timers inside the page run on the real clock while frames arrive at their own pace: an on-screen clock or counter can look faster or slower than real time. Keep them out of the shot.
- A 3× scale (3840×2160) is worth it only for an effect that magnifies a detail, and costs frame rate.

<!-- /full-plugin -->
<!-- directory-plugin
## The headless recipe

Capturing a web page in a browser with no window needs a capture script that this edition of the plugin does not carry. Say so, and ask the user whether a recording in a real window, which shows the page on their screen, will do. Record it with `startRecording` as above only once they agree.

-->
## Check the take before editing

Look at the whole take in one image: `getContactSheet` with the `videoPath` as `path` and `count: 12`. If that tool is not listed, use `getFrames` with `path` and `count: 6`. Then:

- Is it the right window or page, from the first frame?
- Did every beat happen, once, in order, with its result fully drawn?
- Is anything private visible, or any browser chrome?
- Is small text sharp? `getFrames` with a `region` over it reads it at full resolution.

Any no: fix the storyboard or the staging and record again. A headless take costs seconds; a fix in editing costs a cut.

## When it goes wrong

- **`The recording did not start`:** the window title did not match, or capture is not permitted. Call `listSources` and check the permissions.
- **No cursor, no zooms:** the take was driven by a script and `setPointerTrack` was not called, or every `at` falls outside the video. For a frame-by-frame capture, `recordingStartedAt` must be `0`.
- **Zooms on the wrong moments:** `at` is on a different clock from `recordingStartedAt`. Both must be `Date.now()` values, or `0` and milliseconds into the video.
- **Blurry once zoomed:** captured at scale 1. Capture at 2.
