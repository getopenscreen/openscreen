---
name: openscreen-demo
description: Make a polished product demo video of an app or a feature with OpenScreen's MCP tools, from storyboard to recording, editing, export and a post on X. Use when the user asks for a demo, a demo video, a screen recording, a product video, a launch clip, or a video for X/Twitter, LinkedIn, a README or a pull request.
---

# Make a demo video with OpenScreen

You produce a short MP4 (20 to 60 s, 1080p, 60 fps) that shows one feature, zooms on the action and carries its message in on-screen callouts, then a post ready for X. You do the whole job through OpenScreen's MCP tools: record, edit, export, look. **Nothing is ever posted without the user's explicit yes.**

## 1. Connect OpenScreen

You need the tools `startRecording`, `stopRecording`, `exportVideo` and `getFrames`. If they are missing, add OpenScreen's MCP server: it is the desktop app's own executable, started with `mcp`.

| OS | Executable |
|---|---|
| Windows | `%LOCALAPPDATA%\Programs\Openscreen\Openscreen.exe`, or `C:\Program Files\Openscreen\Openscreen.exe` |
| macOS | `/Applications/Openscreen.app/Contents/MacOS/Openscreen` |
| Linux | `openscreen` on the PATH, or the AppImage |

- **Claude Code:** `claude mcp add openscreen -- "<executable>" mcp`
- **Codex:** `codex mcp add openscreen -- "<executable>" mcp`
- **Cursor and others:** a stdio server with the executable as `command` and `["mcp"]` as `args`.

Then ask the user to start a new session so the tools load. If the app is not installed, send the user to https://getopenscreen.com/download/ and stop there.

- **macOS:** the app that runs the agent needs the Screen Recording permission.
- **Linux:** the desktop's picker opens on every recording, and the user chooses the window.

## 2. Plan before recording

Write a storyboard and show it to the user in a few lines, then carry on unless they object.

- **One message.** What should a viewer remember after 3 seconds? The first beat shows the result, not a setup screen.
- **3 to 6 beats.** Each beat is one action and one callout of 6 words or fewer.
- **20 to 60 seconds.** X autoplays muted, so the callouts carry the story, not a voice.
- **Realistic data.** Seed the app with believable content. No real customer data, secrets, tokens or personal notifications on screen.

## 3. Set the stage

- Start the app and open it on the starting state of the first beat.
- Give it one clean window of about 1600×1000. For a web app, open it in an app window without browser chrome: `chrome --app=http://localhost:3000 --window-size=1600,1000 --user-data-dir=<temp folder>`. Its title is the page's `<title>`.
- Call `listSources` and pick a unique part of the window's title.
- **Only the app on screen.** No browser toolbar, address bar, local file path, user name, bookmark bar, translation prompt or notification in the recorded window. Recording one window keeps the rest of the desktop out.

## 4. Record

1. `startRecording` with `window`. It returns once capture has started.
2. Play the storyboard. Move deliberately, and pause about one second after each result appears.
3. `stopRecording` with a `title`. Keep what it returns: `projectId`, `checkpointId`, `videoPath`, `recordingStartedAt`.

**How you drive the app decides the cursor.**
- **Real mouse** (computer-use, or any tool that moves the actual pointer): OpenScreen records the pointer, draws a clean cursor and already zooms on each click. If your mouse tool cannot click in the app's window (some only read browsers, for one), drive it from a script instead.
- **A script** (Playwright, CDP): the screen pointer never moves, so the take has no cursor and no zoom. In the script, log every action as it runs: `at` is `Date.now()`, `x` and `y` are the action's position as fractions of the window, `click` is true for a click. Hand the log to `setPointerTrack` after `stopRecording`; its description gives the formula from a page's coordinates. A script also gives the cleanest take: same timing on every run, no hesitation.

## 5. Check the take

`getFrames` on the `videoPath`, about 6 frames. Is it the right window? Is anything private visible? Did every beat happen? If not, record again: a new take costs less than a fix in editing.

## 6. Edit

Use the document tools, always with the `projectId`. Read the project first with `getCurrentDocument`: its notes say which times are in the recording's seconds and which on the editor's ruler.

**One clock.** Place every effect in ruler seconds, and look at the result with `getFrames` and the `projectId`, which takes the same seconds. Never read times off the exported file: a cut or a speed-up shifts its clock away from the ruler.

- **Format first:** `setAspectRatio` for where the video will be shown, `16:9` for X. Do it before placing text.
- **Cut dead time:** the setup at the start, the stop at the end, any wait. Use `addTrims`, or `addSpeed` to fast-forward a wait instead of cutting it.
- **Zoom on the action:** clicks close together share one zoom, and the first 2.5 s stay wide. Check them, then add or move zooms with `addZooms` and `setZoom` where a result deserves its own. Hold a zoom at least 1.5 s.
- **Callouts:** one `addAnnotation` per beat, short, placed clear of the action. Text sits on the output frame and stays put when the picture zooms. Use its look for hierarchy: a large title with `animation: "typewriter"`, step callouts with `animation: "pop"`. `setAnnotation` moves or restyles one.
- **Undo:** `restoreCheckpoint` with the `checkpointId` takes the project back to the raw take in one step.

Keep the rest as it is: the background, padding, shadow and cursor style are chosen to look good.

## 7. Export and review

1. `exportVideo` with the `projectId` and a path such as `demo/demo.mp4`.
2. `getFrames` with the `projectId`, at the ruler seconds of your beats.
3. Check every frame:
   - Is each callout readable and clear of the action?
   - Is each zoom on the thing that changes?
   - Are there black frames, cut-off text or a leftover setup screen?
4. Fix the project and export again until it holds.

## 8. Post on X

1. **Write the post.** At most 280 characters: the hook first, then what it does, then the link if there is one. One or two hashtags at most.
2. **Check X's limits.** The video must be an MP4 of at most 2 min 20 s and 512 MB for an account without Premium. The export fits.
3. **Ask the user.** Show the post text, the video path and one frame, and ask for an explicit yes. A "looks good" given to an earlier step is not one.
4. **Post, after the yes only.** Use a browser tool that can attach a file to the composer at https://x.com/compose/post, or the X API if the user has set one up. If you cannot attach a file, give the user the text and the file instead.
5. Report the post's URL.

## When it goes wrong

- **`The recording did not start`:** the window title did not match, or capture is not permitted. Check `listSources` and the permissions in step 1.
- **No cursor in the video:** the app was driven by a script. See step 4.
- **No zoom on an early click:** the first 2.5 s stay wide on purpose. Start the first action after that.
