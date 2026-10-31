---
bornAs: xw237s5
kind: story
size: 5
status: open
scopeRationale: we:scripts/conveyor/fix-procedure.mjs is not edited; the fixer push gate lives in we:scripts/operations/fix-run.mjs.
scope: ["we:scripts/lib/review-timing.mjs", "we:scripts/lib/review-timing-settings.mjs", "we:scripts/lib/review-ci-gate-io.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/operations/fix-run.mjs", "we:scripts/lib/__tests__/review-timing.test.mjs", "we:scripts/lib/__tests__/review-timing-settings.test.mjs", "we:scripts/lib/__tests__/review-ci-gate-io.test.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/conveyor/__tests__/review-timing-dispatch.test.mjs", "we:scripts/conveyor/__tests__/review-verify-green.test.mjs", "we:scripts/operations/__tests__/fix-run.test.mjs", "we:docs/agent/testing.md"]
dateOpened: "2026-10-29"
tags: []
---

# Policy-cascade settings review.startBeforeCi and fix.pushAfterCi (default off) to shorten the review+fix cycle under CI

R231 prototype: two default-off cascade settings. review.startBeforeCi lets the review daemon start review (and red team) while CI runs, only when the head has a green local verify marker for that exact sha; merge still needs green CI; red-main CI failures do not count as a round. fix.pushAfterCi makes the fixer hold its push until the previous head CI completed, fold CI findings into one push, bounded wait (fix.pushAfterCiMaxMin, default 30) then push anyway. Extends we:scripts/lib/review-timing.mjs and we:scripts/lib/review-timing-settings.mjs.

## Acceptance

- [A1] **Executable** — vitest over `we:scripts/lib/__tests__/review-timing.test.mjs` and `we:scripts/lib/__tests__/review-timing-settings.test.mjs` fails before and passes after (new startBeforeCi / pushAfterCi cases).
- [A2] **Must** — both settings default off and behave exactly as today; one setting change (platform, tool file or env WE_REVIEW_START_BEFORE_CI / WE_FIX_PUSH_AFTER_CI) toggles each.
- [A3] **Must** — error or missing evidence refuses (waits for CI): no green verify-ledger record for the exact head sha means review waits as today.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Merge gating is unchanged: green CI is still required to merge.
- [N2] No change to the settings when off; no new daemons.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: settings are typed values (boolean / bounded integer), invalid layers ignored by the cascade.
2. **Truncated reads** — n/a: the verify-green ledger record is read whole or treated as absent (fails to wait).
3. **Shared state files** — verify-green ledger is read-only here; a torn or unparsable record counts as absent.
4. **Fail closed** — missing or unreadable marker, unreadable CI state or elapsed bounded wait: review waits for CI (setting 1); fixer pushes anyway after the bound (setting 2, never strands a fix).
5. **Identity scoping** — marker must name the exact head sha; a marker for any other sha never starts review early.
6. **State over time** — a head change voids the early start (existing head-pin); the bounded wait is measured from the first held time, not reset by polls.
7. **Who wrote it** — n/a: marker is written only by verify-lane in a pool lane; ledger record not trusted if gate-less/skipped (existing hasGreenLedger rule).

## Design

- review.startBeforeCi (bool, default false) added to REVIEW_TIMING_DEFAULTS. reviewStartGate gains a `verifyGreen` input (caller reads hasGreenLedger for the exact head sha). When on and verifyGreen is true and no required check is red, the gate allows (reason `verify-marker`) while CI is still running. Same gate serves review and red team. Merge gate untouched.
- CI failing afterwards: for the PR's own code the fix round proceeds as today; a failure attributable to red main (existing red-main detection) does not count toward the round cap.
- fix.pushAfterCi (bool, default false) and fix.pushAfterCiMaxMin (int, default 30) added to FIX_TIMING_DEFAULTS. A pure `fixPushGate` decides push/wait from the previous head's CI state and the first-held time; the fix launcher holds its push until previous head CI completed, folds the CI findings into the same push, then pushes; after the bound it pushes anyway.

## Test plan

- Off: reviewStartGate and the fix push path unchanged (existing tests green plus explicit off cases).
- On: marker present for sha, CI pending -> allowed; marker for another sha / absent -> waits; required check red -> ci-red as today.
- Push: CI pending and under bound -> wait; CI complete -> push with findings folded; bound elapsed -> push; setting off -> push immediately.
- Cascade: defaults, platform, tool file and env layers; invalid values ignored.

## Proof plan

Prototype-load on the review daemon (setting 1) and fix daemon (setting 2), each ON for that daemon only via the env layer. Live PR evidence: a review started (ET timestamp) before the head's CI finished; a fixer push that waited for the previous head's CI completion.
