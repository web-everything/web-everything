---
bornAs: xksotz7
kind: decision
parent: "2405"
blockedBy: ["3255"]
status: resolved
dateOpened: "2026-08-20"
dateResolved: "2026-10-07"
codifiedIn: "docs/agent/platform-decisions.md#verdict-ledger-pr-state-store"
tags: []
scope:
  - we:scripts/lib/verdict-ledger.mjs
  - we:scripts/lib/__tests__/verdict-ledger.test.mjs
  - we:scripts/review-set-label.mjs
  - we:scripts/__tests__/review-set-label.test.mjs
  - we:scripts/operations/review-pr-io.mjs
  - we:scripts/operations/__tests__/review-pr-io.test.mjs
---

# Revisit the ledger write-miss posture before the authority moves

The ledger append is deliberately fail-soft today because a miss costs one observation. Once the drain merges on the ledger a miss costs an un-mergeable PR instead, so the posture has to be chosen deliberately rather than inherited. Which way it goes depends on where the ledger ends up living.



## The posture is inherited, not chosen

Phase 1's append is deliberately **fail-soft**: a lock it cannot get still writes the row, stamped
`unlocked: true`, because a lost verdict is worse than an interleaved line. That is the right call while the
ledger is an observation — a miss costs one data point.

At Phase 2 a miss costs an **un-mergeable PR**, which is a different trade entirely, and `#3007` flags it as
owed rather than settled.

Which way it should go depends on where the ledger ends up living — a store that can be unreachable argues
differently from a git transport that either pushes or errors — so this follows the home decision rather
than pre-empting it.

## Done when

The write-miss posture at Phase 2 is chosen deliberately and documented at the append site, with a test
driving a miss and asserting the chosen behaviour.
