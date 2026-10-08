---
bornAs: xu8wvf7
kind: story
size: 5
parent: "5452"
status: open
blockedBy: ["4283", "5453"]
scope: ["we:scripts/conveyor/decider-daemon.mjs", "we:scripts/conveyor/decide.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:scripts/lib/dispatch-throttle.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Decider process in shadow: projection, one pure decide per dirty PR across all roles, admission and slots

Rulings E1 and E2, step 2 (E6). One decider process reads the projection, runs one pure decide per dirty PR for every role at once (planReconcile in we:scripts/conveyor/reconcile-core.mjs), runs admission over caps and free slots, and appends action-requested events. No network inside a decision. Ships in shadow: it journals what it would request beside the live sweeps.

## Acceptance

- [A1] **Executable** — a unit test calls the pure decide with one PR state that owes both a review and a fix and asserts it returns exactly one of them; a second test asserts decide makes no network call (fetch and gh are stubbed to throw).
- [A2] One decider process: reads dirty PRs from the foundation cursor (xlta0x5), folds the projection, runs decide once per dirty PR for all roles, then runs admission over caps and free slots (fix cap, ci-heal reserve, heavy test slots, host load as settings).
- [A3] At most one decide in flight per PR; an event that arrives meanwhile re-marks the PR so it runs again right after.
- [A4] Decide returns `recheckAt` for time rules (lease expiry, cool-off, max time in state), and the decider honours it.
- [A5] Every decide writes a decision record: PR, `seq` seen, decide version, actions, reasons.
- [A6] SHADOW: the decider journals the action-requested events it would append next to what the live sweeps did, and acts on nothing. The diff report is the cut-over evidence for 5459, 5457 and 5455.
- [A7] Measured with the 2026-10-08 event-latency script: event-to-decide lag p50 reported.

## Non-goals

- [N1] The decider never runs a model, never touches GitHub, never merges.
- [N2] No per-role executors here; the drain stays its own process.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — PR titles, bodies and comments in the projection are data; decide reads only typed fields.
2. **Truncated reads** — an incomplete projection for a PR yields no action and a recheck, never a guessed action.
3. **Shared state files** — the decider is the single writer of action-requested events and decision records.
4. **Fail closed** — if the projection is stale past its bound, the decider requests nothing for that PR and records why.
5. **Identity scoping** — every action is keyed to repo, PR and head commit.
6. **State over time** — a head change makes older owed actions moot (key includes head).
7. **Who wrote it** — decision records carry the decide version and process identity.
