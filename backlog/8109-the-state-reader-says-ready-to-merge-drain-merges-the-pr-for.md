---
bornAs: xe3web9
kind: story
size: 3
status: open
scope: ["we:scripts/lib/pr-state-core.mjs", "we:scripts/conveyor/pr-sweep-core.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# The /state reader says READY-TO-MERGE ('drain merges the PR') for a PR held by red-team:pending/blocked, revi…

Flow-sim gap R8b-G5, class K9 (divergent predicates for one state). Failing input: PR labels: review:accepted (or ready-to-merge) + red-team:blocked (or red-team:pending / review:changes / status:sent-back-red-team / status:fixing); not draft; every required check green; no review:human.' '`node we:scripts/state.mjs <N>`. Cited: we:scripts/lib/pr-state-core.mjs:61-62, we:scripts/lib/pr-state-core.mjs:64, we:scripts/conveyor/pr-sweep-core.mjs:349-353. Soak-break sketch: Fixture: derivePrState facts {state:'OPEN', labels:['review:accepted','red-team:blocked'], head:{sha}, requiredChecks:[{name:'test',state:'green'}], sessions:[], isDraft:false}. Assert phase !== 'READY-TO-MERGE' (expect NEEDS-RULING/STUCK/hold with owner name…

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
