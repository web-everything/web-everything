---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#4912 (head 9b3e9871a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#4912 (reviewed head `9b3e9871a9e3ed4166332f30731f27688137f643`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/reconcile-core.mjs:2119` — (edge-case, degraded) An awaiting-base label suppresses the operator handoff for an orphaned base.
   - Scenario: Reproduced using the new test's pr() fixture and plan(): set baseRefName to 'lane/closed-base', labels to review:changes and review-status:awaiting-base, and supply no other PRs. At attempts 7/cap 6, the planner emits no dispatch and a stacked-awaiting-base note with basePrNumber:null claiming 'nobody needs to act'. isStatusOnlyNote returns true, so the PR-comment sink suppresses the handoff. This also reproduces with isDraft:true and a completed failing test check; the status tagger legitimately retains awaiting-base for that draft. gateHoldReason prioritizes the label, and this new condition
   - Claude's re-check: The diff sets 'selfClearing = takeover.hold === 'awaiting-base' || (stacked-base-unmerged && basePr)'. 'awaiting-base' therefore skips the open-base-PR check. With an orphaned base, this emits a status-only 'stacked-awaiting-base' note ('basePrNumber: null') saying 'nobody needs to act'. That contradicts the code's own comment that an unowned base never clears. The test even asserts this status-only result for 'awaiting-base' with no other PRs. That 'gateHoldReason' returns 'awaiting-base' when the label is present is not visible in the diff, so this part rests on the claim.

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
