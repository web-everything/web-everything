---
kind: story
size: 3
parent: "5407"
status: open
blockedBy: ["xfla18q"]
scope: ["we:scripts/conveyor/decide.mjs", "we:scripts/conveyor/__tests__/decide-replay.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Decision API spec: decide and admission rules as replay fixtures (events in, actions out)

Ruling E4. The delivery standard specifies the Decision API (decide plus admission) as replay fixtures: a recorded event stream in, the exact action-requested set out, so two kernels must agree on what is owed. Limits and thresholds stay settings, not spec. Part of the event-driven daemons epic (xf7ax93).

## Acceptance

- [A1] **Executable** — a conformance runner replays each fixture (recorded event stream plus settings in, exact action-requested set and `recheckAt` out) against the reference decide and admission, passes, and fails on a deliberately broken decide.
- [A2] Fixtures cover at least: review and fix never both owed for one PR; a same-head re-review after a ruling is not suppressed (cause in the key); a freed slot admits the next request; a stale head yields no action; "ready to land" is emitted as a wake only.
- [A3] The spec text names states and actions, never GitHub label strings.
- [A4] Limits and thresholds (caps, intervals, budgets) appear only as fixture settings, never as fixed spec values.

## Non-goals

- [N1] No runtime, no adapters in the spec (zero implementation in the standard).
- [N2] Where the protocol finally lives is #5407's call.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — fixtures include PR text as data to prove it never selects an action.
2. **Truncated reads** — a fixture with a truncated state must yield no action.
3. **Shared state files** — n/a: fixtures are read-only test data.
4. **Fail closed** — a fixture with unreadable ledger state must yield no land wake.
5. **Identity scoping** — fixtures are per repo and per PR head.
6. **State over time** — fixtures include time rules (lease expiry, cool-off) with a fixed `now`.
7. **Who wrote it** — n/a: fixtures are recorded streams; each event keeps its writer field.
