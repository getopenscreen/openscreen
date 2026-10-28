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

## Follow-up: actual trial evidence inspected on 2026-10-28

This section records later evidence and supersedes the earlier absence of actual provider trials only to the extent stated here. It does not approve measurements that were still being produced.

I inspected commit `ae21bed5d53364074ed731dbb185bfe040efe634`, including its batch-tool scope correction and two regression tests. Allowing `addZooms` and enhancement's `addTrims` follows the same edit families as the individual tools; the activity-preservation check still rejects destructive batch trims. I independently reran the same five-file targeted command listed above: **43 tests passed in 5 files** on this source.

I read the candidate descriptors, recorded checks, raw repetitions, actual before/after documents, tool arguments/results, transport policies, provider usage, and reconstructed judge answers for `public-demo-trial-v2/public-demo-grounding` and `public-demo-trial-v3/public-demo-grounding` under `workbench/runs/`.

- Trial v2 used an agent output cap of 2,048 tokens. It read the project and available telemetry but made no edits. The last provider response has `finish_reason: length`; the answer ends mid-sentence. The judge returned `indéterminé` because the response was incomplete. The placement failures and indeterminate judgment accurately retain that outcome. The existing `dsl.turn.completed` check passes from `run.ok`, so it must not be described as proof that this capped trial completed the requested editing.
- Trial v3 used an agent output cap of 8,192 tokens. Its actual document contains three zooms and preserves clip timing with no trims. The sweep focus is `(0.82, 0.6)`, which differs from reviewed `(0.663, 0.6)` by 0.157 horizontally, outside the declared 0.15 tolerance. The sweep/spatial failures are therefore consistent with the current editorial assertion. The judge returned `conforme` for the separate limit-attribution property; this is not an overall edit-quality verdict. The old `addZooms` scope failure was a harness defect, fixed by `ae21bed5`; the trial retains its original source and result and should not be silently relabelled as a final-source measurement.

For the three final-source grounding repetitions already present in `workbench/runs/public-demo-measured-v1/public-demo-grounding`, I inspected all three actual mutation sequences, answers, before/after documents, and deterministic checks. All read the project and available telemetry before editing, add three zooms, and preserve the original clip/timing without trims. Repetition 1 places the middle hold at 10.6–11.6 seconds rather than covering the reviewed sweep; its sweep-focus failure is supported by the document. Repetitions 0 and 2 pass the deterministic checks. Repetition 2 uses auto focus for the sweep; this review verifies the stored document and oracle outcome, not a rendered export of its moving camera.

Using read-only Python checks, I verified every listed artifact SHA256 and every registered fixture-file SHA256 for both trials and the available final-source grounding candidate. I also checked all **539 effective source-manifest entries per candidate** against the recorded Git commit bytes, applying text newline normalization; none differed. Both trials record clean source `ed735595fd1035dfaaf1bd3b98eaf1483cf715d3`; the three-repetition grounding candidate records clean source `ae21bed5d53364074ed731dbb185bfe040efe634`. The public fixture identity matches across these runs. I read no environment/credential file and made no live provider request.

At this inspection the final-source grounding candidate was still `complete: false` with judge status `pending`; final-source zooms/enhance candidates were not yet available. I have issued no adoption receipt or baseline approval for them. Genuine quality failures can be frozen as observed baselines when their completed evidence, judgment, provenance, export validation and replay have been reviewed; approval of that evidence must not be presented as a claim that the edits succeeded. Human annotation review, narrated enhancement coverage, and validation of the original private take remain absent.

## Grounding adoption review at 2026-10-28 06:41 UTC

The final-source grounding candidate subsequently completed its judge pass. I inspected all three actual judge answers: each is `conforme` for limit attribution, consistent with the successful telemetry reads and the answers' explicit use of that telemetry. The candidate retains the observed sweep-focus failure in repetition 1: sweep 2/3, behaviour checks 6/6, DSL checks 35/36 and weighted DSL score 0.9714285714. I rechecked all listed artifact hashes after completion and independently summed the agent/judge SSE scalar usage fields; they match the manifest (16 agent rounds and 3 judge rounds, all with observed usage).

