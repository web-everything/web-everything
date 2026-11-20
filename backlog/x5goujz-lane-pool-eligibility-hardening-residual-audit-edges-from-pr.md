---
kind: story
size: 5
status: open
scope: ["we:scripts/lane-pool.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Lane-pool eligibility hardening: residual audit edges from PR 7220

Reinforce-later card (R825/R1085 waiver) for PR 7220 round-2 findings: we:scripts/lane-pool.mjs history check ordering before lease claim, provision --acquirable growth ignoring laneEligibilityProbeFailed, list --no-cache caching failed probes, ambiguous origin/<branch> shorthand, git cherry omitting merges, assume-unchanged/skip-worktree, --no-reset HEAD-only check. Findings are verbatim in the waiver record for lane/autopick-skip-unpushed.

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
