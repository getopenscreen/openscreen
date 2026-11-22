---
# Protects everyone else's sessions: a request with no video in it must not load an
# OpenScreen skill or touch an OpenScreen tool. The skills' descriptions are always in
# context, so an over-broad one shows up here first.
description: No OpenScreen skill or tool fires on an unrelated coding request.
tags: [negative, smoke]
max_turns: 4
allowed_tools: [Read, Glob, Grep, Skill]
---

Write me a POSIX shell script that renames every .jpeg file in the current directory to .jpg, skipping a file when the target name already exists. Just give me the script in your answer.
