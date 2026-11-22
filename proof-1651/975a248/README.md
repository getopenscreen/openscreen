# Proof for #1651 on the live head 975a248

The author pushed 975a248d ("restart per clip window, exactly on its start") on top of 6a20551 while that head's proof was running. This is the same harness, scenes and host as [../README.md](../README.md), run against base main 128ab637.

## Verdict

**The rendering is correct, but preview gets a new cost that grows with the recording's length.**

- **Re-smoothing on every clip change.** Preview now re-smooths the whole cursor track whenever the active clip changes, on the render thread. `live.rs` says so itself: "the track is smoothed again on a clip change even when the file stays the same". The breaks now differ per clip. On base, and on 6a20551, they did not.
  - **Cost** (`bench.txt`): 0.65 ms on a 32 s recording. 77 ms on a 1-hour track, which is about 4 to 5 frames at 60 fps, at every cut during playback and at every clip crossing while scrubbing.
- **Auto-focus zooms move too.** An auto-focus zoom that starts right after a cut is still framed differently, as on 6a20551.
- **No real-app preview run.** Preview frame rate and preview-versus-export were not measured in the real app, for the same reason as on 6a20551.

## Results

| point | result |
|---|---|
| 1. Single untrimmed clip | **Pass.** 960 of 960 frames are pixel-identical to base. |
| 2. Cut, light scene | **Pass.** 447 of 540 frames are identical. The 93 others are cursor-sized diffs in the ~1.3 s after each window start. |
| 2. Cursor at the cut | **Pass.** Frames 0 and 195 are pixel-identical to the raw pointer, so 0 px. Base is 80.4 px off at frame 195. 6a20551 still showed a 450 px residue at frame 195. |
| 2. Heavy, manual focus | **Pass.** The diffs fit in cursor-sized boxes. |
| 2. Heavy, auto focus | **Wider change.** 299 frames differ. Frames 240 to 442, the auto-focus zoom, are re-framed by about 8 px. |
| 3. Export time | **Pass.** Heavy median 2.539 s on base, 2.563 s on head (+0.9 %). Light 4.136 s, 4.146 s (+0.25 %). |
| 3. Per-loop break lookup | **Pass.** 27 to 35 ns per iteration, whatever the clip count. |
| 3. Re-smooth per clip change | **New cost**, see the verdict. Not measured as frame rate in the real app. |
| 4. Preview against export | **Shown in code, not run.** Both use `smoothed_with_breaks(s, cursor_break_for_clip(i))` on the full scene. |
| 5. `cargo test --release --lib` | **Pass.** 519 passed, 0 failed. |
