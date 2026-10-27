# Public local demo — issue #459

## Scope and design

This change adds an independently named, openly licensed local demo and reuses #653's cassette, usage, provenance, judge, adoption and bound-baseline workflow. It preserves all `real-*` scenario IDs and missing-fixture failures. Nothing here validates the original private take.

Three scenarios (`public-demo-enhance`, `public-demo-zooms`, `public-demo-grounding`) read the same portable project and production-parsed cursor sidecar. Temporal precision/recall, spatial focus, scope and read-before-edit order are separate assertions. Assertions and editorial labels are absent from prompts, project metadata and tools. Scripts are offline controls, never model observations. The media is a silent, scripted browser canvas capture, honestly labelled `public-recorded`, with no transcript or speech-preservation claim.

The only newly exportable recorded IDs are these three. Their input descriptor pins the exact registered file roster and hashes (media, project, sidecar, capture source and license/provenance README). Replay checks current committed input bytes as well as existing source identity and request hashes. Export/verify retain the existing secret, path and raw-document barriers. The original synthetic descriptor schema and allowlist remain valid.

For a bounded DeepSeek/Chat trial, the existing `--max-output-tokens` flag now imposes a recorded `max_tokens` policy, forwarding the effective body and replaying the same policy. An omitted cap keeps the historical Chat profile. Bounded calls use zero SDK and repetition retries. The current empty tool envelope is 73,649 UTF-8 bytes on this source, so the default request cap is 128 KiB rather than 64 KiB; explicit lower limits still apply. No prompt or tool descriptions were changed to fit these scenarios.

## Inspection record

2026-10-27: Codex inspected contact-sheet frames at approximately 0, 2, 4, 6, 8, 10, 12 and 14 seconds. Visible pointer: idle below the cards, Preview at 2–4, below cards at 6, moving across Compare shapes at 8–10, idle at 12, comparison-area click at 14. ffprobe: VP9, 800×450, 15.966392 seconds, no audio; 219456 bytes. Sidecar: 402 samples and two clicks. The second click toggles Preview's color because the page listens on the whole canvas; the annotation describes the pointer/click location, not a comparison selection state.

This was agent visual inspection, not a human annotation review. An independent reviewer also inspected a frame near 13.5 s and caught the over-specific initial selection label, which was corrected. Review also found retry-policy and 40%/50% spatial-coverage inconsistencies; implementation and negative controls were corrected. No measurement approval receipt has been issued by this activity.

Truth windows permit frame scheduling uncertainty: 1.8–4.8 s (Preview), 7–11 s (continuous sweep), 13–15 s (comparison-area click). Spatial checks allow 0.15 normalized displacement and use the same temporal coverage criterion as recall. These are editorial assertions, not proof of causal use of telemetry. `dsl.consults.before-editing` separately tests the method. A tool call that returns no data does not count as reading. A cut removing visible activity fails even when enhancement permits trim edits.

## Measurement and baseline status

The bounded trial command below was actually invoked on 2026-10-27. The CLI built successfully, then exited 1 at `requireLiveEnv` because the local API-key field was empty (`OPENSCREEN_WORKBENCH_API_KEY manquant`). No provider request was sent. Pending local `.env.workbench` configuration; no real provider requests have run yet. No usage, model-quality rates, judge verdicts or approved baseline are claimed. No human/independent approval receipt is fabricated. Do not close #459 on the strength of scripted lifecycle tests.

First trial, after configuring the repository's three required environment values and `chat-completions` mode:

```sh
npm run wb:live -- --scenario public-demo-grounding --reps 1 --label public-demo-trial-v1 \
  --record --max-requests 6 --max-output-tokens 2048 --timeout 180000
npm run wb:judge -- --scenario public-demo-grounding --label public-demo-trial-v1 \
  --record --max-requests 1 --max-output-tokens 1024 --timeout 60000
```

This permits at most six agent requests (2,048 output tokens each) and one judge request (1,024 output tokens). The trial must finish and its edits and judge evidence must be inspected before expanding. Follow-up measurement: each of the three IDs, three repetitions, at most 18 agent requests and three judge requests per scenario, with the same per-request output caps. The timeout is per repetition (at most 540 seconds for three agent repetitions); per-request timeouts remain 60 seconds. Provider omission of usage remains unknown, not zero.

After actual review, with a genuine receipt naming the measurement ID and reviewer:

```sh
npm run wb:measurement -- export --run workbench/runs/<label>/<scenario> \
  --id <measurement-id> --review <actual-review-receipt.json>
npm run wb:measurement -- verify --id <measurement-id>
npm run wb:measurement -- replay --id <measurement-id>
npm run wb:measurement -- baseline --id <measurement-id> \
  --out workbench/baselines/<scenario>.json
```

Commit the adopted evidence and bound baseline together. The receipt is not evidence that a human reviewed it unless a human actually did. A known model failure is an observed result to retain and explain, not grounds to weaken the oracle.

## Validation

Commands and final outcomes are recorded below before submission. The full Workbench keeps private-fixture failures visible. The new fixture does not turn those into skips or green results.


Validation on Node 22.22.1 / npm 10.9.4, macOS arm64, 2026-10-27:

| Command | Observed outcome |
| --- | --- |
| `npm run test` | 364 files passed; 5,032 tests passed, 2 skipped (after installing the Electron binary with its package install script) |
| `npx tsc --noEmit` | Passed |
| `npx tsc -p tsconfig.test.json --noEmit` | Passed |
| `npm run wb:typecheck` | Passed |
| `npm run lint` | Passed with 26 existing warnings |
| `npm run docs:check` | Passed, 37 files |
| `npm run wb -- workbench/l0/public-demo.wb.ts workbench/l1/public-demo.wb.ts workbench/l0/chat-budget.wb.ts workbench/l0/transport-policy.wb.ts workbench/l0/measurements.wb.ts workbench/l1/measurements.wb.ts workbench/l1/cassette.wb.ts` | 7 files passed; 76 tests passed, 1 existing skip |
| `npm run wb` (before the final same-batch grounding control) | 558 passed, 66 failed, 1 skipped; see breakdown below |

Of the 66 full-Workbench failures, 65 are `ORIGINAL_FIXTURE_UNAVAILABLE` for the absent original take (L0 real fixture, quality, truth and score; L1 real fixture turn, real screencast and registry-wide end-to-end cases). The other failure is the unchanged `l0/editorial.wb.ts` orphan-fragment assertion: expected `20.94 - 20.63 = 0.31` seconds, observed `0.45` seconds. `editorial.ts`, its fixture generator and that assertion were not modified in this PR. Neither category is converted to a skip or represented as a new-fixture success. The final scoped run above includes the added same-batch negative control.

Lifecycle/export/verify/replay/baseline-binding coverage here uses temporary **scripted loopback** artifacts and test-only receipts. They are deleted by test cleanup and do not qualify as actual provider measurements or baseline approval. See [independent implementation review](public-demo-independent-review.md) for the independent agent's own inspection and test record.
