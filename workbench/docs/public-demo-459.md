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

## Actual measurements and remaining blockers (2026-10-28)

Real requests used the repository's ignored `.env.workbench`, without reading other applications' credentials. Requested and observed agent/judge model: `deepseek-flash`, provider `openai-compatible`; endpoint is recorded only by fingerprint. Four authentic evidence bundles are committed under `workbench/measurements/`. **Every review is rejected for baseline eligibility. No new baseline is frozen, and this does not complete #459.**

| Evidence ID | Repetitions and actual result | Observed agent tokens (input / output) | Judge |
| --- | --- | --- | --- |
| `public-demo-trial-2048-20261028` | 1; capped at 2,048, final `finish_reason=length`, no edits | 67,429 / 2,224 | 1 indeterminate (incomplete answer) |
| `public-demo-trial-8192-20261028` | 1; 3 zooms, stored sweep focus outside tolerance; old-source batch scope false positive retained | 123,732 / 3,901 | 1 conforme |
| `public-demo-grounding-deepseek-flash-20261028-v1` | 3; all edit after project/telemetry reads; sweep check 2/3 | 393,521 / 9,095 | 3 conforme |
| `public-demo-zooms-deepseek-flash-20261028-v2` | 3; stored sweep/spatial checks each 2/3; actual mistyped zoom ID preserved | 430,161 / 13,607 | 2 conforme, 1 indeterminate (length/no final JSON) |

These are observed sums across recorded requests, not per-request caps or billed-cost estimates. The manifests retain the original provider usage blocks, cache counters, requested/observed models and separate judge usage. The behaviour percentages do not turn an indeterminate check into a pass. The grounding and zooms weighted DSL scores are respectively 0.9714285714 and 0.9310344828; these are observations on rejected evidence, not approved baseline rates. With n=3 they cannot establish fine-grained quality differences. The judge checks attribution of limitations, not overall edit quality; it uses the same model and is not the independent adoption reviewer.

The first six-request trial had a 2,048 output-token cap and 180-second turn timeout. Its final round used 1,948 reasoning tokens within the 2,048 limit; output ended mid-sentence. The second trial retained the six-request/180-second limits and raised the output cap to 8,192. Follow-up groups used three repetitions, at most 18 agent requests per scenario/invocation, 8,192 output tokens/request and 180 seconds/repetition. Judges allowed at most three requests, 2,048 output tokens/request and 60 seconds/repetition. Bounded profiles disable SDK and repetition retries. Every invocation has its own request budget; the failed service attempts and explicitly bounded follow-up invocations are retained, not silently retried away.

Both enhancement groups (three repetitions each) ended in transport failures. The first has a complete *candidate evidence structure*, but all three agent turns failed, made no edits and received indeterminate judgments; its usage status is incomplete because failed requests have unknown usage. Its formal export was correctly refused because the report contains local error-stack paths. The second enhancement group and the first zooms group lack a response cassette for at least one repetition, so candidate creation was refused. A first grounding judge attempt also failed with proxy HTTP 502; a separately bounded judge retry completed. Do not interpret these proxy failures as independently diagnosed provider HTTP responses.

[Failure investigation evidence](evidence/public-demo-459/failure-summary.json) retains unchanged partial cassettes/attempt ledgers, a public projection of raw pre-judge check statuses, local raw-record hashes, and candidate context where it actually exists. Error stacks and full raw project snapshots stay local. This projection is explicitly not an adopted measurement manifest. [The rejected enhancement review](evidence/public-demo-459/enhance-rejected-review.json) is genuine. No signed artifact was edited to bypass export privacy checks.

### Why no baseline is frozen

All four exported bundles pass `verify`. Strict offline replay of final-source grounding fails at rounds 4/5 and zooms at rounds 4/5/6. The model creates regions, then references their returned random UUIDs in later `setZoom` calls. Replay creates new UUIDs, while recorded assistant arguments still target the originals. Existing hash normalization stabilizes identity strings but does not retarget tool execution. Neither ignoring freshness nor approximate UUID matching is safe: zooms also contains an actual mistyped-ID model error that must survive replay. The old exploratory trials correctly fail current-source identity after the batch-scope fix.

