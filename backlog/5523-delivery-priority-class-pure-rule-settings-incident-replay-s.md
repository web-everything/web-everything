---
bornAs: xjddimd
kind: story
size: 3
parent: "5522"
status: resolved
scaffoldedBy: "priority-class-s1"
dateScaffolded: "2026-10-08"
relatedTo: ["5468", "5510"]
scope: ["we:scripts/lib/delivery-priority.mjs", "we:scripts/lib/delivery-priority-settings.json", "we:scripts/lib/__tests__/delivery-priority.replay.test.mjs", "we:scripts/lib/__tests__/fixtures/delivery-priority.replay.json", "we:scripts/conveyor/delivery-priority-shadow.mjs", "we:scripts/conveyor/__tests__/delivery-priority-shadow.test.mjs", "we:scripts/conveyor/__tests__/fixtures/fix-pass-2026-10-09.json", "we:scripts/conveyor/reconcile-fix-dispatch.mjs"]
dateOpened: "2026-10-08"
dateResolved: "2026-10-08"
tags: [conveyor, delivery-standard, priority]
---

# Delivery priority class: pure rule, settings, incident replay, shadow log on the fix daemon

Slice S1 of epic 5522 (rulings Q1, Q2). A pure rule `deliveryPriority(facts, settings, now)` gives one PR or job a class P0-P4, the reasons, and an in-class score (unblocks x weight + minutes waited). `rankByDeliveryPriority` ranks a whole queue and applies the live-P0 cap. Settings are declared in we:scripts/lib/delivery-priority-settings.json; the off value makes every item P3 and keeps today's order.

Shadow only: the fix daemon (we:scripts/conveyor/reconcile-fix-dispatch.mjs) logs the class each owed PR would get, through the adapter we:scripts/conveyor/delivery-priority-shadow.mjs. It changes no order, refusal or dispatch. Consumers are slice 5524.

The P0 incident fact comes from the main-red owner record that card 5510 (PR #4527) publishes (the coordination-root main-red priority record, written by we:scripts/lib/main-red-priority.mjs once PR #4527 lands: the PR that owns the fix). Until that lands, nothing is P0 live, which is the honest shadow result.

## Acceptance

- [A1] **Executable** — the replay test we:scripts/lib/__tests__/delivery-priority.replay.test.mjs (run with `npm run test:unit`) replays the fixtures (facts + settings in, exact class out) and passes; it fails on a deliberately broken rule.
- [A2] The 2026-10-08 incident replay gives #4522 = P0 (owns the main-red fix) and a class for each of the 14 PRs held by red main, recorded in the fixture with its reason.
- [A3] The rule is a pure function: no IO, clock, network or label strings inside it; `now` and every threshold are inputs. Fact names are standard-shaped.
- [A4] Every setting (mode, agingHours, maxLiveP0, unblockWeightMinutes) is declared with a default; an unknown or malformed value falls back to the off value; mode off gives every item P3 with today's order (one fixture).
- [A5] Aging moves an item up one class after `agingHours` (8), never into P0 (fixture). Operator override urgent -> P0 and low -> P4 win over the derived class; an unverified override is ignored and named in the reasons.
- [A6] The live fix daemon logs one `priority-shadow` line per pass with the class of every owed PR, and its dispatch order is unchanged.

## Non-goals

- [N1] No queue sorts by class yet (slice 5524).
- [N2] No reserve, interruption, incident freeze or speed setting (slices 5525, 5527, 5526).
- [N3] No check of who set an override label on the forge: the shadow adapter treats every label as unverified. The writer check ships with 5524.
- [N4] No merge-gate change (slice 5528).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the rule reads no free text; a fixture carries a title saying "P0 urgent" and proves it changes nothing.
2. **Truncated reads** — a missing fact counts as absent: it can only lower a class to P3, never raise it (fixture with an empty fact set).
3. **Shared state files** — the main-red owner record is only read, never written; an unreadable or expired record counts as "no open episode".
4. **Fail closed** — unknown mode or a malformed number falls back to the off value for that setting.
5. **Identity scoping** — the owner record counts only when its repo and PR match the PR being classed.
6. **State over time** — `now` is an input; fixtures use a fixed `now`; the owner record's own expiry is honoured.
7. **Who wrote it** — the override needs `byOperator: true`; the shadow adapter never sets it, so labels show as "unverified" in the log.
