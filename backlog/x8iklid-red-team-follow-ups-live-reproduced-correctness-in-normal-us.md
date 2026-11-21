---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7280 (head 6479f7e69)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7280 (reviewed head `6479f7e696e807bbc3116fc1019b06d065527931`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/ci-heal-pr-dispatch.mjs:1031` — (edge-case, degraded) Stale-freeze reruns still consume the planner’s ordinary timeout budget
   - Scenario: Confirm stale-freeze reruns for runs 42 and 43 on one PR head, then observe an eligible ordinary timeout on that same head. readTimeoutBudget counts both stale-freeze requests as confirmed ordinary retries. The planner’s retrySpent &lt; 2 condition consequently fails and routes to CI healing, although dispatchTimeoutRetry itself excludes those requests. The ordinary timeout should retain its two retries.
   - Class: live-reproduced (basis: A read-only Node probe supplied two marked stale-freeze records through in-memory filesystem IO to the real readTimeoutBudget function; it returned confirmed: 2. reconcile-pass forwards that budget unchanged, and reconcile-core uses it to enforce the ordinary retry cap.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/conveyor/reconcile-core.mjs:3198` — (failing-input, degraded) The planned stale-freeze review is refused again at dispatch under ci-green timing
   - Scenario: Use review timing ci-green with merge-gate required, complete current-head checks, review:pending, and a correctly annotated sole stale automatic freeze. This branch emits an ordinary review without advisoryReview.ciWaived. The daemon therefore supplies no waiver, and the dispatcher’s fresh readReviewCiGate refuses the still-failed merge-gate. Independent review cannot proceed alongside recovery; a rejected bounded rerun leaves it blocked until operator intervention. The planned review should remain eligible through the dispatch gate.
   - Class: live-reproduced (basis: A read-only probe of the real readReviewCiGate with complete provenance and valid stale-freeze evidence returned the annotation but allowed: false and required-checks-not-successful. Both dispatch adapters enforce that refusal; the daemon forwards waivers only from advisoryReview.ciWaived, which this new branch does not set.)
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
