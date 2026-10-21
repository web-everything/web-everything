---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Extract the pending-budget decision (hold / escalate / proceed) into one shared helper used by bo… (from web-everything/web-everything#5285 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-core.mjs:2825` — Extract the pending-budget decision (hold / escalate / proceed) into one shared helper used by both call sites. Add a test that runs the stale-pending fixture against both paths.
2. `we:scripts/conveyor/reconcile-core.mjs:2845` — Either gate the spent fall-through on the head already containing main's tip (aheadByOnMain === 0, or rebase-comment cap exhausted), or add a test asserting that a spent budget on a stale head still yields the rebase-owed refusal. Treat max=0 as off.
3. `we:scripts/conveyor/reconcile-core.mjs:2830` — Add a boundary test for maxRerunsPerHead=0 and either treat cap===0 as rerun-off (keep the refusal) or reject 0 in the resolver. A table-driven setting-boundary test would catch the whole class.
4. `we:scripts/conveyor/reconcile-pass.mjs:157` — Add table-driven resolver tests to the required test gate, including malformed configuration and invalid environment overrides; assert the resolved action is off.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5285@b878ef4babb5aa1164ac8ac089d66fafb24765cd

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
