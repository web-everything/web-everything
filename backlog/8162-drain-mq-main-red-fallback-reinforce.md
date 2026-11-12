---
bornAs: xehrn3q
kind: task
status: open
dateOpened: "2026-11-11"
tags: []
---

# Reinforce drain MQ same-head retry: main-red fallback can excuse a real failure; freeze-hold gate-log proof unaudited after round 2

Audit residuals of lane/drain-retry-freeze-ejections: (1) pre-existing main-red fallback in readMqRetryEvidence (infra main-red when main was red at removal, no aggregate candidates) can let a real test failure retry once; (2) the merge-gate freeze proof (sole hold line in job log) was not re-audited after round 2; (3) the one-retry cap is structural, not a policy-cascade setting (R905).

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