The independent reviewer reproduced these failures and withdrew grounding's provisional approval **before any baseline was generated**. The four committed receipts reject baseline eligibility; actual `baseline` derivation refuses all four with `REVIEW_NOT_APPROVED`. [Machine-readable validation](evidence/public-demo-459/adoption-validation.json) and [the independent review](public-demo-independent-review.md) record this. No human review receipt exists. Exported evidence is excluded from Biome rewriting so its original bytes and hashes remain intact; the measurement verifier and archive privacy scanner validate it separately.

A robust prospective replay fix needs per-document ID-allocation evidence with exact prefix/count/collision validation, or an equivalent reviewed mechanism preserving strict hashes and genuine wrong-ID failures. It requires its own tests and fresh real measurements on the final source. That infrastructure work has not been implemented here. Do not regenerate or approve a baseline from these records merely because export verification succeeds.

The spatial oracle also checks stored `focus` even when `focusMode=auto`; production auto focus follows the pointer. Those failures are failures of the declared stored-focus assertion, not proof of rendered misframing. No compositor export was reviewed. Before baseline approval, the auto-focus assertion needs rendering-aware validation and negative controls, rather than silently accepting or weakening its threshold. Narrated enhancement, speech preservation, human annotation review and the original private take remain outside this fixture's coverage.

### Reproduce the observed checks

```sh
# No credentials or provider requests are used by these commands.
npm run wb:measurement -- verify --id public-demo-grounding-deepseek-flash-20261028-v1
npm run wb:measurement -- replay --id public-demo-grounding-deepseek-flash-20261028-v1
# Expected: strict stale rounds 4,5; command exits nonzero.
npm run wb:measurement -- baseline --id public-demo-grounding-deepseek-flash-20261028-v1 \
  --out workbench/runs/rejected-grounding-baseline.json
# Expected: REVIEW_NOT_APPROVED; no baseline written.
```

The same commands for `public-demo-zooms-deepseek-flash-20261028-v2` verify successfully, then fail strict replay and baseline approval. Exploratory trials verify but fail replay with `SOURCE_IDENTITY_MISMATCH` on the later source.

For a new explicitly labelled bounded run after addressing those blockers (requires local `.env.workbench`; do not reuse an adopted ID):

```sh
npm run wb:live -- --scenario public-demo-grounding --reps 3 --label <new-label> \
  --record --max-requests 18 --max-output-tokens 8192 --timeout 180000
npm run wb:judge -- --scenario public-demo-grounding --label <new-label> \
  --record --max-requests 3 --max-output-tokens 2048 --timeout 60000
```

Repeat for the other two distinct IDs only as needed. Each invocation has a separate budget; the agent timeout is per repetition (at most 540 seconds for three), per-request timeout 60 seconds. Only after genuine review, successful strict replay and approval should the existing export/verify/baseline workflow be used. Known model failures must remain observed failures; the checks are not to be tuned to make measured outputs green.

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
| `npm run wb -- workbench/l0/public-demo.wb.ts workbench/l1/public-demo.wb.ts workbench/l0/chat-budget.wb.ts workbench/l0/transport-policy.wb.ts workbench/l0/measurements.wb.ts workbench/l1/measurements.wb.ts workbench/l1/cassette.wb.ts` | 7 files passed; 78 tests passed, 1 existing skip (final batch-tool controls included, 2026-10-28) |
| `npm run wb` (before the final same-batch grounding control) | 558 passed, 66 failed, 1 skipped; see breakdown below |

Of the 66 full-Workbench failures, 65 are `ORIGINAL_FIXTURE_UNAVAILABLE` for the absent original take (L0 real fixture, quality, truth and score; L1 real fixture turn, real screencast and registry-wide end-to-end cases). The other failure is the unchanged `l0/editorial.wb.ts` orphan-fragment assertion: expected `20.94 - 20.63 = 0.31` seconds, observed `0.45` seconds. `editorial.ts`, its fixture generator and that assertion were not modified in this PR. Neither category is converted to a skip or represented as a new-fixture success. The final scoped run above includes the same-batch and batch-tool negative controls.

Lifecycle/export/verify/replay/baseline-binding coverage here uses temporary **scripted loopback** artifacts and test-only receipts. They are deleted by test cleanup and do not qualify as provider measurements or baseline approval; they are separate from the actual rejected evidence above. See [independent implementation review](public-demo-independent-review.md) for the independent agent's own inspection and test record.
