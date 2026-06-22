---
name: post-commit
event: post-commit
type: reminder
---

# Post-commit reminder for OpenScreen

Runs after every successful `git commit`. Goal: nudge the dev toward the next step without blocking.

## What it does

Prints a single reminder line summarizing:

- Number of commits ahead of `main` on the current branch.
- Whether the current branch has been pushed (`git status` reports `Your branch is up to date with 'origin/<branch>'` if pushed).
- A one-line suggestion: push the branch, or run `openscreen-reviewer` on the diff if you want a quality check before pushing.

## What it does NOT do

- It does NOT push automatically. The dev pushes explicitly.
- It does NOT spawn a reviewer automatically. Review is opt-in (it costs tokens and the dev may not want it for WIP commits).
- It does NOT block. If `git status` can't be read, the reminder is skipped silently.

## Notes

- This is intentionally lightweight — a single line of context, not a wall of text. The dev already knows what they just committed.
- If you want a deeper post-commit check (e.g. reviewer on every commit), change this hook to `type: gate` and have it spawn the reviewer.
