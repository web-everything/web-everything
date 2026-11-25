---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/drain-blocked-reason.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [theoretical-race] from web-everything/web-everything#7485 (head 7b1fd4daf)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7485 (reviewed head `7b1fd4daf7eb19c105d85ea9aed5c05fe6fff832`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/drain-blocked-reason.mjs:147` — (edge-case, degraded) The new comment read can outlive the ledger lock and defeat send-back deduplication.
   - Scenario: Writer A holds the shared ledger lock while reading comments for PR 7196. The new default reader permits a 300-second paginated read followed by a 60-second count read, exceeding the lock’s five-minute expiry. While A remains blocked, writer B reaps its lock, retries, sends PR 7197 back, and records that head. A then resumes with no clearing verdict and writes its previously loaded ledger, deleting B’s entry. A subsequent call sends PR 7197 back again. Exclusive ownership and both ledger entries should survive.
   - Class: theoretical-race (basis: Reproduced the lost entry and duplicate writer invocation using the production module with an in-memory filesystem, injected clock, and interleaved calls. Actual occurrence requires overlapping callers sharing the ledger and sufficiently slow comment reads; the outer drain lease serializes common invocations, and no live concurrent drain failure was observed.)
   - Claude's re-check: demonstrated break

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
