# Replay completion plan

Keep existing measured artifacts immutable, with their rejected receipts. New evidence must use a fresh source identity and measurement ID.

1. Instrument the production document `createId` boundary only in Workbench builds/tests. A per-turn AsyncLocalStorage scope observes the actual production generator. No global crypto patch, tool-argument rewriting, prompt changes or shipped application changes.
2. Store a versioned document-ID allocation ledger inside each newly retained cassette. Replay supplies the original exact allocations, validates prefix/order/uniqueness and collisions with input IDs, and requires full consumption. Request hashes, source/input checks and real wrong-ID failures remain strict.
3. Cover create-then-update record/replay, missing/corrupted/unused allocations, wrong model IDs and concurrent scopes with offline regressions. Preserve legacy cassette parsing; old evidence is not retroactively repaired.
4. Correct public-demo spatial assertions for actual automatic pointer following using production cursor data and timing, with manual and auto negative controls. Check actual edited documents and rendered evidence before approval.
5. Diagnose transport failures from recorded admission/forward/response evidence. Use separate bounded live invocations, retain failures, then judge and independently review final-source evidence.
6. Only after actual strict replay passes, issue genuine approval receipts and generate/verify bound baselines. Run required checks, update the existing draft PR and report remaining limitations without claiming validation of the private take.
