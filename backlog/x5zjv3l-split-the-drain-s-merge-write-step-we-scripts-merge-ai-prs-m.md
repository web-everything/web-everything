---
kind: story
size: 5
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/drain-hooks/"]
dateOpened: "2026-10-09"
tags: []
---

# Split the drain's merge write step (we:scripts/merge-ai-prs.mjs) into per-feature hook modules so drain features stop colliding on the same lines

Live 2026-10-09: PRs #4624 (lane/red-main-contain) and #4631 (lane/accept-carry-forward) both edit the merge write step in we:scripts/merge-ai-prs.mjs, and both went CONFLICTING with main after #4619 merged its own edits to the same lines (fix commits 425c1954f, bcc3abba1). The fix daemon's scope-overlap fence (net diff via we:scripts/conveyor/net-scope.mjs) saw both PRs on we:scripts/merge-ai-prs.mjs and we:backlog/xx7ckd6-drain-red-main-hold-while-main-is-red-only-the-main-fix-pr-l.md, so their fixes alternated ('refused scope-overlap ... waiting 2nd behind #4631', then the reverse) and each push made the other stale. Every drain feature appends to the same write-step block, so parallel drain features always collide. Split that step into an ordered list of per-feature hook modules under a new we:scripts/drain-hooks/ dir (one file per feature, discovered from disk, like we:scripts/settings/), so a new drain feature adds a file instead of editing shared lines. Same pattern as the per-feature settings split (PR #4563). Stacked-PR handling in the fixer (PR #4655) treats the symptom; this removes the shared hot spot.

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
