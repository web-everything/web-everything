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
- [A4] The terminal-state audit must check obligation identity as well as head identity: a repair marker and fix-end for a newer unrelated advisory cannot discharge an older test-removal route. Include ordinary and converted advisory notes, unfinished routes, and routes already repaired before a later note.

## Advisory prevention record — PR #5537

This card records the prevention owed by the advisory posted on 2026-10-18 at 16:58:29 UTC, including the **codex-correctness/correctness** finding about an unrelated advisory's repair completing the test-removal route. The guards below are already implemented on head `ef30d766a`; the remaining work is the terminal-state standards check in A1, A2 and A4. Extend this card rather than filing duplicate work to add these tests again.

All test names below refer to we:scripts/conveyor/__tests__/test-gaming-route.test.mjs.

| Advisory finding | Implemented prevention guard |
| --- | --- |
| Completed pass leaves the same head held without operator attention | `raises needs-you once when a completed pass leaves the same head held` |
| Failed ruling comment duplicates feed notification | `does not notify before a failed ruling comment, then notifies once across retries: %s`; feed delivery and acknowledgement failures have separate retry guards |
| Mixed skipped-test and removal evidence enters a removal-only route | `rejects mixed removal evidence containing %s in either order` |
| Routing ignores the configured setting when enabled is omitted | `honors the configured routing setting when enabled is omitted: %s`, with opposing configured values |
| A newer unrelated advisory's repair completes the original route | `does not complete a test-removal route when only a newer unrelated finding was repaired: %s`, covering ordinary and converted advisory notes and asserting that reconcile still offers the original repair |

The last guard exercises route admission, a newer unrelated changes advisory, its repair marker and matching-head fix-end, then repeated routing. It requires the original binding finding to remain actionable and forbids an operator notice that would imply its completion. The production completion check uses only the route's own episode; the whole-thread repair check remains appropriate for deciding whether an unrelated advisory has finished before restoring the original binding input.

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
