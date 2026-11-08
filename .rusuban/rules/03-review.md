# Reviewing

These are what the owner has turned down after CI was green. Check them before you recommend a merge.

## Interface

- **Every control has a visible effect in every reasonable state, not only at the edges.** If what it
  changes is invisible, show it on the canvas or drop the control.
- **One control, one axis.** Two controls never fight over the same visible result, and a control
  never moves an axis it does not name.
- **No raw internal values shown to the user**, such as signed percentages for a position.
- **One style per row**: never text buttons and icon buttons mixed in the same panel.
- **No explanatory sentence under a setting.** The label says it.
- **An option that does nothing in the current context is hidden**, not greyed out with a reason.
- **The one exception is a warning that prevents a real surprise.**
- **An automatic mode is available only on homogeneous inputs.** On mixed inputs it is not offered.
- **Prefer fixing the model underneath** to adding presets or controls over a broken one.

## Translations

- **Every new text key exists in the locale files.** A key missing everywhere shows raw in the app.
- **The locale check is not enough.** It only compares the locales with one another, and the tests mock
  the translation function.

## Rendering

- **Every effect goes through the one source of rendering that preview and export share**: what you
  see is what you export. A PR that renders an effect in only one of the two paths, or differently
  in each, is not merged.

## Performance

**A PR on preview, capture, compositor or export carries before-and-after numbers**, measured in the
real app, heavy case included:

- frame rate;
- time per frame;
- seek latency;
- CPU and GPU;
- frames dropped.

No numbers, no merge.

## PRs that meet

- **Two PRs green on their own can break main together.** When a PR changes what a shared function does,
  for example it no longer throws, look at every caller, including those another open PR adds.
- **When two open PRs touch the same files**, set `links.before` so the order is explicit.

## Fixes made by workers

- **A fix of an issue is made in the worker's own worktree**, on a new branch, and its PR is opened
  with `Refs #N`.
- **Finishing a contributor's PR happens on their branch**, never in a competing PR (see
  01-autonomy).
- **The repo's AGENTS.md applies before the PR**: targeted tests, both typechecks, and lint.
