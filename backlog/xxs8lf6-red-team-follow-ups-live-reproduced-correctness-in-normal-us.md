---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7280 (head d3914c1c8)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7280 (reviewed head `d3914c1c8c8b8e6c994642dd2ca7d6428e312bec`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/reconcile-core.mjs:3198` — (failing-input, degraded) The emitted review lacks the waiver needed to pass the live review gate.
   - Scenario: Use ci-green review timing and a review:pending PR whose only failed required check is an annotated stale automatic merge-gate freeze. The new branch emits a review without advisoryReview.ciWaived. A probe of readReviewCiGate returns allowed:false, reason:required-checks-not-successful, affected:merge-gate=failure, despite successfully annotating the stale freeze. The dispatcher therefore skips the promised independent review. Review should proceed while merge-gate remains red for merging.
   - Class: live-reproduced (basis: A read-only Node probe invoked the real readReviewCiGate with injected head, verdict, main-CI and freeze readers and observed the refusal. The daemon forwards a waiver only for advisoryReview.ciWaived, which this new dispatch path does not supply.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/conveyor/reconcile-core.mjs:2908` — (edge-case, degraded) Spent stale-freeze rows can indefinitely starve other PRs of rerun capacity.
   - Scenario: Set the supported per-pass rerun limit to 1. PR 100 has already spent its stale-freeze reservation after an API rejection, leaving its original stale failed check; PR 101 needs its first rerun. This branch emits both rows every tick without checking spent state. The executor sorts by PR number and caps before dispatch, so PR 100 repeatedly receives stale-freeze-rerun-spent while PR 101 is always skipped. With the default limit, ten spent PRs cause the same starvation. Spent rows should cease competing for automatic rerun capacity.
   - Class: correctness-in-normal-use (basis: A read-only probe exercised the real executeOwedCiReruns with max=1 and an injected dispatcher returning the production spent-refusal shape. Two successive passes called only PR 100 and each reported skippedOverCap=1. The new planner branch unconditionally recreates the spent row; no race or hostile actor is required.)
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
