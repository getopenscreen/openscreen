---
# The near miss: a question about video that needs no tool. The agent may answer from
# general knowledge (an OpenScreen skill may even inform the answer), but it must not
# record, create, edit or export anything to answer a question.
description: A general video question is answered without recording or editing anything.
tags: [negative]
max_turns: 4
allowed_tools: [Read, Glob, Grep, Skill]
---

Quick question: what frame rate should I record a software tutorial at, 30 or 60 fps, and why?
