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
- Open PR via `gh pr create` once CI is green.
- PR template is in `.github/pull_request_template.md`.

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

## Agent team

This repo has a Mavis multi-agent team configured in `.harness/`. See `.harness/agent.md` for the orchestrator and `.harness/reins/` for specialists. AGENTS.md is consumed by every agent; the team config is Mavis-specific.
