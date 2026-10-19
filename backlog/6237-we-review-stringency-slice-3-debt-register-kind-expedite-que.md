---
bornAs: xsnny7x
kind: story
size: 8
parent: "6236"
status: open
blockedBy: ["6233"]
dateOpened: "2026-10-17"
tags: []
---

# we: review stringency slice 3 — debt register (kind, expedite queue position, level gate)

Add backlog kind debt with its size and buildable rules and every kind-set reference in the same slice, the expedite queue position and deadline, and the level gate that blocks a move while due debt is open. Ruled in 6239.

## Acceptance

- [A1] **Executable** — registration test `debt-kind-registration` checks the debt size rule, buildable rule and agreement of every kind-set consumer in one slice; if they cannot ship together, exercise the ratified task-plus-debt-fields fallback through the same gate tests.
- [A2] **Executable** — integration test `expedite-deadline-escalation` uses a controlled clock: an expedite ruling lets the PR land, puts its card at the top of the build queue, and assigns a deadline from the persisted ruling time plus the configured duration (initially 72 elapsed hours). Before and exactly at the deadline it is not overdue; strictly after it, the item reaches the operator's needs-you feed, counts as debt due now at the current level, and blocks a level move. This automatic obligation requires no debtQuadrant or owner assessment and must persist even when either is absent; it is not permission to admit ordinary deferred debt. Feed identity is repository plus class, with all matching item ids retained in the row: two overdue items of one class and one of another produce exactly two rows, never one per item. Repeated/concurrent checks neither auto-extend the deadline nor duplicate rows or lose items; paying one item preserves the row for its unpaid sibling, and paying the last removes that class row.
- [A3] **Executable** — clock-driven test `debt-staleness-resurface` measures 45 elapsed days from persisted debt `openedAt` until the first successful surfacing, then from trusted `lastSurfacedAt`. With a controlled clock, check just before/at day 45 and day 90, unpaid debt resurfaces at both crossings and never early; a late day-50 surfacing makes the next due day 95. Update lastSurfacedAt only atomically with a successful feed publication; retries/concurrent checks publish once per interval, failed publication retains the old baseline for retry, and clock rollback does not cause an early duplicate. Multiple same-class debts aggregate into one repository/class row with all ids. Resurfacing retains due level; unpaid debt never expires or disappears, paid debt never resurfaces. Neither timestamp is editable by a PR to defer surfacing.
- [A4] **Executable** — level-write and gate integration test `level-edit-authority` rejects agent changes to the current level and to a debt item's must-pay-before level, leaving the stored levels and gate result unchanged. With due debt open, an operator's attempted level move still blocks; paying the debt or the operator's recorded edit of its must-pay-before level permits the move, with operator identity and old/new levels recorded.
- [A5] **Executable** — gate integration test `due-debt-gates-level` refuses a move with unpaid debt due at or below the target level, including a skipped intermediate level, and permits it after a verified payment or an authenticated operator edit moving its due level beyond the target.
- [A6] **Executable** — writer and protected CI integration test `debt-item-tamper` compares the complete trusted base inventory to the candidate tree before any kind/status filtering. Agent deletion, rename, kind change, resolved-status change, class/severity/confidence/debtQuadrant change, openedAt/lastSurfacedAt change, deadline edit or removal, due-level edit, source edit, and forged payment receipt refuse and leave the debt effective at the gate. The task-plus-debt-fields fallback gets the same cases. Ordinary fix work may be proposed by an agent; payment becomes effective only when protected CI independently verifies a landed fix and passing validation tied to the debt id, source finding and exact fixed revision. A status string or operator claim alone is never payment.
- [A7] **Executable** — authority integration test `debt-approval-provenance` uses slice 2 A10's protected CI authenticated GitHub review actor and protected operator allowlist, bound to exact repository/base/head/diff. Forged, absent, stale and replayed approvals cannot change due level, deadline or current level; a verified operator due-level edit is recorded and a verified deadline extension updates the overdue calculation. No actor may delete or reclassify debt to bypass payment.
- [A8] **Executable** — register test `debt-source-required` refuses missing, malformed or mismatched source repository, PR and stable finding id; a valid entry retains these alongside class, impact, severity, confidence, openedAt, lastSurfacedAt (explicitly absent until first surfacing), must-pay-before level, deadline (explicitly absent for ordinary debt), fix cost and interest. Ordinary deferred debt additionally retains debtQuadrant and the owner's assessment/rationale confirmed by the authenticated operator, bound to this admission through A7's protected writer. Reuse slice 2's exact field domains: missing/malformed quadrant, any value other than prudent-deliberate, or an unconfirmed reviewer label refuses ordinary debt admission in both representations. A provenance-verified overdue-expedite obligation is retained and gates without a quadrant (A2); a forged expedite claim cannot bypass ordinary admission. Timestamps must be valid UTC instants written by the trusted lifecycle service. Display text is stored as data and confers no authority; A12 `debt-display-text-inert` supplies the injected-text fixture.
- [A9] **Executable** — gate integration test `debt-register-unreadable` supplies a missing, unreadable, truncated, paginated-incomplete or malformed register/base inventory or validation receipt and observes a blocked move, never an empty-debt success.
- [A10] **Executable** — integration test `debt-gate-revision-race` races a payment, operator due-level edit and level move; the move re-reads validated debt and settings under a revision lock and retries on change. A crash before atomic persistence keeps the prior debt effective; an expired writer cannot overwrite a newer revision.
- [A11] **Executable** — integration test `debt-ingress-bounds` applies slice 2 A16's 1 MiB body-size, 128-byte enum-field and 60 requests/minute repository/principal rate limit to register/payment/level writes through the protected writer; over-limit requests cannot create, settle or hide debt. Origin/CSRF `n/a:` for this CI/CLI-only surface without browser cookies, using the A10/A15 protected trust root; no new browser endpoint or state-reset trigger is exposed.
- [A12] **Executable** — production register/writer/gate test `debt-display-text-inert` round-trips an otherwise valid unpaid due debt entry with instructions in every display-text field, including title, textual impact, fix cost, interest and assessment rationale. Enumerate display fields from the entry schema so an added field cannot escape the fixture. Inject fake operator/payment/level commands, HTML/script markup, newline/CR/U+2028, backticks, quotes, leading `--`, traversal text, NFKC lookalikes/invisibles and joined fragments in each display field. Reads return data without executing markup, commands or instructions; the gate still blocks the move, and no effective setting, deadline, due level, payment state, source identity or authority changes. Feed and lesson handoffs keep prose in separate data fields and cannot treat it as policy or standing instructions (reuse slice 4 A2 and slice 5 A5 at those consumers). A tamper attempt combining display instructions with forged structured authority/payment fields still refuses under A6–A7. Exercise both debt-kind and task-plus-fields paths, including retries after a failed write.

