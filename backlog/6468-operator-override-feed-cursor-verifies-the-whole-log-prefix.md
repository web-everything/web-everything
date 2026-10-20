---
bornAs: xxouunn
kind: story
size: 2
status: open
scope: ["we:backlog/6266-we-operator-override-slice-1-host-wide-store-and-operator-on.md", "we:backlog/6269-we-operator-override-slice-3-guard-floor-confirm-and-flag-on.md"]
dateOpened: "2026-10-18"
tags: []
---

# Operator-override feed cursor verifies the whole log prefix, not only its final record (slice 1 of PR 5549, card 6266)

[A1] Executable. Priority: expedite (before public-preview). Red-team break (security, broken) on PR #5549 head 71839eec, card 6266 line 35: the cursor checks only position, entryId and hash of its final record. Scenario: feed consumed log [A, R] and saved a cursor for R. An actor with direct store-write replaces A with equal-length B and removes the appended B, giving [B, R] with a matching snapshot. A daemon reads B while active, B expires before the next poll, and R still matches the saved cursor, so the rewrite check passes and the earlier rewrite is hidden: no attention event is published for the loosening. Fix in the 6266 card text: bind the cursor to the whole prefix (a running hash chain or prefix digest) so any earlier rewrite fails the check; add a named log-rewrite-before-cursor test. Also name the fail-closed tests from referral 6269:21 (unreadable table treated as loosening, snapshot that cannot be checked is ignored whole, expiry of a confirmation, snapshot never replaces the log's confirmation) against card 6269.

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
