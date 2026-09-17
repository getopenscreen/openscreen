---
id: cli
title: Screen recorder CLI for scripts and agents
sidebar_label: CLI
description: "OpenScreen's screen recorder CLI records, captions and exports .openscreen projects from scripts, CI jobs and coding agents, with NDJSON output."
keywords:
  - screen recorder CLI
  - record screen from command line
  - headless screen recorder
  - automate product demo video
  - NDJSON
  - openscreen export
---

# Screen recorder CLI

OpenScreen's command-line interface is built into the desktop app's own executable. `openscreen record`, `captions`, `export`, `pack`, `info` and `sources` run from a terminal without opening a window, and `--json` turns their output into NDJSON on stdout. A script, a CI job or a coding agent can record a take, edit the `.openscreen` project as plain JSON, and render an MP4 or GIF with the same native compositor as the editor's **Export** button.

It is not a server tool. Every command starts Electron, which needs a display server even though no window appears, and recording needs a real desktop session. See [When the CLI is not the right tool](#when-the-cli-is-not-the-right-tool).

:::caution
The CLI and the `.openscreen` project format can still change in breaking ways between releases. Check your scripts after each update.
:::

## Running the CLI

[Install OpenScreen](/download/) first ([Installation](./installation.md)). Every command is a subcommand of the app's executable:

| Install | Executable |
|---|---|
| macOS | `/Applications/Openscreen.app/Contents/MacOS/Openscreen` |
| Windows installer | `Openscreen.exe` in the folder chosen during setup: `%LOCALAPPDATA%\Programs\Openscreen\` for an install for the current user, `C:\Program Files\Openscreen\` for all users |
| Linux `.deb`, `.rpm`, `.pacman` | `openscreen` |
| Linux AppImage | `./Openscreen-Linux-1.11.0.AppImage` |
| Nix | `openscreen` |

The examples on this page write `openscreen`. On macOS and Windows, use the full path or an alias:

```bash
/Applications/Openscreen.app/Contents/MacOS/Openscreen export demo.openscreen -o demo.mp4
```

- `openscreen help`, `--help` or `-h` prints the usage.
- Chromium switches placed before the subcommand are skipped. If Chromium's sandbox cannot start on the host, run `./Openscreen-Linux-1.11.0.AppImage --no-sandbox export demo.openscreen`.
- CLI runs do not take the app's single-instance lock, so they work while the desktop app is open.
- From a source checkout, build the app and its native helpers as [Build and packaging](https://github.com/getopenscreen/openscreen/blob/main/technical-documentation/engineering/build-and-packaging.md) describes, then run `npm run cli -- <command> [options]`.

## Commands

### `openscreen record`

To record the screen from the command line, run `record`. It drives the same recording hook as the desktop app, and the files land in the app's recordings directory, next to recordings made in the GUI: the screen video and, when pointer data was captured, a `<video>.cursor.json` cursor-telemetry file that the editable cursor and `--auto-zoom` read.

```bash
openscreen record --duration 30 --project demo.openscreen --json
openscreen record --window "My App" --mic --system-audio
openscreen record --display 1 --cursor system
```

| Option | Meaning |
|---|---|
| `--display <n>` | Screen index, as listed by `openscreen sources` (default 0) |
| `--window <title>` | Record the first window whose title contains `<title>`, ignoring case. Takes precedence over `--display` |
| `--mic` | Capture the default microphone |
| `--mic-device <name>` | Capture the microphone whose label contains `<name>`, ignoring case. Implies `--mic` |
| `--system-audio` | Capture system audio |
| `--cursor <editable-overlay\|system>` | `editable-overlay` (default) hides the system pointer and records it as data, so the editor can restyle it. `system` draws the pointer into the video |
| `--duration <seconds>` | Stop automatically after this long |
| `--project <out.openscreen>` | When done, write a project file that references the recording, ready for `export` or the editor. Must end in `.openscreen` |
| `--json` | NDJSON events on stdout |

There is no webcam option: a CLI recording contains the screen and audio only.

**Stopping.** Without `--duration`, stop a recording with Ctrl+C (SIGINT), SIGTERM, or by typing `stop`, `q` or `quit` and Enter on its stdin. Closing stdin does not stop it. A forced kill skips the normal finish, so no `done` event and no project file are written.

**Per platform**

- **macOS.** Capture goes through the ScreenCaptureKit helper, with no fallback. The Screen Recording permission is required; for a development build started from a terminal, grant it to the terminal. With `--mic`, the CLI asks for microphone access if it has not been granted. Pointer clicks and shapes are only recorded with the Accessibility permission.
- **Windows.** Capture goes through the Windows Graphics Capture helper, from Windows 10 build 19041. On older builds, or without the helper, OpenScreen falls back to browser capture. Windows never delivers SIGTERM: use Ctrl+C, stdin `stop`, or `--duration`.
- **Linux.** Capture goes through the PipeWire helper and the desktop's ScreenCast portal. The portal's own picker decides what is recorded, and it opens on every run and waits for an answer, so `--display` and `--window` do not choose the source and a Linux recording cannot start unattended. It needs a desktop session with `xdg-desktop-portal`: an SSH session without a display cannot record. Only a build without the helper falls back to Chromium's capture.

### `openscreen sources`

Lists the displays, windows and microphones the app can see, so a script can choose `--display`, `--window` and `--mic-device` values. On Linux the portal picker still decides what `record` captures.

```bash
openscreen sources                   # human-readable
openscreen sources --json            # NDJSON on stdout
openscreen sources -o sources.json   # payload written to a file
```

With `--json`, the payload arrives inside the final `done` event:

```json
{
  "event": "done",
  "success": true,
  "sources": {
    "displays": [{ "index": 0, "id": "screen:1:0", "name": "Entire screen" }],
    "windows": [{ "id": "window:210:0", "name": "My App" }],
    "microphones": [{ "label": "Built-in Microphone" }],
    "microphoneLabelsUnavailable": false
  }
}
```

`microphoneLabelsUnavailable` is `true` when device names need a permission that has not been granted, or when the device list could not be read within a few seconds.

**Why `-o` exists.** The CLI writes only its own output to stdout; Chromium's diagnostics go to stderr. The wrapper around the process is another matter. Ubuntu's `xvfb-run`, the usual way to run a GUI binary on a machine without a screen, merges stderr into stdout, so Chromium's startup warnings land ahead of the JSON and `openscreen sources --json | jq` fails. `-o <file>` writes to a place no wrapper can redirect, and it avoids shell quoting and encoding differences.

The two channels carry different shapes. stdout wraps the payload in the `done` event, because it is one event in a stream. The file holds the payload alone:

```bash
openscreen sources --json | jq 'select(.event == "done") | .sources.displays'   # stdout: inside the envelope
openscreen sources -o s.json && jq '.displays' s.json                             # file: the payload itself
```

The file is written only on success, and atomically: a failed run leaves an earlier file untouched. Check the exit code, not whether the file exists.

### `openscreen export`

Renders a project to MP4 or GIF with the native compositor the editor uses for its preview and export. Zooms, trims, speed regions, annotations and captions, the cursor and the background all come from the project.

```bash
openscreen export demo.openscreen                          # format and quality from the project
openscreen export demo.openscreen -o out.mp4 --quality source
openscreen export demo.openscreen -o out.gif --gif-fps 20 --gif-size large
openscreen export demo.openscreen -o out.mp4 --auto-zoom --json
```

| Option | Meaning |
|---|---|
| `-o, --out <path>` | Output file. The extension, `.mp4` or `.gif`, sets the format. Default: the project's path with `.mp4` or `.gif` |
| `--format <mp4\|gif>` | Override the format stored in the project. Must agree with `--out` |
| `--quality <medium\|good\|source>` | Output size: `medium` is 720p, `good` is 1080p, `source` follows the smallest clip after cropping, so it never upscales. A GIF starts from this size too |
| `--gif-fps <15\|20\|25\|30>` | GIF frame rate |
| `--gif-size <medium\|large\|original>` | GIF height cap applied to that size: 720, 1080, or none |
| `--auto-zoom` | Before rendering, add zooms where the recorded pointer paused, with the same engine as the editor's [automatic zooms](/features/auto-zoom/). Existing zooms are kept, and new ones never overlap them |
| `--audio <file>` | Mix a voiceover file (mp3, wav or m4a) into the MP4. MP4 only |
| `--audio-mode <mix\|replace>` | `mix` (default) keeps the recording's audio under the voiceover at 40% gain; `replace` drops it |
| `--audio-offset <seconds>` | Delay before the voiceover starts (default 0) |
| `--json` | NDJSON progress and result on stdout |

MP4 exports from the CLI are always **H.264 at 60 fps**. There is no codec or frame-rate option. The desktop app's [Export](./export.md) dialog also offers H.265 and 24 or 30 fps.

`--audio` works after the render: the video stream is copied untouched, and a new AAC track is mixed and written over the same output file.

**Where media may live.** When it loads a project, the app approves the referenced media automatically only inside its recordings directory or the project file's own folder. Keep a hand-written project next to its media, or record with the CLI, which uses the recordings directory.

**No cancel.** Only `record` listens for a stop request. Ending the process is the only way to abandon an export; treat whatever it left at the output path as unusable.

### `openscreen captions`

Transcribes the project's audio on your machine with Whisper, then writes caption annotations into the project file. Nothing is uploaded, and the language is detected automatically. The first run downloads the Whisper model once, about 264 MB, as the desktop app does.

```bash
openscreen captions demo.openscreen --min-words 2 --max-words 7
openscreen export demo.openscreen -o demo.mp4   # captions are burned into the video
```

- `--min-words` and `--max-words` set the words per caption. Defaults: 2 and 7.
- Running it again replaces the captions it added before. Annotations you added yourself are kept.
- The project's screen video must have an audio track, for example from `record --mic`.
- Captions are burned into the export. There is no subtitle file output. See [Captions](./captions.md).

### `openscreen pack`

Copies a project and everything it references (screen video, webcam video, cursor telemetry) into one folder, and rewrites the media paths in the copied project.

```bash
openscreen pack demo.openscreen --out bundle/
```

`-o` is accepted as a short form of `--out`, which is required. The folder can be moved or kept as a CI artifact: when the stored absolute paths no longer exist, the app falls back to files with the same name next to the project file.

### `openscreen info`

Prints what a project references and whether its screen video still exists, plus its export settings and how many zooms, trims, speed regions and annotations it holds.

```bash
openscreen info demo.openscreen --json
```

It exits with 1 when the referenced screen video is missing.

## Machine-readable output

With `--json`, stdout carries one JSON object per line. stderr carries diagnostics only, including the app's own log lines.

```json
{"event":"started","command":"export"}
{"event":"progress","percentage":50,"currentFrame":60,"totalFrames":120,"estimatedTimeRemaining":3}
{"event":"done","success":true,"outputPath":"/path/out.mp4","format":"mp4","width":1920,"height":1080}
```

| Event | Sent when | Fields |
|---|---|---|
| `started` | A `record`, `sources`, `export` or `captions` run begins | `command` |
| `log` | A status line, such as `Recording started` | `message` |
| `progress` | Export frames are encoded | `percentage`, `currentFrame`, `totalFrames`, `estimatedTimeRemaining` in seconds. While `--audio` is mixed: `percentage` and `phase: "mixing-voiceover"` |
| `stopping` | `record` received a stop request | `reason`: `SIGINT`, `SIGTERM` or `stdin` |
| `warning` | The run succeeded with a caveat | `message` |
| `error` | A failure was reported | `message` |
| `done` | The run finished, successfully or not | `success`, then the result, or `error` |

What `done` carries:

- **export:** `outputPath`, `format`, `width`, `height`.
- **record:** `screenVideoPath`, `cursorDataPath` (where the telemetry file goes; it may not exist), `durationMs`; with `--project`, also `projectPath` and `projectData`, the project it wrote.
- **sources:** `sources`.
- **captions:** `projectPath`, `captionCount`.
- **pack:** `projectPath`, `files`, `cursorData`. `pack` sends no `started` event.

`info --json` prints a single summary object with no `event` field.

A `pack` or `info` that fails ends on an `error` event with no `done`. A crash can end on an `error` event, or with nothing more on stdout at all. Rely on the exit code.

**Exit codes**

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Failure, including `info` on a project whose screen video is missing |
| `2` | Bad arguments. The message and the usage go to stderr as plain text, even with `--json` |

## Example: an automated product demo

A script or a coding agent can produce a captioned, zoomed demo without opening the editor:

```bash
# 1. Record 20 seconds of one window, with narration from the microphone
openscreen record --window "MyProduct" --mic --duration 20 --project demo.openscreen --json

# 2. Caption the narration on this machine
openscreen captions demo.openscreen --json

# 3. Add a manual zoom and a text label by editing the project JSON
node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync("demo.openscreen", "utf8"));
  p.editor.zoomRegions.push({ id: "z1", startMs: 2000, endMs: 6000, depth: 3,
    focus: { cx: 0.5, cy: 0.4 }, focusMode: "manual", source: "manual" });
  p.editor.annotationRegions.push({ id: "a1", startMs: 500, endMs: 4000,
    type: "text", content: "One-click setup", textContent: "One-click setup",
    position: { x: 8, y: 6 }, size: { width: 40, height: 12 },
    style: { fontSize: 24, color: "#fff" }, zIndex: 1 });
  fs.writeFileSync("demo.openscreen", JSON.stringify(p, null, 2));
