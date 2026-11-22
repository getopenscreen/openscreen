---
# The fix is the one line: the corrected call carries the user's shader as written, with
# only `let k` turned into `var k`. A few fragments cannot tell the real ring function from
# one gutted to return 0.0, so a judge compares the whole code. mock_calls, not trace: the
# trace may list every tool the session was offered.
type: llm
focus: mock_calls
arm: with-only
---

The user asked for this WGSL shader, as written:

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

Its line `let k = 0.0;` does not compile, because the loop adds to k. The repair is to declare k with `var`.

Among these mock calls, take each addEffect call whose `effect.code` declares k with `var`, and compare that code with the shader above.

PASS if one of them is the same shader with only that repair: the line that declares k changes from `let` to `var`, with or without a type (`var k: f32 = 0.0;`). Whitespace, line breaks and comments do not count.

FAIL if each of them changes anything else: a line removed, added or rewritten, a number, a color or a condition changed, or a result replaced, such as ring's last line returning 0.0. FAIL too if no addEffect call declares k with `var`.
