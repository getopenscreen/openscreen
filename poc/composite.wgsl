// The compositor. Two sources, one layout, three effects — written from zero.
//
// Everything is a pure function of the uniforms. No cache: a shader recomputes
// every pixel every frame, which is the point of the paradigm.

struct U {
  // stage.xy | time (s) | screenRadius
  a : vec4f,
  // screenRect: x, y, w, h — already carries the zoom (scale + pan)
  screen : vec4f,
  // webcamRect: x, y, w, h — already carries the layout animation
  webcam : vec4f,
  // shadowIntensity | bgBlurPx | shadowOffsetY | shadowSpread
  fx : vec4f,
  // webcamRadius | motionBlurPx | webcamCoverScale | optimised(0/1)
  b : vec4f,
};

@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var screenTex : texture_external;
@group(0) @binding(3) var webcamTex : texture_external;
@group(0) @binding(4) var bgTex : texture_2d<f32>;

struct VsOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
};

// Full-screen triangle: three vertices, no vertex buffer.
@vertex
fn vs(@builtin(vertex_index) i : u32) -> VsOut {
  var out : VsOut;
  let x = f32((i << 1u) & 2u);
  let y = f32(i & 2u);
  out.uv = vec2f(x, y);
  out.pos = vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
  return out;
}

// ---- geometry ---------------------------------------------------------------

/** Signed distance to a rounded box. Negative inside. */
fn sdRoundBox(p : vec2f, half : vec2f, r : f32) -> f32 {
  let rr = min(r, min(half.x, half.y));
  let q = abs(p) - half + vec2f(rr);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - rr;
}

/** Antialiased coverage from a signed distance: one pixel of ramp. */
fn cover(d : f32) -> f32 {
  return clamp(0.5 - d, 0.0, 1.0);
}

// ---- effect 1: the background ----------------------------------------------
//
// A blurred gradient — baked into a texture ONCE, at init, by fsBackground below.
// The per-frame shader reads one texel.
//
// It was 16 gradient evaluations per pixel per frame, and every one of them
// recomputed a CONSTANT: the background does not depend on t, on the video, or on
// the camera. 2 Mpx x 16 taps x 30 fps of arithmetic to reproduce the same image
// 210 times.
//
// This is not the shadow cache in disguise, and the difference is the whole
// argument: a cache guesses that its input has not changed and needs a key to
// find out. This has no key, because there is no input — the background is a
// constant, and a constant is computed once by definition. The shadow follows the
// camera, so it has no such luxury and is recomputed every frame, on purpose.

/** The background, evaluated at init only. Blurred with 16 Fibonacci taps. */
fn gradient(uv : vec2f) -> vec3f {
  let a = vec3f(0.06, 0.11, 0.24);
  let b = vec3f(0.35, 0.12, 0.42);
  let c = vec3f(0.02, 0.35, 0.38);
  let w = 0.5 + 0.5 * sin(uv.x * 2.0);
  return mix(mix(a, b, uv.y), c, w * 0.45);
}

fn blurredGradient(uv : vec2f) -> vec3f {
  let radiusPx = u.fx.y;
  if (radiusPx < 0.5) {
    return gradient(uv);
  }
  let px = radiusPx / u.a.xy;
  var acc = vec3f(0.0);
  let taps = 16;
  let golden = 2.39996;
  for (var i = 0; i < taps; i = i + 1) {
    let fi = f32(i);
    let r = sqrt((fi + 0.5) / f32(taps));
    let a = fi * golden;
    acc = acc + gradient(uv + vec2f(cos(a), sin(a)) * r * px);
  }
  return acc / f32(taps);
}

@fragment
fn fsBackground(in : VsOut) -> @location(0) vec4f {
  return vec4f(blurredGradient(in.uv), 1.0);
}

// ---- effect 2: the drop shadow ----------------------------------------------
// The shape is known analytically — a rounded rect — so its shadow does not need
// a blur pass at all: the coverage of a rounded box, evaluated at a few offsets,
// IS the shadow. No silhouette texture, no ping-pong, no 18 passes.
//
// 12 taps on a disc of radius `spread`. It is a soft shape under an opaque
// rectangle; the eye reads its falloff, not its exact profile.
//
// The taps only run in the BAND where the answer is in doubt. Every tap lands
// within `spread` of the pixel, so:
//   - grow the box by spread: outside it, every tap misses  → exactly 0
//   - shrink the box by spread: inside it, every tap hits    → exactly intensity
// Both are the box's Minkowski sum/difference with the tap disc, so this is not
// an approximation — it is the same number, arrived at by arithmetic instead of
// by twelve samples. It leaves a band ~2*spread wide around the edge paying full
// price, which on this layout is ~20% of the frame. Pure ALU, so branching costs
// nothing and no texture sampling is involved.
fn shadow(px : vec2f, rect : vec4f, radius : f32, intensity : f32) -> f32 {
  if (intensity <= 0.0) {
    return 0.0;
  }
  let centre = rect.xy + rect.zw * 0.5 + vec2f(0.0, u.fx.z);
  let half = rect.zw * 0.5;
  let spread = u.fx.w;
  let p = px - centre;

  // Both variants live here, chosen by a uniform, so old and new can be
  // interleaved in ONE session. Attributing a change across two sessions is what
  // this machine punishes: two identical runs measured 23% apart.
  if (u.b.w > 0.5) {
    if (sdRoundBox(p, half + vec2f(spread), radius + spread) > 0.5) {
      return 0.0;
    }
    if (sdRoundBox(p, max(half - vec2f(spread), vec2f(0.0)), max(radius - spread, 0.0)) < -0.5) {
      return intensity;
    }
  }

  var acc = 0.0;
  let taps = 12;
  let golden = 2.39996;
  for (var i = 0; i < taps; i = i + 1) {
    let fi = f32(i);
    let r = sqrt((fi + 0.5) / f32(taps)) * spread;
    let a = fi * golden;
    let o = vec2f(cos(a), sin(a)) * r;
    acc = acc + cover(sdRoundBox(p + o, half, radius));
  }
  return (acc / f32(taps)) * intensity;
}

