---
bornAs: xf7ax93
kind: epic
parent: "3383"
status: open
dateOpened: "2026-10-08"
tags: [conveyor, daemons, event-driven]
---

# Event-driven delivery daemons: one decider, per-role executors, one ordered event log

Operator rulings E1-E7 of 2026-10-08 on the event-driven daemon design (feeds #3886, #4282, #4283). Replaces sweep-everything ticks with one ordered event log, one pure per-PR decide, and per-role executors. Parent is #3383 (the mechanical dispatcher that replaces the interactive supervisor), the tree that already holds #3886 and #4075/#4283.

## Rulings (operator, 2026-10-08)

- **E1 Handler unit.** Decide per PR across all roles: one pure decide over the PR state. Execute per action kind.
- **E2 Process layout.** ONE decider process (projection + pure decide + admission/slots; no network inside a decision; it appends action-requested events to the log). SEPARATE executor processes per role (review, fix, ci-heal) plus the drain, each consuming its own action kind through its own log cursor, each on its own clone so each role can carry its own edge version. A slow or crashed executor only delays its own role. Decision-rule edge changes run in SHADOW: new rules beside old, diffs journaled, flipped per role.
- **E3 What the log holds.** One log, one order: GitHub facts, ledger verdicts and rulings, worker start/finish, action-requested events. Facts compact; judgments are kept forever. The ledger and the event log grow into one stream.
- **E4 Standard scope.** The Decision API (decide + admission rules) is in the delivery standard as replay fixtures (events in, actions out). Limits and thresholds stay settings.
- **E5 Safety pass.** Re-decide all every 5 min from the cached projection (no GitHub calls), re-sync with GitHub every 15 min (target: one batched GraphQL query for all open PRs), plus timers. A "missed by events" counter lets intervals grow while it stays at 0. Operator condition "ok if cheap enough": intervals are settings; calls per re-sync are logged, with an alert over a budget setting.
- **E6 First step.** Shared foundation (persisted log cursor + dirty-PR marking) plus the drain consuming the event feed (#4283). The decider is step 2. Each step is measured before/after with the 2026-10-08 event-latency measurement script.
- **E7 Statute.** "Ready to land, one PR" is a wake: a hint, never an order. The drain re-checks every gate live and keeps the ordering. Codified in we:docs/agent/platform-decisions.md#event-driven-land-is-wake-only.

## Slices (blockedBy DAG)

1. xlta0x5 Event runtime foundation: persisted cursor + dirty-PR marking (3). Filed and being built by the `event-foundation-drain` lane, not re-filed here (it sits under #4075 there; re-parent it here and add it to #4283's `blockedBy` once it lands — it is not on main yet, so no `blockedBy` edge can name it today).
2. #4283 Drain consumes the PR-events feed (2) ← foundation xlta0x5 (prose edge until it lands).
3. 5453 Log accepts runtime events (action-requested, worker started/finished) (3) ← #4283 (step 1 done, E6).
4. 5454 Decider process in shadow (5) ← #4283, 5453.
5. 5459 Review executor + review sweep cut-over (3) ← 5454.
6. 5457 Fix executor + admission on worker-finished (3) ← 5454.
7. 5455 ci-heal executor (2) ← 5454.
8. 5460 Decision-rule changes in shadow, flip per role (3) ← 5454.
9. 5458 Safety pass + batched re-sync + call budget alert (3) ← 5454.
10. 5456 Ledger joins the stream; decide on derivePrState (5) ← 5453, 5454.
11. 5461 Decision API replay-fixture spec, filed under #5407 (3) ← 5456.

## Covered elsewhere (not re-filed)

- Design step 4, builder out of the hot path: #5036 (blue-green daemons, versioned clones).
- Daemons read the PR ledger instead of `gh pr list`: #4282. Webhooks-not-polling decision: #3886.

## Acceptance

- [A1] **Executable** — n/a: an epic. Done when every slice above is resolved and the event-latency measurement shows first look under 30 s p50 for drain, review and fix.
- [A2] Every slice keeps the log lines the measurement script reads (one tick line per handled batch, with wake cause), or extends the script in the same PR.
- [A3] Nothing merges except the drain (statute event-driven-land-is-wake-only).

## Non-goals

- [N1] No second writer to main, and no drain inside the decider process (E2).
- [N2] No durable per-PR workflow engine (Temporal-style); the decide stays a pure function over current state.
- [N3] Limits and thresholds are not part of the standard (E4).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: an epic; each slice carries its own edge cases.
2. **Truncated reads** — n/a: an epic; each slice carries its own edge cases.
3. **Shared state files** — n/a: an epic; each slice carries its own edge cases.
4. **Fail closed** — n/a: an epic; each slice carries its own edge cases.
5. **Identity scoping** — n/a: an epic; each slice carries its own edge cases.
6. **State over time** — n/a: an epic; each slice carries its own edge cases.
7. **Who wrote it** — n/a: an epic; each slice carries its own edge cases.
