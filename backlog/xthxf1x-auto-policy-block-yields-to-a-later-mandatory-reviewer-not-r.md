---
kind: story
size: 3
parent: "xrlwbd7"
status: open
blockedBy: ["x77cl1h"]
scope: ["we:scripts/conveyor/referral-auto-block.mjs", "we:scripts/lib/ruling-ledger.mjs", "we:scripts/lib/jury-core.mjs", "we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Auto-policy block yields to a later mandatory-reviewer not-real; escalations never call an auto-policy block an operator ruling

An automatic block from review.referralDefault (an auto-policy ruling, not an operator) must yield when the mandatory reviewer later rules the same finding not-real with evidence. Escalation text must never call an auto-policy block 'the operator ruled'. Live cases: PR 5514 was escalated to a stronger model three times over an auto-block; 126 auto-block overrides of not-real were counted 3-17 Oct. Epic xrlwbd7.

## Acceptance

- [A1] **Executable** — `node --test` on we:scripts/conveyor/__tests__/referral-auto-block.test.mjs and we:scripts/lib/__tests__/ruling-ledger.test.mjs fails before and passes after. Named tests, one per guarantee:
  - `an auto-policy block is superseded by a later mandatory-reviewer not-real that carries evidence`.
  - `an auto-policy block is NOT superseded by a not-real with no evidence, or by a non-mandatory reviewer`.
  - `an operator-sourced block is never superseded by a reviewer not-real`.
  - `escalation and dispute text names an auto-policy block as auto-policy, never as the operator ruled`.
  - `PR 5514 replay: three escalations over an auto-block collapse to zero once the reviewer ruled not-real`.

## Non-goals

- [N1] Does not change the operator's own rulings or the review-stringency outcome table (other slices of epic xrlwbd7).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — evidence is read from the structured ruling record, not from finding or PR text.
2. **Truncated reads** — an unreadable ruling record keeps the block standing.
3. **Shared state files** — writes only through the existing ruling ledger.
4. **Fail closed** — any doubt about who ruled keeps the block standing.
5. **Identity scoping** — only the mandatory reviewer's ruling on the same finding key and live head can supersede.
6. **State over time** — a new head or a changed finding re-evaluates; the supersede is tied to the head it was ruled on.
7. **Who wrote it** — source is read from the ruling's recorded actor; an auto-policy actor is never presented as the operator.
