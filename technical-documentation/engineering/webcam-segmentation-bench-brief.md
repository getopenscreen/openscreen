# Brief — segmentation experiment ladder (round 3: settle the execution provider)

Self-contained brief for an agent on a test machine. Read
[webcam-segmentation.md](webcam-segmentation.md) for the decision this feeds.

Previous rounds, both in PR #493:
[round 1](https://github.com/getopenscreen/openscreen/pull/493#issuecomment-5410489010) —
realtime is affordable but thin (+3.01 ms/frame, 2.59 ms headroom).
[round 2](https://github.com/getopenscreen/openscreen/pull/493#issuecomment-5415093217) —
the workload is **memory-bandwidth-bound per pixel**; input resolution is the lever
(192×112 = 1.53× at IoU 0.976, 128×80 = 2.64× at IoU 0.949).

---

## The question

**Does the CPU execution provider beat DirectML once both are running next to the compositor?**

It is the only unknown left that changes the architecture. The CPU EP already measures **21 %
faster than DirectML** in isolation here (2.476 vs 3.119 ms p10) and it never touches the
contended GPU queue. If that holds under load, it removes the D3D11↔D3D12 shared-handle interop,
the adapter-LUID matching, the cross-queue fence and the DirectML packaging cost.

That removal is **measured on Windows only** — this box is the whole ladder. macOS and Linux
inherit the simplification by construction, since with no GPU execution provider there is no
interop to build in the first place; but neither has been measured. Linux is where it could still
fail: its export path is already CPU-heavy, so giving two cores to inference may bite differently
there. Claim the Windows GPU path removed, and nothing more, until those two are run.

The risk that could kill it: this box is a **4-core / 8-thread** Ryzen 5 7520U. An ONNX Runtime
CPU session that grabs every core will fight the compositor's own CPU work. **Thread count is the
tuning knob and must be swept, not left at default.**

## Hard constraints

Unchanged: **no production code touched** (nothing under `src/`, `electron/`,
`crates/compositor/`), **no dependency added to the app**, **nothing pushed**, **no model weights
downloaded** without the source being named and approved.

Protocol per [rendering-performance.md](rendering-performance.md) §C.2 — warm-up discarded,
interleaved arms, **any arm above 15 % spread is VOID**, quiet machine, **only within-run ratios
transfer**. Round 2 only became admissible after moving to **iteration-level interleaving with a
p10 statistic**; start there rather than rediscovering it. Round 2 also needed a 300 s cooldown
between sweeps — budget for it.

Report the hardware and the battery state. Round 1's absolutes were depressed by a charging
battery; round 2's were not. Say which you have.

## The arms

Four, interleaved at iteration level. **Keep the no-op control** — without it a drop cannot be
attributed to the GPU rather than to the load generator stealing CPU.

| arm | load |
|---|---|
| **A** | compositor alone |
| **N** | pacing loop only, no inference — control |
| **B-dml** | + DirectML inference at 30 Hz |
| **B-cpu** | + CPU EP inference at 30 Hz |

Run the whole set at **two input resolutions: 256×144 and 128×80**, so the EP choice and the
resolution lever can be read separately rather than confounded.

**Verify the achieved load rate inside every arm.** Round 1's void came from a "60 Hz" load
silently running at 38 Hz and reporting a reassuring, wrong result.

30 Hz is not a bench convenience, it is what production does: `RateLimiter` in
`crates/compositor/src/segmentation.rs` admits one frame per 1/30 s and drops the rest rather than
queueing them, and `a_60_hz_render_loop_yields_about_30_inferences_per_second` pins that. The
renderer runs no inference at all — the mask is produced in the compositor process and reaches the
shader as a texture. Benching at 30 Hz measures the shipped cadence.

## What to sweep on the CPU arm

`intra_op_num_threads` at **1, 2, 4, and default**. For each, report both the inference latency
*and* the compositor's ratio against arm A. The interesting answer is almost certainly not the
fastest inference — it is the thread count where inference is fast enough and the compositor is
untouched.

Also report `inter_op_num_threads` if you change it, and which `ExecutionMode` you used.

## What else to watch

- **Does the compositor's own CPU work suffer?** Decode and mux are CPU-side. Report whether arm
  B-cpu costs the compositor more in *CPU* time even where it costs nothing in GPU time.
- The encoder mattered enormously in round 1 (−21.4 % with it, −6.5 % without), so **A, N, B-dml
  and B-cpu must all share one encode/decode/mux configuration**. Mixed placement across arms is
  not a detail that shows up as noise: a 21.4 % encoder effect dwarfs the ~5 % provider effect
  this round exists to measure, and would be read as the provider difference. Say which
  configuration you used; if both are wanted, run two matched sets rather than one mixed set.
- **Total system headroom**, not just the compositor's: if the CPU EP saturates the box, the app
  is unusable even with a happy compositor.

## Correctness check, not just timing

IoU 0.949 at 128×80 is a number, not a verdict. Render the mask at the two sizes it will actually
be seen at and look:

- as a **picture-in-picture** at roughly 25 % of frame width — the common case;
- **camera fullscreen**, where a 128×80 mask is upscaled ~15× and edges will be at their worst.

Say plainly whether 128×80 is shippable, whether 192×112 is the safer pick, and what the edge
artefacts actually look like. A visual call here is worth more than another decimal place.

## What to report

Per arm and per resolution: the number, the spread, admissible or VOID, the ratio against A, and
**both the target and the achieved rate** — for the load and for the inference. Verifying the
cadence without publishing it protects no one: that is how round 1 looked admissible while running
at 38 Hz. Then, in prose:

- **which EP you would ship, and at which resolution and thread count**;
- whether the CPU EP removes the need for the D3D11↔D3D12 interop — the actual decision this
  round exists to make;
- every run discarded and why. A prediction falsified is the most valuable thing you can return —
  round 2's falsification of the overhead hypothesis saved building two levers that did not exist.

## Do not pursue

- ORT session hygiene and hand-fused SE compute shaders — round 2 measured the total fixed cost at
  0.43 ms. That is ~14 % of DirectML's 3.119 ms p10 but ~17 % of the CPU EP's 2.476 ms, so the cap
  is provider-dependent and the CPU EP is the stricter case. Either way the ceiling is too low to
  justify building them.
- Inputs below 128×80: at 64×48 the model emits an all-background mask. It breaks, it does not
  degrade. Both dimensions must also be **divisible by 16** or the skip-connection `Add`s fail.
- **RobustVideoMatting** — GPL-3.0 against an MIT app.
- MODNet, BiSeNet, SelfieMulticlass, ROI-tracking as a perf lever.

fp16/int8 is live again after round 2, but it is **round 4** — settle the provider first, since
precision interacts with which one you pick.
