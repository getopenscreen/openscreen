# AGENTS.md

OpenScreen is a free, open-source screen recorder and video editor (Electron + React + TypeScript + Pixi.js) maintained as a continuation of the original v1.5.0 release. This file is the canonical guide for any AI coding agent working in this repo.

## Setup commands

- Install deps: `npm install` (Node 22.22.1, npm 10.9.4 — see `package.json#engines`)
- Start dev:    `npm run dev` (Vite dev server; Electron window opens via `vite-plugin-electron`)
- Build:        `npm run build` (TypeScript check + Vite build + electron-builder)
- Typecheck:    `npx tsc --noEmit` (CI runs this; no standalone script)
- Test (unit):  `npm run test` (Vitest, jsdom env)
- Test (browser): `npm run test:browser` (Vitest + Playwright, requires `npm run test:browser:install` first)
- Test (e2e):   `npm run test:e2e` (Playwright)
- Lint:         `npm run lint` (Biome 2.4)
- Format:       `npm run format` (Biome, tabs, double quotes, 100-col)
- i18n check:   `npm run i18n:check` (validates the 13 locale files)

## Project layout

- `src/` — React app: UI, editor components, timeline, i18n, captioning/cursor/exporter libs
- `electron/` — main process, IPC, recording orchestration
- `electron/native/` — **native** capture helpers: `screencapturekit/` (Swift, macOS) and `wgc-capture/` (C++/Win32, Windows). These are built and shipped with the app, not loaded from npm
- `docs/` — architecture, engineering roadmaps, testing guides
- `tests/` — Playwright e2e specs + fixtures
- `scripts/` — native build scripts, diagnostic tools
- `nix/`, `flake.nix` — Linux packaging
- `release/`, `dist-electron/` — build artifacts (gitignored)

## Code style

- TypeScript strict mode (`tsconfig.json`). No `any` (Biome `noExplicitAny` is `warn` — don't add new `any`).
- Biome handles lint AND format. Tabs, double quotes, 100-col width, LF line endings. Run `npm run lint:fix` before committing.
- React functional components only. Hooks at top level (Biome `useHookAtTopLevel` is `error`).
- Imports: use the `useImportType` discipline (Biome organizes them).
- Husky + lint-staged runs Biome on staged `*.{ts,tsx,js,jsx,mts,cts,json}`.
- The repo is pre-1.x and not production-grade — rough edges are expected, but new code should be clean.

## Testing instructions

- Unit tests live next to source as `*.test.ts` / `*.test.tsx` (Vitest, jsdom).
- Browser tests use `vitest.browser.config.ts` (Playwright headless) — only run when DOM/Pixi rendering matters.
- E2E tests are in `tests/e2e/` (Playwright). Some specs are platform-specific (e.g. `windows-native-checklist.spec.ts`).
- Add a test for every new behavior in the same package as the code under test.
- All tests must pass before opening a PR. CI runs `npm run test` and `npm run test:browser` on every PR.

## PR & commit conventions

- Branch from `main`; never push to it directly.
- Commit messages: short imperative summary, optional body. Recent style mixes conventional-ish prefixes (`ci:`, `chore:`, `fix:`) with plain messages — either is fine, just be consistent within a PR.
- **PR titles must follow Conventional Commits** (`feat:`, `fix:`, `chore:`, `refactor:`, `perf:`, `docs:`, `test:`, `build:`, `ci:`, `style:`, `revert:`). Enforced by the `semantic-pr` job in `ci.yml`. This feeds GitHub's auto-generated release notes with clean categories.
- Open PR via `gh pr create` once CI is green.
- PR template is in `.github/pull_request_template.md`.

## Release flow

Two `workflow_dispatch` workflows cut a release with a pre-release candidate (RC) first, then promote to stable. Trunk-based, no extra branch. Full operational guide in `.harness/docs/git-workflow.md` § Release flow.

- **Cut RC**: Actions → "Cut a release candidate" → Run workflow. Inputs: `bump` (patch|minor|major), `rc_number` (default 1), optional `target_version` override. Snaps issues out of the rolling `Next Release` milestone into a versioned `vX.Y.Z` milestone, bumps `package.json`, pushes the `vX.Y.Z-rc.N` tag, which triggers the existing `build.yml` to publish a GitHub pre-release. Notarization is skipped on RCs. Notifies `#rc-testing` on Discord.
- **Promote RC**: Actions → "Promote RC to stable release" → Run workflow. Input: `rc_tag` (e.g. `v1.5.0-rc.2`), optional `release_notes_extra`. Closes the `vX.Y.Z` milestone, strips `-rc.N` from `package.json`, pushes `vX.Y.Z` tag, which triggers `build.yml` to publish a stable release (full notarization, Tier 3 homebrew/winget/nix/aur fires). Notifies `#announcements` on Discord.
- **Manual fallback**: `git tag vX.Y.Z-rc.N <sha> && git push origin vX.Y.Z-rc.N` does the same as Cut RC (minus the milestone migration and Discord announce) — useful for emergency cuts.

Both workflows require the `OPENSCREEN_RELEASE_TOKEN` secret (a fine-grained PAT with `contents: write` + `issues: write`). This is the standard fix for `release: published` not triggering downstream workflows when the release is created by `GITHUB_TOKEN`. See `docs/secrets.md`.

**Release branches freeze the build between cut and promote.** Every RC cut creates `release/vX.Y.Z-rc.N`. The branch is *not* merged into `main` until the stable tag is published; only cherry-picks of bugfixes land on the release branch during the RC window. The stable tag points at the branch tip (RC + cherry-picks), then `promote.yml` opens a `release/vX.Y.Z-sync → main` PR to bring main into line. This contract exists because of the v1.6.0 incident (2026-07-05) where the original promote workflow tagged `main` instead of the RC snapshot, causing 23 unreleased commits to ship in `v1.6.0`. Full rules in `.harness/docs/git-workflow.md` § Release branches.

## Security

- Never commit secrets. `.env.example` exists; real `.env` is gitignored.
- `macos.entitlements` controls macOS permissions — review when touching native recorder.
- Native helpers run with elevated privileges on user systems; treat code in `electron/*-helper/` as security-sensitive.

## Specialized notes

- **Native capture is platform-fragile**: macOS uses ScreenCaptureKit (Swift), Windows uses WGC (C++/Win32). CI runs on Linux only — manual smoke test on real macOS/Windows is required for native changes.
- **Pixi.js v8** is the rendering engine. Filters come from `pixi-filters` and `@pixi/filter-drop-shadow`. GSAP + `motion` for animation.
- **i18n**: 13 locales in `src/i18n/locales/<locale>/` (e.g. `src/i18n/locales/en/settings.json`). The `i18n:check` script validates them — run it after touching translation files.
- **Build pipeline**: `npm run build` is full electron-builder. For iterating on renderer only, use `npm run build-vite` (Vite + tsc, no packaging).
- **README tone**: the project is explicitly "not production-grade" and free forever — don't add paywalls, premium tiers, or upsell language to UI/copy.
