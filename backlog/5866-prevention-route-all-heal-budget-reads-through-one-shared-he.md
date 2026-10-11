---
bornAs: xfo0n8z
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/__tests__/ci-heal-attempts.test.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — Route all heal-budget reads through one shared helper that applies the reset (e.g. a 'healsSinceL… (from web-everything/web-everything#4880 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-core.mjs:2690` — Route all heal-budget reads through one shared helper that applies the reset (e.g. a 'healsSinceLastFixHead(comments)' in we:ci-heal-mark.mjs). Add a check:standards rule that flags direct countChargeableCiHealComments calls outside that helper.
2. `we:scripts/conveyor/__tests__/ci-heal-attempts.test.mjs:137` — Require a test per branch of any new cascade or override rule. A coverage-threshold check on we:scripts/conveyor/reconcile-core.mjs for the touched lines would catch this.
3. `we:scripts/conveyor/reconcile-core.mjs:480` — Make the timestamp check fail closed, e.g. keep the heal unless Date.parse(createdAt) is finite and <= cut. Add a unit test for a createdAt-less heal after a reset.
4. `we:scripts/conveyor/reconcile-core.mjs:415` — Add a test that alternates N (heal×3, fixer push) cycles and asserts that the fix round cap, or a total heal ceiling, stops further ci-heal dispatch. Alternatively add a hard cap on total resets.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4880@f3c6f0f56e3aa52d4137cd495ea01e6b1e31d81a

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
