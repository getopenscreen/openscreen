---
# Protects the motion skill's "fewer, longer zooms" rule: eight zooms a second apart, one
# per click on a form, are the dizzying-zoom tell. The edit must end with clearly fewer
# zooms (at least four removed, or merged into one), and the agent must look at the result.
# getCurrentDocument and getContactSheet are agent mocks so they reflect the edits made.
description: The motion skill merges eight dizzying zooms and checks the result.
tags: [motion]
max_turns: 20
allowed_tools: [Read, Glob, Grep, Skill]
---

The zooms in my OpenScreen project p_demo make me dizzy. Fix the motion.
