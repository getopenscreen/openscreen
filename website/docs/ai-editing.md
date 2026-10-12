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

OpenScreen ships an optional agent that edits your project from a chat panel. It is **off until you connect a provider yourself**, and nothing is sent to any model before that. Once connected, the agent talks only to that provider, and so does [caption translation](./captions.md#translation). The app's other network use (the Whisper model download, annotation fonts, update checks) is listed in the [introduction](./intro.md).

:::tip
None of this is required. Recording, editing, transcription, captions, and export all work with no account and no provider, whether or not you ever open the chat panel. Of those, only transcription needs a download, once: the [Whisper model](./captions.md#transcribing), on your first run.
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

Describe the edit in plain language — "cut the dead air in the intro", "zoom in when I open the terminal". The agent works through real, undoable timeline operations, not a re-render: it can add and adjust trims, zooms, speed regions, annotations and Full Camera segments, edit clip in/out points, reorder or remove clips, and read the transcript to find what you're referring to.

The panel around it:

- **Conversations** — history, rename, delete, and start a new one. Each keeps its own agent state.
- **Model picker** — live model list from the connected provider, with a reasoning-effort control where the provider supports one.
- **Context meter** — estimated tokens used against the budget, with a **Compact** action that summarizes earlier turns instead of dropping them.
- **Rewind to this message** — rolls back the agent's edits and every follow-up turn after that point, restoring project, conversation, and agent state together.
- **Project edits** — a switch in **AI settings**. When it is off, every edit the agent tries is refused: it can still read the project and describe the change it would make, and it applies nothing until you turn the switch back on.

`Ctrl/Cmd + Z` undoes an agent edit exactly like a manual one.

The **Smart cuts** entry (marked *With AI*) in the timeline's auto-enhance menu is the same agent on a one-shot prompt. (The other entry, **Automatic zooms**, reads the recorded clicks and needs no provider at all.)

## What else uses your provider

[Caption translation](./captions.md#translation) is a single text-transform call against the same model — it doesn't run the agent loop and can't touch your document. Transcription and caption rendering stay entirely on-device either way.

## Using Claude Code, Codex or another MCP client

If you already use an AI coding agent such as Claude Code or Codex, it can drive the same editing tools, signed in with its own account. Nothing about that account passes through OpenScreen.

1. **AI settings** → **MCP server** → turn it on. It listens only on your own machine (`127.0.0.1`), on the port shown.
2. Copy the **Claude Code** or **Codex** command shown there and run it in a terminal. The Claude Code command carries the access token. Codex reads it from the `OPENSCREEN_MCP_TOKEN` environment variable instead: set that in the shell you start Codex from.
3. Keep a project open in the OpenScreen editor, then ask your agent for the edit.

The tools are the ones the built-in agent uses, and they act on the project open in the editor. MCP clients can only **read** the project until you also turn on **Project edits** in the MCP server section; this switch is separate from the built-in agent's, and it starts off. Once on, each edit is saved as it lands and undone with `Ctrl/Cmd + Z`. Clients are told to save a checkpoint before a series of edits, so you can ask them to put the project back as it was in a single step, which `Ctrl/Cmd + Z` can itself undo. **Regenerate** the token to disconnect every client set up with the old one.

## Letting an agent make the whole video

The server above edits projects. To have an agent make a whole video on its own, from the recording to the export, add OpenScreen to it as a stdio server instead: the agent starts the app's own executable with `mcp`. It gets the same editing tools, plus `listSources`, `startRecording`, `stopRecording`, `setPointerTrack`, `exportVideo` and `getFrames`.

The quickest way is to paste this into Claude Code:

```text
Install the OpenScreen demo skill with `npx skills add getopenscreen/openscreen --skill openscreen-demo -a claude-code`, then follow it to make a demo video of this feature.
```

The skill installs OpenScreen if it is missing, once you agree, and adds its MCP server. It then asks you to open a new session and say *continue the OpenScreen demo*: an agent only gets new tools in a new session. To set it up by hand instead:

```bash
claude mcp add openscreen -- "/Applications/Openscreen.app/Contents/MacOS/Openscreen" mcp
codex mcp add openscreen -- "/Applications/Openscreen.app/Contents/MacOS/Openscreen" mcp
```

The executable on each system is listed in [Running the CLI](./cli.md#running-the-cli).

- **No port, no token, no setting.** The agent starts the process itself, with your rights, as it would run `openscreen record`. So it can record your screen and edit without the **Project edits** switch.
- **Each take becomes a new project** in your project list, zoomed on its clicks as a recording made in the app is: clicks close together share one zoom, and the first seconds and the end stay on the whole screen. Do not edit it in the editor while the agent is still working on it: the editor keeps its own copy.
- **A take driven by a script** (Playwright, for example) never moves the screen pointer. The agent hands OpenScreen its own log of the actions with `setPointerTrack`, and the video gets a cursor and its zooms all the same.
- **The `openscreen-demo` skill** teaches an agent the whole job, from the storyboard to the finished video. It then attaches the video to a pull request, so reviewers watch the change in place, or drafts a post on X that it publishes only once you say yes. Add it with `npx skills add getopenscreen/openscreen --skill openscreen-demo`. The recipe is [`skills/openscreen-demo/SKILL.md`](https://github.com/getopenscreen/openscreen/blob/main/skills/openscreen-demo/SKILL.md).
