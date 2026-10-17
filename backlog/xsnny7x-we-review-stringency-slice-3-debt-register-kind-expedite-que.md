---
kind: story
size: 8
parent: "xrlwbd7"
status: open
blockedBy: ["x77cl1h"]
dateOpened: "2026-10-17"
tags: []
---

# we: review stringency slice 3 — debt register (kind, expedite queue position, level gate)

Add backlog kind debt with its size and buildable rules and every kind-set reference in the same slice, the expedite queue position and deadline, and the level gate that blocks a move while due debt is open. Ruled in xugqjw1.

## Acceptance

- [A1] **Executable** — registration test `debt-kind-registration` checks the debt size rule, buildable rule and agreement of every kind-set consumer in one slice; if they cannot ship together, exercise the ratified task-plus-debt-fields fallback through the same gate tests.
- [A2] **Executable** — integration test `expedite-deadline-escalation` uses a controlled clock: an expedite ruling lets the PR land, puts its card at the top of the build queue, and assigns the configured deadline (initially 72 hours). Before the deadline it is not overdue; once past it, the item reaches the operator's needs-you feed (one row per class), counts as debt due now at the current level, and blocks a level move. Repeated checks neither auto-extend the deadline nor duplicate feed rows.
- [A3] **Executable** — clock-driven test `debt-staleness-resurface` keeps unpaid debt open across the 45-day staleness threshold: it is not resurfaced early, resurfaces when the threshold is reached, retains its must-pay-before level, and cannot expire or disappear from the register; paid debt does not resurface.
- [A4] **Executable** — level-write and gate integration test `level-edit-authority` rejects agent changes to the current level and to a debt item's must-pay-before level, leaving the stored levels and gate result unchanged. With due debt open, an operator's attempted level move still blocks; paying the debt or the operator's recorded edit of its must-pay-before level permits the move, with operator identity and old/new levels recorded.
- [A5] **Executable** — gate integration test `due-debt-gates-level` refuses a move with unpaid debt due at or below the target level, including a skipped intermediate level, and permits it after a verified payment or an authenticated operator edit moving its due level beyond the target.
- [A6] **Executable** — writer and protected CI integration test `debt-item-tamper` compares the complete trusted base inventory to the candidate tree before any kind/status filtering. Agent deletion, rename, kind change, resolved-status change, class/severity/confidence change, deadline edit or removal, due-level edit, source edit, and forged payment receipt refuse and leave the debt effective at the gate. The task-plus-debt-fields fallback gets the same cases. Ordinary fix work may be proposed by an agent; payment becomes effective only when protected CI independently verifies a landed fix and passing validation tied to the debt id, source finding and exact fixed revision. A status string or operator claim alone is never payment.
- [A7] **Executable** — authority integration test `debt-approval-provenance` uses slice 2 A10's protected CI authenticated GitHub review actor and protected operator allowlist, bound to exact repository/base/head/diff. Forged, absent, stale and replayed approvals cannot change due level, deadline or current level; a verified operator due-level edit is recorded and a verified deadline extension updates the overdue calculation. No actor may delete or reclassify debt to bypass payment.
- [A8] **Executable** — register test `debt-source-required` refuses missing, malformed or mismatched source repository, PR and stable finding id; a valid entry retains these alongside class, impact, severity, confidence, must-pay-before level, deadline (explicitly absent for ordinary debt), fix cost and interest. Display text is stored as data and confers no authority.
- [A9] **Executable** — gate integration test `debt-register-unreadable` supplies a missing, unreadable, truncated, paginated-incomplete or malformed register/base inventory or validation receipt and observes a blocked move, never an empty-debt success.
- [A10] **Executable** — integration test `debt-gate-revision-race` races a payment, operator due-level edit and level move; the move re-reads validated debt and settings under a revision lock and retries on change. A crash before atomic persistence keeps the prior debt effective; an expired writer cannot overwrite a newer revision.

Ruling and amended table: [we:backlog/xugqjw1](/backlog/xugqjw1-decision-review-stringency-classified-findings-per-level-out/) and the statute `we:docs/agent/platform-decisions.md#review-stringency-classified-outcomes`.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] No unrecorded waiver, automatic deadline extension, debt expiry or status-only payment. The panel is slice 4 and lessons are slice 5.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — source and finding text are data; forged fields and payment claims cannot bypass the gate (A6–A8).
2. **Truncated reads** — incomplete inventory or receipt blocks rather than becoming an empty register (A9).
3. **Shared state files** — complete base/candidate comparison and revision-locked atomic writes prevent deletion and stale-writer bypasses (A6, A10).
4. **Fail closed** — unpaid due debt, tampering or unreadable state blocks a move (A5, A6, A9), including the task-kind fallback (A1).
5. **Identity scoping** — every debt entry names repository, source PR and stable finding id (A8); approvals and payment evidence bind exact revisions (A6–A7).
6. **State over time** — controlled clocks cover 72-hour expedite escalation and 45-day debt resurfacing without expiry (A2–A3); A7 covers recorded extensions.
7. **Who wrote it** — protected CI verifies approvals and landed fixes independently; agent-editable card fields cannot settle or hide debt (A6–A7).
