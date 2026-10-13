---
bornAs: xhkx845
kind: story
size: 1
status: open
scope: ["we:scripts/lib/pr-snapshot.mjs", "we:scripts/conveyor/review-hold-reconcile.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Shared PR snapshot: flags only, any write decision re-reads the full comment thread

Held finding 216 (2026-10-10). The shared PR snapshot (we:scripts/lib/pr-snapshot.mjs) truncates comments at 100 (#4708 had 120, so the advisory sweep missed the newest advisory; #4826 fixed the sweep, #4938 fixed operator-queue). we:scripts/conveyor/review-hold-reconcile.mjs and any other reader still decide from the cut snapshot. Fix: the snapshot only flags; any write decision re-reads the PR's full thread (pr-comments-complete), as #4826 does for the sweep. Add a test with a 120-comment PR.

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
