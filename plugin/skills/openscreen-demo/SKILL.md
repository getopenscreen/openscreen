---
name: openscreen-demo
description: Make a polished video of an app or a feature with OpenScreen's MCP tools, from storyboard to recording, editing and export, then either attach it to a pull request or draft a post on X. Use when the user asks for a demo, a demo video, a screen recording, a product video, a launch clip, a video for X/Twitter, LinkedIn or a README, or to show a change in a pull request ("add a video to the PR", "show the feature to reviewers"). Also use to set OpenScreen up for an agent, and to continue an OpenScreen demo in a new session.
---

# Make a demo video with OpenScreen

You produce a short MP4 that shows one feature, zooms on the action and carries its message in on-screen callouts. You do the whole job through OpenScreen's MCP tools: record, edit, export, look. It ends one of two ways:

- **A pull request video:** 10 to 30 s, showing the change a pull request makes, attached to that pull request so reviewers watch it in place (step 8).
- **A launch demo:** 20 to 60 s, 1080p, with a post drafted for X (step 8). **Nothing is ever posted without the user's explicit yes.**

This skill carries the whole job on its own. Where this plugin's other skills are installed, each takes one step further: `openscreen-capture` (a clean or headless take), `openscreen-effects`, `openscreen-motion` and `openscreen-sound` (the craft of the edit), `openscreen-review` (the quality gate) and `openscreen-deliver` (formats, size, pull request, posts).

## 1. Set up OpenScreen

You need the tools `startRecording`, `stopRecording`, `exportVideo` and `getFrames`. <!-- full-plugin -->Both of OpenScreen's MCP servers have them: the one the app serves (*AI settings* → *MCP server*), and `openscreen mcp`. With the OpenScreen plugin installed in Claude Code, `openscreen mcp` is already connected: the plugin starts it through a small launcher (Node) that finds the installed app. If you have the tools, go to step 2.

If you have only the tool `openscreenSetup`, the plugin's launcher is running but did not find a usable app: call it, and it says why and which locations it checked. Otherwise the tools are missing for one of these reasons, so do only what is missing:

- **The plugin was just installed:** its server connects after `/reload-plugins` or in a new session.
- **The app is missing or too old** (`openscreenSetup` says so): install it as below, then `/reload-plugins`.
- **Node is not installed,** so the launcher cannot run: register the server by hand, as below.
- **The agent has no plugin support,** or you work in Codex, Cursor or another agent: register the server by hand, as below.

**The app.** Its executable is the MCP server. The launcher checks these locations, and the environment variable `OPENSCREEN_EXE` overrides them:

| OS | Executable |
|---|---|
| Windows | `%LOCALAPPDATA%\Programs\Openscreen\Openscreen.exe`, or `C:\Program Files\Openscreen\Openscreen.exe`. The Microsoft Store version (2.2.0 and later): the execution alias `openscreen`, which is `%LOCALAPPDATA%\Microsoft\WindowsApps\openscreen.exe` (`where openscreen`). Failing that, `app\Openscreen.exe` under `(Get-AppxPackage EtienneLescot.OpenScreen).InstallLocation` (in PowerShell); that path carries the version, so register it again after a Store update. Never wrap it in a `powershell -Command` launcher: PowerShell swallows the server's input after the first message |
| macOS | `/Applications/Openscreen.app/Contents/MacOS/Openscreen`, or the same under `~/Applications` |
| Linux | `openscreen` on the PATH (`.deb`, `.rpm`, `.pacman`, Nix), `/opt/Openscreen/openscreen`, or an `Openscreen-Linux-<version>.AppImage` in `~/Applications`, `~/Downloads` or the home folder |

Check every location in the table before you call OpenScreen missing: the Store version is the one most often overlooked. Run `"<executable>" help`: it must list `mcp`, which arrived in 2.1.0. If the app is missing, or too old to list it, offer to install the latest release, and do it only once the user agrees:

