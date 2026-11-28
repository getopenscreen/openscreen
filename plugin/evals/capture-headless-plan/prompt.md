---
# Protects the capture skill's choice table and headless recipe: a web app filmed with
# nothing on the user's screen is the bundled capture.mjs script, then createProject with
# the take, then setPointerTrack on the take's own clock (recordingStartedAt 0, which the
# script writes into its pointer file), never startRecording; and nothing gets installed without asking. The session has no shell, so
# the case grades the plan the agent gives.
description: The capture skill picks the headless script for a localhost web app and asks before installing.
tags: [capture]
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
---

Record a demo take of our web app running at http://localhost:5173 with OpenScreen, but nothing may show up on my screen while it records: I am working on it. Tell me how you will do it, step by step, before you start.
