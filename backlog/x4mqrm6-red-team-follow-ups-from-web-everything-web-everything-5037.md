---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/merge-queue-enqueue.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5037 (head d2aafee3b)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5037 (reviewed head `d2aafee3b4f8047961517655734cea21333fd3ae`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/merge-queue-enqueue.mjs:119` — (edge-case, degraded) Concurrent fast drains can refresh the same stale head more than once.
   - Scenario: Run two --only=42 drains against the same eligible stale merge-gate head and an empty refresh ledger. Single-PR drains bypass the whole-process lease, and the new post-cascade refresh calls are outside the land-write mutex. Both can read the empty ledger before either records success, then independently refresh the same head. A read-only concurrent helper probe reproduced two refresh calls and two rerun requests with only one final ledger entry. If the second process resumes after the first rerun completes, its previously approved decision still requests another rerun despite the recorded atte
   - Claude's re-check: handleQueueRefresh reads the ledger, awaits refreshStalePr, and only then records. The post-cascade calls take no lock or reservation. Two concurrent drains on the same head can both read an empty ledger and both refresh or rerun, so once-per-head is not guaranteed across processes.

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