I issued a genuine independent receipt for `public-demo-grounding-deepseek-flash-20261028-v1`, approving the completed candidate with SHA256 `8982c09b5b3ef5d2e40868af321acb09c9cb22b80b9bb611689e6ef5cbd5ce34` as faithful observed evidence eligible for baseline binding after normal export verification and offline replay. I have not personally run export/replay for that adopted ID at this point. Approval includes the real failure and does not assert successful editing, human annotation approval, rendered-output quality or issue closure.

I also issued **rejected** adoption receipts for the authentic exploratory evidence IDs `public-demo-trial-2048-20261028` and `public-demo-trial-8192-20261028`. The first preserves capped truncation/no edits and an indeterminate judge; the second preserves the genuine spatial failure and prior-source scope false positive. Rejection prevents using these mixed or capped exploratory trials as approved baselines; it is not a claim that the evidence is fabricated. All three receipts are in the sibling validation directory `../validation-459/reviews/` and identify this independent agent, never a human reviewer. No approval extends to zooms/enhance measurements not yet reviewed.

## Enhancement transport evidence at 2026-10-28 06:46 UTC

The public export barrier rejected the initial receipt label because it contained an agent task path. I changed the public reviewer label in the existing receipts to `Codex independent reviewer (review_public_demo)`; no privacy barrier was weakened and the review dispositions are unchanged.

I inspected `workbench/runs/public-demo-measured-v1/public-demo-enhance` after its judge pass. Contrary to an earlier progress report supplied to this reviewer, **all three repetitions are transport failures**, with empty answers and no document mutation. All three judge verdicts are `indéterminé` for empty answers. The candidate has completed its evidence/judge workflow but has not completed the requested editing. Its eight agent attempts comprise five recorded rounds and three retained forward failures; available usage sums match the candidate, while usage for failed attempts remains unknown. I independently checked actual calls/documents, checks and judge answers, listed artifact hashes and registered fixture-file hashes. Raw repetition errors contain local stack paths and should remain local; existing export privacy checks remain required for the adopted artifact set.

I issued a **rejected** receipt for `public-demo-enhance-transport-20261028`, candidate SHA256 `fb86586921e9ee534d7848b82ef5a275e21dac85bbfbf068436e31215dcec090`. It preserves authentic transport diagnostics, not an approved enhancement-quality baseline. This rejection neither imputes transport failures to model editorial quality nor discards their cost/attempt evidence. No subsequent enhancement or zooms candidate is approved by this section.

## Replay blocker and zooms review at 2026-10-28 06:48 UTC

The executing agent reported that strict offline replay of the exported grounding measurement fails freshness at rounds 4 and 5. I independently traced the code and the original mutation sequence: `createId` uses fresh random UUIDs, the first recorded `addZooms` therefore creates new IDs on replay, and subsequent recorded `setZoom` arguments still contain the original IDs. `normalizeIds` changes hashes only; replay serves the original SSE without changing tool arguments. This changes actual tool outcomes and later conversation history. I did not personally execute that replay command, and do not claim that I did.

I changed the grounding receipt to **rejected** for baseline eligibility, superseding its earlier approval. The evidence remains authentic and its observed failure remains meaningful, but an approved receipt mechanically permits baseline binding; a prose condition about later replay is insufficient protection after a known replay failure. No baseline is approved while this blocker persists.

The safe prospective direction is a scoped ID allocator whose actual allocation sequence becomes explicit, versioned replay evidence. Replay must restore exact allocations, reject sequence/prefix/collision mismatches and preserve strict request freshness; it must not patch global randomness, force request matches, or turn genuinely wrong model IDs into correct ones. Legacy Chat cassettes alone do not contain the original tool-result bodies needed to reconstruct a general ID map. Extending current evidence would require genuine retained allocation/tool-result provenance and separate validation; declaring the current limitation is the smaller safe change.

