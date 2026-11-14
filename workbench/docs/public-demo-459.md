# Public local demo — issue #459

## Scope and provenance

Three new IDs, `public-demo-enhance`, `public-demo-zooms` and `public-demo-grounding`, reuse #653's cassette, provider usage, provenance, judge, offline replay and bound-baseline workflow. The original private files, `real-*` IDs and missing-fixture failures are preserved. These observations do not validate the private take, and this leaves #459 open.

The [MIT-licensed original demo](../public-fixtures/local-demo-v1/README.md) is a silent scripted browser-canvas recording: VP9, 800×450, 15.966392 seconds, 219456 bytes, 402 cursor samples and two clicks. Its portable project, capture script, page and provenance are committed. It is registered as `public-recorded`, with an exact allowlist and file hashes; it is never presented as synthetic input, native capture, human interaction or narrated speech. There is no invented transcript. No private accounts, external page content or personal data were used.

## Annotation and checks

On 2026-10-27 Codex visually inspected source frames near 0, 2, 4, 6, 8, 10, 12 and 14 seconds, then compared the sidecar. The independent agent inspected additional frames and corrected an initially over-specific selection label: the second click is in the comparison area, but the whole-canvas listener toggles Preview's color. Neither review is a human annotation receipt.

Assertion windows are 1.8–4.8 seconds (Preview), 7–11 (continuous comparison sweep), and 13–15 (comparison-area click). They allow capture scheduling uncertainty. The sidecar first records the sweep's actual motion at 7041 ms. Truth labels, windows and target coordinates remain in scenario assertions; project metadata, prompts and tool responses carry no editorial answer key. L0 and actual L1 wire audits test this, including an intentional leak control.

Temporal precision/recall, manual spatial placement, activity preservation, scope, successful project reads and successful telemetry reads **before** editing are separate checks. Negative controls exercise empty edits, wrong focus, 40–49% coverage, destructive trims, missing/failed/late/same-batch reads and scope breaches. The inclusive normalized focus tolerance is 0.15 plus one floating-point epsilon: exact ±0.15 passes and ±0.150001 fails. This corrects subtraction rounding without widening the editorial criterion. Batch zoom/trim and automatic zoom tools have the same permitted scope as their equivalent individual operations.

Automatic focus follows the pointer in production; stored coordinates do not measure it. A spatial result that depends on automatic coverage is **indeterminate**, with its count retained, while wrong manual coverage still fails. Sampled native renders provide additional inspection, without turning unmeasured automatic checks into passes. A manual stored-focus failure is not, by itself, proof of pixel-level misframing after compositor clamping. These checks measure the declared editorial properties, not causal understanding or overall aesthetic quality.

## Prospective replay correction

Fresh cassettes retain a versioned ledger of actual document-ID allocations. Workbench builds/tests wrap the unchanged production `createId` body using per-turn AsyncLocalStorage; the shipped app and model arguments are unchanged. Replay consumes the exact original allocations, validates version/prefix/order/uniqueness/input collisions and full consumption, and rejects work after scope closure. Request hashes and source/input freshness stay strict. Genuine mistyped model IDs remain errors. Legacy cassettes still parse, but no missing historical ledger is fabricated.

Interrupted turns now retain the last actually observed tool document while remaining failed; this is not a project-save claim. Bounded response diagnostics distinguish response overflow, timeout and allowlisted network codes without publishing URLs, headers or raw error stacks.

## Final current-main measurements

Final measurements use source commit `d1e2d9a4faf53d5a0fd77f177b01edde9c602569`, which includes upstream main `06bd7f2e` and its schema/layout changes. The project is migrated through the production loader; original fixture bytes are unchanged. Relevant source bytes, not later documentation-only commit IDs, determine replay compatibility.

The ignored local `.env.workbench` supplied the configured provider. Requested and observed agent/judge model is `deepseek-flash`, provider `openai-compatible`; the endpoint is published only as a fingerprint. Keys and configuration remain local. The attribution judge uses the same model and evaluates one limitation-attribution rubric; it is distinct from the independent evidence-adoption reviewer and is not an overall editing-quality judge.

