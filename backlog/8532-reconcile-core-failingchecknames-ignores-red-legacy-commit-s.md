---
bornAs: xynktfa
kind: story
size: 2
status: active
scaffoldedBy: "fix-6326"
dateScaffolded: "2026-11-03"
scope: ["we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-11-03"
tags: []
---

# reconcile-core failingCheckNames ignores red legacy commit statuses, so CI heal and review-hold checks miss them

failingCheckNames reads only status/conclusion, so a required legacy commit status with state FAILURE/ERROR is invisible to splitFailingChecks, isBouncedRealRed and reviewHoldGatesOnlyRed (no CI repair owed; review-hold-only can be wrongly reported), while review-timing ciRedOnHead reads conclusion ?? state. reviewHoldOnlyRed also patches only conclusion on status rows. Found by the PR #6326 self-review; pre-existing, outside that PR's review-start finding. Related root-helper card 8522.

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
