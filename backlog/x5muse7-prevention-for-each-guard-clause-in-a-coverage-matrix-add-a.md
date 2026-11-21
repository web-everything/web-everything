---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/operations/operator-why.mjs", "we:scripts/conveyor/__tests__/reconcile-advisory-head-move.test.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/operations/__tests__/operator-why.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — For each guard clause in a coverage matrix, add a fixture that satisfies only that clause. Ideall… (from web-everything/web-everything#7263 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-core.mjs:1646` — For each guard clause in a coverage matrix, add a fixture that satisfies only that clause. Ideally also run a mutation check in the soak/test harness that deletes each `||` operand and requires a named test to redden.
2. `we:scripts/operations/operator-why.mjs:47` — Add a planner-versus-`why` parity test over the gate matrix the planner tests already enumerate (draft, pending CI, referral hold, in-flight review). Better, have `why` read the planner's decision instead of a second derivation.
3. `we:scripts/conveyor/reconcile-core.mjs:1645` — Add a check:standards rule or test helper requiring that any detector reading commit message text for provenance matches a closed allowlist of known producer trailer names, and that a spoof test accompanies each such detector. Card xyqs0x4 is the start of this.
4. `we:scripts/conveyor/__tests__/reconcile-advisory-head-move.test.mjs:208` — Require that a guarantee stated in a dispatch row's `why` ('never accepts') has a test at the module that enforces it. A review lens covering prose guarantees is enough here. Card x9f84a2 already plans the execution-boundary test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7263@46ea7c62a888a25922534db3fce8ab0cb13b9858

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