I inspected all three actual repetitions, answers, tools/documents, checks and judge outputs for `workbench/runs/public-demo-measured-v2/public-demo-zooms`. All add three zooms without trims/timing changes. Repetition 0 successfully adjusts the first zoom, but twice mistypes the third ID (`ecca78` where the created ID contains `ecca84`); those original `Unknown zoom` errors must remain failures under any replay fix. It also fails the stored-focus/sweep oracle. Its sweep is in auto mode, so this is a declared static-focus assertion failure, not independent proof of misframing in a rendered export. I did not render its output. The judge returns two `conforme` outputs and one response with `finish_reason: length` and no final JSON; that last judgment is correctly indeterminate. All listed artifact/input hashes and recorded scalar usage totals match (17 agent rounds and 3 judge rounds).

I wrote a **rejected** receipt for `public-demo-zooms-deepseek-flash-20261028-v2`, candidate SHA256 `32104014da25d33effa11cfde6791355743501d0e1138de0aa8174f8f3bfa7a2`. This retains reviewed, authentic evidence but withholds baseline eligibility pending successful strict replay, particularly because repetition 0 targets an originally generated ID. Neither future measurements nor a future replay extension are approved by this review.

## Final evidence packaging review on 2026-10-28

I independently checked the four exported public-demo bundles and the separate failure-investigation archive. Every listed exported artifact hash matches its file, and every exported review is rejected. For the archive I compared each copied cassette/attempt file byte-for-byte with its original local file, checked its declared hash, verified each local raw-record hash, and compared every projected per-repetition check status with the corresponding raw pre-judge record. They match. The public projection retains failures without publishing raw project snapshots or local error stacks; its explicit kind says it is not an adopted measurement. Missing response cassettes remain missing, and the completed enhancement candidate's refused formal export remains disclosed rather than being silently replaced by this archive.

I then personally executed a read-only Node command that bundled the existing measurement API in memory with esbuild (`write: false`), recursively called `assertPublicArtifact` for every archive file, and called `verifyMeasurementId`, `replayMeasurement`, and `boundBaselineFromMeasurement` for all four exported IDs. No source/output file was generated by the command and no provider request was made. Results:

| Evidence | Verification | Strict replay | Baseline binding |
| --- | --- | --- | --- |
| Grounding v1 | passed; rejected review | freshness failure, rounds 4, 5 | refused: `REVIEW_NOT_APPROVED` |
| Zooms v2 | passed; rejected review | freshness failure, rounds 4, 5, 6 | refused: `REVIEW_NOT_APPROVED` |
| Trial 2048 | passed; rejected review | `SOURCE_IDENTITY_MISMATCH` on current source | refused: `REVIEW_NOT_APPROVED` |
| Trial 8192 | passed; rejected review | `SOURCE_IDENTITY_MISMATCH` on current source | refused: `REVIEW_NOT_APPROVED` |

All **22 archive files** present at this check passed `assertPublicArtifact` using its standard scanner (no credential-file access or supplied secret values). These actual API outcomes agree with `adoption-validation.json` and supersede my earlier statement that I had not personally executed adopted-ID replay. The frozen exported receipts are unchanged; their statements describe the earlier review time.

Two metadata clarity issues were reported to the implementing agent: duplicate attempt-ledger entries in the archive roster should be deduplicated, and projected check statuses should be explicitly labelled as raw pre-judge checks with judge results not applied. In particular, finalized candidate context must not cause readers to mistake raw pre-judge repetition checks for finalized judgments. These are archive presentation issues rather than evidence/hash mismatches.

No approved baseline exists in this reviewed packaging. The recordings and measurements retain their genuine model/transport/judge failures, strict replay remains blocked, enhancement lacks an exportable completed quality dataset, and human annotation review and narrated enhancement coverage remain absent. This is partial investigation evidence for a draft, not completion of issue #459.

## Review of prospective replay instrumentation on 2026-10-28

