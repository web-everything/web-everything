---
bornAs: xtvqx59
kind: story
size: 2
status: active
scaffoldedBy: "fix-6326"
dateScaffolded: "2026-11-03"
scope: ["we:scripts/lib/required-check-implication.mjs", "we:scripts/lib/review-ci-gate.mjs", "we:scripts/operations/pr-status.mjs", "we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/fix-push-ci.mjs", "we:scripts/conveyor/pr-status-label.mjs", "we:scripts/conveyor/ci-heal-verdict-recheck.mjs"]
dateOpened: "2026-11-03"
tags: []
---

# withoutImpliedRequiredChecks ignores green legacy commit statuses (state=success) as implying aggregates

The implication rule only recognises conclusion=success, so a required test published as a legacy commit status ({context,state:success}) does not imply integration. PR #6326 normalised statuses locally in review-timing registeredStartGate (red team on f4ed5360); the strict review gate normalises via its private statusAsCheckRow. Other callers (pr-status, reconcile-pass missing-check scans, fix-push-ci, pr-status-label, ci-heal-verdict-recheck) still pass raw rollup rows. Fix at the root: make the helper's green() accept state=success with no status/conclusion, then drop the two local normalisers.

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
