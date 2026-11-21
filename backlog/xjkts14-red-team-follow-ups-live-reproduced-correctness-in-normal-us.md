---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7280 (head d3661f3c4)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7280 (reviewed head `d3661f3c426961f834d54f2e862cfe7e061d6d18`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/reconcile-core.mjs:3197` — (failing-input, degraded) The newly planned review is refused by the dispatcher's CI gate
   - Scenario: Use review timing startAfter=ci-green, require merge-gate, and supply complete current-head rows with only the annotated stale-freeze failure. This branch emits an ordinary review without advisoryReview.ciWaived. The daemon therefore supplies no advisoryCiWaiver, and dispatchReviewJob refuses it because readReviewCiGate still returns required-checks-not-successful for merge-gate=failure. Independent review cannot proceed while the rerun is pending or refused, contrary to the claimed behavior. The head-bound stale-freeze admission must reach the dispatcher while preserving merge refusal.
   - Class: live-reproduced (basis: Executed the real reviewStartGate with complete, matching-head evidence and both stale-freeze annotations; it returned allowed=false with merge-gate=failure. Traced the new planner branch and daemon forwarding: neither supplies the waiver required by dispatchReviewJob.)
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
