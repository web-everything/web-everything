---
bornAs: xn27six
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# already-done refresh checks 2 items per tick with one GraphQL search each

[held entry 318] (daemon-async-audit 2026-10-14, held) already-done refresh checks 2 items per tick with one GraphQL search each. 576 searches/day across 2,352 items, so a full pass takes ~4 days (median item last checked 82 h ago); 77 rate-limit errors, 40 timeouts. health-watch probeMergedPrs separately re-reads 800 merged PRs. Fix idea: one incremental merged-PR read per tick from a saved cursor, matched against all items locally (filterAlreadyDoneCandidates), shared with health-watch. Design: shared incremental cache. Evidence: we:wev-control/.conveyor/already-done-cache.json.refresh.log; we:already-done-refresh.mjs:116-131, we:gh-metered-reads.mjs:27. Size 3.

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
