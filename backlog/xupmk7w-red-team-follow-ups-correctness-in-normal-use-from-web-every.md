---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/rewaive-plan.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7479 (head 5168bf9dd)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7479 (reviewed head `5168bf9ddc684907ae755c7753a2e3905f4bb02c`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/rewaive-plan.mjs:24` — (failing-input, degraded) Planner rejects valid waivers with combined ruling IDs
   - Scenario: Use a linear history B→H where B has a full WEAKENED audit and an unrevoked, matching waiver with ruling R475+R485, and H is unaudited. The planner rejects the waiver and returns refuse/basis-not-waived instead of audit-needed. Combined rulings are valid in both the canonical waiver store and admission gate.
   - Class: correctness-in-normal-use (basis: A read-only probe evaluated the actual validation expressions: R475+R485 passes the store and gate expressions but fails the planner expression. The waiver lookup therefore discards a valid basis. Full-module execution was blocked by missing dependencies.)
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
