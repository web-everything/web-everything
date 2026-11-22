---
kind: story
size: 2
status: open
scope: ["we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7330 (head 8b984fd43)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7330 (reviewed head `8b984fd43f9621f8f597b5045b4f8a20935a537c`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:1491` — (failing-input, degraded) An exclusion predicate disables plan reuse even when no PRs are held
   - Scenario: Enable the orphan guard, set standDownAutoProceed=false, and run a pass with unchanged fingerprints, unchanged claims and zero held PRs. The daemon still supplies excludePrs as a function. The dispatcher consequently adds skipStandDownPrs, which createReconcilePlanCache rejects as an unsupported override: it deletes the cache entry and does not cache the replacement. A subsequent CI-heal reconciliation therefore runs the full planner again. Replaying fix, CI-heal and promotion inputs produced two planner executions versus one without the empty exclusion. Empty holds should preserve plan reuse.
   - Class: live-reproduced (basis: Executed the checked-out createReconcilePlanCache function body with a counting planner and stable injected probes. The production argument path unconditionally supplies the predicate whenever requireOrphanGuard is true. Full module tests could not load because gray-matter is absent.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break

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
