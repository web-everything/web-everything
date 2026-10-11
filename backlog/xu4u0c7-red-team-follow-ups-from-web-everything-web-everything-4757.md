---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/fix-resume.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#4757 (head 965af3a67)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#4757 (reviewed head `965af3a67087b16c94c8f15163d55457cfba2135`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/fix-resume.mjs:313` — (failing-input, degraded) A rewritten stacked base can pass the no-rebase guard.
   - Scenario: Start with M→A→C, where the base branch points to A and the fixer's PR head is C. Rewrite the base to M→B, leaving C unchanged. The current PR commit list now includes A followed by C, so prFirstParent returns M rather than the previous base A. Comparing M...B returns 'ahead', and planRoundResume permits resume despite the base rewrite. A read-only module probe using this graph's API responses returned rebased:false and resume:true. The guard should compare a base SHA recorded for the previous round against the current base, or decline when that historical relationship cannot be proved.
   - Claude's re-check: prFirstParent reads the first commit of the PR's current commit list. After the base is rewritten with the PR head unchanged, that list includes the old base commit A, so the first parent is M, an ancestor of the new base B. Compare M...B returns 'ahead', so the guard reports rebased:false and resume proceeds. The check never uses a SHA recorded for the earlier round.

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
