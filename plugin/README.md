# OpenScreen plugin for Claude Code

This plugin turns one sentence into a finished demo video of an app or a feature. Its skills have Claude plan a short storyboard, record the screen with [OpenScreen](https://getopenscreen.com), add zooms, captions and on-screen callouts, export an MP4, check the frames, and then either attach the video to a pull request or draft a post on X.

OpenScreen is a free, open-source (MIT) screen recorder and video editor for Windows, macOS and Linux. The plugin carries several skills and OpenScreen's MCP server, so the recording and editing tools are there as soon as the plugin is enabled. The tools themselves come from the desktop app's own executable, started with `mcp`.

## The skills

- **`openscreen-demo`**: makes the whole video, from the storyboard to the export, then attaches it to a pull request or drafts a post on X.
- **`openscreen-capture`**: gets a clean, repeatable take, scripted or recorded, including a web page captured with no window on your desktop.
- **`openscreen-motion`**: places zooms, callouts, speed changes and the 3D camera with motion-design rules.
- **`openscreen-effects`**: writes custom shader effects, with a cookbook of worked examples.
- **`openscreen-sound`**: adds narration and music, and checks loudness, true peak and silences by measurement.
- **`openscreen-review`**: checks the video before it goes out, frame by frame and in the exported file, then fixes and looks again.
- **`openscreen-deliver`**: exports for each destination, within its size limit, and hands the video over.

## What the plugin runs, sends and fetches

- **Starts OpenScreen's MCP server at session start.** `scripts/openscreen-mcp.mjs`, a short Node script with no dependency, looks for the installed app in its usual locations (or the path in `OPENSCREEN_EXE`) and runs `<app> mcp` over stdio. The server runs locally and needs no account. The script downloads nothing and sends nothing.
- **Explains instead of failing when the app is missing.** If OpenScreen is not installed, is older than 2.1.0 or cannot start, the script serves one tool, `openscreenSetup`, that tells Claude what it checked and how to set OpenScreen up.
- **Installs OpenScreen, only after you agree.** If the app is missing, a skill offers to download the latest installer from [the project's GitHub releases](https://github.com/getopenscreen/openscreen/releases/latest), or the Microsoft Store on Windows, and install it.
- **Records the window you choose.** The recording and the project stay on your machine. The exported video leaves it only when you share it, as below.
- **Attaches the video to a pull request** with `gh`, on the repository you work in, when you ask for a pull request video.
- **Drafts a post on X** for a launch demo, and posts it only after your explicit yes.

## Use it

Install it in Claude Code:

```
/plugin marketplace add getopenscreen/openscreen
/plugin install openscreen@openscreen
```

Then ask Claude for a demo, for example: *make a 30-second demo of the new export dialog and add it to my PR*. Right after an install, run `/reload-plugins` or start a new session so the server connects.

The server needs Node.js on the PATH. Without it, or in an agent without plugin support, register the server by hand: `claude mcp add openscreen -- "<path to the OpenScreen executable>" mcp`, or the same command and `mcp` argument in your agent's MCP settings.

Documentation: [Letting an agent make the whole video](https://getopenscreen.com/docs/ai-editing/#letting-an-agent-make-the-whole-video).