1. Find the installer for this machine in the latest release of `getopenscreen/openscreen`: `gh release view --repo getopenscreen/openscreen --json assets`, or https://github.com/getopenscreen/openscreen/releases/latest.
   - **macOS:** `Openscreen-macOS-Apple-Silicon-<version>.dmg`, or `-Intel-` (check `uname -m`). Mount it, copy `Openscreen.app` to `/Applications`, unmount it.
   - **Windows:** the Microsoft Store (`winget install --source msstore OpenScreen`), or the `Openscreen.Setup.<version>.exe` installer, run with `/S /currentuser` for a silent install for the current user.
   - **Linux:** the `.deb`, `.rpm` or `.pacman` for the distribution, or the `.AppImage` made executable.
2. Check `help` again. If even the latest release does not list `mcp`, this OpenScreen feature is not released yet: say so and stop.
3. With the plugin, run `/reload-plugins` or start a new session: the launcher now finds the app.

**The MCP server by hand,** only without the plugin's server: add it to the agent, then the tools load in the next session.

- **Claude Code:** `claude mcp add openscreen -- "<executable>" mcp`. Not alongside the plugin's server, which would give you every tool twice.
- **Codex:** `codex mcp add openscreen -- "<executable>" mcp`
- **Cursor and others:** a stdio server with the executable as `command` and `["mcp"]` as `args`.
<!-- /full-plugin -->
<!-- directory-plugin
This edition of the plugin carries the skills only. If you have the tools, go to step 2. If you do not, OpenScreen's tools are not available in this session: say so in plain words, point the user to OpenScreen's documentation, https://getopenscreen.com/docs/ai-editing, and stop. Never install anything or change the agent's settings for it yourself. Tools added during a session load only in a new one.
-->

**Permissions.**
- **macOS:** the app that runs the agent needs, in System Settings → Privacy & Security, the Screen Recording permission to record at all, and the Accessibility permission for OpenScreen to record the pointer's clicks and shapes. Without Accessibility a take driven with the real mouse gets no zoom on its clicks: grant it, or hand the clicks over with `setPointerTrack` as for a scripted take.
- **Linux:** the desktop's picker opens on every recording, and the user chooses the window.

**Hand over to the next session.** Write the user's request, and anything already decided, to `openscreen-demo-plan.md` in the working directory. Then ask the user to start a new session and say *continue the OpenScreen demo*. In that session, read the file and carry on from step 2.

<!-- full-plugin -->The tools are missing right after the plugin, the app or the server is added: an agent loads its MCP servers when a session starts, or in Claude Code on `/reload-plugins`. Say so in plain words; when a reload is not possible, hand over as above, with the storyboard in the file if you have made one.<!-- /full-plugin --><!-- directory-plugin When the tools are missing, say so in plain words and stop, as above. --> Never stand in for the missing tools by driving OpenScreen's window with computer use or a mouse tool: it takes over the user's mouse and screen while they may be working.

## 2. Plan before recording

Write a storyboard as a short table and show it to the user, then carry on unless they object.

| Time | On screen | Callout | Zoom on |
|---|---|---|---|
| 0 to 3 s | The export dialog, already filled | **Exports remember your format** (title) | none, wide |
| 3 to 8 s | Click *Export*, the file appears | One click, same settings | the dialog and the file |
| 8 to 12 s | Reopen: the format is kept | Picked up next time | the format field |

- **One message.** Say in one sentence what a stranger should remember. If you cannot, the film has no message yet.
- **The first 3 seconds show the result**, with a title that names the product and its promise. No setup screen, no logo intro, no end card.
- **Launch demo: 3 to 6 beats, 20 to 60 seconds. Pull request video: 1 to 3 beats, 10 to 30 seconds.** The beats' durations add up to the target. A pull request video shows what the change does, not the whole product: the new behavior, or the bug no longer happening.
- **Each beat is one action and one callout of 6 words or fewer;** the title can run to 8. X and LinkedIn autoplay muted, so the callouts carry the story, not a voice.
- **Callouts state what the screen shows.** A number in a callout appears on screen; a feature named is the one shown. Never a figure you computed or an adjective the product does not use.
- **The last beat holds its result 2 s.** A link, if any, goes in the last second.
- **Realistic data.** Seed the app with believable content. No real customer data, secrets, tokens or personal notifications on screen.

## 3. Set the stage

