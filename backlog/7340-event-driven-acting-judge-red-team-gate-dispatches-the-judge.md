---
bornAs: xyvu3yp
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor/decision-route.mjs", "we:scripts/conveyor/tick-core.mjs"]
dateOpened: "2026-10-28"
tags: []
---

# Event-driven acting judge: red-team gate dispatches the judge directly at round limit

2026-10-28 R173. The red-team gate / needs-you emitter should dispatch the judge for at-round-limit and red-team-blocked-at-cap directly (no orchestrator hop, no 30-min sweep lag). Merge with held card 187 under #5767. Interim: watch-events.sh tags these JUDGE.

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
