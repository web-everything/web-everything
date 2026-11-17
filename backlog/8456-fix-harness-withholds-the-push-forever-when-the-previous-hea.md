---
bornAs: xcda3eu
kind: story
size: 3
status: active
scaffoldedBy: "fix-6535"
dateScaffolded: "2026-11-09"
scope: ["we:scripts/conveyor/"]
dateOpened: "2026-11-09"
tags: []
---

# Fix harness withholds the push forever when the previous head's merge-gate is a human-only review hold

await-verify treats a merge-gate HOLD (review-acceptance human-only: diff touches .github/workflows) on the previous PR head as a CI failure the fixer must repair. That hold clears only after a human ceremony on the exact head, so every fix on a review:human PR touching workflow files is withheld and loops to a gate-red stand-down. Live: PR #6535 fix-6535, head 46e1b49d9, fix ae02d96d saved at lane/redteam-check-run-fix-6535-alt. Expected: a policy HOLD (not a check failure) on the previous head does not withhold the push.

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

## Duplicate admission

5894 is a resolved takeover budget, 7150 is AI review after a CI-fixer hand-off, 7621 is early review start; none covers the fix harness push hold misreading a merge-gate policy HOLD as a CI failure
