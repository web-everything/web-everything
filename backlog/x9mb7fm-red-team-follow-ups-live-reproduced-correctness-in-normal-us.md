---
kind: story
size: 2
status: open
scope: ["we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7330 (head 0d03d21b2)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7330 (reviewed head `0d03d21b2094f42c6f354652a6c6a783f249d9bf`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:1500` — (failing-input, degraded) An empty orphan hold disables reconcile-plan reuse.
   - Scenario: Run the daemon with standDownAutoProceed=false, stable PR fingerprints and claims, and no held orphans. The daemon nevertheless supplies an excludePrs predicate, which becomes skipStandDownPrs. createReconcilePlanCache treats that callback as an incompatible override, deletes the cached plan and refuses to cache the replacement. Later phases therefore repeat full reconciliation. An isolated three-call probe produced three planner executions with a no-op exclusion versus one without it. Empty holds should preserve plan reuse, for example by passing an empty exclusion array.
   - Class: live-reproduced (basis: Executed the actual createReconcilePlanCache function with dependencies isolated and injected planner, fingerprint and claim readers. Identical inputs planned once; adding skipStandDownPrs returning false to the middle call caused three plans. The daemon unconditionally introduces this callback whenever its orphan guard is required, including when its hold map is empty.)
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
