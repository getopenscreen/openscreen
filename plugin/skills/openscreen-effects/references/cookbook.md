# Effect cookbook

Four complete effects for contract 1. Each one compiles as written, at the tier given. Pass the
code as `effect.code` and the JSON array as `effect.params` to `addEffect`, then tune the region
with `setEffect` `values`.

- [Soft ring on each click](#soft-ring-on-each-click): light, 1 read
- [Glass loupe on one detail](#glass-loupe-on-one-detail): light, 2 reads
- [Spotlight on an interface block](#spotlight-on-an-interface-block): light, 1 read
- [Logo in a corner](#logo-in-a-corner): light, 2 reads, with the logo's file as `effect.image`

Change a recipe freely: the compiler checks every version. Keep what makes it work, listed under
each one.

## Soft ring on each click

Two hairline rings and a faint glow answer every click, then fade. Quiet enough to run over the
whole video. Tint it with the product's brand colour.

```wgsl
// Two hairline rings and a faint glow where the pointer clicks, mixed toward a tint so they read
// on a light interface as well as a dark one.
fn ring(uv: vec2<f32>, c: vec4<f32>, delay: f32) -> f32 {
    let age = c.z - delay;
    if (c.w < 0.5 || age < 0.0 || age > params.duration) { return 0.0; }
    let t = age / params.duration;
    let d = length((uv - c.xy) * vec2<f32>(ctx.aspect, 1.0));
    let r = params.radius * (1.0 - pow(1.0 - t, 3.0));
    let w = fx_px(1.5) + fx_px(6.0) * (1.0 - t);
    return (1.0 - smoothstep(0.0, w, abs(d - r))) * (1.0 - t) * (1.0 - t);
}

fn glow(uv: vec2<f32>, c: vec4<f32>) -> f32 {
    if (c.w < 0.5 || c.z > params.duration) { return 0.0; }
    let t = c.z / params.duration;
    let d = length((uv - c.xy) * vec2<f32>(ctx.aspect, 1.0));
    return exp(-d * d / (params.radius * params.radius * 0.35)) * 0.35 * (1.0 - t);
}

fn effect(uv: vec2<f32>) -> vec4<f32> {
    let c = frame(uv);
    var k = 0.0;
    for (var i = 0; i < 4; i++) {
        k += ring(uv, ctx.clicks[i], 0.0) + 0.6 * ring(uv, ctx.clicks[i], 0.12) + glow(uv, ctx.clicks[i]);
    }
    k = clamp(k * params.strength, 0.0, 1.0);
    return vec4<f32>(mix(c.rgb, params.tint.rgb, k), c.a);
}
```

```json
[
  { "type": "color", "name": "tint", "label": "Tint", "default": "#a882ff" },
  { "type": "number", "name": "radius", "label": "Radius", "default": 0.07, "min": 0.02, "max": 0.2 },
  { "type": "number", "name": "duration", "label": "Duration", "default": 0.8, "min": 0.3, "max": 2 },
  { "type": "number", "name": "strength", "label": "Strength", "default": 0.9, "min": 0, "max": 1.5 }
]
```

What makes it work:
- **`mix` toward the tint, not an additive or screen blend.** A screen blend adds nothing where
  the interface is already white, so the ring vanishes on a light theme.
- **The second ring starts 0.12 s late** at 60 % strength: a ripple, not a stamp.
- **Ease-out radius** (`1 - (1 - t)^3`) and a squared fade: fast out of the click, soft at the end.
- **Width in `fx_px`:** the same hairline in the preview and the 4K export.
- **Region:** the whole video, from 0 to its end. It costs nothing between clicks.

Check it with `getFrames` at 0.1 s and 0.4 s after a click.

## Glass loupe on one detail

A round loupe holds one point of the recording and magnifies it, sharp, because it reads the
recording at its own resolution. It grows in over the first 0.3 s of its region and shrinks out
over the last 0.3 s. Use it for a number, a line of code or a small control the viewer must read
while the rest of the screen stays in place.

```wgsl
// A round glass loupe that holds one point of the recording and magnifies it from the recording's
// own pixels. It opens at the start of its region and closes at its end.
fn ease_out(x: f32) -> f32 {
    let t = clamp(x, 0.0, 1.0);
    return 1.0 - pow(1.0 - t, 3.0);
}

fn effect(uv: vec2<f32>) -> vec4<f32> {
    let base = frame(uv);
    let open = ease_out(ctx.region.z / 0.3) * ease_out((ctx.region.y - ctx.region.z) / 0.3);
    // `at` is a point of the recording's surface, so the loupe stays on its detail under a zoom.
    let center = fx_from_footage(params.at);
    let r = params.radius * open;
    let d = length((uv - center) * vec2<f32>(ctx.aspect, 1.0));
    let aa = fx_px(1.0);
    let shadow = (1.0 - smoothstep(r, r + fx_px(24.0), d)) * 0.3 * open;
    var col = base.rgb * (1.0 - shadow);
    if (d < r + aa) {
        let seen = footage(fx_to_footage(center + (uv - center) / params.zoom));
        let glass = mix(base.rgb, seen.rgb, seen.a);
        col = mix(col, glass, 1.0 - smoothstep(r - aa, r + aa, d));
    }
    let rim = (1.0 - smoothstep(0.0, fx_px(1.5), abs(d - r))) * open;
    col = mix(col, params.rim.rgb, rim * params.rim.a);
    return vec4<f32>(col, base.a);
}
```

```json
[
  { "type": "point", "name": "at", "label": "Detail", "default": { "x": 0.5, "y": 0.5 } },
  { "type": "number", "name": "zoom", "label": "Magnification", "default": 2.5, "min": 1.5, "max": 4 },
  { "type": "number", "name": "radius", "label": "Size", "default": 0.16, "min": 0.06, "max": 0.35 },
  { "type": "color", "name": "rim", "label": "Rim", "default": "#ffffffcc" }
]
```

What makes it work:
- **`footage()` for the magnified picture, `frame()` for the rest.** Magnifying `frame()` only
  magnifies the output's pixels, which is blur. `footage()` carries no cursor or webcam, which is
  right for a loupe that holds still.
- **`at` is a point of the recording** (0 to 1 across its frame), placed with `fx_from_footage`.
  Read it off a `getFrames` still of the take, or from the page you recorded.
- **The loupe holds its point; it does not chase the pointer.** A loupe that follows the mouse
  swims and hides the cursor under the glass.
- **Distances use `ctx.aspect`,** so the loupe stays round in every format.
- **Region:** 2 to 4 s around the moment the detail matters, at least 1 s longer than the 0.6 s
  the open and close take.

Check it with `getContactSheet` over the first 0.5 s of the region (the opening), then
`getFrames` with `region` on the loupe at full resolution: the magnified text must be sharp.

## Spotlight on an interface block

Dims everything except one block of the interface, a card, a panel, a form, and draws a hairline
on its real border. The block is measured in the page, not estimated.

```wgsl
// Dims everything but one interface block and draws a hairline on its real border. The block is
// a rectangle of the recording, so it follows zooms, layouts and the 3D camera.
// BLOCK: x, y, width, height as fractions of the recorded frame, measured in the page.
// CORNER: the block's border radius in pixels over the recorded frame's height in pixels.
const BLOCK: vec4<f32> = vec4<f32>(0.08, 0.22, 0.36, 0.30);
const CORNER: f32 = 0.011;

fn rounded_box(p: vec2<f32>, half_size: vec2<f32>, r: f32) -> f32 {
    let q = abs(p) - half_size + vec2<f32>(r);
    return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

fn effect(uv: vec2<f32>) -> vec4<f32> {
    let c = frame(uv);
    let fade = smoothstep(0.0, 0.35, ctx.region.z) * smoothstep(0.0, 0.35, ctx.region.y - ctx.region.z);
    let metric = vec2<f32>(ctx.footage_aspect, 1.0);
    let p = fx_to_footage(uv) * metric;
    let center = (BLOCK.xy + BLOCK.zw * 0.5) * metric;
    let d = rounded_box(p - center, BLOCK.zw * 0.5 * metric, CORNER);
    // One output pixel in units of the recording's height (ctx.footage.w is its height in uv).
    let px = fx_px(1.0) / max(ctx.footage.w, 1e-4);
    let outside = smoothstep(-px, px, d);
    let edge = 1.0 - smoothstep(0.0, px * params.edge_px, abs(d));
    var col = c.rgb * (1.0 - params.dim * outside * fade);
    col = mix(col, params.edge.rgb, edge * params.edge.a * fade);
    return vec4<f32>(col, c.a);
}
```

```json
[
  { "type": "number", "name": "dim", "label": "Dim", "default": 0.55, "min": 0, "max": 0.85 },
  { "type": "color", "name": "edge", "label": "Border", "default": "#ffffff" },
  { "type": "number", "name": "edge_px", "label": "Border width", "default": 1.5, "min": 0.5, "max": 4 }
]
```

What makes it work:
- **Measure the block, never estimate it.** While you drive the page, read the element's
  `getBoundingClientRect()` and its computed `border-radius`, then convert to fractions of the
  recorded frame as the contract's "lift real UI blocks" recipe says (device pixel ratio, the
  viewport's origin in the frame, a crop if the project has one). A rectangle that misses the
  real border by a few pixels reads as a mistake.
- **Distances on the recording's surface** (`fx_to_footage`, scaled by `ctx.footage_aspect`): the
  corners stay round and the outline stays on the border under a zoom or a tilt.
- **A block that moves** (a panel sliding open) gets two or three keyframed rectangles mixed on
  `ctx.time`, never a long table.
- **Fade 0.35 s in and out**, so the dim never snaps.
- **Region:** the beat where that block is the subject, typically 2 to 5 s.

Check it with `getFrames` with `region` on each corner of the block: the hairline must sit on the
border all the way round.

## Logo in a corner

The product's logo, read from its own file, sits in a corner of the frame at its own proportions
and fades in. Use it for a brand mark on a demo, or an end card's sign-off. Pass the logo's file
as `effect.image`.

```wgsl
// The effect's image (a logo) in the bottom-right corner, `size` of the frame's height tall at its
// own proportions, faded in by `opacity`.
fn effect(uv: vec2<f32>) -> vec4<f32> {
    let c = frame(uv);
    let box = vec2<f32>(params.size * ctx.image.z / ctx.aspect, params.size);
    let corner = vec2<f32>(1.0 - params.margin / ctx.aspect, 1.0 - params.margin) - box;
    let logo = image((uv - corner) / box);
    return vec4<f32>(mix(c.rgb, logo.rgb, logo.a * params.opacity), c.a);
}
```

```json
[
  { "type": "number", "name": "size", "label": "Size", "default": 0.08, "min": 0.03, "max": 0.3 },
  { "type": "number", "name": "margin", "label": "Margin", "default": 0.04, "min": 0, "max": 0.2 },
  { "type": "number", "name": "opacity", "label": "Opacity", "default": 1, "min": 0, "max": 1 }
]
```

Lay it with `animate` on `opacity` so it fades in instead of popping:
`{ "opacity": [{ "atSec": 0, "value": 0, "ease": "ease-out" }, { "atSec": 0.6, "value": 1 }] }`.

What makes it work:
- **The image's own uv.** `image()` reads (0,0) to (1,1) across the logo, transparent outside:
  mapping the output's uv into the logo's box is all the placement there is, and the box crops it.
- **Proportions from `ctx.image.z`,** the logo's width over its height, divided by `ctx.aspect`
  so a round mark stays round in every output format.
- **Margin in fractions of the height,** the same on both edges once divided by `ctx.aspect`.
- **`mix` by the logo's alpha:** `image()` returns straight alpha, so the transparent corners of
  a PNG leave the frame untouched.
- **A file near the size shown.** At 8 % of a 1080p height the logo is about 90 px tall: give it
  a file 100 to 200 px tall. Far larger, it shimmers when it moves.
- **Region:** the end card, or the whole film for a discreet brand mark. It costs two reads.

Check it with `getFrames` with `region` on the corner at full resolution: the edges of the logo
must be clean, with no dark fringe around them.
