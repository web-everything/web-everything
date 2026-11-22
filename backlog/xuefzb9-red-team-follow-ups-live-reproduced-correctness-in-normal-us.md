---
kind: story
size: 2
status: open
scope: ["we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7330 (head 6ec32570e)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7330 (reviewed head `6ec32570e675f9f51190dbab8a35148f0d38f794`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:1491` — (failing-input, degraded) An empty orphan exclusion disables reconciliation plan reuse.
   - Scenario: Run with standDownAutoProceed=false, plan reuse enabled, and no held PRs. The daemon nevertheless supplies an excludePrs function, so fix dispatch forwards skipStandDownPrs. createReconcilePlanCache treats this override as uncacheable, deletes the preceding cache entry and does not store the replacement. Consequently, fix followed by CI-heal performs two full reconciliations despite unchanged fingerprints and claims; the control without the empty predicate performs one. An empty hold should preserve reuse for otherwise compatible planner inputs.
   - Class: live-reproduced (basis: An isolated probe of the checked-out createReconcilePlanCache function reproduced two planner calls with skipStandDownPrs returning false versus one without it, using identical permissions, stable fingerprints and unchanged claims. The daemon-to-dispatch argument forwarding was verified in source.)
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