I reviewed the new uncommitted Workbench-only ID instrumentation, build integration, ledger validation/capture/replay, safe transport diagnostics and automatic-focus assertion changes against `public-demo-replay-plan.md`. The production `createId` body and shipped application source remain unchanged; Workbench wraps that generator with a per-turn AsyncLocalStorage capture/replay scope. The ledger records actual allocations, has a closed versioned schema and limit, checks prefix/order/duplicates/input collisions, and requires consumption on normal turn completion. The replay leaves recorded model tool arguments untouched, including genuinely wrong IDs. The retained canonical cassette receives the retained turn's ledger, and both official CLI and measurement replay supply it. Source fingerprints cover the new helper and build files; cassette artifact hashes bind the ledger. I found no privacy expansion in the ledger's restricted identifier shape or diagnostic messages.

The first esbuild plugin filter missed Windows separators. I reproduced that mismatch with its registered filter; the implementing agent corrected it and added a regression. I independently rechecked the current filter with a Windows-style path: it now matches. The harness also checks an instrumentation marker and fails closed when the official wrapper is missing.

I personally ran `npm run wb -- workbench/l0/document-ids.wb.ts workbench/l1/document-ids.wb.ts workbench/l1/cassette.wb.ts workbench/l1/measurements.wb.ts workbench/l1/public-demo.wb.ts`: **49 tests passed in 5 files**. I also ran `npm run wb:typecheck`, which passed. Separately, I bundled the actual harness and plugin in memory with esbuild and ran an offline scripted zoom: it recorded the actual created zoom ID. Repeating without instrumentation correctly rejected the turn before running. These checks use no provider and write no bundled source file. Vitest's create/update replay controls preserve both valid and invalid original model-ID outcomes, while the transport regression distinguishes response overflow from generic forward failures without publishing URLs or arbitrary exception text.

One remaining assertion edge was reported: a zone split between correctly focused manual coverage and automatic coverage can be covered by their union even when neither subset alone reaches the 40% threshold. The inspected spatial check then falsely returns wrong focus. It should test the union of known-correct manual and unmeasured auto spans to distinguish a possible valid result (undecided) from a definite failure, retaining manual-only negative controls. The new decision to leave automatic spatial focus unmeasured pending rendered trajectory review is otherwise appropriately conservative. This implementation review is not approval of any new measurement or baseline, nor verification of native rendering or the separately running provider diagnostics.

## Renderer and response-bound follow-up on 2026-10-28

The mixed manual/automatic coverage issue is corrected in the current source: potential coverage uses the union of known-correct manual and automatic spans, and its negative/regression control is present. I reviewed the new explicit `--max-response-bytes` parsing and its wiring into both agent and judge transport limits. It preserves the default and records the selected limit in transport identity. I independently ran `npm run wb -- workbench/l1/public-demo.wb.ts workbench/l0/cli-bounds.wb.ts workbench/l1/responses-cli.wb.ts`: **16 tests passed in 3 files**, including the compiled instrumented CLI replay. `npm run wb:typecheck` also passed.

I read the actual `public-demo-diagnostic-v4/public-demo-enhance` attempt ledger: two rounds were recorded and the third failed in response phase with `response body limit exceeded (1049828 > 1048576 bytes)`. This diagnoses that bounded trial as response overflow; it does not establish that every earlier generic transport failure had the same cause. I made no provider request.

I inspected `render-public-demo.ts`, its build entry and import-meta handling, production `buildNativeClipList`, `buildSceneDescription`/editor settings, the production scene asset resolver, and the native timeline walk's adjacent cursor-sidecar lookup. The renderer uses the actual persisted after-document and registered WebM, production scene/default settings, real asset resolution and local native addon. I found no invented zooms, media or settings in that path. I viewed the existing native `frame-0200.jpg` at programme time 8 seconds from the old grounding probe: it shows the composed comparison panel and cursor. I did not execute the native build or renderer, inspect all nine frames, or validate a new measurement's visual result.

At review time the render manifest bound the raw record and addon binary but not the media/sidecar bytes, resolved scene or source identity used at render time. I requested those hashes before treating rendered frames as approval evidence. The existing frames are inspection aids pending that provenance extension. Code-path fidelity and passing offline tests do not approve a future live measurement, automatic-focus trajectory, baseline or completion of issue #459.
