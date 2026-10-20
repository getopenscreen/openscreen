---
id: ai-editing
title: AI editing
sidebar_position: 8
description: "Connect your own LLM key to edit OpenScreen projects from a chat panel. Optional and off by default: nothing is sent to a model until you connect one."
keywords:
  - AI video editing
  - LLM video editor
  - chat editing
  - bring your own key
  - privacy
---

# AI editing

OpenScreen ships an optional agent that edits your project from a chat panel. It is **off until you connect a provider yourself**, and nothing is sent to any model before that. Once connected, the agent talks only to that provider, and so does [caption translation](./captions.md#translation). The app's other network use (the transcription model downloads, update checks) is listed in the [FAQ](./faq.md#does-openscreen-work-offline).

:::tip
None of this is required. Recording, editing, transcription, captions, and export all work with no account and no provider, whether or not you ever open the chat panel. Of those, only transcription needs a download, once: its [models](./captions.md#transcribing), on your first run.
:::

## Connecting a provider

Open the chat column (the toggle at the far left of the top bar, in **Edit** mode), then **AI settings** → pick a provider and paste an API key:

| Provider | Notes |
|---|---|
| **Claude API** (Anthropic) | |
| **OpenAI API** | |
| **Gemini API** (Google) | |
| **Mistral API** | |
| **OpenRouter API** | One key, many models. |
| **MiniMax API** / **MiniMax Token Plan** | |
| **OpenAI Compatible** | Any OpenAI-shaped endpoint — you supply the base URL. |

Your key is stored encrypted through your OS's credential protection (Electron `safeStorage`); if encryption isn't available, the write fails rather than falling back to plaintext. OpenScreen's servers never see it, because there aren't any — requests go straight from your machine to the provider you picked. Provider-specific environment variables work too, if you'd rather not store a key at all.

:::note
The ChatGPT and GitHub Copilot sign-in options were **removed in 1.8.0**. They worked by shipping first-party client credentials belonging to those vendors, which isn't ours to redistribute. Use an API-key provider instead.
:::

## Using the agent

Describe the edit in plain language — "cut the dead air in the intro", "zoom in when I open the terminal". The agent works through real, undoable timeline operations, not a re-render: it can add and adjust trims, zooms, speed regions, annotations (text, arrows, and blurs that hide private details on screen), imported audio tracks with their fades, and Full Camera segments, add automatic zooms on your clicks, edit a clip's in/out points and crop, place another source's footage, duplicate, reorder or remove clips, and read the transcript to find what you're referring to. It also sets the look of the video: background, padding, rounded corners, shadow, device frame, format, the camera layout, the cursor and the master volume. It can also turn the [captions](./captions.md) on, style and place them, and translate them into another language itself. And it can write a visual effect the settings don't offer: see [Custom effects](./effects.md).

The panel around it:

- **Conversations** — history, rename, delete, and start a new one. Each keeps its own agent state.
- **Model picker** — live model list from the connected provider, with a reasoning-effort control where the provider supports one.
- **Context meter** — estimated tokens used against the budget, with a **Compact** action that summarizes earlier turns instead of dropping them.
- **Rewind to this message** — rolls back the agent's edits and every follow-up turn after that point, restoring project, conversation, and agent state together.
- **Agent edits** — a switch in **AI settings**. When it is off, every edit the agent tries is refused: it can still read the project and describe the change it would make, and it applies nothing until you turn the switch back on.

`Ctrl/Cmd + Z` undoes an agent edit exactly like a manual one.

The **Smart cuts** entry (marked *With AI*) in the timeline's auto-enhance menu is the same agent on a one-shot prompt. (The other entry, **Automatic zooms**, reads the recorded clicks and needs no provider at all.)

## What else uses your provider

[Caption translation](./captions.md#translation) is a single text-transform call against the same model — it doesn't run the agent loop and can't touch your document. Asked in the chat, the agent translates the captions itself instead, into the same translation layer. Transcription and caption rendering stay entirely on-device either way.

## Using Claude Code, Codex or another MCP client

If you already use an AI coding agent such as Claude Code or Codex, it can drive the same editing tools, signed in with its own account. Nothing about that account passes through OpenScreen.

1. **AI settings** → **MCP server** → turn it on. It listens only on your own machine (`127.0.0.1`), on the port shown.
2. Copy the **Claude Code** or **Codex** command shown there and run it in a terminal. The Claude Code command carries the access token. Codex reads it from the `OPENSCREEN_MCP_TOKEN` environment variable instead: set that in the shell you start Codex from.
3. Ask your agent for the edit, on the project open in the OpenScreen editor or on any other project in your list.

The tools are the ones the built-in agent uses, plus the ones that record, export and look at a video ([below](#letting-an-agent-make-the-whole-video)), and `transcribe`, which runs the on-device Whisper on a project's media as the editor does when it opens a project. A client translates the captions with its own model, so caption translation needs no provider in OpenScreen. The tools act on the project open in the editor unless the client names another one: it can list every project and read or edit any of them. It can also create a project, empty or from a video file, rename one, and add a video or audio file to a project's media or remove one. Deleting a project is not among the tools: that stays yours to do in the app. MCP clients can only **read** until you also turn on **MCP edits** in the MCP server section: until then every edit, recording, export and new project they try is refused. This switch is separate from the built-in agent's **Agent edits**, and it starts off. Once on, each edit is saved as it lands:

- **On the project open in the editor**, an edit is undone with `Ctrl/Cmd + Z`. Clients are told to save a checkpoint before a series of edits, so you can ask them to put the project back as it was in a single step, which `Ctrl/Cmd + Z` can itself undo.
- **On any other project**, an edit is saved to its file, where `Ctrl/Cmd + Z` cannot reach it. A client must save a checkpoint of that project before its first edit, and putting the project back from it is the only undo.

Checkpoints are kept in OpenScreen's memory: they are lost when it quits or when the server restarts, which changing the port or regenerating the token does. Only the 20 most recent checkpoints are kept, so an older one can be gone sooner. **Regenerate** the token to disconnect every client set up with the old one.

## Letting an agent make the whole video

An agent can make a whole video on its own, from the recording to the export. Besides the editing tools, both ways of adding OpenScreen to it give it `listSources`, `startRecording`, `stopRecording`, `setPointerTrack`, `exportVideo`, `getFrames` and `createProject`. A take can also record your webcam and the system's own cursor, as the recording bar can, and an export takes the Export dialog's options: quality and frame rate for an MP4; frame rate, size and looping for a GIF.

**Through the server above**, a take is recorded by OpenScreen itself, as with its Record button: the editor closes, the recording bar counts down and records, and the take opens in the editor as a new project, where you watch each edit land. It needs **MCP edits** on, and the recording bar gets your own settings back once the take ends.

**As a stdio server**, it needs no setting at all: the agent starts the app's own executable with `mcp`. The quickest way is to paste this into your AI agent (Claude Code, Codex, Cursor…):

```text
Install the OpenScreen demo skill with `npx skills add getopenscreen/openscreen --skill openscreen-demo -y`, then follow it to make a demo video of this feature.
```

The skill installs OpenScreen if it is missing, once you agree, and adds its MCP server. It then asks you to open a new session and say *continue the OpenScreen demo*: an agent only gets new tools in a new session. To set it up by hand instead:

```bash
claude mcp add openscreen -- "<executable>" mcp
codex mcp add openscreen -- "<executable>" mcp
```

`<executable>` is the app's executable, listed for each system in [Running the CLI](./cli.md#running-the-cli). Other clients, Cursor for one, take a stdio server with the executable as `command` and `["mcp"]` as `args`.

The skill also comes as a plugin, from the repository's own marketplace. In Claude Code:

```text
/plugin marketplace add getopenscreen/openscreen
/plugin install openscreen@openscreen
```

For Codex and the ChatGPT desktop app, which share their plugins:

```bash
codex plugin marketplace add getopenscreen/openscreen
codex plugin add openscreen@openscreen
```

OpenScreen then shows among the app's installed plugins, with the skill.

- **No port, no token, no setting.** The agent starts the process itself, with your rights, as it would run `openscreen record`. So it can record your screen and edit without the **MCP edits** switch.
- **Each take becomes a new project** in your project list, zoomed on its clicks as a recording made in the app is: clicks close in time and on screen share one zoom, and the first seconds and the end stay on the whole screen. Every edit the agent makes is saved to the project's file. Its undo is the checkpoint the agent takes, which lasts until the agent's session ends. Only the 20 most recent checkpoints are kept, so an older one can be gone sooner.
- **While OpenScreen is running, the agent works through it.** An edit to the project open in the editor appears there at once, and `Ctrl/Cmd + Z` undoes it. The agent's checkpoints then last until OpenScreen quits. If the app does not answer, edits to that project are refused, since the editor would save its own copy over them.
- **A take has no transcript until the agent asks for one.** It calls `transcribe` before it cuts words or turns the captions on. Whisper runs on your machine, in OpenScreen when it is open.
- **A take driven by a script** (Playwright, for example) never moves the screen pointer. The agent hands OpenScreen its own log of the actions with `setPointerTrack`, and the video gets a cursor and its zooms all the same.
- **The `openscreen-demo` skill** teaches an agent the whole job, from the storyboard to the finished video. It then attaches the video to a pull request, so reviewers watch the change in place, or drafts a post on X that it publishes only once you say yes. Add it with `npx skills add getopenscreen/openscreen --skill openscreen-demo`. The recipe is [`plugin/skills/openscreen-demo/SKILL.md`](https://github.com/getopenscreen/openscreen/blob/main/plugin/skills/openscreen-demo/SKILL.md).
