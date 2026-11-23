---
type: llm
---

Read the final answer to the user. PASS only if every item holds:

1. The plan captures the page headless (in a browser with no window), through the plugin's bundled `capture.mjs` script, not by recording a window or the screen.
2. After the capture it makes an OpenScreen project from the video with `createProject`.
3. After `createProject` it gives OpenScreen the pointer log with `setPointerTrack`, either with `recordingStartedAt: 0` or with the values from the pointer file the script writes (`take.mp4.pointer.json`). It does not tell OpenScreen the take started at the current time or at a `Date.now()` value.
4. It asks before installing anything (Playwright, a browser, ffmpeg), or says it will check first and ask; it does not say it has installed or will install something without asking.

FAIL if any item is missing or contradicted.
