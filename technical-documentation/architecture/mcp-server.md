# MCP server

OpenScreen offers the in-app agent's tools to MCP clients the user runs themselves (Claude Code, Codex, Cursor, anything that speaks MCP), on any of the user's projects, not only the one open in the editor. The client brings its own model and its own sign-in; OpenScreen never sees, stores or relays those credentials.

The same tools are served over two transports, by two different processes:

| | In-app server (HTTP) | `openscreen mcp` (stdio) |
|---|---|---|
| Process | The running app (the GUI) | A process of its own, started by the client: the app's executable with `mcp` |
| Setup | **AI settings → MCP server**: turn it on, copy the `claude mcp add` / `codex mcp add` command (it carries the token) | `claude mcp add openscreen -- <executable> mcp` ([executables](../../website/docs/cli.md#running-the-cli)) |
| Auth | Bearer token, `127.0.0.1` only, Host/Origin check | None: the client launched the process with the user's rights |
| Edits, recording, export | Off until the user turns on **MCP edits** | Always allowed |
| Project open in the editor | Edited live through the editor, one undo step per call | The same while the app runs: the call is forwarded to it. With no app answering, refused ([the marker](#the-open-in-editor-marker)) |
| Other projects | Read from and saved to their file, a checkpoint first | Same |
| Tools | `listProjects`, the agent's tools, `transcribe`, the project tools (`setProjectInfo`, `importMedia`, `removeMedia`), the checkpoint tools, and the media tools: `listSources`, `startRecording`, `stopRecording`, `setPointerTrack`, `exportVideo`, `getFrames`, `createProject` | The same |
| A take | Recorded by the app's recording bar, as its Record button records; the editor opens it ([below](#the-media-tools)) | Recorded by a hidden runner of its own process, and made a project there |
| Checkpoints | In the app's memory, shared with forwarded `openscreen mcp` calls, lost when the app quits | In the app's while it runs; otherwise in this process's, lost when it exits, which it does when the client disconnects |

**When the app runs, it is the authority**: `openscreen mcp` forwards its document calls to it ([below](#openscreen-mcp-and-the-running-app)), so one process writes the projects. Only when no app answers do two processes write the same project folder; the [open-in-editor marker](#the-open-in-editor-marker) and the byte compare of `saveProjectIfUnchanged` are then what keep them from overwriting each other's work.

| File | Role |
|---|---|
| [`electron/mcp/openscreen-mcp-server.ts`](../../electron/mcp/openscreen-mcp-server.ts) | The tools both transports serve, the tool runner (routing, refusals, checkpoints), the texts per transport (`mcpInstructions`), and the local HTTP guard. |
| [`electron/mcp/stdio-server.ts`](../../electron/mcp/stdio-server.ts) | `openscreen mcp`: the same server, runner and media tools on stdin/stdout. |
| [`electron/mcp/project-tools.ts`](../../electron/mcp/project-tools.ts) | The project tools the runner runs: rename a project, import a file into its media, remove one. |
| [`electron/mcp/media-tools.ts`](../../electron/mcp/media-tools.ts) | The media tools both servers serve (`createMediaTools`), their capability block per transport (`mediaPreamble`), and `openscreen mcp`'s recorder. |
| [`electron/mcp/app-recorder.ts`](../../electron/mcp/app-recorder.ts) | The in-app server's recorder: a take through the app's recording bar, opened by its editor. |
| [`electron/mcp/editor-document-host.ts`](../../electron/mcp/editor-document-host.ts) | Main-process side of the live document: asks the editor window for a snapshot and hands edits back. |
| [`electron/mcp/app-channel.ts`](../../electron/mcp/app-channel.ts) | The local channel `openscreen mcp` forwards its document calls through to the running app. See [`openscreen mcp` and the running app](#openscreen-mcp-and-the-running-app). |
| [`electron/mcp/mcp-controller.ts`](../../electron/mcp/mcp-controller.ts) | In-app server lifecycle: start when enabled, restart on a port or token change, status for the settings UI. |
| [`electron/mcp/mcp-settings-store.ts`](../../electron/mcp/mcp-settings-store.ts) | `mcp-server.json` (enabled, port, allowEdits) and `mcp-token.enc` (bearer token, `safeStorage`). |
| [`src/lib/ai-edition/store/mcpDocumentHost.ts`](../../src/lib/ai-edition/store/mcpDocumentHost.ts) | Renderer side: answers snapshot / apply requests from the project store, and transcribe requests through the editor's transcription queue. Mounted by `NewEditorShell`. |
| [`electron/ai-edition/caption-tools.ts`](../../electron/ai-edition/caption-tools.ts) | The caption and vocabulary tools, routed there by `executeAgentTool`. |
| [`src/components/ai-edition/McpServerSettings.tsx`](../../src/components/ai-edition/McpServerSettings.tsx) | The settings section: server toggle, the **MCP edits** toggle, port, token, copyable `claude mcp add` / `codex mcp add` commands. |

## One tool surface, two agents

Nothing about the tools is reimplemented. The server registers `TOOL_ARG_SCHEMAS` (names and zod schemas) and `TOOL_DESCRIPTIONS`, and builds its `instructions` around `buildSystemPrompt`, all exported from [`deep-agent/service.ts`](../../electron/ai-edition/deep-agent/service.ts), where `buildTools` builds the in-app agent from the same table. Every call goes through `runDocumentTool`, the function the in-app agent's `documentTool` also calls: the cursor-telemetry read the zoom tools need (for `addAutoZooms`, the timeline wand's plan, `collectAutoZoomSuggestionsForDocument`, over every take on the timeline), then `executeAgentTool`.

So a tool added to the agent appears over MCP with no further work, and the MCP test asserts the listed tools equal `listProjects`, then `OPENSCREEN_TOOL_NAMES`, then the three project tools, then the two checkpoint tools, then the [media tools](#the-media-tools). The caption tools are agent tools like the others (`getCaptions`, `setCaptionSettings`, `getCaptionTranslationUnits`, `putCaptionTranslation`, `removeCaptionTranslation`, `setVocabulary`): the caller translates the captions with its own model and stores them with `putCaptionTranslation`, so neither agent needs the app's provider for it. What the server adds:

- **`listProjects`**, a tool of its own: every project's id, title, `updatedAt`, asset count, and `open` for the one in an editor (this process's, or the app's seen through the marker).
- **`transcribe`**, registered where `McpToolDeps.transcribe` is wired (both transports, by `registerIpcHandlers`), see [Transcription](#transcription).
- **An optional `projectId` on every agent tool and both checkpoint tools**, added to its schema with `.extend()` at registration and stripped again before the call reaches the executor, which never sees it. See [Which project a call acts on](#which-project-a-call-acts-on).
- **`createCheckpoint` / `restoreCheckpoint`**, see [Checkpoints](#checkpoints).
- **The project tools**, see [The project and its media](#the-project-and-its-media).
- MCP metadata: `readOnlyHint` for the reads (`!isMutatingTool`), `listProjects` and `createCheckpoint`, and `destructiveHint` for `replaceTimeline`, the three `remove*` agent tools, `removeMedia` and `restoreCheckpoint`.

### The effect contract

The server's one resource, `openscreen://effects/contract` ([`effects-contract.ts`](../../electron/mcp/effects-contract.ts)), holds the full WGSL contract of `addEffect`: the inputs an effect reads, its parameters, the rules, the cost tiers and two examples. It is too long for a tool description and versioned with the contract; the instructions point to it. `effects-contract.test.ts` checks that it names every field of the compositor's prelude, and `shader_fx::tests::the_examples_of_the_mcp_contract_compile` compiles its examples. The code an agent writes is checked by `McpToolDeps.checkShaderEffect`, the compositor's `checkShaderEffect`, wired in `registerIpcHandlers` like `cameraSegmentation`; the in-app agent gets the same check through `ChatRunEnv`.

### The project's look

`setEditorSettings` ([`editor-settings-tool.ts`](../../electron/ai-edition/editor-settings-tool.ts)) writes every setting of the editor's look panes: background, frame, format, camera layout, cursor, `autoFocusAll` and `audioGainDb`. It takes a partial `EditorSettingsPatch` and applies it with `applySettingsPatch`, the editor's own write, plus what the panes do around a pick (a first fixed format fills the frame, an untouched camera roundness follows its shape, the camera framing is stored as size and pan). `setAspectRatio` is the same write for the format alone.

- **Validation.** Numbers are held to `SETTING_BOUNDS`, enums to the constant lists, and both wallpapers go through `parseStylePresetWallpaper`: a colour, a gradient, a bundled path or an inline PNG/JPEG, never `file://` nor a URL. The schema is strict, so a misnamed key is refused rather than dropped.
- **Read side.** `getCurrentDocument` adds `settings`, in the tool's own shape with data-URL wallpapers elided, and `settingsContext`: the formats on offer (`originalAspectRatios` from `collectNativeFormats`), `formatFill`, `hasTiltedZoom`, the bundled wallpapers, the cursor themes, `cameraSegmentation`, and `inactive`, each setting the editor hides in the current state with why. A write reports the same for the keys it set. The captions stay out of `settings`: `getCaptions` reads them and `setCaptionSettings` writes them, so no caption field has two owners.
- **Segmentation.** `McpToolDeps.cameraSegmentation` and the in-app agent's `ChatRunEnv` ask the compositor (`probeSegmentation`), wired in `registerIpcHandlers`; `openscreen mcp` inherits it with `mcpToolDeps`. Where nothing is wired it reads `null`, "not checked".
- **Not covered yet:** style presets (`StylePresetService`) are not exposed; `setEditorSettings` reaches every field a preset holds.

## What each transport tells its client

Every text a client reads must be true on the server that serves it, so the texts are composed rather than shared verbatim. `McpToolDeps.transport` (`"http"` or `"stdio"`) selects them:

- **Instructions** (`mcpInstructions`): the media tools' capability block (`mediaPreamble`), then the projects-and-checkpoints rules of the transport, then how long checkpoints live there, then `buildSystemPrompt`. The checkpoint rule is in both. Over HTTP the media block says a take goes through the app's recording bar and opens in the editor, and the rules speak of the editor and its undo stack; while **MCP edits** is off, a line says `startRecording`, `exportVideo` and `createProject` are refused too. Over stdio the media block says the takes land in the app's project list, and the rules say that calls go through the app while it runs (the open project live, with `Ctrl/Cmd+Z`), and to the files when it does not.
- **`buildSystemPrompt`** takes the transport's facts as options: `editsSetting` names the switch its consent block points to (the MCP server's **MCP edits**, not the in-app agent's **Agent edits**), and `canExport` drops "exporting" from its examples of a request with no tool, since both serve `exportVideo`.
- **Tool descriptions**: `projectId` is "omit it for the open project" over HTTP and "omit it only for the open project, while the app runs" over stdio. `startRecording` and `stopRecording` say how each server makes a take ([below](#the-media-tools)), and the paths of `exportVideo` and `getFrames` must be absolute over HTTP: the app has no working directory of the client's.
- **Messages**: no project to fall back on, a checkpoint required, an unknown checkpoint, edits turned off. Each has a version per transport, or exists only on the one that can produce it. The stdio versions are only met with no app answering, and say so.

The in-app chat agent keeps `buildSystemPrompt`'s defaults: its own switch, no export. The app's channel for `openscreen mcp` registers none of the media tools, only a `setPointerTrack` of its own ([below](#the-media-tools)), so its instructions have no media block: no agent reads them.

**Writes on the in-app server are a second opt-in.** MCP clients have their own **MCP edits** switch, `allowEdits` in `mcp-server.json`, **off by default** and independent of the in-app agent's **Agent edits** (`allowAgentEdits`). Turning the server on therefore grants read access only. The value is read on every call; while it is off every mutating tool and `setPointerTrack` are refused with the executor's `consent_required` payload naming **MCP edits**, `restoreCheckpoint` with its own refusal text naming it too, `startRecording`, `exportVideo` and `createProject` with theirs, and the consent block of the system prompt is in the instructions. It is independent because `allowAgentEdits` defaults to allowed and lives in the provider form, so a user with no provider configured could never have turned MCP writes off. Toggling it does not restart the server. `openscreen mcp` has no such switch: the client started it itself, and there is no other caller to keep out. Its calls forwarded to the app keep that: the runner takes `editsAllowed` per call.

**Recording and export wait for the same switch, with no setting of their own.** The settings model has two steps: the server on is read access, **MCP edits** on is a client changing things. A take captures the screen and creates a project; an export writes a file wherever the client says, over one already there. Both change things, more than an edit does, so both wait for **MCP edits**, whose label says so: *Allow MCP clients to edit your projects, record and export*. A third switch would split one decision, whether this client may act for the user, in two. `stopRecording` is not gated, so a take started before the switch went off can still end. `listSources` and `getFrames` only read, so the server being on is enough.

## Which project a call acts on

| `projectId` | In-app server | `openscreen mcp` |
|---|---|---|
| omitted | The project open in the editor, through the editor. With none open the call fails and points at `listProjects`. | While the app runs, forwarded: the same as the in-app server. Otherwise fails, asking for a `projectId`. |
| the id of the project open in the app's editor | The same: through the editor, never its file. The file is read first all the same (see below). | While the app runs, forwarded: the same. Otherwise refused ([the marker](#the-open-in-editor-marker)). |
| any other id | That project's file, through the process's one `DocumentService` (`getProjectForUpdate` → tool → `saveProjectIfUnchanged`). Works with no editor window at all. A write needs a checkpoint of that project first, and is refused while another process's editor holds it. | Same. |

The open project is never written to disk from here because the editor holds it in memory and saves it as a whole: a file edit under it would be overwritten by the editor's next save, and the editor would never show it.

## Where the document comes from

### The open project (in-app server)

The in-app agent is handed a document snapshot per chat turn. An MCP client has no turn, so each call reads the **live** document from the editor window, which owns it (`useProjectStore`, with its `revision`):

1. `EditorDocumentHost.snapshot()` sends `{op: "snapshot"}` on `ai-edition.mcp-request` to the editor; it answers `{document, revision}` (or `null` with no project open).
2. `runDocumentTool` runs against that document.
3. If the tool changed it, `apply(document, revision)` sends it back; the editor applies it through `applyAgentDocumentIfCurrent` — the same revision-guarded apply an in-app chat turn uses — so it is saved and becomes **one undo step**.

A user edit that lands between 1 and 3 moves the revision and the apply is refused as a conflict; the client is told to re-read. The renderer also compares the project id, because the revision counter restarts at 0 when a project closes and a quick switch to another project could otherwise match. Calls are serialised in the main process so two of them never interleave.

Only the webContents that registered on `ai-edition.mcp-host` is asked, and only its replies count. An editor that unmounts or is destroyed stops being asked. A request unanswered for 30 s resolves to "no project" (reads) or `timeout` (writes, reported as "did not confirm", not as a failure, since the save may have landed).

`openscreen mcp` builds the same `EditorDocumentHost`, but no editor window ever exists in that process, so its snapshot is always `null`: it reaches the app's editor by forwarding the call to the app.

### Any other project

Read with `DocumentService.getProjectForUpdate` (`getProject`, migrated and relinked like any open, plus a version) and, if the tool changed it, saved with `saveProjectIfUnchanged` — the same instance every other save in the process goes through. Reads and saves of one project share its queue, so a read returns only once every read and save asked for before it is done.

A call naming a project reads its file **before** asking the editor for a snapshot. An editor open of that project already under way has then returned, and the editor installs what it read before it answers, so the snapshot shows the project and the call goes through the editor.

Before the save, the runner refuses, in this order and with nothing written:

1. **Another process's editor holds the project** ([the marker](#the-open-in-editor-marker)). That editor would save over the edit.
2. **The project has no checkpoint** in this server's memory. An edit to a file is on no undo stack, so the checkpoint is its only way back ([Checkpoints](#checkpoints)).
3. **The project changed since the call read it.** There is no revision to guard a file with, so the save is refused with "NOT applied … re-read, then retry" when, since the read:
   - **anything read the project.** This is the editor opening it: from that read on it holds a copy without the MCP edit, and its next save would drop the edit without a word. A snapshot cannot see this in time, since the editor installs what it read only after the read returns. `DocumentService` counts every read and save of a project instead. The client's retry, with the same `projectId`, then goes through the editor. The open-file dialog never saves back a project's own file: it loads that project by id (`storedProjectId`), a read like any other.
   - **anything saved it, or its file changed.** The file must still be, byte for byte, the one the tool ran against. This also covers the other process, a writer outside the app (a sync tool, a restored copy) and a delete.

The check runs inside the project's queue, so nothing in the process reads or saves the project between the check and the write.

### The open-in-editor marker

When no app answers its channel, `openscreen mcp` cannot ask the app's editor anything, so the app says which project its editor holds: the editor sends the project id on `AI_EDITION_OPEN_PROJECT_CHANNEL`, and `DocumentService.markOpenInEditor` writes `.open-in-editor.json` (`{pid, projectId}`, temp file then rename) in the projects folder. Only the window that set it clears it, on closing the project or on being destroyed. `projectOpenInEditor()` reads it back and ignores a marker whose `pid` is no longer running, so an app that crashed blocks nothing. The runner checks it just before any write to a file; `listProjects` reports the project as `open`.

An edit refused this way is answered with `ProjectOpenInEditorError`'s message: the editor could not be reached, so retry, and if it is refused again, close the project in the app, or restart or update it. It takes an app that is alive but not answering, or one that predates forwarding.

## Checkpoints

A client chains several edits in one turn, and each is its own undo step, so reverting a turn by hand means one Ctrl+Z per call, interleaved with whatever the user did meanwhile. `createCheckpoint` saves the document in the server's memory and returns a `checkpointId`; `restoreCheckpoint` hands that document back as the call's new document. On the project open in the in-app server's editor it goes through the same revision-guarded apply, so the whole revert is **one undo step** the user can itself undo. The server instructions tell the client to checkpoint before a series of edits.

- They take `projectId` like every tool, so a project that is not open has them too: the checkpoint is read from its file, and the restore is saved to it with the same guards as any edit. That restore is not one undo step, since nothing holds the project's history.
- **A project that is not open cannot be edited without one.** Ctrl+Z cannot reach an edit to it, so a write there is refused until a checkpoint of that project is in memory, and the client is told to call `createCheckpoint` first. Over stdio that is every project. `stopRecording` creates one for each new take and returns its id.
- **They cover the cursor sidecar.** `setPointerTrack` rewrites `<video>.cursor.json`. Before the runner writes a sidecar, it keeps the file's previous content (or its absence) in every checkpoint of that project that has none for it yet; a restore writes those back, and deletes a sidecar the take never had. A restore is itself such a write, so each checkpoint gets back its own state whatever order they are restored in.
- A restore is a write: refused while **MCP edits** is off, and refused when the checkpoint belongs to another project than the one the call acts on. That message names the checkpoint's `projectId`: restoring a closed project's checkpoint takes it explicitly.
- It discards every edit since the checkpoint, the user's included. The tool description says so. A transcript an asset gained since the checkpoint is kept, where the checkpoint had none for it: it is the media read, not an edit (`keepTranscriptsMadeSince`).
- **Lifetime.** Checkpoints live in the runner's memory, the 20 most recent. In the app that is one runner (`createToolRunner`, built in `registerIpcHandlers`), shared by the in-app server and every forwarded `openscreen mcp` call; a restart of the in-app server keeps them, and they are lost when the app quits. An `openscreen mcp` with no app answering keeps its own, lost when the process exits, which it does when the client disconnects. The unknown-checkpoint message says which. The in-app agent does not need them: its whole turn is a single apply.

## The project and its media

Three tools of the runner's own ([`project-tools.ts`](../../electron/mcp/project-tools.ts)) edit what the agent's tools cannot reach: the project's name and its media. They take `projectId` and go through the runner like any edit, so the project open in the editor changes there, live and one undo step, any other project needs a checkpoint first, and **MCP edits** gates them. The app's channel serves them, so `openscreen mcp` forwards them to the running app like any document call. The in-app agent does not get them: it has no file on disk to name.

- **`setProjectInfo`** sets `project.title`, trimmed and never empty, as the editor's name field commits it.
- **`importMedia`** files a video or audio file into `assets`, through the same `documentWithAsset` as `DocumentService.addAsset`: an audio file never claims the primary slot, a video claims it only when the project has none. Before the runner reads the project, the path is checked (absolute, a file, an extension `addAsset` accepts for the kind) and measured with the hidden-window probe (`openVideo`, hidden-video.ts), so the slow probe never holds a snapshot open. A probe that fails is not fatal, as in the editor: the asset has no `durationSec` and the editor measures it once it opens the project. In the app, `approveMedia` grants the file to the renderer, as picking it would, so the editor can play what a client imported into the project it has open. The kind defaults to the extension: audio for an audio-only one, video otherwise. The file lands in the media, not on the timeline: `addAudio` plays an audio file.
- **`removeMedia`** drops an asset with `documentWithoutAsset`, `DocumentService.removeAsset`'s own change, but refuses while a clip or an audio track still uses it, naming them: removing footage the timeline plays is a `removeClip`, not a side effect. The file on disk is never touched.

**Deleting a project is left out on purpose.** It cannot be undone, no checkpoint holds a deleted file, and nothing an agent makes needs it. The user deletes projects in the app.

## Transcription

`transcribe` runs the on-device Whisper on one asset and stores its transcript, which `getTranscriptWords`, `removeWords` and the captions read. A take from `stopRecording` has none until it runs; the editor makes one on its own when it opens a project.

- **Outside the queue.** Whisper takes minutes, so the runner does not hold its queue for it: other calls go on, and only the landing is queued, as a `RunnerEdit` on the project as it is by then (`applyTranscriptionResult`: the transcript replaced, the word corrections that still match carried over, a remembered failure cleared, as the editor's queue lands one).
- **The project open in an editor of this process** goes to that editor's own queue (`McpDocumentHost.transcribe` → `ensureTranscript`): a job already queued or running for the asset is waited for, never doubled. The host waits up to an hour, and answers at once when the editor goes away.
- **Any other project** runs `SttManager.transcribe` in this process with the asset's path and the project's vocabulary as Whisper's prompt, one MCP transcription at a time. No runner window is needed: the engine and its ffmpeg decode already live in the main process. The renderer's own decode, the editor's fallback for an install with no ffmpeg, is not available there.
- **Without `language`** a transcript already there is returned unchanged; with one (or `auto`) the asset is transcribed again.
- **Failures** are classified as the editor classifies them (`classifyTranscriptionError`), and a deterministic one (no audio, unreadable codec) is remembered on the asset (`withTranscriptionFailure`).
- **No checkpoint is needed** on a closed project, since `restoreCheckpoint` keeps the transcript anyway.
- **Forwarded** from `openscreen mcp` to the app like every tool, with a 65-minute timeout instead of 90 s, and never run again locally after a lost answer. With no app, `openscreen mcp` transcribes in its own process and stops the Whisper helper before it exits.

## The media tools

`createMediaTools` builds the tools that make a video around the edits, once per server, and `createOpenScreenMcpServer` registers them. Both servers serve the same seven, from the same code. Their state (the take running, the export running, each take's start time, each project's last export) lives in what `createMediaTools` returns, so the in-app server, which builds a fresh `McpServer` per request, keeps it across requests and across a restart of its port. They share the runner the document tools use: the app's one runner in the app, the routed one of `stdio-server.ts` over stdio, so their document calls go to the app while it runs.

What differs between the two servers is who records, handed in as a `TakeRecorder`:

| | In-app server | `openscreen mcp` |
|---|---|---|
| Recorder | `createAppRecorder` (app-recorder.ts) | `runnerRecorder` (media-tools.ts) |
| `startRecording` | Points the recording bar at the request, as the editor's Record mode does before it hands over: the source, picked from the list `listSources` shows (`pickRecordingSource`, as `openscreen record`), and the microphone, camera, system audio and cursor mode in the recording prefs (`takePrefs`; a device named by the client is looked up in the same list, for its id beside its name). Then hands over as the editor's Record button does (`start-new-recording`): the editor closes, the HUD starts the take with its countdown. Returns once `set-recording-state` says it records. Refused while the editor has unsaved changes, since the editor closes. Where the system's picker owns the choice (the Linux portal, Apple's picker on macOS 15.2+), the request picks nothing: that picker asks the user. | A hidden `cli-record` runner of its own process, as `openscreen record`, with the same request (`CliRecordRequest`: source, microphone, camera, system audio, cursor mode). |
| `stopRecording` | Presses the HUD's Stop, as the tray does. The HUD saves the take and hands it to the editor (`set-current-recording-session`), which imports it as for any take: one clip, measured, and the zooms on its clicks when Record mode's *Auto-zoom after recording* is on. The recorder waits for the editor's document to hold the take with its real length, then for its revision to hold still for 1.5 s, and returns that project, open in the editor. A `title` is applied through the editor. | Stops the runner and makes the project here (`createProjectFromVideo`): a fresh id no editor can hold, the zooms planned from the clicks, and the webcam, when one was recorded, linked to the take's asset as the editor links it (its offset and size). |
| The user's settings | The source, microphone, camera, system audio and cursor mode the user had (`TAKE_PREF_KEYS`) come back once the take is captured, or as the app quits mid-take. A request that fails before the take changes none of them. | Untouched: the runner never saves them. |

Then both servers carry on alike:

- `stopRecording` creates the take's checkpoint through the runner, and records when the take started, by its video, for `setPointerTrack`.
- `setPointerTrack` gives a script-driven take a pointer track and plans zooms on its clicks. `pointerTrackEdit` computes the new sidecar and the zooms from the project the runner read, writes nothing itself, and hands both to the runner as a `RunnerEdit`. The runner then applies the same refusals as any edit (another process's editor, no checkpoint, a project changed mid-call) before writing anything, saves the project, and only then writes the sidecar, keeping its previous content for the checkpoints. Every refusal comes back as the tool's own text result. A sidecar write that fails after the save is reported as a partial edit: the project was saved, the pointer track was not. A `RunnerEdit` is a closure and cannot be forwarded, so the call carries what the edit needs (`events`, and `takes`, each take's start time by video): the app's channel serves `setPointerTrack` with those args and runs `pointerTrackEdit` in its own runner. That is the channel's own registration, not the in-app server's tool: the takes of `openscreen mcp` are known to it alone.
- `exportVideo` renders in a hidden `cli-export` runner, the same in both processes: in the app, `listSources` and `exportVideo` run the CLI's runners (`createRunnerHost` with `createRunnerWindow`), whose IPC the app registers on first use. The runner reads the project by id (`CliExportRequest.projectId`, the editor's own `aiEdition.get`), not by path: opening a file by path moves the main process's current project and recording-session slot, which in the app is the hand-off from the recorder to the editor.
- `exportVideo` takes the Export dialog's options and choices: `quality` and `fps` (24, 30, 60) for an MP4, `gifFrameRate`, `gifSize` and `gifLoop` for a GIF, the dialog's defaults when left out. An option of the other format is refused rather than ignored. Hiding the desktop icons is not a `startRecording` option: the HUD has no such control, so it follows the user's Record mode setting on both servers. Nor are the CLI's `--auto-zoom` and `--audio`: zooms and a voiceover are edits of the project, and an export that added them would not be the project `getFrames` maps through.
- `exportVideo` and `getFrames` read projects; they write none. Over HTTP their paths must be absolute.
- `getFrames` with a `projectId` reads the project's last export while it is current. With no export, or one the project changed after, it renders the frames from the project instead (`renderFrames` in the addon, through the export's own walk), so an agent checks an edit without exporting. See [docs/shader-effects.md](../../docs/shader-effects.md), E.4.
- `createProject` makes a project with `DocumentService.createProject`, so it starts in the look new projects take (the preset marked for them, else the last edited project's), as the editor's New does. With a `videoPath` it lays the video out with `createProjectFromVideo`, the path a stdio take goes through: one clip, measured, and the zooms on its clicks when a pointer track sits beside it. Either way it returns a checkpoint, as `stopRecording` does, so the client can edit the closed project at once. It runs where the media tools run (in the CLI process for `openscreen mcp`): a new project is one no editor holds. **MCP edits** gates it.

## `openscreen mcp` and the running app

The stdio server (`openscreen mcp`, [`stdio-server.ts`](../../electron/mcp/stdio-server.ts)) is a process apart from the app. **When the app runs, it is the authority** (#1174): `listProjects`, every document tool, the project tools, both checkpoint tools and `setPointerTrack` are forwarded to it, and the app runs them through the same runner as the in-app server. The project open in the editor is then edited through the editor, live and one undo step per call, and checkpoints live in one place. The other media tools (record, export, `getFrames`, `listSources`, `createProject`) stay in the CLI process.

- **Channel.** MCP itself, over a Windows named pipe (a fresh random name per launch) or a Unix socket (`<userData>/mcp.sock`, mode 0600). The app serves `createOpenScreenMcpServer` on it, `openscreen mcp` is its client and forwards each `tools/call` unchanged. The handshake lists the app's tools, so a tool an older app lacks runs locally.
- **Discovery.** Once listening, the app writes `<userData>/mcp-app.json` (`{ pid, endpoint, token }`, mode 0600) and removes it as it quits. `openscreen mcp` shares that userData and reads the file on each call it is not connected for: the app starting or quitting mid-session is picked up on the next call. A file whose pid is dead, or whose endpoint does not answer within 3 s, is a crashed app's and is ignored.
- **Trust.** Every connection must first send the token from that file, or it is dropped. Node cannot set a named pipe's DACL, and the default one lets any user open it read-only; the token, in a file inside the user's profile, is what limits the channel to the current user. Any process of that user can connect, which grants nothing new: it could run `openscreen mcp` itself. So calls over the channel edit as `openscreen mcp` always did, whatever the in-app server's **MCP server** and **MCP edits** switches say: those guard the HTTP port, a door a web page or another tool could knock on.
- **Fallback.** With no app, or one that does not answer, the calls run in the CLI process on the files, as before. The project a live app's editor holds is then still refused (#1138): the app's `.open-in-editor.json` marker says so, and the refusal asks to retry, close the project, or restart or update OpenScreen.
- **Never twice.** A call the app received but did not answer within 90 s (65 minutes for `transcribe`), or whose connection dropped, is not run again locally unless it is a read: the client is told the outcome is unknown and to re-read. The connection is dropped, so a hung app does not hold later calls.
- **Checkpoints do not cross over.** One made while the app answered lives in the app and is gone once it quits; one made while no app was reachable (before the call was sent) lives in the CLI process and is unknown to the app. A `createCheckpoint` the app received but never answered creates none here: it gets the unknown-outcome error like any other write. Either way the restore says the checkpoint is unknown, and an edit to a closed project asks for a new one.

## Transport and security

**In-app server (HTTP)**

- Streamable HTTP, **stateless**: a fresh `McpServer` + transport per request, the SDK's documented shape for a server that keeps no session state. The runner, and so the checkpoints, and the media tools' state live as long as the app.
- Bound to `127.0.0.1` only, endpoint `/mcp`, default port 47821 (configurable, 1024–65535).
- Every request needs `Authorization: Bearer <token>`, compared in constant time. The token is 32 random bytes, stored with `safeStorage`, and read only once the server is enabled, so users who never enable it never meet a Keychain prompt for it. Regenerating it restarts the server, so the old one stops working at once.
- The `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, and a request carrying any other `Origin` is refused — this blocks a web page from reaching the server through DNS rebinding.

**`openscreen mcp` (stdio)**

- One `McpServer` on the process's stdin/stdout for the whole session. It exits when stdin ends, closes or errors, whichever the client's pipe reports.
- No port and no token: only the client that launched the process can talk to it, with the user's rights, as it would run `openscreen record` or `openscreen export`. Its own channel to the app is described [above](#openscreen-mcp-and-the-running-app).

## Lifecycle

`registerIpcHandlers` builds the `McpController` and the in-app media tools with their recorder (it is where the agent's own dependencies — the cursor reader, the LLM config — live, and the recording handlers the recorder listens to) and returns it; **`main.ts` starts it**, and hands `registerIpcHandlers` the editor's unsaved-changes flag that `startRecording` checks. The headless CLI shares `registerIpcHandlers` and must never bind the port a running app is listening on, and a bench run has no use for it, so neither calls `startIfEnabled`. `main.ts` also opens the channel for `openscreen mcp` (`serveAppChannel`), always, and closes it on `will-quit`. `openscreen mcp` reuses the same dependencies (`mcpToolDeps`) with `transport: "stdio"` and edits always allowed.

## Connecting a client

The settings section shows both commands for the in-app server with the real URL, and copies them with the real token:

```sh
claude mcp add --transport http openscreen http://127.0.0.1:47821/mcp --header "Authorization: Bearer <token>"

export OPENSCREEN_MCP_TOKEN=<token>
codex mcp add openscreen --url http://127.0.0.1:47821/mcp --bearer-token-env-var OPENSCREEN_MCP_TOKEN
```

For `openscreen mcp`, the client starts the executable itself:

```sh
claude mcp add openscreen -- "<executable>" mcp
codex mcp add openscreen -- "<executable>" mcp
```

## Known gaps

- **`openscreen mcp` records in its own process, app or no app.** Only its document calls are forwarded; its takes, exports and frames stay in the CLI process, and its take lands in the project list rather than in the editor. The in-app server is the way to record through the app's recording bar.
- **An in-app take is ready by a quiet period.** The editor lays a take out in several saves and says none of them is the last: the recorder waits for its revision to hold for 1.5 s. A save later than that (a slow auto-zoom pass) lands after the checkpoint, so `restoreCheckpoint` takes it back with the client's edits.
- **No Ctrl+Z for edits to closed projects.** Their undo is the checkpoint the write requires, which lives in memory: it is gone once its server goes away or 20 newer ones push it out, and the edits stay.
- **An editor that stops answering looks closed.** A snapshot unanswered for 30 s reads as "no project open", so an edit naming the project that editor holds would go to its file, and the editor's next save would drop it. It takes a renderer hung for 30 s.
- **No project deletion**, on purpose ([above](#the-project-and-its-media)).
- **An imported recording comes without its camera.** The editor's import links the webcam an OpenScreen recording was made with (`find-recording-camera`); `importMedia` and `createProject` do not, so the camera of a recording imported over MCP is not in the project.
- **A transcription reports no progress.** `transcribe` answers once Whisper is done, which can outlast a client's own tool timeout on a long recording. In the app, the editor cancelling its own run (a regenerate in another language) also stops an MCP run of the same engine, which then reports a failure.
