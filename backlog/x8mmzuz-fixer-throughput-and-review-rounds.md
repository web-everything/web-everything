---
kind: epic
parent: "3383"
status: open
relatedTo: ["5452", "5407", "5461"]
dateOpened: "2026-10-08"
tags: [conveyor, review, fixer]
---

# Fixer throughput and review rounds

Fixer/review proposal, operator 2026-10-08, P1-P6 (all six ruled 2026-10-08). Two findings from the 2026-10-08 fixer audit. Fixers are slow because they wait: about 70% of fixer time is idle after verify, waiting for a fix-daemon tick to push and release the slot. Review rounds rise because each round is a fresh, full, forgetful review: every round re-reads the whole `base..head` diff and the ledger keeps no finding identity, so round N+1 finds new things on code round N already saw. Six PRs with 3+ rounds used 49% of all fix minutes; only 8 of 75 round-2+ findings were rated `broken`.

Parent is #3383 (the mechanical conveyor), not the event-driven daemons epic #5452: these slices span review scope, verify, the lane lease and slot admission, not only the event runtime. A1's interim fast loop swaps to #5452's `verify-finished` event at event-migration step 3 (P2).

## Cross-cutting rule (operator 2026-10-08)

Every policy here is a protocol/standard-shaped PURE rule over plain facts plus declared settings. Today's behaviour is the setting's off value. Each rule ships with replay-fixture tests and standard-shaped names (no forge or label strings in the rule). The core implementation sits behind the rule. The rules are collected into the delivery standard by the "Review & fix policy protocol" card xdsdeeu (under #5407, related to the Decision API slice #5461).

## Slices (blockedBy DAG)

1. xdsdeeu Review & fix policy protocol: pure rules, declared settings, replay fixtures (5), under #5407. Collects every rule below.
2. xm1mi56 Stable finding identity in the ledger + scoped re-review in shadow (5). B1 part 1; proposal "First slices" item 3.
3. xtzqoyq Binding prior round (3), P3 ← xm1mi56.
4. xu7kxtt Heal on an accepted PR keeps the accept; heal commit gets a delta review (3), P4 ← xm1mi56.
5. xlsepow Round budget K=3: accept with cards (2), P5 ← xm1mi56, xtzqoyq (set once B1 is live).
6. x5d9nso Revert-red check on fix pushes (5), P6. Runs inside verify, so it should land after A1 (below) makes verify-to-push fast; prose edge until A1's card exists.

## Filed by other lanes (not re-filed here)

- **A3 lane protection** (never reap, reset or acquire a lane holding verified, unpushed work): being built and filed by the `lane-protect-unpushed` lane. No card or PR existed when this epic was filed; re-parent it here when it lands.
- **A1 push-on-green + A2 slot semantics** (P1: a fixer parked on verify releases its slot and its resume goes first; P2: fast local await-verify push loop now, `verify-finished` event later): being built and filed by the `push-on-green` lane. No card or PR existed when this epic was filed; re-parent it here when it lands and add it to x5d9nso's `blockedBy`.

## Not in scope (from the proposal, unruled)

A4 (verify restarts never drop a running gate), B5 (checklist from top finding classes) and the small A/B fixes were not ruled on 2026-10-08. File them separately if wanted.

## Done when

1. **Executable** — n/a: an epic. Done when every slice above (and the two sibling-lane cards) is resolved, and the protocol card's replay fixtures cover every ruled policy.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: an epic; each slice carries its own edge cases.
2. **Truncated reads** — n/a: an epic; each slice carries its own edge cases.
3. **Shared state files** — n/a: an epic; each slice carries its own edge cases.
4. **Fail closed** — n/a: an epic; each slice carries its own edge cases.
5. **Identity scoping** — n/a: an epic; each slice carries its own edge cases.
6. **State over time** — n/a: an epic; each slice carries its own edge cases.
7. **Who wrote it** — n/a: an epic; each slice carries its own edge cases.