// ---- effect 3: the masks ----------------------------------------------------
// Rounded rect for the recording, circle for the webcam. Both are the same SDF
// with different parameters — which is the whole argument for computing shapes
// instead of tessellating them.

/**
 * The webcam's mask, morphing with the layout animation.
 *
 * radius drives the shape: a circle when radius == min(half), a rounded rect as
 * it drops. The animation is a single number, and the SDF interpolates the SHAPE
 * for free — this is the thing a tessellated 2D mask cannot do without rebuilding
 * geometry every frame.
 */
fn webcamCover(px : vec2f, rect : vec4f, radius : f32) -> f32 {
  let centre = rect.xy + rect.zw * 0.5;
  let half = rect.zw * 0.5;
  return cover(sdRoundBox(px - centre, half, radius));
}

/**
 * Directional motion blur, applied while the camera moves.
 *
 * Skipped entirely at rest: a branch is free next to nine texture fetches.
 */
fn sampleScreen(px : vec2f, blurPx : f32) -> vec3f {
  let uv0 = (px - u.screen.xy) / max(u.screen.zw, vec2f(1.0));
  if (blurPx < 0.5) {
    return textureSampleBaseClampToEdge(screenTex, samp, clamp(uv0, vec2f(0.0), vec2f(1.0))).rgb;
  }
  var acc = vec3f(0.0);
  let taps = 7;
  for (var i = 0; i < taps; i = i + 1) {
    let t = (f32(i) / f32(taps - 1)) - 0.5;
    let p = px + vec2f(blurPx * t, 0.0);
    let uv = (p - u.screen.xy) / max(u.screen.zw, vec2f(1.0));
    acc = acc + textureSampleBaseClampToEdge(screenTex, samp, clamp(uv, vec2f(0.0), vec2f(1.0))).rgb;
  }
  return acc / f32(taps);
}

fn over(dst : vec3f, src : vec3f, a : f32) -> vec3f {
  return mix(dst, src, clamp(a, 0.0, 1.0));
}

@fragment
fn fs(in : VsOut) -> @location(0) vec4f {
  let px = in.uv * u.a.xy;

  // The recording's coverage decides how much of the frame even has to be built:
  // where it is fully opaque — most of the picture, and all of it during a zoom —
  // nothing underneath can show, so the background read and the shadow's taps are
  // work with no output. Computing coverage first and branching on it is exact:
  // over(dst, src, 1.0) returns src, whatever dst was.
  let sc = cover(sdRoundBox(px - (u.screen.xy + u.screen.zw * 0.5), u.screen.zw * 0.5, u.a.w));
  let opt = u.b.w > 0.5;

  var colour : vec3f;
  if (opt && sc >= 1.0) {
    colour = sampleScreen(px, u.b.y);
  } else {
    // 1. Background. Optimised: one texel of a texture baked at init.
    //    Naive: 16 gradient evaluations, per pixel, per frame — recomputing a
    //    constant 210 times.
    //    textureSampleLevel, not textureSample: the latter needs derivatives and
    //    is illegal in non-uniform control flow, which is exactly where we are.
    if (opt) {
      colour = textureSampleLevel(bgTex, samp, in.uv, 0.0).rgb;
    } else {
      colour = blurredGradient(in.uv);
    }

    // 2. Shadow under the recording.
    colour = over(colour, vec3f(0.0), shadow(px, u.screen, u.a.w, u.fx.x));

    // 3. The recording: zoomed (the rect already carries scale + pan), masked to
    //    a rounded rect, motion-blurred while the camera travels.
    if (sc > 0.0) {
      colour = over(colour, sampleScreen(px, u.b.y), sc);
    }
  }

  // 4. The webcam, its shape morphing with the layout animation, with its own
  //    shadow.
  let ws = shadow(px, u.webcam, u.b.x, u.fx.x * 0.8);
  colour = over(colour, vec3f(0.0), ws);
  let wc = webcamCover(px, u.webcam, u.b.x);
  if (wc > 0.0) {
    // Cover-fit: a 4:3 source in a square hole would squash without this. Sample
    // the middle and let the mask crop, which is what the eye expects.
    let centre = u.webcam.xy + u.webcam.zw * 0.5;
    var uv = (px - centre) / max(u.webcam.zw, vec2f(1.0));
    uv = uv * vec2f(u.b.z, 1.0) + vec2f(0.5);
    let cam = textureSampleBaseClampToEdge(webcamTex, samp, clamp(uv, vec2f(0.0), vec2f(1.0)));
    colour = over(colour, cam.rgb, wc);
  }

  return vec4f(colour, 1.0);
}
