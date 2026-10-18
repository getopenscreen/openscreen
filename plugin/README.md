# OpenScreen plugin for Claude Code

This plugin turns one sentence into a finished demo video of an app or a feature. Its `openscreen-demo` skill has Claude plan a short storyboard, record the screen with [OpenScreen](https://getopenscreen.com), add zooms, captions and on-screen callouts, export an MP4, check the frames, and then either attach the video to a pull request or draft a post on X.

OpenScreen is a free, open-source (MIT) screen recorder and video editor for Windows, macOS and Linux. The plugin holds the skill only; the recording and editing tools come from OpenScreen's MCP server, which is the desktop app's own executable started with `mcp`.

## What the skill runs, sends and fetches

- **Installs OpenScreen, only after you agree.** If the app is missing, it offers to download the latest installer from [the project's GitHub releases](https://github.com/getopenscreen/openscreen/releases/latest) and install it.
- **Registers the MCP server** with `claude mcp add openscreen -- "<executable>" mcp`. The server runs locally over stdio and needs no account.
- **Records the window you choose.** The recording and the project stay on your machine. The exported video leaves it only when you share it, as below.
- **Attaches the video to a pull request** with `gh`, on the repository you work in, when you ask for a pull request video.
- **Drafts a post on X** for a launch demo, and posts it only after your explicit yes.

## Use it

Install it in Claude Code:

```
/plugin install openscreen --marketplace getopenscreen/openscreen
```

Then ask Claude for a demo, for example: *make a 30-second demo of the new export dialog and add it to my PR*. The skill sets OpenScreen up on first use.

Documentation: [Letting an agent make the whole video](https://getopenscreen.com/docs/ai-editing/#letting-an-agent-make-the-whole-video).
