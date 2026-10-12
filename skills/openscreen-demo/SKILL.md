---
name: openscreen-demo
description: Make a polished video of an app or a feature with OpenScreen's MCP tools, from storyboard to recording, editing and export, then either attach it to a pull request or draft a post on X. Use when the user asks for a demo, a demo video, a screen recording, a product video, a launch clip, a video for X/Twitter, LinkedIn or a README, or to show a change in a pull request ("add a video to the PR", "show the feature to reviewers"). Also use to set OpenScreen up for an agent, and to continue an OpenScreen demo in a new session.
---

# Make a demo video with OpenScreen

You produce a short MP4 that shows one feature, zooms on the action and carries its message in on-screen callouts. You do the whole job through OpenScreen's MCP tools: record, edit, export, look. It ends one of two ways:

- **A pull request video:** 10 to 30 s, showing the change a pull request makes, attached to that pull request so reviewers watch it in place (step 8).
- **A launch demo:** 20 to 60 s, 1080p, with a post drafted for X (step 9). **Nothing is ever posted without the user's explicit yes.**

## 1. Set up OpenScreen

You need the tools `startRecording`, `stopRecording`, `exportVideo` and `getFrames`. If you have them, go to step 2. Otherwise set OpenScreen up, once per machine, doing only what is missing.

**The app.** Its executable is the MCP server:

| OS | Executable |
|---|---|
| Windows | `%LOCALAPPDATA%\Programs\Openscreen\Openscreen.exe`, or `C:\Program Files\Openscreen\Openscreen.exe` |
| macOS | `/Applications/Openscreen.app/Contents/MacOS/Openscreen` |
| Linux | `openscreen` on the PATH, or the AppImage |

Run `"<executable>" help`: it must list `mcp`. If the app is missing, or too old to list it, offer to install the latest release, and do it only once the user agrees:

1. Find the installer for this machine in the latest release of `getopenscreen/openscreen`: `gh release view --repo getopenscreen/openscreen --json assets`, or https://github.com/getopenscreen/openscreen/releases/latest.
   - **macOS:** `Openscreen-macOS-Apple-Silicon-<version>.dmg`, or `-Intel-` (check `uname -m`). Mount it, copy `Openscreen.app` to `/Applications`, unmount it.
   - **Windows:** the `Openscreen.Setup.<version>.exe` installer, run with `/S /currentuser` for a silent install for the current user.
   - **Linux:** the `.deb`, `.rpm` or `.pacman` for the distribution, or the `.AppImage` made executable.
2. Check `help` again. If even the latest release does not list `mcp`, this OpenScreen feature is not released yet: say so and stop.

**The MCP server.** Add it to the agent, then the tools load in the next session:

- **Claude Code:** `claude mcp add openscreen -- "<executable>" mcp`
- **Codex:** `codex mcp add openscreen -- "<executable>" mcp`
- **Cursor and others:** a stdio server with the executable as `command` and `["mcp"]` as `args`.

**Permissions.**
- **macOS:** the app that runs the agent needs, in System Settings → Privacy & Security, the Screen Recording permission to record at all, and the Accessibility permission for OpenScreen to record the pointer's clicks and shapes. Without Accessibility a take driven with the real mouse gets no zoom on its clicks: grant it, or hand the clicks over with `setPointerTrack` as for a scripted take.
- **Linux:** the desktop's picker opens on every recording, and the user chooses the window.

**Hand over to the next session.** Write the user's request, and anything already decided, to `openscreen-demo-plan.md` in the working directory. Then ask the user to start a new session and say *continue the OpenScreen demo*. In that session, read the file and carry on from step 2.

## 2. Plan before recording

Write a storyboard and show it to the user in a few lines, then carry on unless they object.

- **One message.** What should a viewer remember after 3 seconds? The first beat shows the result, not a setup screen.
- **Launch demo: 3 to 6 beats, 20 to 60 seconds.** Each beat is one action and one callout of 6 words or fewer. X autoplays muted, so the callouts carry the story, not a voice.
- **Pull request video: 1 to 3 beats, 10 to 30 seconds.** Show what the change does, not the whole product: the new behavior, or the bug no longer happening. The pull request text explains the rest, so one short callout per beat is enough.
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

1. `exportVideo` with the `projectId` and a path such as `demo/demo.mp4`. For a pull request video, pass `quality: "medium"` (720p) to keep the file small.
2. `getFrames` with the `projectId`, at the ruler seconds of your beats.
3. Check every frame:
   - Is each callout readable and clear of the action?
   - Is each zoom on the thing that changes?
   - Are there black frames, cut-off text or a leftover setup screen?
4. Fix the project and export again until it holds.

Never commit the video to the repository: it goes into the pull request or the post, not the code.

## 8. Attach it to the pull request

Only to a pull request the user asked for a video on, or one you open for them in this task.

1. **Check the size.** GitHub takes videos up to 10 MB in a repository on a free plan, 100 MB on a paid one. Over the limit, cut or speed up a beat and export again.
2. **Write the text around it** in a file, say `demo/pr-video.md`: one line saying what the video shows, then the video alone in its own paragraph, so GitHub shows a player and not a link:

   ```markdown
   **Demo:** the export dialog now remembers the last format.

   ![](demo/pr-video.mp4)
   ```

3. **Attach it with `gh`**, version 2.99.0 or later (`gh --version`). `gh` uploads the file and puts its URL in place of the path. You need push access to the repository.
   - On an existing pull request, as a comment: `gh pr comment <number> --body-file demo/pr-video.md --attach demo/pr-video.mp4`
   - On a pull request you are opening: put the same two lines in its body, and pass `--attach demo/pr-video.mp4` to `gh pr create`.
4. **With an older `gh`,** ask the user to update it. **On GitHub Enterprise Server,** where `gh` cannot attach files at all, skip `--attach`. In both cases, use a browser tool that can attach a file to the comment box on the pull request's page, or else give the user the file and the text to drop in themselves.
5. Report the comment's or the pull request's URL.

## 9. Post on X

1. **Write the post.** At most 280 characters: the hook first, then what it does, then the link if there is one. One or two hashtags at most.
2. **Check X's limits.** The video must be an MP4 of at most 2 min 20 s and 512 MB for an account without Premium. The export fits.
3. **Ask the user.** Show the post text, the video path and one frame, and ask for an explicit yes. A "looks good" given to an earlier step is not one.
4. **Post, after the yes only.** Use a browser tool that can attach a file to the composer at https://x.com/compose/post, or the X API if the user has set one up. If you cannot attach a file, give the user the text and the file instead.
5. Report the post's URL.

## When it goes wrong

- **`The recording did not start`:** the window title did not match, or capture is not permitted. Check `listSources` and the permissions in step 1.
- **No cursor in the video:** the app was driven by a script. See step 4.
- **No zoom on an early click:** the first 2.5 s stay wide on purpose. Start the first action after that.
- **`unknown flag: --attach`:** `gh` is older than 2.99.0. See step 8.