| Measurement ID (prefix `public-demo-`, suffix `-deepseek-flash-20261028-v9`) | Agent requests; input/output tokens | DSL passed/decided; indeterminate | Attribution judge |
| --- | --- | --- | --- |
| `enhance` | 19; 531,870 / 23,666 | 29/30; 0 | 2 conforme, 1 indeterminate |
| `grounding` | 15; 361,093 / 6,054 | 33/35; 1 | 3 conforme |
| `zooms` | 15; 367,709 / 7,612 | 28/28; 2 | 2 conforme, 1 fautif (known judge false positive) |

All nine agent turns completed normally. Enhancement repetition 1 misses the declared sweep duration; grounding repetitions 1/2 omit that sweep. Automatic spatial checks remain indeterminate where applicable. Enhancement's one indeterminate judge returned no final JSON at its cap. Zooms repetition 0's judge faults the statement that no transcript exists, although the actual successful project read states `hasTranscript:false`. The cursor-only `pointerReadFacts` summary omitted that known fact. This is an observed **judge false positive**, retained unchanged and explicitly not evidence of a model behaviour failure. Fixing that broader rubric-facts gap is future work; this measurement does not conceal it or rerun it away.

Separate observed judge input/output token sums are 5,900/6,334 (enhancement), 4,809/5,354 (grounding), and 4,959/2,345 (zooms). Each judge cassette contains three actual requests.

Final groups use label `public-demo-final-v9`, three repetitions each, zero SDK/repetition retries, at most 36 agent requests for enhancement and 24 for each other group. Per request: 8,192 output tokens and a 4 MiB response cap; per repetition: 180 seconds, with the existing 60-second upstream request timeout. Each judge group permits three requests, 4,096 output tokens, 4 MiB response and 60 seconds per repetition. Chat caps are forwarded as `max_tokens` and bound into the cassette transport policy. The default request cap is 128 KiB; explicit smaller bounds still apply.

Observed usage blocks, cache counters, missing/complete status, requested/observed models, input/source fingerprints, checks and reports remain in each manifest. Token totals are observations, not cost estimates. With n=3, small differences are not statistically established. A faithful reviewed baseline records model failures and indeterminate checks; approval does not mean every edit succeeded.

Three genuine independent approved receipts were issued only after actual edit/judge/native inspection and full strict measurement preflights in temporary exports. The executing agent subsequently exported all three public bundles and reran official CLI `verify`, full agent-plus-judge `replay` and `baseline`, then `verifyBoundBaseline` for every result. All passed. [Executed final lifecycle results](evidence/public-demo-459/final-v9-validation.json) and [independent preflight results](evidence/public-demo-459/independent-v9-preflight.json) retain the exact counts and qualifications. The three baselines are `workbench/baselines/public-demo-{enhance,zooms,grounding}.json`, schema 2, bound to their v9 measurement IDs and effective source `df44d2c0e1dc96f64a24d5b396b4e1d643226a5d9868032a1e294f9ed1247898`. Known failures and all indeterminate counts remain in those bindings. Seven historical rejected bundles in the pinned archive still refuse baseline adoption.

## Archived investigation evidence

