---
bornAs: xayoas1
kind: story
size: 5
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/pr-comment-policy.mjs", "we:scripts/operations/pr-ownership.mjs", "we:scripts/conveyor/pr-stack.mjs", "we:scripts/conveyor/reconcile-pass.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# A stacked top whose base PR left without the drain's retarget (closed unmerged, or merged by hand with the br…

Flow-sim gap R5c-G1, class K18 (state keyed to an identity never checked for liveness or retraction). Failing input: Top PR T: open lane PR, base `lane/X`, labels review:pending or review:accepted/ready-to-merge (via carry or human), checks maybe green. Bottom PR B (head `lane/X`) is either (a) CLOSED unmerged, branch still on origin, or (b) merged in the GitHub UI / by a human without --delete-branch (or the branch delete was withheld by pru… Cited: we:scripts/merge-ai-prs.mjs:1022, we:scripts/lib/pr-comment-policy.mjs:147, we:scripts/operations/pr-ownership.mjs:57-58, we:scripts/conveyor/pr-stack.mjs:145, we:scripts/conveyor/reconcile-pass.mjs:1507-1509. Soak-break sketch: Fixture: open PR T (base lane/X, review:accepted+ready-to-merge, test green) and no open PR with head lane/X (B closed unmerged), then the same with B merged (head on main) and lane/X still on origin. Action: run reconcile/fix planning plus the drain classify…

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
