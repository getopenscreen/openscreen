# What merges alone, and how this repo merges

## A PR may merge alone (`pr.auto: true`)

It applies to every author, contributors included, judged on the head you read. A PR merges alone
only when it is one of these:

- a bug fix;
- a translation into a language other than English;
- documentation;
- tests;
- maintenance.

It never merges alone when it is:

- a feature;
- a change of UI or UX;
- an architecture choice;
- an impact on pixels, rendering or performance that a proof has not ruled out.

**A bug** is behavior that contradicts what is expected or documented: a crash, a desync, a wrong
export. A new setting, an interface text, a default value or a new visible behavior is a feature.

The locks file adds what the server checks alone:

- the supply-chain paths (CI, scripts, dependencies, packaging) never merge alone;
- at most 300 changed lines and 15 files, tests and documentation excluded.

## Rendering and performance need a proof

Preview and export share one source of truth for rendering: what you see is what you export.

A change to capture, preview, compositor, export or rendering needs a proof of no impact:

- a pixel-identical export of the reference project;
- export time and preview frame rate within ±5 % of the base, measured in the real app, heavy case
  included;
- a preview and an export of the same instant, compared at the preview's size: they show the same
  effects, with the same composition and the same timing. They need not match pixel for pixel.

The locks file names the zones. Elsewhere, set `pr.evidence.needed: true` yourself when the change can
reach the picture or its timing. A worker other than the judge makes the proof and records it.

Performance comes first. A correctness fix that costs latency is split in two:

- the part that costs nothing goes on its own;
- the rest goes to the owner as an explicit trade-off, on a card.

## Rebase only

- **This repo merges by rebase only, with no merge commits and no squash.**
- **Conflicts are fixed by rebasing on the base, never by a merge commit.** With a merge commit, GitHub
  still calls the PR mergeable, but it cannot rebase it. Check the REST field `rebaseable`, not
  `mergeable`.
- **During a train of merges, `rebaseable` can be stale.** Rebase on main, push, and wait for CI.
- **Merge first the PRs that touch shared files**, such as the end-to-end checklist and the locales.

## No closing keyword in a commit

- **A rebase merge replays every commit.** A `Fixes #N` in a commit closes the issue, even when the PR
  only says "Part of #N".
- **Closing keywords** (`Fixes`, `Closes`, `Resolves`) belong in the PR's description only, and only
  when the PR completes the issue. Agents write `Refs #N`.
- **Before a partial fix merges**, read its commit messages.

## Checks

- **The Nix build is not a merge gate**: the locks file ignores it.
- **CodeRabbit is required.** When its review is cancelled or skipped (it reviews at most 8 PRs an
  hour here), comment `@coderabbitai review` on the PR, then wait for its review. If that request is
  skipped too, ask once more an hour later; if the second one is skipped as well, the PR goes to the
  owner on a card. Never more than two requests per head.
- **Do not trust the CI rollup on a fork's PR.** Its workflows wait for an approval, while the Discord
  sync and CodeRabbit pass without one, so the rollup can read green when no real job ran. Judge from
  the CI workflow's own run on the head.

## Features run on the three systems

- **A feature must work on macOS, Windows and Linux.** A feature PR limited to one system is not merged.
- **Before you propose to merge a feature, check the three systems.** If one is missing, comment to
  ask the contributor for the port and a short end-to-end video per system (a real capture and an
  export).
