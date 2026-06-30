# Git Workflow for OpenScreen

Conventions for the Mavis reins when working in this repo.

## Branches

- Default branch: `main`. Never push to it directly.
- Feature branches: `feature/<short-kebab>` or `fix/<short-kebab>`. Match the style of recent merged PRs.
- One PR = one concern. Don't bundle a refactor with a feature.

## Commits

- Short imperative summary line (≤72 chars). Optional body explaining the why.
- Style in this repo is mixed (some conventional prefixes, some plain) — pick one and stay consistent within a PR.
- Husky pre-commit runs lint-staged (Biome on staged `*.{ts,tsx,js,jsx,mts,cts,json}`). Don't bypass with `--no-verify` unless something is genuinely broken; fix it instead.

## Hooks (Mavis)

- Pre-commit (`.harness/hooks/pre-commit.md`) — runs Biome + the affected unit test files. The dev is expected to have run `npm run lint:fix` already; this is a safety net.
- Post-commit (`.harness/hooks/post-commit.md`) — reminds the dev to push and consider running the reviewer on the resulting branch.

## CI (`.github/workflows/ci.yml`)

CI runs on every PR to `main` and every push to `main`:
- `npm run lint` (Biome)
- `npx tsc --noEmit` (TypeScript)
- `npm run test` (Vitest unit)
- `npm run test:browser` (Vitest + Playwright headless)
- `npx vite build` (renderer build smoke)

All five must be green before merge. Native helper code is NOT covered by CI — manual smoke test is required for `electron/*-helper/` changes; note it in the PR description.

## Pull request flow

1. Branch from `main`.
2. Implement + add tests in the same package.
3. Run locally: `npm run lint && npx tsc --noEmit && npm run test`. For browser/e2e-touching changes, also run the relevant suite.
4. Push and open the PR via `gh pr create`. Use `.github/pull_request_template.md`.
5. Wait for the Mavis reviewer (`openscreen-reviewer`) PASS or address the requested changes.
6. Merge once CI is green and review is PASS. PR titles must follow Conventional Commits (enforced by the `semantic-pr` job in `ci.yml`) — this keeps the auto-generated release notes clean.

## Release flow

Two `workflow_dispatch` workflows cut a release. Both run on `main` directly (trunk-based, no `next` branch). Both require the `OPENSCREEN_RELEASE_TOKEN` secret — see `docs/secrets.md`.

### Step 1: cut a release candidate

`Actions` → `Cut a release candidate` → `Run workflow`.

- `bump`: `patch | minor | major` (default `minor`)
- `rc_number`: integer, default `1` (use `.2`, `.3`, … for subsequent RCs)
- `target_version` (optional): override the auto-computed next version (e.g. `2.0.0` when bumping straight to a major)

The workflow:

1. Computes the next SemVer from `package.json` + `bump`, builds `vX.Y.Z-rc.N`.
2. Migrates every issue/PR in the rolling `Next Release` milestone into a fresh `vX.Y.Z` milestone. Each migrated item gets a hidden marker comment so re-running is idempotent.
3. Commits `package.json` → `X.Y.Z-rc.N` to `main`.
4. Pushes the tag `vX.Y.Z-rc.N`. This triggers `build.yml`, which publishes a **GitHub pre-release** (badged as such, does not become "Latest"). macOS notarization is skipped on RC tags.
5. Posts in `#rc-testing` on Discord with the download link.

Tier 3 (homebrew/winget/nix/aur) does **not** run on pre-releases — they're already gated on `!prerelease`.

### Step 2: announce and QA

Pin the pre-release link in `#rc-testing`. Get the maintainer team + a few early adopters to install and smoke-test.

If the RC has a regression, fix forward on `main` and re-cut as `vX.Y.Z-rc.(N+1)`. The previous RC is auto-superseded by GitHub.

### Step 3: promote to stable

`Actions` → `Promote RC to stable release` → `Run workflow`.

- `rc_tag`: e.g. `v1.5.0-rc.2`
- `release_notes_extra` (optional): a one-paragraph note that gets prepended to the auto-generated release notes

The workflow:

1. Validates the tag matches `^vX.Y.Z-(rc|beta|alpha)\.N$`.
2. Closes the `vX.Y.Z` milestone (snapshotting it for the release notes).
3. Strips `-rc.N` from `package.json`.
4. Pushes the tag `vX.Y.Z`. This triggers `build.yml` (full notarization) and the `release: published` event — which now fires Tier 3 (homebrew/winget/nix/aur) thanks to `OPENSCREEN_RELEASE_TOKEN`.
5. Posts in `#announcements` on Discord with the release notes + a "Closed issues in this release" list pulled from the milestone.

### Manual fallback (emergency)

If the dispatch UI is unavailable, the same flow works from a shell:

```bash
# Cut RC (skips milestone migration and Discord announce)
git tag v1.5.0-rc.1 <sha-of-main>
git push origin v1.5.0-rc.1

# Promote (skips milestone close and Discord announce)
git tag v1.5.0 <sha-of-main>
git push origin v1.5.0
```

The pipeline can't tell the difference between a manually-pushed tag and a workflow-pushed one — same `build.yml` runs either way.

### Backports / patch on a previous line

For a `v1.4.2` while `v1.5.0` is in flight:

1. Branch `release/1.4.x` from the `v1.4.0` (or `v1.4.1`) tag.
2. Cherry-pick the fix commits.
3. Push the branch, then `git tag v1.4.2-rc.1` on the branch tip.
4. `git push origin release/1.4.x v1.4.2-rc.1` — `build.yml` works from any branch.

No new workflow code is needed; the tag-pushed trigger is branch-agnostic.

### Issue tracking during a release cycle

- **Daily state**: issues/PRs accumulate in the rolling `Next Release` milestone. `merged-pr-bookkeeping.yml` adds them automatically on PR merge; maintainers can also drag issues in by hand.
- **At RC cut**: `prerelease.yml` snapshots `Next Release` into a versioned `vX.Y.Z` milestone. The rolling milestone is left open and empty for new work.
- **Between RC cut and promote**: any PR that merges during the RC window lands back in the empty `Next Release`. It is **not** retroactively added to `vX.Y.Z`. If a critical fix lands, cut `vX.Y.Z-rc.(N+1)` instead of promoting.
- **At promote**: `promote.yml` closes the `vX.Y.Z` milestone and uses its closed issues to populate the Discord release announcement.
