---
bornAs: xjq7c5z
kind: story
size: 3
status: open
scope: ["we:scripts/operations/gh-etag-prune.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# gh-etag eviction residuals (#6846) and register gh-etag-prune in we:run.mjs

#6846 residuals: per-file lstat errors are treated as vanished (an incomplete scan is stamped success); stamp-write symlink race after lstat; the evicted-cache test never asserts the cached answer. Also register gh-etag-prune in we:run.mjs after #6844 lands.

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
