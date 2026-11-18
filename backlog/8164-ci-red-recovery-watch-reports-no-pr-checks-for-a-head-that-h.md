---
bornAs: xgtrei0
kind: story
size: 2
status: active
scaffoldedBy: "missing-required-check-recovery"
dateScaffolded: "2026-11-12"
dateOpened: "2026-11-12"
tags: []
related: ["6703"]
---

# ci-red-recovery-watch reports 'no PR checks' for a head that has test/smoke/daemon-soak from a workflow_dispatch run

TODO digest — one ≤100-word paragraph: what this item does and why (replace this line).

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

05:32Z the pass said #6684 recovery commit still has no PR checks although head 41d2469173 has test/smoke/daemon-soak from the 02:13Z workflow_dispatch; the missing-run evidence reader (rollup/workflowRuns) likely ignores workflow_dispatch runs or reads stale evidence

distinct from the dispatch fallback in #6703 and its residual card