'

# 4. Render, with automatic zooms added where the pointer paused
openscreen export demo.openscreen -o demo.mp4 --auto-zoom --json
```

In step 3, `depth` runs from 1 to 6 (1.25× to 5×; 3 is 1.8×), and `cx` and `cy` place the zoom center as fractions of the frame.

To narrate with a text-to-speech engine instead, record without `--mic` and mix the voiceover in at export. Any engine that writes mp3, wav or m4a works; macOS `say` is shown:

```bash
say -o voice.m4a --file-format=m4af "Welcome to MyProduct. Here is a quick tour."
openscreen export demo.openscreen -o demo.mp4 --auto-zoom --audio voice.m4a --audio-mode replace
```

`captions` reads the recording's own audio track, not a voiceover mixed in at export, so a text-to-speech narration gets no captions this way.

**Exporting a video from another tool.** `export` does not need an OpenScreen recording. The smallest project it accepts is a media path and an empty editor, which becomes one full-length clip with default settings:

```json
{
  "version": 2,
  "media": { "screenVideoPath": "/path/to/clip.mp4" },
  "editor": {}
}
```

Save it in the same folder as the clip. Without cursor telemetry, `--auto-zoom` has nothing to work from.

## Displays, CI and servers

- Every command starts Electron, which starts Chromium, so a display server must be present even though no window opens. On a Linux machine without a screen, a virtual X server started with `xvfb-run` provides it.
- `export` captures nothing, so it works that way, given a Vulkan driver: the Linux compositor renders through Vulkan, and a machine without a GPU needs a software driver such as Mesa's lavapipe. The project's Nix build workflow renders an MP4 from a generated clip this way, under `xvfb-run` with lavapipe on a Linux runner with no screen, and fails if no MP4 comes out.
- `record` does not. On that same runner Chromium finds no display to capture, and on Linux the portal picker needs a person anyway.

## When the CLI is not the right tool

- **You need to record on a server** with no display or desktop session. Recording needs a real desktop, and on Linux someone has to answer the portal picker on each run.
- **You need a stable, versioned API.** The CLI and the project format can still change between releases.
- **You need codec, frame-rate or bitrate control from the command line.** CLI MP4 exports are H.264 at 60 fps, and the MP4 bitrate is not adjustable in the app either.
- **You need the webcam in a scripted recording.** `record` has no camera option.
- **You need subtitle files.** Captions are burned into the video only.

For a hands-on walkthrough of the same steps in the editor, see [How to make a product demo video](./guides/product-demo-video.md). Answers on licensing and network use are in the [FAQ](./faq.md).

## Source code

The CLI is part of the [OpenScreen repository](https://github.com/getopenscreen/openscreen):

- `electron/cli/args.ts`: the argument parser and the usage text, unit-tested in `args.test.ts`.
- `electron/cli/cliMain.ts`: the windowless boot, the stdio protocol, stop signals and exit codes.
- `electron/cli/projectCommands.ts`: `pack` and `info`.
- `src/cli/`: the hidden-window runners for `record`, `sources`, `export` and `captions`.
- `src/lib/cliContracts.ts`: the request and result types shared by both sides.
