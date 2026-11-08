# What the agents do alone, and what comes to the owner

The owner is @EtienneLescot. Every card goes to the owner.

## Alone

The agents act alone on everything that is not a product or architecture decision:

- fix a bug, and merge a PR that is not a feature once its gates are green (see 02-merging);
- approve a fork's CI after reading the diff;
- ask for a rebase, a fix or missing information;
- close a duplicate, an item that was replaced, or one that came due.

## To the owner, always with a card

- A feature, issue or PR.
- A change of UI or UX: visible English text, style, layout, a default value, a setting.
- An architecture choice: a new module, a new dependency, a new IPC or API surface, a data format.
- An impact on pixels, rendering or performance that no proof has ruled out.
- A refusal: declining a PR, closing a feature request, or answering a product question.

## Issues

- **A bug that can be reproduced and is documented enough**: the agents own it, and a worker fixes it.
- **A bug without enough information**: it waits on its reporter (`owner: "third"`, `waits: "@login"`).
  Post one factual question.
- **A product, UI or architecture request**: to the owner, with a card.
- **A duplicate**: set `links.duplicateOf`, post a factual comment and close it.

## Waiting on a third party: two days at most

An item that waits on someone (a reporter, an author, a contributor, a merge, a release) comes back
two days later (`revisitAt`). Read the thread first: if they answered in the last two days, take the
answer in and judge again. Otherwise, move on without them.

- **A bug fix or a consolidation** (bug, maintenance, cleanup, robustness, translation): the agents
  own it, and a worker moves it forward.
  - An issue: fix it from what is known (the thread, logs, the code, a reproduction on a machine the
    agents can reach) and open the PR.
  - A contributor's PR: finish it in their place, on their fork's branch, without closing their PR
    (rebase, fixes, review threads). They keep the credit.
    - If their fork refuses maintainer edits, ask them to allow them. Without an answer in two days,
      carry their commits to a new PR from a fork under your account whose Actions stay disabled,
      never from a branch of this repo: a branch here runs its workflows in the repo's trusted
      context, where secrets can reach them; a fork's PR never runs its code with secrets or a
      write token. Their name stays on their commits:
      - read every commit first. One that touches `.github/`, `scripts/` or the build goes to the
        owner on a card;
      - link the two PRs, and say so on theirs. When theirs would close an issue, the new PR's
        description carries its closing reference;
      - before the new PR merges, read their PR's head again and bring in what they pushed since.
        Once it merged, compare their head with the last one you carried: anything newer goes into
        a follow-up PR. If the issue the new PR closed is not complete without it, reopen it. The
        follow-up's description carries its closing reference only when it completes the issue, and
        `Refs #N` otherwise, `Refs owner/repo#N` for an issue in another repo.
  - A wait on a merge or a release: check whether it happened, then close the item or push what
    blocks it.
  - Close only when the code gives no lead and no machine reproduces it, with a factual comment that
    invites a reopen with the missing information.
- **A new feature**, issue or PR: to the owner, with a card that presents it as it is: what is done,
  what is missing. Offer actions you will take: merge it as it is, finish it yourself, keep it open as
  "help wanted", or close it.

Never hand a two-day wait back to the third party without a recent answer from them: that would be a
silent wait.

## Nothing stays with the agents without work

An item the agents own comes back after one day at most (`revisitAt`). With no work in progress,
delegate it to a worker, hand it to a named third party, or bring it to the owner with a card.

## Priority

- **P0**: a crash, lost data, or a recording or an export that fails, in a released version.
- **P1**: a core flow degraded (capture, preview, editing, export), or a regression.
- **P2**: any other bug, and maintenance.
- **P3**: cosmetic, and nice to have.

## Areas

`capture`, `preview`, `export`, `editor`, `ai`, `mcp`, `i18n`, `packaging`, `tooling`, `storage`,
`webcam`, `audio`.
