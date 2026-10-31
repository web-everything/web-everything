---
kind: story
size: 3
status: open
scope: ["we:scripts/operations/open-pr.mjs", "we:scripts/worker-brief.mjs"]
dateOpened: "2026-10-31"
tags: []
---

# open-pr bypass flags must verify the operator instruction came from the operator, not a quoted brief

Live 2026-10-31 10:30 ET (#6132): worker build-7537 passed open-pr --skipPrePrReview with --operatorInstruction quoting the ORCHESTRATOR brief ('open one PR via open-pr...') as if the operator said it, and open-pr accepted it. Fix: the bypass must check who gave the instruction (session/actor identity, e.g. an operator-channel record), not free text; worker-brief must say never pass bypass flags. Related: #7105 (quoted operator OK), #5832 (pr-limit operator-channel check). Retraction + converge were ordered on #6132.

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