<!-- directory-plugin
**A web app captured headless** (frame by frame, so no window opens on the desktop) needs a capture script that this edition of the plugin does not carry. Say so, and ask the user whether a recording in a real window, which shows the page on their screen, will do. Stage and record it as below only once they agree.
-->

- Start the app and open it on the starting state of the first beat.
- Give it one clean window of about 1600×1000. For a web app, open it in an app window without browser chrome: `chrome --app=http://localhost:3000 --window-size=1600,1000 --user-data-dir=<temp folder>`. Its title is the page's `<title>`.
- Call `listSources` and pick a unique part of the window's title.
- **Only the app on screen.** No browser toolbar, address bar, local file path, user name, bookmark bar, translation prompt or notification in the recorded window. Recording one window keeps the rest of the desktop out.

For staging, choreography and a take recorded with no window at all, use the `openscreen-capture` skill.

## 4. Record

1. `startRecording` with `window`. It returns once capture has started. Connected to the server in the app, the take goes through OpenScreen's recording bar: the editor closes, the bar counts down, and `stopRecording` opens the take in the editor. Pass `camera` only when the user wants to appear on screen: the webcam then shows as a picture-in-picture. Pass `microphone: true` when the user narrates: without it the take has no voice, and nothing to caption.
2. Play the storyboard. Move deliberately, start the first action after 2.5 s, and pause about one second after each result has finished drawing.
3. `stopRecording` with a `title`. Keep what it returns: `projectId`, `checkpointId`, `videoPath`, `recordingStartedAt`.

**How you drive the app decides the cursor.**
- **Real mouse** (computer-use, or any tool that moves the actual pointer): OpenScreen records the pointer, draws a clean cursor and already zooms on the clicks. If your mouse tool cannot click in the app's window (some only read browsers, for one), drive it from a script instead.
- **A script** (Playwright, CDP): the screen pointer never moves, so the take has no cursor and no zoom. In the script, log every action as it runs: `at` is `Date.now()`, `x` and `y` are the action's position as fractions of the window, `click` is true for a click. Hand the log to `setPointerTrack` after `stopRecording`; its description gives the formula from a page's coordinates. A script also gives the cleanest take: same timing on every run, no hesitation.

**The user records the take themselves** from the recording bar: connected to the server in the app, call `waitForRecording` while it records. It never starts or stops anything; it returns once the user has stopped and the editor has saved the take, with the same fields as `stopRecording`. Set `timeoutSec` (default 300, at most 3600) and your client's tool-call timeout longer than the take. A timeout only ends the wait: call it again while the take runs. <!-- full-plugin -->`openscreen mcp` cannot see the recording bar.<!-- /full-plugin -->

**A video you already have** needs no recording: `createProject` with its absolute `videoPath` lays it out as a project, and returns a `projectId` and a `checkpointId` as `stopRecording` does. Check it as a take in step 5, its `videoPath` included, then go on from step 6.

<!-- full-plugin -->
**A web app captured headless** (frame by frame, so no window opens on the desktop): the `openscreen-capture` skill ships a script that does it at twice the display scale and writes the pointer log. Then `createProject` with the video, and `setPointerTrack` with `recordingStartedAt: 0` and each `at` in milliseconds into the video.
<!-- /full-plugin -->

## 5. Check the take

`getContactSheet` with the `videoPath` as `path` and `count: 12` (or `getFrames` on the `videoPath`, about 6 frames). Is it the right window? Is anything private visible? Did every beat happen, once, with its result fully drawn? If not, record again: a new take costs less than a fix in editing.

## 6. Edit

Use the document tools, always with the `projectId`. Read the project first with `getCurrentDocument`: its notes say which times are in the recording's seconds and which on the editor's ruler. Checkpoints live in the server's memory: in a new session, or a new <!-- full-plugin -->`openscreen mcp` <!-- /full-plugin -->server process, call `createCheckpoint` before editing a project that is not open in the editor.

**One clock.** Place every effect in ruler seconds, and look at the result with `getFrames` and the `projectId`, which takes the same seconds. Never read times off the exported file: a cut or a speed-up shifts its clock away from the ruler.

