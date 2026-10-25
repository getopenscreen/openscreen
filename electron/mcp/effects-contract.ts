/**
 * The WGSL contract of agent-written shader effects, served as an MCP resource
 * (`openscreen://effects/contract`): too long for a tool description, and versioned with the
 * contract. The compositor's prelude (`crates/compositor/src/shader_fx.rs`) is the authority;
 * `effects-contract.test.ts` checks that every `ctx` field it declares is described here.
 * The design is in docs/shader-effects.md.
 */

export const EFFECTS_CONTRACT_URI = "openscreen://effects/contract";

export const EFFECTS_NOTE = `Before writing a shader effect with addEffect, read the resource ${EFFECTS_CONTRACT_URI}: the full WGSL contract and two examples.`;

export const EFFECTS_CONTRACT = `# OpenScreen shader effects — WGSL contract 1

An effect is WGSL that defines one function, called for every pixel of the output:

    fn effect(uv: vec2<f32>) -> vec4<f32>

\`uv\` runs from (0, 0) top-left to (1, 1) bottom-right of the output. Return the pixel's color.
Declare nothing else the compositor provides: bindings, entry points and the inputs below are
added after your code, so compiler errors point at your lines.

## Inputs

| Name | Type | Meaning |
|---|---|---|
| frame(uv) | vec4<f32> | The composed picture at uv (bilinear, edges clamped). |
| footage(p) | vec4<f32> | The recording itself at point p of its surface (the space of fx_to_footage), at the recording's own resolution: no cursor, webcam, frame or background on it. Transparent outside 0..1. |
| ctx.resolution | vec2<f32> | Output size in pixels. |
| ctx.aspect | f32 | Width over height, for round distances in uv. |
| ctx.time | f32 | Programme seconds, continuous through cuts, clips and speed changes. |
| ctx.region | vec4<f32> | x: progress 0 → 1 across the whole region; y: its length in s; z: seconds since it began. |
| ctx.cursor | vec4<f32> | xy: the pointer tip in uv; z: 1 when it is on screen. |
| ctx.clicks[i] | vec4<f32> | The last 4 clicks of the last 2 s, newest first. xy: where it happened, in uv; z: seconds since; w: 1 when the slot holds one. |
| ctx.footage | vec4<f32> | The recording's rect in uv (x, y, w, h), after zoom and layout; under a 3D tilt, its bounding box. |
| ctx.camera | vec4<f32> | The webcam's rect in uv; zero-sized without a camera. |
| ctx.footage_aspect | f32 | The recording's width over height on its own surface, for round distances on it. |
| ctx.footage_corners, ctx.footage_warp | | What the two functions below read: the recording's corners and its warp. Use the functions. |
| fx_to_footage(uv) | vec2<f32> | The point of the recording's surface under uv: (0, 0) its top-left corner, (1, 1) its bottom-right, extended past its edges. Far outside 0..1 where no point of the surface lands. |
| fx_from_footage(p) | vec2<f32> | Back: where point p of the recording's surface lands, in uv. |
| params.<name> | per type | Your declared parameters. |
| fx_px(n) | f32 | n pixels of a 1080p output, as a fraction of the height. |
| fx_hash(p) | f32 | A random number in [0, 1) for a vec2<u32>, identical on every GPU. |

Everything in uv is already placed through zoom, layout, frame and tilt: never recompute where
the screen, the camera or the pointer sit.

There are two spaces to work in, and the effect picks the one that fits it. Output uv is the
picture as it is framed. The recording's surface is the recording itself, wherever the zoom, the
layout and the 3D camera put it, through the same warp the compositor draws it with: something
computed there moves, scales and tilts with the recording. Map into it with fx_to_footage, compute,
and map back with fx_from_footage before calling frame().

frame() holds the picture at the output's resolution: a recording shown smaller than its pixels has
lost detail there. footage() reads the recording at its own resolution, so an effect that magnifies
(a loupe, a lens, a close-up) reads footage(p) and stays sharp. footage() holds the recording only:
where the effect must show the cursor or the webcam too, it reads frame() for them.

## Parameters

Declare each one as \`{ type, name, label, default }\`; a number also takes \`min\` and \`max\`.

| type | WGSL | value in the document |
|---|---|---|
| number | f32 | a number between min and max |
| toggle | f32 (0 or 1) | true or false |
| color | vec4<f32> (RGBA, 0..1) | "#rrggbb" or "#rrggbbaa" |
| point | vec2<f32> (uv) | { "x": 0.5, "y": 0.5 } |

Names are snake_case. Up to 8 is recommended. Declare a parameter only when moving it visibly
changes the effect over its whole range: each one becomes a control in the editor.

## Rules

- **Pure.** The result depends only on uv, frame(), footage(), ctx and params. No state between frames, no
  clock, no frame counter: the preview jumps between frames when seeking, the export renders them
  in order, and both must show the same picture.
- **Resolution-free.** The preview renders smaller than the export: measure in uv or fx_px.
- **Random through fx_hash.** \`fract(sin(x) * 43758.5453)\` differs from one GPU to another.
- **Loops are \`for\` with literal bounds**: \`for (var i = 0; i < 16; i++)\`. Any other loop is
  refused, and so is more than 4096 iterations per pixel: a loop that never ends stalls the GPU.
  This is the one hard rule.
- **Alpha.** For the targets image and both, the returned color replaces the pixel; return
  \`frame(uv).a\` as alpha. For the target text, frame() is the text layer in premultiplied alpha,
  transparent outside the text, and the effect must return premultiplied alpha.

## Targets

- **image** (default): the picture under the annotations and captions; the text stays readable.
- **text**: the annotations and captions alone, drawn over the untouched picture afterwards.
- **both**: everything, captions included.

Use text or both only when the request asks for them.

**One effect at a time.** Two effects cannot overlap in time. To combine two looks at the same
moment, write them in one shader: an effect is written for what the user asked, not stacked from
parts.

## Cost

The result of addEffect gives the cost in frame() and footage() reads per pixel, counted from the
code (loops multiplied by their bound), and its tier. An effect that reads footage() also has the
recording copied once per frame at its own resolution, about one read more at 4K. Per 1080p frame, measured on a fast discrete GPU (RTX
4070 Ti) and on an integrated one (Apple M1):

| Tier | Reads | Per frame, RTX 4070 Ti | Per frame, M1 | Recommended for |
|---|---|---|---|---|
| light | ≤ 8 | ≤ 0.06 ms | ≤ 1.3 ms | anywhere, the whole video included |
| medium | ≤ 32 | ≤ 0.14 ms | ≤ 4.3 ms | up to a minute |
| heavy | ≤ 128 | ≤ 0.54 ms | ≤ 16 ms | up to 10 s: a transition, a key moment |
| very heavy | more | 2 ms at 512 | 49 ms at 512 | a few seconds |

A 4K frame costs about four times as much. The tiers are recommendations, never refusals.

## Example: a ripple on the recording, on every click

Parameters: strength (number, 0–2, default 1), radius (number, 0.05–0.5, default 0.2),
duration (number, 0.3–2, default 0.9). The wave is computed on the recording's surface, so it
follows the zoom and lies flat on the recording under the 3D camera.

    fn ripple(p: vec2<f32>, click: vec4<f32>) -> vec2<f32> {
        if (click.w < 0.5 || click.z > params.duration) { return vec2<f32>(0.0); }
        let t = click.z / params.duration;
        let metric = vec2<f32>(ctx.footage_aspect, 1.0);
        let d = (p - fx_to_footage(click.xy)) * metric;
        let r = length(d);
        let x = params.radius * (1.0 - pow(1.0 - t, 3.0)) - r;
        let env = smoothstep(-0.008, 0.0, x) * exp(-max(x, 0.0) / 0.07);
        let wave = sin(x / 0.03 * 6.2831853) * env * (1.0 - t) * (1.0 - t) * params.strength;
        let dir = select(vec2<f32>(0.0), d / r, r > 1e-5);
        return dir * wave * 0.01 / metric;
    }

    fn effect(uv: vec2<f32>) -> vec4<f32> {
        let p = fx_to_footage(uv);
        var offset = vec2<f32>(0.0);
        for (var i = 0; i < 4; i++) { offset += ripple(p, ctx.clicks[i]); }
        if (dot(offset, offset) == 0.0) { return frame(uv); }
        return frame(fx_from_footage(p - offset));
    }

## Example: a vignette that breathes across the region

Parameters: depth (number, 0–1, default 0.6), tint (color, default "#000000").

    fn effect(uv: vec2<f32>) -> vec4<f32> {
        let c = frame(uv);
        let v = (uv - 0.5) * vec2<f32>(ctx.aspect, 1.0);
        let pulse = sin(ctx.region.x * 3.14159265);
        let k = smoothstep(0.35, 0.9, length(v)) * params.depth * pulse;
        return vec4<f32>(mix(c.rgb, params.tint.rgb, k), c.a);
    }

## Recipe: lift real UI blocks out of the recording

To detach a card or a panel, bring it to the camera, zoom into it or explode the interface into 3D
cards. The compositor sees pixels, not the page, so the blocks come from you:

1. **Read them while you record.** In the page you drive, take each block's
   \`getBoundingClientRect()\`. Divided by the viewport size, it is a fraction of the recorded frame
   only when the recording is the viewport itself. For a screen or window recording, convert it to
   frame pixels first (times \`devicePixelRatio\`, plus the viewport's origin in the frame), then
   divide by the frame size. Scroll before the take starts, so nothing moves while a block is lifted.
2. **Write them into the code** as constants: \`const CARD: vec4<f32> = vec4<f32>(x, y, w, h);\`.
   A block that moves during the take (a panel that opens, a card that slides) gets a few keyframes
   mixed on \`ctx.time\`, never a long table: a large constant table slows every frame on some GPUs.
   These fractions are points of the recording's surface (when the project crops the recording,
   take them relative to the crop rectangle), so place them with \`fx_from_footage\` and they follow
   the zoom, the layout and the 3D camera.
3. **Hide the cursor and draw the pointer yourself.** \`frame()\` already holds the pointer: a lifted
   block would carry a frozen copy of it while the page keeps another. Turn it off with
   \`setEditorSettings\` \`{ cursor: { show: false } }\`. This needs an \`editable-overlay\` recording
   (the default): with \`cursor: "system"\` the pointer is drawn into the video and cannot be hidden,
   so record again. \`ctx.cursor\` and \`ctx.clicks\` keep the
   recording's pointer. Draw it last: over a lifted block, move it with that block's transform, so it
   stays on the part of the interface the user points at; anywhere else, at \`ctx.cursor.xy\`.

Check the result with getFrames at the moments that matter.
`;
