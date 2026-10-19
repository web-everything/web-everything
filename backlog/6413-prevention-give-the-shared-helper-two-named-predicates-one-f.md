---
bornAs: xb5o4ky
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/priority-sync.mjs", "we:scripts/backlog.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/backlog-closed-accounting.test.mjs", "we:scripts/operations/close-items-io.mjs", "we:scripts/operations/__tests__/priority-sync.test.mjs", "we:scripts/__tests__/backlog.test.mjs", "we:scripts/__tests__/check-standards-rules.test.mjs", "we:scripts/operations/__tests__/close-items-io.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Give the shared helper two named predicates, one for 'item is done as work' and one for 'blocker… (from web-everything/web-everything#5184 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/priority-sync.mjs:213` — Give the shared helper two named predicates, one for 'item is done as work' and one for 'blocker is satisfied' (`isDelivered`, which already exists), and add a lint that flags `isTerminalStatus` applied to a blocker/blockedBy lookup.
2. `we:scripts/backlog.mjs:362` — Extract the per-card refusal checks into one shared pure function that both the CLI verb and `planCloseItems` call, and test both entry points against the same refusal table.
3. `we:scripts/check-standards-rules.mjs:531` — Extend that gate branch to `isTerminalStatus(item.status)` with a closed-specific message, plus a fixture test for a closed epic with an open child.
4. `we:scripts/__tests__/backlog-closed-accounting.test.mjs:44` — Add a single table-driven test over the shared predicate's call sites (status 'closed' must behave as terminal for each exported pure planner), or a grep gate that rejects a bare `=== 'resolved'` outside an allow-list.
5. `we:scripts/backlog.mjs:362` — Route `we:scripts/backlog.mjs close` through the close-items planner, or make it refuse and point to the operation. Add a contract test that every close entry point refuses an on-priority card.
6. `we:scripts/operations/close-items-io.mjs:62` — Reject `input.triage` unless the resolved path is inside root (or a declared reports/ directory), with a test for `../` and absolute paths. A lint for `resolve(root, input.*)` in operation readers would catch the class.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5184@5f2906d8086c2b100f6a390991e683cd743c00de

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