**Edit in this order**, because a cut moves every ruler second after it:

1. **Format:** `setAspectRatio` for where the video will be shown, `16:9` for X or a pull request. When a fixed format makes the frame follow the cursor and you want the whole app in view, `setEditorSettings` with `formatFollowCursor: false`.
2. **Frame the app:** when the take shows more than the app, `setClipRange` with a `cropRegion` crops the clip to it.
3. **Cut dead time:** the setup at the start, the stop at the end, any wait. Use `addTrims`, or `addSpeed` to fast-forward a wait instead of cutting it. No cut shorter than about 0.5 s: it reads as a glitch. Keep cuts out of a zoom's move in and out (`zoomInFromSec`, `zoomOutUntilSec` in `getCurrentDocument`).
4. **Zoom on the action:** the take already has zooms on its clicks, and the first 2.5 s stay wide. After a cut, `addAutoZooms` plans them again on the clicks left. Where one misses, `removeModifier` it and place your own with `addZooms`:
   - `depth: 1` (1.25×) when the action and its result sit apart on screen, so both stay in view; `depth: 2` (1.5×) on a single result; deeper only for small text. Quote the result's `renderedScale`, never the depth.
   - Fully in before the action, held at least 1.5 s and until the result has finished redrawing.
   - `focus` is the zoom's centre; the result's `cursorAnchor` says where the pointer really was.
   - `rotationPreset` (a 3D camera) for one reveal at most, never every zoom.
5. **Callouts:** one `addAnnotation` per beat, placed clear of the action. Text sits on the output frame and stays put when the picture zooms. A consistent look: centred at the top (`x: 50`, `y: 6`), bold white (`color: "#ffffff"`, `bold: true`) on a solid `#rrggbb` plate (`background`) in the product's own colour, `fontSize` 40 for callouts and larger for the title, `animation: "pop"` (a typewriter is still typing at 3 s). An arrow, `type: "figure"`, points at a control the text names. `setAnnotation` moves or restyles one.
6. **Hide what is private:** an email address, a token or a name that shows on screen gets `addAnnotation` with `type: "blur"` over the span it is visible. Its x, y, width and height are percent of the recording's picture, not of the frame, so it stays on what it hides when a zoom moves the picture. Check it with `getFrames`.
7. **An effect no setting offers** (a ripple on each click, a transition over a cut, a color grade): read the resource `openscreen://effects/contract`, then write it as WGSL with `addEffect`. It reads the clicks and the pointer already placed on the frame. Code that does not compile comes back with the compiler's error at your line: fix it and call again. The result gives a cost tier; keep heavy effects to short spans. Check the effect with `getFrames` at the moments it acts. For effects that look designed, use the `openscreen-effects` skill; for timing and easing, `openscreen-motion`.
8. **Music or a voiceover:** `importMedia` with the file's absolute path adds it to the project's media, then `addAudio` plays it over a span. `removeMedia` takes back a file the timeline no longer uses. One sound in the foreground at a time, about -14 LUFS overall. For music and mixing, use the `openscreen-sound` skill.
9. **Captions, for a narrated take** (`startRecording` with `microphone: true`):
   1. `transcribe` with the `projectId`. Whisper runs on this machine and can take a minute; a take has no transcript before this.
   2. `setCaptionSettings` with `enabled: true` and a `style`, plus `anchorV`, `insetY` or `maxWordsPerLine` if the callouts need room.
   3. To caption in another language: `getCaptionTranslationUnits` with the `language`, translate each unit yourself as a whole phrase, store them with `putCaptionTranslation`, then `setCaptionSettings` with that `language`.
   4. `getCaptions` reads it all back. The export burns the captions in.
   A misheard name is fixed with `setWordText` (or `setVocabulary`, then `transcribe` again with the `language`), a flubbed phrase cut with `getTranscriptWords` and `removeWords`.

- **Name:** `setProjectInfo` renames the project, if the `title` given to `stopRecording` no longer fits.
- **Undo:** `restoreCheckpoint` with the `checkpointId` takes the project back to the raw take in one step. It also puts back the take's own pointer track, undoing any `setPointerTrack` made since.
- **Open in the app:** while OpenScreen is running, your edits go through it, so a project the user has open in its editor changes there live and they can undo each edit. If an edit is refused as "open in the OpenScreen editor", the app did not answer: retry once, then ask the user to close the project there or restart OpenScreen.

