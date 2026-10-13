---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/stale-base-refresh.mjs", "we:scripts/operations/fix-run.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5185 (head 65024811c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5185 (reviewed head `65024811c40cb0c9afcad37166a90200c00d6923`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/stale-base-refresh.mjs:242` — (edge-case, degraded) Failure to post the budget marker allows repeated refresh attempts on the same base.
   - Scenario: A qualifying refresh fails, for example with a rejected push, and its GitHub budget comment also fails or is deferred. The catch only logs the comment failure and retains no durable reservation. If the subsequent fixer makes no change, the next tick sees the same merge base with budgetSpent=false and attempts the refresh again. An in-memory gate probe reproduced two refresh attempts on identical facts with zero recorded markers. Failed attempts should remain durably spent even when the comment cannot be published.
   - Claude's re-check: The gate only logs a postComment failure. A non-rebased refresh then returns null with no durable marker, so the next tick sees budgetSpent=false on the same mergeBase and can refresh again.
2. `we:scripts/operations/fix-run.mjs:413` — (edge-case, degraded) A failed review gate is treated as a code failure to heal even when CI is green.
   - Scenario: A ci-heal is planned while test CI is red, but its rerun succeeds before the launcher reads the rollup; review-gate remains FAILURE because review:pending still exists. readCiHealInputs includes review-gate without applying the existing CI-truth exclusions, so the no-ci-failure refusal is bypassed and a repair agent runs against a label-dependent check that code edits cannot clear. A dependency-stubbed runFixCli probe with test=SUCCESS and review-gate=FAILURE reproduced one agent spawn and a no-change outcome. This sequence should refuse as no-ci-failure and release the claim.
   - Claude's re-check: readCiHealInputs keeps any FAILURE/TIMED_OUT/STARTUP_FAILURE rollup entry with no workflow filter. A red review-gate with test green gives non-empty checks, so the no-ci-failure refusal is skipped and an agent is spawned.

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
