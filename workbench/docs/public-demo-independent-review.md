# Independent agent review of the public demo draft

Reviewed on 2026-10-27 by the independent review agent assigned to `/root/review_public_demo`. This agent did not implement the fixture or runtime changes. Its only authored repository document is this review record. This is a code and limited visual review for a partial draft PR, not a measurement adoption receipt, human annotation approval, or approval of a model baseline.

## Scope inspected

I inspected the working-tree changes against `origin/main`, including `workbench/lib/measurement.ts`, `transport.ts`, `cassette.ts`, `runner.ts`, `harness.ts`, `public-demo.ts`, `limits.ts`, `workbench/cli.ts`, the scenario registry, and `vitest.workbench.config.ts`. I read `workbench/scenarios/public-demo.scn.ts`, the public-demo L0/L1 controls, the Chat budget control, cassette tests, and the measurement lifecycle test changes. I also inspected the existing temporal placement and scope helpers and source provenance implementation to understand the contracts being extended.

For fixture provenance I read `workbench/public-fixtures/local-demo-v1/README.md`, `capture.mjs`, `demo.html`, and `project.openscreen`. The capture source describes a local, silent, scripted canvas recording; the project has no transcript. No private fixture substitution or annotation labels entering the current prompt/document path was observed. The registered descriptor includes the public file roster and hashes, and replay compares the current fixture descriptor with the recorded input identity.

My visual inspection was limited to one frame extracted from the committed `demo.webm` at approximately 13.5 seconds. I ran:

```sh
ffmpeg -hide_banner -loglevel error -ss 13.5 -i workbench/public-fixtures/local-demo-v1/demo.webm -frames:v 1 work/review-frame-13_5.png
```

I viewed that PNG with the image tool. It shows the pointer over the comparison panel. Reading `demo.html` establishes that canvas clicks toggle the Preview color; the frame alone does not establish a comparison selection state. I did not watch the whole video or independently validate every annotation boundary. The revised label, `annotation comparison-area click`, describes the observed pointer location without claiming a selection effect.

## Findings and corrections rechecked

Earlier review found inconsistent zero-retry behavior in bounded Chat recording/replay and library repetitions. The current runner and replay paths preserve the recorded zero-retry policy for the bounded profile. The historical uncapped Chat profile remains available. The request-size default is now 128 KiB, while explicit limits still take precedence; I inspected this change and the passing recorder controls, but did not independently measure the documented 73,649-byte tool envelope.

Earlier review also found that temporal recall could pass wrong spatial placement outside the sweep, and subsequently found a 40%/50% coverage mismatch in the first fix. The current spatial check selects covered zones with `c.zoomPlacement` and evaluates focus-filtered coverage with the same helper. This shares its coverage threshold and union semantics. The negative control for 40–49% coverage now passes. The current grounding check requires a successful data-bearing read in a strictly earlier model round than mutation, and the same-batch negative control passes. A trim crossing the visible sweep fails the activity-preservation check. The label overstatement described above was corrected.

I found no remaining implementation blocker within this inspected draft scope. This conclusion concerns the fixture, controls, transport extension, and measurement plumbing; it does not establish editorial quality of a model's edits.

## Commands I actually ran

In the initial review I ran:

```sh
npm run wb -- workbench/l0/chat-budget.wb.ts workbench/l1/public-demo.wb.ts
```

That revision passed 7 tests in 2 files. After the final fixes I independently ran:

```sh
npm run wb -- workbench/l0/public-demo.wb.ts workbench/l0/chat-budget.wb.ts workbench/l1/public-demo.wb.ts workbench/l1/cassette.wb.ts workbench/l1/measurements.wb.ts
```

The final command exited successfully: 41 tests passed in 5 files. These are scripted/loopback tests, including public-recorded candidate completion, export, replay, baseline binding, and rejection of a synthetic mislabel. Their fixture receipts and judge responses are test data, not actual provider measurements or baseline approvals. I also used `git diff`, `git status`, `rg`, and source reads during the review. I did not run the full application suite, the full Workbench suite, a provider call, a judge call, or measurement adoption commands. Broader test totals reported by the implementing agent are outside my independently executed evidence.

## Work still required

Actual provider measurements, observed usage, judge verdicts, inspection of the model's edits and judge evidence, genuine adoption review, and committed bound baselines remain unverified by this review. No human annotation review occurred here. This silent scripted recording also leaves narrated enhancement, speech preservation, and word timing outside its coverage, and says nothing about the missing original private take. Issue #459 must not be declared complete from these offline controls. A real measurement and baseline require their own evidence and review record.
