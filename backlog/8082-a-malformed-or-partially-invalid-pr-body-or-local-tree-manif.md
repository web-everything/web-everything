---
bornAs: xgmu4j6
kind: story
size: 3
status: open
scope: ["we:scripts/readiness/lane-manifest.mjs", "we:scripts/lib/fast-drain-scope.mjs", "we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# A malformed or partially invalid PR-body or local-tree manifest reads as 'no manifest', dropping blockedBy an…

Flow-sim gap R9c-G5, class K15 (detector or report false negative). Failing input: Lane PR whose body manifest block was hand-edited or re-written by a fixer's `gh pr edit --body` (broken JSON, a blockedBy written as '#2151', or a block missing). blockedBy names an open item. Drain builds verdicts. Cited: we:scripts/readiness/lane-manifest.mjs:219-225, we:scripts/readiness/lane-manifest.mjs:124, we:scripts/readiness/lane-manifest.mjs:258-266, we:scripts/lib/fast-drain-scope.mjs:101, we:scripts/merge-ai-prs.mjs:5044-5062. Soak-break sketch: Fixture: PR body with the lane-manifest markers around '{'item':50,'blockedBy':[49],' (truncated) while item 49 is an open candidate. Action: buildDrainVerdicts + planLabelDrain. Assert (fails today): PR 50 is deferred or held with reason 'manifest block pres…

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
