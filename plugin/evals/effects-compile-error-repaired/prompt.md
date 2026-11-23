---
# Protects the effects loop's repair step: the real addEffect refuses code that does not
# compile with the compiler's error at a line, and the agent must fix that line and call
# addEffect again, not give up or switch to another approach. The user's shader assigns to
# a `let` binding (line 12), which WGSL refuses; the addEffect mock is an agent that
# answers that error while the code still says `let k = 0.0`, and accepts it otherwise.
description: The agent repairs a WGSL compile error reported by addEffect and calls it again.
tags: [effects]
max_turns: 15
allowed_tools: [Read, Glob, Grep, Skill]
---

Add this shader to my OpenScreen project p_demo, over the whole video (0 to 34 s), as written:

```wgsl
fn ring(uv: vec2<f32>, c: vec4<f32>) -> f32 {
    if (c.w < 0.5 || c.z > 0.8) { return 0.0; }
    let d = length((uv - c.xy) * vec2<f32>(ctx.aspect, 1.0));
    let r = 0.07 * (1.0 - pow(1.0 - c.z / 0.8, 3.0));
    return (1.0 - smoothstep(0.0, fx_px(2.0), abs(d - r))) * (1.0 - c.z / 0.8);
}

fn effect(uv: vec2<f32>) -> vec4<f32> {
    let c = frame(uv);
    let k = 0.0;
    for (var i = 0; i < 4; i++) {
        k += ring(uv, ctx.clicks[i]);
    }
    return vec4<f32>(mix(c.rgb, vec3<f32>(0.43, 0.29, 1.0), clamp(k, 0.0, 1.0)), c.a);
}
```
