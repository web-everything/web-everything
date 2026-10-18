---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/test-gaming-route.mjs", "we:scripts/conveyor/__tests__/test-gaming-route.test.mjs", "we:scripts/check-standards.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — terminal merge-gate routes must clear or notify

PR #5537 advisory review found missing episode-scoped completion, terminal escalation, retry and configuration-consumer guards in we:scripts/conveyor/test-gaming-route.mjs. This repair adds deterministic regressions in we:scripts/conveyor/__tests__/test-gaming-route.test.mjs for completed still-held heads, failed ruling comments, mixed removal reasons, configured routing with enabled omitted, unrelated advisory repair markers, failed feed delivery and failed delivery acknowledgements. The live routing scenario in we:scripts/conveyor/soak/breaks/test-gaming-new-head-stranded.mjs now covers these daemon transitions. Follow up with a standards check requiring each terminal routing state to clear its obligation or durably notify the operator; do not require already-added regression guards again.

## Acceptance

- [A1] Add deterministic standards-rule fixtures for terminal routing states: a state with neither clearance nor durable operator notification fails; a state with either succeeds. Run the affected standards-rule tests through `npm run test:unit -- <affected test file>`.
- [A2] Audit terminal states in merge-gate routing and map each to clearance or durable notification, including interrupted delivery and acknowledgement recovery.
- [A3] Keep the PR #5537 regression guards listed above; they are implemented in that repair and are not outstanding work on this card.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Do not clear merge-gate holds or change human review ownership.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — source declarations are data; do not evaluate source to discover terminal states.
2. **Truncated reads** — an unreadable declaration must produce a check error rather than an empty passing audit.
3. **Shared state files** — distinguish notification intent from successful delivery; cover interrupted writes and idempotent retries.
4. **Fail closed** — an unknown terminal state without a declared disposition fails the rule.
5. **Identity scoping** — notification and clearance must belong to the same PR, head and obligation as the terminal state.
6. **State over time** — cover retry, restart, newer findings and already-completed obligations.
7. **Who wrote it** — untrusted thread markers cannot satisfy notification or clearance declarations.

## Filing handoff

Created through the declared file-item operation in the restricted repair lane. Queue clearance is deferred to the launcher because this sandbox permits only lane and temporary-file writes.
