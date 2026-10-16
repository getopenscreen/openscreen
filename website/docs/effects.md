---
id: effects
title: Custom effects
description: "Ask an AI agent for a visual effect the settings don't offer. It writes a GPU shader that OpenScreen draws in the preview and in every export."
keywords:
  - custom video effects
  - shader effects
  - WGSL
  - AI video effects
  - GPU effects
---

# Custom effects

When the settings don't have the look you want, ask an agent for it: a ripple from each click, a vignette that breathes, a fade to black over the last seconds. The agent writes the effect as a small GPU shader, and OpenScreen draws it in the preview and in every export, MP4 and GIF, on Windows, macOS and Linux.

Effects come from an agent: the built-in chat or an MCP client such as Claude Code or Codex (see [AI editing](./ai-editing.md)). Once an effect is in the project, you adjust it yourself in the editor.

## Asking for an effect

Describe what you want to see, and when: "a ripple on every click", "fade to black over the last two seconds, captions included". The agent writes the effect, places it on the timeline, and can look at the result with `getFrames` without exporting the video.

An effect knows where the cursor is and where each click landed, where the recording and the webcam sit in the video after zooms and layout, and the time. So a halo can follow the mouse, and a ripple can start from each click, wherever the zoom has moved it.

## In the editor

Effects get their own row on the timeline, under the Full Camera segments, once the project has one. Each block carries the effect's name. Move it, resize it, copy and paste it or delete it like any other region, and `Ctrl/Cmd + Z` undoes the change. One effect plays at a time: a paste onto another effect is refused.

Click a block to open its inspector:

- **A control for each setting** the agent gave the effect: a slider, a switch, a color or a point.
- **Applies to**, where the effect is drawn:
  - **Image**, the default: the recording, the webcam, the cursor and the background, under your annotations and captions, which stay legible.
  - **Text**: the annotations and captions only.
  - **Both**: the whole frame, text included, for a fade to black that also covers the captions.
- **Cost**: **Light**, **Medium**, **Heavy** or **Very heavy** (see [below](#cost)).
- **Code**: the shader, read-only, with **Copy code**. To change it, ask the agent.

A copied effect pasted into another project brings its code along.

## Cost

The cost is estimated from the code, by counting how many times the effect reads the picture for each pixel. The same code gets the same tier on every computer. Nothing is refused for its cost: the heavier the effect, the shorter the stretch it suits.

| Tier | Typical effects | Suits |
|---|---|---|
| **Light** | vignette, color grade, click ripple | the whole video |
| **Medium** | chromatic aberration, small blur, glitch | a few tens of seconds |
| **Heavy** | strong blur, bokeh | a transition, a highlight |
| **Very heavy** | raymarching, simulations | a few seconds: the export stays exact but slower, and the preview can slow down on a small GPU |

## If an effect doesn't compile

An agent's code is compiled before the effect is accepted. Code that fails is refused with the compiler's error, and the project doesn't change.

A project opened on another computer can still meet a compiler that disagrees. The effect is then not drawn, its inspector shows **Doesn't compile on this computer** with the error, and the export goes on without it.

## Projects from someone else

A project carries the code of its effects, so opening someone else's project runs code you didn't write. That code runs only on the GPU, with no access to your files, the network or the app's memory.

## For agent authors

The tools are `addEffect`, `setEffect`, `setEffectDefinition` and `getEffect`, and `removeModifier` takes an effect off. The full contract, the `effect(uv)` function, what it can read and its rules, is the MCP resource `openscreen://effects/contract`.
