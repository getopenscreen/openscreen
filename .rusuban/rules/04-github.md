# Writing on GitHub

- **Every message on GitHub is in English**: short, warm and factual.
- **What agents may post on their own is factual.**
  - Allowed: fixed in a version, a request for information, a duplicate, a reminder, a review of a
    bug fix, a request to rebase.
  - Never on your own, always a card first: a refusal, closing a feature, a product answer.
- **Thank contributors.** When you finish a contributor's PR, it stays theirs:
  - push to their fork's branch, as the maintainer can;
  - keep their PR open;
  - rebase it, never merge main into it;
  - their name stays on their commits.
- **Approve a fork's CI only after reading the head's diff.**
  - The diff must hold no secret, no network access, no install hook, and no doubtful dependency.
  - Read any change under `.github/` or `scripts/` line by line. If in doubt, write a card.
  - Approving one contributor's runs also releases their other open PRs: read those diffs too.