Keep the rest as it is: the background, padding, shadow and cursor style are chosen to look good. When the user asks for a different look, `setEditorSettings` sets it (background, frame, camera layout, cursor, volume); `getCurrentDocument` shows the current values under `settings`, and `settingsContext.inactive` says which ones would change nothing right now. When they have a look of their own saved as a style preset, `listStylePresets` shows it and `applyStylePreset` with its `presetId` applies the whole look in one edit, leaving the content untouched.

## 7. Export and review

1. `exportVideo` with the `projectId` and an absolute path: resolve, say, `demo/demo.mp4` against your working directory first, since the server in the app refuses a relative path. For a pull request video, pass `quality: "medium"` (720p) to keep the file small. For a GIF (a README, say), end the path in `.gif` and pass `gifSize: "small"` (480p).
2. Review the film with the `openscreen-review` skill. Without it, run at least this pass:
   - `getContactSheet` with the `projectId` over the whole film, `count: 24`: every beat present, in order, no black frame, no leftover setup screen.
   - `getFrames` with the `projectId` at the ruler seconds of the title and each callout: the title readable before 2.5 s; each callout readable, clear of the action, and true to what is on screen; no text cut off.
   - `getContactSheet` with `startSec` and `endSec` around each zoom and each cut: each zoom on the thing that changes, holding both action and result; each cut clean, frame by frame.
   - No pointer over a label or a number, no private data, no browser chrome. `getFrames` with a `region` reads small text at full resolution.
   - `getAudioReport` when the film has sound: about -14 LUFS, true peak at -1 dBTP or lower, no unplanned silence.
   - The exported file itself, with `path`: compression shows banding in gradients and dark areas that the project's frames hide.
3. Fix the project and export again until a whole pass finds nothing.

While you edit, you can call `getFrames` and `getContactSheet` with the `projectId` before exporting: without a current export they render the frames the export would show.

If a tool named here is not in your tool list (`getContactSheet`, `getAudioReport`, or `region`, `startSec` and `endSec` on `getFrames`), the installed OpenScreen is older than this skill: <!-- full-plugin -->offer to update it as in step 1<!-- /full-plugin --><!-- directory-plugin ask the user to quit OpenScreen, install the latest one over it, as https://getopenscreen.com/docs/installation explains, then to start a new session -->, or fall back to `getFrames` with `atSec`.

## 8. Deliver

Use the `openscreen-deliver` skill: shape and size per destination (10 MB for a GitHub comment on a free plan or for Discord without Nitro), attaching to a pull request with `gh`, and drafting a post for X. Without it: attach only to a pull request the user asked for a video on, with `gh pr comment <number> --body-file <text> --attach <video>` (`gh` 2.99.0 or later), and give the user the file and a draft for anything else.

- **Nothing is posted, published, commented or sent without the user's explicit yes for that one action.** Show the text, the video path and one frame, and ask. A "looks good" given to an earlier step is not one.
- **Never commit the video to the repository:** it goes into the pull request or the post, not the code.

## When it goes wrong

- **`The recording did not start`:** the window title did not match, or capture is not permitted. Check `listSources` and the permissions in step 1.
- **Recording, exporting or an edit refused, naming *MCP edits*:** you are connected to the server in the app, which records, exports and edits only once the user allows it. Ask them to turn on *MCP edits* under *AI settings* → *MCP server*.
- **No cursor in the video:** the app was driven by a script. See step 4.
- **`transcribe` fails with `no-audio`:** the take was recorded with neither `microphone` nor `systemAudio`. Record again with one of them.
- **No zoom on an early click:** the first 2.5 s stay wide on purpose. Start the first action after that.
- **An edit refused for want of a checkpoint:** the server process changed since the take. `createCheckpoint` with the `projectId`, then edit again.
- **`unknown flag: --attach`:** `gh` is older than 2.99.0. See the `openscreen-deliver` skill, or ask the user to update `gh`.