The current tree keeps the three complete adopted v9 bundles and their bound baselines. Earlier trials and individual native frames are preserved unchanged in the published tag [`wb/public-demo-459-evidence-20261028`](https://github.com/auberginewly/openscreen-community/tree/04ba1f2a02e465d6ccb9632e2e266e513e04734d), pointing to commit `04ba1f2a02e465d6ccb9632e2e266e513e04734d`. [The archive index](evidence/public-demo-459/archive.json) identifies the paths and seven rejected measurement IDs. This keeps the review focused without rewriting or discarding the original observations.

The archive contains the four initial rejected bundles, three rejected v7 bundles, transport-failure cassettes/attempt ledgers, v4–v6 replay investigation, explicitly unjudged v8 turns and all 78 native sample JPEGs/nine render manifests. Rejected receipts stay rejected; unknown usage and missing responses stay unknown/missing. The old UUID replay failures, the decimal-boundary false failure, truncated judgments and actual failed edits remain documented in [the independent review](public-demo-independent-review.md). The final v9 bundles still retain their own genuine failures, indeterminate checks and judge false positive.

`final-v9-validation.json` and `independent-v9-preflight.json` are original executed records from before packaging was reduced. Their historical seven-bundle results refer to this unchanged archive. The current v9 files and baselines are byte-identical to that snapshot.

To inspect the complete original evidence in a separate checkout:

```sh
git fetch https://github.com/auberginewly/openscreen-community.git \
  refs/tags/wb/public-demo-459-evidence-20261028:refs/tags/wb/public-demo-459-evidence-20261028
git worktree add --detach ../public-demo-459-archive wb/public-demo-459-evidence-20261028
```

No JSON is minified to disguise the diff. The formal manifests and bound baselines retain #653's existing format, including complete source identities; `.gitattributes` marks machine-generated evidence for collapsed GitHub review.

## Reproduction

Use Node **22.22.1** and npm **10.9.4**, then `npm ci`. At this PR's final source identity, these commands use local loopback replay, without provider credentials or upstream requests:

```sh
npm run wb -- workbench/l0/public-demo.wb.ts workbench/l1/public-demo.wb.ts \
  workbench/l0/document-ids.wb.ts workbench/l1/document-ids.wb.ts \
  workbench/l0/chat-budget.wb.ts workbench/l0/transport-policy.wb.ts \
  workbench/l0/cli-bounds.wb.ts workbench/l0/measurements.wb.ts \
  workbench/l1/measurements.wb.ts workbench/l1/cassette.wb.ts \
  workbench/l1/responses-cli.wb.ts
npm run wb:typecheck
baseline_check_dir="$(mktemp -d)"
for scene in enhance zooms grounding; do
  id="public-demo-$scene-deepseek-flash-20261028-v9"
  npm run wb:measurement -- verify --id "$id"
  npm run wb:measurement -- replay --id "$id"
  npm run wb:measurement -- baseline --id "$id" --out "$baseline_check_dir/$scene.json"
  node -e 'const fs=require("node:fs"), a=require("node:assert/strict");
    const [x,y]=process.argv.slice(1).map(p=>JSON.parse(fs.readFileSync(p,"utf8")));
    a.deepStrictEqual(x,y);' \
    "workbench/baselines/public-demo-$scene.json" "$baseline_check_dir/$scene.json"
done
```

A future relevant source change must cause `SOURCE_IDENTITY_MISMATCH`; use the recorded source snapshot to reproduce those measurements, rather than bypassing freshness. Later upstream merges do not retroactively validate old measurements. Historical rejected bundles verify but are not eligible baseline inputs.

To collect **new paid measurements**, configure `OPENSCREEN_WORKBENCH_API_KEY`, `OPENSCREEN_WORKBENCH_BASE_URL` and `OPENSCREEN_WORKBENCH_MODEL` locally in ignored `.env.workbench`. Never paste keys into a PR, log or chat. Use a fresh label and explicit limits:

```sh
npm run wb:live -- --scenario public-demo-enhance --reps 3 --label <fresh-label> \
  --record --max-requests 36 --max-output-tokens 8192 \
  --max-response-bytes 4194304 --timeout 180000
npm run wb:judge -- --scenario public-demo-enhance --label <fresh-label> \
  --record --max-requests 3 --max-output-tokens 4096 \
  --max-response-bytes 4194304 --timeout 60000
```

For zooms/grounding use the corresponding scenario and at most 24 agent requests. Review the actual documents, failed tool calls, check details, judge output and rendering; perform strict full measurement replay in a temporary export before issuing a genuine adoption receipt. Then use existing `wb:measurement export`, `verify`, `replay` and `baseline` commands with a fresh measurement ID and the actual receipt. Do not overwrite an adopted bundle or create a human review on someone's behalf.

### Native visual evidence

The offline `render-public-demo` helper uses each actual persisted `documents.after`, production scene construction/asset resolution and the real native `renderFrames` API. Its output records raw-input, media/sidecar, fixture descriptor, source, native-source/addon, public wallpaper/cursor-asset and JPEG hashes. Frame timestamps are **programme time after trims**, not original media timestamps. It samples 0, 2, 4, 6, 8, 9, 10, 12 and 14 seconds at 25 fps; a shortened programme may yield fewer frames.

The local macOS arm64 addon was built from the current repository with Homebrew FFmpeg, using `cargo build --locked -p compositor-view-napi --release`. It is a development validation binary, not a shipped app or native screen-capture test. Native WebM decoding warns that stream duration is unknown; ffprobe supplies the source duration, but sampled renders do not prove the entire requested stream bound. Hardware/FFmpeg differences may change JPEG bytes across machines. Samples include the page's painted pointer and the compositor cursor overlay; they do not evaluate cursor-rendering fidelity.

```sh
# Build the development addon using your platform's documented FFmpeg setup.
# On the validated macOS machine:
cd crates
MAC_FFMPEG_DIR=/opt/homebrew/opt/ffmpeg cargo build --locked -p compositor-view-napi --release
cd ..
cp crates/target/release/libcompositor_view.dylib workbench/runs/compositor_view.node
npm run wb:build
# Reconstruct a local ignored raw turn from the committed cassette first.
node workbench/.build/cli.cjs replay --scenario public-demo-enhance \
  --cassette workbench/measurements/public-demo-enhance-deepseek-flash-20261028-v9/main-cassette-rep-0.json \
  --label inspect-enhance --timeout 180000
node workbench/.build/render-public-demo.cjs \
  workbench/runs/inspect-enhance/public-demo-enhance/rep-0.json \
  workbench/runs/compositor_view.node workbench/runs/native-review
```

[The immutable native archive](https://github.com/auberginewly/openscreen-community/tree/04ba1f2a02e465d6ccb9632e2e266e513e04734d/workbench/docs/evidence/public-demo-459/final-v9-native) contains 78 actual rendered JPEGs and nine hash manifests: eight programme-time samples per shortened enhancement turn and nine per other turn, plus three contact sheets. The three [contact sheets](evidence/public-demo-459/final-v9-native/) remain in the current tree for a quick visual review. The executing agent inspected all three sheets and individual frames at enhancement rep1/6s, grounding rep1/8s and zooms rep0/9s. They show the comparison focus, the missing sweep zoom and automatic pointer framing respectively. The independent review records its own distinct sampled inspection. This is sampled agent inspection, without a human receipt or a full-video approval.

## Validation and limits

Final checks on Node 22.22.1 / npm 10.9.4, macOS arm64, 2026-10-28:

| Check | Observed result |
| --- | --- |
| App unit suite | 368 files; 5,085 passed, 2 skipped |
| Focused Workbench L0/L1 above | 11 files; 94 passed, 1 existing skip |
| Full Workbench | 581 passed, 66 failed, 1 skipped |
| App/test/Workbench typechecks | Passed |
| `lint:fix` / lint | Passed; 25 existing warnings |
| i18n check | Passed |
| Docs and artifact validation | Three retained bundles verify/replay and bind; seven archived rejected bundles verified and refused adoption; original archive privacy and 78 frame hashes checked; see packaging review |

Of the 66 full-Workbench failures, 65 are `ORIGINAL_FIXTURE_UNAVAILABLE` for the private take. The other is the unchanged editorial orphan-fragment assertion (expected 0.31 seconds, observed 0.45). Neither is made into a skip or counted as new-fixture success. Lifecycle tests use temporary scripted artifacts and test-only receipts; those are separate from the real measurements.

This fixture covers silent browser interaction, zooms and pointer grounding. Narrated enhancement, speech preservation, human annotation review, native/human capture, full video playback, other operating systems and the original private take remain unvalidated. No absent review or unexecuted manual check is represented as passed.
