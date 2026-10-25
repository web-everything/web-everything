---
kind: task
status: open
scope: ["we:scripts/lib/pr-comment-read-guard.mjs", "we:scripts/pr-comment-read-baseline.json"]
dateOpened: "2026-10-25"
tags: []
---

# gh comment reads page and bound their buffer (ENOBUFS on long PRs)

2026-10-25 02:44 ET: `gh pr view --json comments` blows the 1 MiB spawnSync buffer on long PRs (ENOBUFS, empty stderr) and surfaces as an opaque 'comment error'. Audit every gh comment read for maxBuffer and paging, and make pr-comment-read-guard require paging.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