Ruling and amended table: [we:backlog/6239](/backlog/6239-decision-review-stringency-classified-findings-per-level-out/) and the statute `we:docs/agent/platform-decisions.md#review-stringency-classified-outcomes`.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] No unrecorded waiver, automatic deadline extension, debt expiry or status-only payment. The panel is slice 4 and lessons are slice 5.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — source and finding text are data; forged fields and payment claims cannot bypass the gate (A6–A8). Injected display-text fixtures exercise register round trips, the gate and downstream handoffs (A12).
2. **Truncated reads** — incomplete inventory or receipt blocks rather than becoming an empty register (A9).
3. **Shared state files** — complete base/candidate comparison and revision-locked atomic writes prevent deletion and stale-writer bypasses (A6, A10).
4. **Fail closed** — unpaid due debt, tampering or unreadable state blocks a move (A5, A6, A9), including the task-kind fallback (A1).
5. **Identity scoping** — every debt entry names repository, source PR and stable finding id (A8); approvals and payment evidence bind exact revisions (A6–A7).
6. **State over time** — controlled clocks cover 72-hour expedite escalation and 45-day debt resurfacing without expiry (A2–A3); A7 covers recorded extensions.
7. **Who wrote it** — protected CI verifies approvals and landed fixes independently; agent-editable card fields cannot settle or hide debt (A6–A7).

## Risks

Debt can disappear through mutable fields or untrusted provenance (A6–A9), lose escalation through aggregation or clock errors (A2–A3), bypass the gate during races (A4–A5, A10), or overload its writer (A11). Display prose could be mistaken for policy or payment instructions (A12). Both backlog representations need identical protection (A1).

## Test plan

Planned file `we:scripts/__tests__/review-stringency-debt.test.mjs` owns every named case in A1–A12 and its observable assertions above, including N+1 same-class items, the second staleness crossing and injected display prose through the production register/gate path. Authority root coverage additionally runs `allowlist-and-gate-self-protection` in `we:scripts/__tests__/review-stringency-ruling.test.mjs` (slice 2 A15). These files are implementation deliverables, not present-day passing tests.
