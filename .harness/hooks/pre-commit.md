---
name: pre-commit
event: pre-commit
type: gate
---

# Pre-commit gate for OpenScreen

Runs on every `git commit` in this repo. Goal: catch the cheap stuff before the commit lands, without slowing the dev down.

## What it does

1. **Biome check (lint + format)** on staged `*.{ts,tsx,js,jsx,mts,cts,json}` files. Uses the same scope as `lint-staged` in `package.json`.
2. **TypeScript** — `npx tsc --noEmit` for the whole project. Cheap on this codebase, catches type errors that Biome misses.
3. **Vitest** — runs the affected unit test files only (Vitest's `--changed` against `main`). Skipped automatically if no tests are affected.

## What it does NOT do

- It does NOT run the full Vitest suite, the browser tests, the e2e tests, or any native helper test. Those are too slow for a pre-commit gate and belong to CI.
- It does NOT modify files. If Biome wants to reformat, the dev runs `npm run lint:fix` themselves.

## Pass criteria

All three steps exit 0. The commit proceeds.

## Fail behavior

The commit is blocked. The hook prints the failing step's output. The dev fixes and re-stages.

## Notes

- This hook is layered on top of the existing Husky `pre-commit` (lint-staged). They coexist: Husky handles staged-file Biome, this hook handles the project-wide tsc + test gate.
- Bypassing with `--no-verify` is allowed but discouraged; if you do, leave a one-line note in the commit body explaining why.
