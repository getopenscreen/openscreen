# Local browser demo v1

Original fictional artwork and scripted browser interactions, contributed under the repository's MIT license (including the WebM, sidecar and project). No third-party media, people, accounts, external fonts, network requests or private desktop content.

This is **public-recorded**, a controlled browser canvas recording made with MediaRecorder, VP9, 25 fps, 800 × 450. It is not native OS capture and not a human-operated take. The visible pointer is drawn at the browser pointer event position. Playwright supplies the events; a 40 ms sampler logs the same positions, plus pointerdown events, against the same performance clock. Recording and sampling start in one browser task. Frame scheduling means visual transitions have approximately one frame of uncertainty. The sidecar provider is `none`: it does not claim a native cursor provider. The production sidecar reader consumes it unchanged.

Captured 2026-10-27 with Node 22.22.1, npm 10.9.4, locked Playwright and Chrome 156.0.8078.48 (`--chrome`), on macOS arm64. The committed video is 219456 bytes and 15.966392 s per ffprobe, with 402 sidecar samples. This is a silent recording with no audio stream, speech or transcript. We deliberately make no speech-cutting or word-timing claim. The enhancement scenario exercises zoom edits and permitted scope on this material; it does not replace a narrated enhancement evaluation.

Reproduce from the repository root:

```sh
npm ci
npx playwright install chromium
node workbench/public-fixtures/local-demo-v1/capture.mjs
# Or use locally installed Chrome:
node workbench/public-fixtures/local-demo-v1/capture.mjs --chrome
ffprobe -v error -show_streams -show_format workbench/public-fixtures/local-demo-v1/demo.webm
```

Timing and encoder bytes vary on recapture. Commit a recapture as a new fixture version and re-review annotations; do not silently overwrite the adopted input. Update the project's asset and clip duration from ffprobe if recapturing. No assertion module is loaded by the capture page or project loader. Annotation labels and expected editorial windows live only in `scenarios/public-demo.scn.ts`. The script specifies actions rather than importing the expected results.

The project uses a repository-relative media path and no camera track. Open the WebM directly for visual inspection; when opening the project in the desktop editor, relink its single video if the editor resolves relative paths elsewhere.

Limitations: one controlled silent scene, scripted pointer motion, no real speech or native capture coverage. These inputs and their measurements say nothing about the absent private `real-*` take. No model measurement, judge review, human annotation review or baseline approval is implied by the existence of this fixture. Actual inspection and measurement status is tracked separately in `workbench/docs/public-demo-459.md`.
