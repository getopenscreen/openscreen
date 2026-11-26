# Replay completion plan

Keep existing measured artifacts immutable, with their rejected receipts. New evidence must use a fresh source identity and measurement ID.

1. Instrument the production document `createId` boundary only in Workbench builds/tests. A per-turn AsyncLocalStorage scope observes the actual production generator. No global crypto patch, tool-argument rewriting, prompt changes or shipped application changes.
2. Store a versioned document-ID allocation ledger inside each newly retained cassette. Replay supplies the original exact allocations, validates prefix/order/uniqueness and collisions with input IDs, and requires full consumption. Request hashes, source/input checks and real wrong-ID failures remain strict.
3. Cover create-then-update record/replay, missing/corrupted/unused allocations, wrong model IDs and concurrent scopes with offline regressions. Preserve legacy cassette parsing; old evidence is not retroactively repaired.
4. Correct false spatial results for automatic pointer following: retain such spatial checks as indeterminate, with manual/auto and mixed-coverage controls. Inspect actual edited documents and production-compositor samples before evidence approval. A quantitative full-trajectory oracle remains outside this change.
5. Diagnose transport failures from recorded admission/forward/response evidence. Use separate bounded live invocations, retain failures, then judge and independently review final-source evidence.
6. Only after actual strict replay passes, issue genuine approval receipts and generate/verify bound baselines. Run required checks, update the existing draft PR and report remaining limitations without claiming validation of the private take.

## Executed outcome, 2026-10-28

Steps 1–3 were implemented prospectively with strict ID-allocation ledgers; historic missing ledgers were not reconstructed. Interrupted turns retain actual observed edits while remaining failed. Step 4 explicitly preserves automatic spatial uncertainty, rather than claiming a new quantitative rendering oracle. The inclusive 0.15 manual boundary has positive and negative floating-point controls.

After synchronizing upstream main `06bd7f2e`, final source `d1e2d9a4` recorded nine normally completed real `deepseek-flash` turns and nine judge requests under `public-demo-final-v9`. All three full strict preflights and final official export/verify/replay/baseline commands passed, with schema-2 baseline bindings verified. Independent receipts followed actual document, judge, usage/hash and native-frame inspection. Known model failures, automatic indeterminate results and a documented judge false positive remain intact. Prior rejected and superseded/unjudged evidence is retained unchanged in the published archive tag at commit `04ba1f2a`; the final tree keeps only adopted v9 datasets and necessary review records.

See [final results and commands](public-demo-459.md) and [the independent reviewer's actual record](public-demo-independent-review.md). Narrated/speech quality, human annotation review, full automatic trajectories and the private take remain unvalidated. This plan does not claim issue closure.
