---
bornAs: xrlwbd7
kind: epic
status: open
dateOpened: "2026-10-17"
tags: []
---

# we: review stringency build — classed findings, per-level outcomes, debt register

Build the ruling of decision 6239: a closed finding-class list, a settings table that picks block, expedite, debt or advisory per class and level, a debt register that gates level moves, a plateau debt panel, and advisory lessons. Five slices, in order.

## Acceptance

- [A1] **Executable** — end-to-end test `review-stringency-outcomes-e2e` drives production review parsing, classification, settings resolution and ruling persistence with fixtures for block, expedite, debt and advisory; it observes the resulting merge eligibility, queue/debt entry or ledger entry rather than a stubbed reducer result. Invalid input and always-block classes cannot become advisory. The test must be added by the implementation slices and run through the affected-test gate before this epic resolves.
- [A2] **Executable** — end-to-end test `review-stringency-level-gate-e2e` uses the production debt writer and level-move entry point: unpaid due debt and overdue expedite block, verified payment or an authenticated operator due-level edit permits the move, and forged authority, card tampering or unreadable state cannot clear the gate. Covers both debt-kind and task-plus-fields representations.
- [A3] **Inspection** — attach before/after evidence on a live PR to the epic before resolution: repository, PR number, exact pre/post heads, active level, settings revision and source, finding id/class/confidence, expected outcome and observed ruling/queue/ledger effects. A green fixture suite alone does not satisfy this criterion.
- [A4] **Executable** — test `review-stringency-override-recount` pins the recount's handling of duplicate findings and strongest rulings; publish its real-data output for a fresh, explicitly dated post-build 14-day window beside the original window (134 auto-blocks, 126 over reviewer not-real). Include denominators and unavailable-data errors; no invented improvement target. The epic stays open until this evidence exists.
- [A5] **Inspection** — acceptance trace `review-stringency-handoff` confirms all five slices below are delivered and their named tests/evidence are linked, rather than resolving this epic solely because children are resolved: 6232 (classes), 6233 (settings/ruling), 6237 (register/gate), 6238 (panel), 6234 (lessons). The canonical statute is `we:docs/agent/platform-decisions.md#review-stringency-classified-outcomes`.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] No changes to operator-wait, stale-head or process holds, no new severity scale, and no waiver outside the recorded due-level edit. This epic ships implementation; the resolved decision only rules the design.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the production path rejects malformed model fields (A1, slice 2 A8) and never turns finding prose into standing lessons (slice 5 A5).
2. **Truncated reads** — incomplete findings/settings block (A1); incomplete debt evidence blocks a level move (A2); incomplete recount input errors (A4).
3. **Shared state files** — settings/debt revisions are checked atomically (A2, slice 2 A11, slice 3 A10); lesson retries are idempotent (slice 5 A6).
4. **Fail closed** — missing class/cell and unreadable state block rather than defaulting to advisory or empty debt (A1–A2).
5. **Identity scoping** — repository/PR/finding provenance and revision-bound authenticated approvals are exercised end to end (A2–A3, slice 3 A7–A8).
6. **State over time** — deadline and 45-day staleness cases remain mandatory in slice 3 A2–A3; A4 waits for a fresh complete measurement window.
7. **Who wrote it** — protected CI independently verifies the authenticated operator review actor and landed-fix evidence, not commit authors or card claims (A2, slice 2 A10, slice 3 A6–A7).

## Risks

Weak fixtures can hide production wiring gaps; A1–A3 require the production path and a live PR. Agent-editable card fields can hide debt; A2 requires complete-base inventory comparison. False blocks and lower-stringency regressions remain measurable through A4 and slice 2 A6.

## Test plan

Run each slice's named tests through its affected-test gate, then the epic's A1–A2 production-path cases and A4 recount test. Keep live evidence A3 and fresh-window output A4 on this epic before resolution; A5 is the completion checklist.

All following paths are planned implementation destinations, not tests shipped by the decision PR. Each slice's Test plan assigns every named acceptance case to a repository-qualified file.

| Risk / acceptance owner | Planned file and named case | Observable assertion |
|---|---|---|
| Production wiring (A1) | `we:scripts/__tests__/review-stringency-integration.test.mjs` — `review-stringency-outcomes-e2e` | Persisted ruling changes merge eligibility, queue/debt or ledger through the production path. |
| Debt/authority bypass (A2) | `we:scripts/__tests__/review-stringency-integration.test.mjs` — `review-stringency-level-gate-e2e` | Tampering/unreadable evidence refuses the level move; verified payment or operator due-level edit permits it. |
| Relaxed levels (slice 2 A6) | `we:scripts/__tests__/review-stringency-ruling.test.mjs` — `monotonic-levels` | Reject every fixture relaxing a lower-level block. |
| Delivery impact and false blocks (A3–A4) | `we:scripts/__tests__/review-stringency-recount.test.mjs` — `review-stringency-override-recount`; A3 inspection evidence attached to this epic | Pin duplicate/strongest-ruling counts and errors; attach dated live-PR pre/post effects and the fresh-window output with denominators. |

The epic exposes no separate endpoint: body-size, rate limit and origin checks are owned by slice 2 A16, slice 3 A11 and slice 4 A6; slice 1 and slice 5 document their local-validator/job applicability. Epic A1–A2 exercise those ingress refusals as part of production wiring.
