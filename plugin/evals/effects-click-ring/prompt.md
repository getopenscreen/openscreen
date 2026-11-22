---
# Protects the effects skill's loop: write WGSL that defines `effect`, lay it with
# addEffect, then look at the moments right after a click (the clicks are at 4.2, 9.8,
# 15.5 and 22.0 s in the cursor mock) before calling it done.
description: The effects skill writes a click ring in WGSL and checks it just after a click.
tags: [effects]
max_turns: 20
allowed_tools: [Read, Glob, Grep, Skill]
---

In my OpenScreen project p_demo, add a soft ring on each click, in our brand purple #6d4aff.
