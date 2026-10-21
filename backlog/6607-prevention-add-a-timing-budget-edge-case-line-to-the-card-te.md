---
bornAs: xnu3bjy
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/6266-we-operator-override-slice-1-host-wide-store-and-operator-on.md", "we:backlog/6265-we-operator-override-slice-4-needs-you-flag-for-confirmed-lo.md"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Add a 'timing budget' edge-case line to the card template for any flow with chained time windows. (from web-everything/web-everything#5549 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/6266-we-operator-override-slice-1-host-wide-store-and-operator-on.md:24` — Add a 'timing budget' edge-case line to the card template for any flow with chained time windows.
2. `we:backlog/6266-we-operator-override-slice-1-host-wide-store-and-operator-on.md:9` — The x3g7q2m lint should also reject cards whose body names another card's export as a dependency (`slice N's <symbol>`) without a matching blockedBy edge, and reject blockedBy cycles.
3. `we:backlog/6266-we-operator-override-slice-1-host-wide-store-and-operator-on.md:30` — Add a card-lint review-checklist item: every limit stated for a write path needs a named read-path test, because the log is directly writable. Where possible, enforce invariants in the shared view function.
4. `we:backlog/6265-we-operator-override-slice-4-needs-you-flag-for-confirmed-lo.md:75` — Extend the planned acceptance-mapping lint in x3g7q2m to require structured mappings for each failure condition and each persisted-state guarantee; map invalid identity to an explicit cursor-preservation assertion.
5. `we:backlog/6265-we-operator-override-slice-4-needs-you-flag-for-confirmed-lo.md:29` — Extend the already-filed acceptance-coverage gate in backlog/6311 to require explicit default, initial-state and pagination-continuation test references for cursor-based consumers.
6. `we:backlog/6265-we-operator-override-slice-4-needs-you-flag-for-confirmed-lo.md:75` — Extend the already-filed acceptance-coverage work in backlog/6311 with structured mappings from each error condition to assertions on persistent state and recovery.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5549@aa45975818769155a9798e6522b04eaf9600f7ff

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
