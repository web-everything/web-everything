---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/pr-status-label.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use, theoretical-race] from web-everything/web-everything#7258 (head d3ac2333f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7258 (reviewed head `d3ac2333f999c4a75704b9c2b2e6963af603ed3a`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/pr-status-label.mjs:75` — (edge-case, degraded) Incomplete rollups can still produce ready-to-merge
   - Scenario: Use review:accepted and red-team:clear with requiredChecks ['test']. Supply a 100-row truncated rollup containing an older successful test, with rowsComplete false and rollupIncomplete true. A newer pending test beyond the truncation is invisible, so the new predicate returns true and readiness is reported. Including the hidden pending row returns false. Incomplete evidence should retain awaiting-ci until a complete current-head read establishes readiness.
   - Class: correctness-in-normal-use (basis: A standalone probe of the copied new predicate reproduced true for the explicitly incomplete rollup and false for the complete rollup. The daemon passes its raw snapshot to the tagger; this helper never checks completeness provenance.)
   - Also class: theoretical-race
   - Claude's re-check: demonstrated break
2. `we:scripts/conveyor/pr-status-label.mjs:163` — (failing-input, degraded) Declared repository requirements leave green PRs awaiting CI indefinitely
   - Scenario: For Frontier UI, let protection discovery return its supported declared policy: source declared and checks ['test']. With review:accepted, red-team:clear and a successful test, tagReviewStatus excludes declared from its accepted roster sources and passes requiredChecks null. The new gate therefore reports awaiting-ci on every tick despite all declared requirements passing. The supported declared roster should be used to establish readiness.
   - Class: correctness-in-normal-use (basis: getRequiredStatusChecks explicitly returns declared on protection-access denial, including from cache. we:review-status-tag.mjs accepts only live, cache and stale-cache. A standalone predicate probe returned false for the resulting null requirements and true for the declared requirements.)
   - Claude's re-check: demonstrated break
3. `we:scripts/conveyor/pr-status-label.mjs:86` — (edge-case, degraded) A superseded pending run blocks a newer successful run
   - Scenario: For an accepted, red-team-clear PR requiring test, supply same-head CheckRun rows with id 1 IN_PROGRESS and id 2 COMPLETED/SUCCESS. The new runs.every check returns false, leaving awaiting-ci even though the newer run supersedes the old one. Select the latest authoritative run before evaluating green, while continuing to block when the newer run is pending.
   - Class: correctness-in-normal-use (basis: A standalone probe of the copied predicate returned false for these two rows. Applying the repository's real collapseRollupToLatestPerName helper selected id 2 and made the predicate return true. Both rows are non-failing, so the preceding requiredCiRed branch does not account for this difference.)
   - Also class: theoretical-race
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
