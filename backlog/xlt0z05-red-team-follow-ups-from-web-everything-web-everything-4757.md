---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/fix-resume.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#4757 (head d96752c42)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#4757 (reviewed head `d96752c4290a54f9fa19ae6e1d719e6f4183d854`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/fix-resume.mjs:313` — (failing-input, degraded) A rewritten stacked base can pass the no-rebase check.
   - Scenario: Start with A→B→C, where the base branch points to B and the PR/fixer head is C. Force-push the base to A→D without moving C. The PR commit list now includes B and C, so prFirstParent reads A from B's parents. Comparing A...D returns 'ahead', and baseRebasedUnder reports rebased:false. A read-only probe through these functions and planRoundResume returned resume:true for this input. The session therefore resumes despite the base rewrite that should force a cold start. The check must compare against a base anchor recorded before the rewrite, rather than deriving it from the current PR commit lis
   - Claude's re-check: prFirstParent reads the first commit of the current PR commit list. After a base rewrite, GitHub's list includes the old base commits (B,C), so its parent A is still an ancestor of the rewritten base. The compare then returns 'ahead' and rebased:false, so an ordinary base rebase goes undetected and the resume proceeds.
2. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1881` — (edge-case, degraded) A resumed fixer and a fresh fixer can be assigned the same free lane in one pass.
   - Scenario: The free-lane snapshot is [4,5]. PR #77 resumes its previous session, whose released, untouched lane-4 is to be re-acquired. The success branch continues without removing lane-4 from the snapshot. The next ordinary dispatch, PR #78, shifts lane-4 and receives a brief pinned to it. A read-only runReconcileFixDispatch probe with injected IO returned both dispatches with lane:4 and no refusals. Whichever worker acquires second fails despite lane-5 being available. Round resumes that need to acquire a lane must participate in lane allocation and consume the selected slot before subsequent dispatch
   - Claude's re-check: The round-resume branch does 'continue' without removing anything from 'lanes'. A resumed session whose released lane-4 is 'free' is meant to re-take lane-4. That lane is still in the free-lane snapshot, so the next ordinary dispatch shifts it and gets a brief pinned to the same lane, and the two collide.

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
