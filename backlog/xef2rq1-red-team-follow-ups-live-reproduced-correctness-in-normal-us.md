---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/merge-gate-hold-class.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7531 (head f7ff71717)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7531 (reviewed head `f7ff717175facb12568f632d327977f7a9914f2d`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/merge-gate-hold-class.mjs:255` — (edge-case, degraded) Missing red-team checks incorrectly authorize CI healing for review-only holds
   - Scenario: With candidacyHoldIsNotCiFailure=off, supply a review:pending PR whose required merge-gate failed. Its complete, head-matched verdict has only candidate-label, review-hold-labels, review-acceptance and red-team holds, with red-team reason 'no red-team check run on head'. The new annotation classifies this as real and admitCiHeal returns admitted:true because isRedTeamMissing is recognized as review work only when workflowEditProtection is true. No code failure exists for a healer to repair; this should classify as review and refuse review-hold, preserving the failed check conclusion.
   - Class: live-reproduced (basis: Executed the actual verdict reader/parser, excusal, annotation and admission functions against the complete fixture: parsing succeeded and admission returned classes:[real], basis:real. Also reproduced with excusal on for a PR carrying ready-to-merge and review:pending. Full planner execution was unavailable because checkout dependencies are missing.)
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
