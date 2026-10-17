---
bornAs: x8a6951
kind: story
size: 8
parent: "6188"
status: open
blockedBy: ["6185", "6186"]
scope: ["we:scripts/operations/incident-evidence.mjs", "we:scripts/conveyor/health-smells/pr-conflicts.mjs", "we:scripts/conveyor/health-smells/pr-fix-rounds.mjs", "we:scripts/conveyor/health-smells/approvals-lost.mjs", "we:scripts/conveyor/health-smells/handoff-gap-p90.mjs", "we:scripts/operations/needs-you-feed.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Evidence bundle, new smells for inefficiency, needs-you escalation

Add the missing inefficiency smells: merge conflicts per PR (2 or more), fix rounds above 4 per PR, the same finding key raised 3 or more times, approvals lost (2 or more per PR), stand-down on a PR, prepare-stale churn (3 or more re-prepares per card), and hand-off gap above its 14-day p90. Build the per-incident evidence bundle (bounded, redacted) on top of the scoped wrappers over coroner-extract, coroner-rounds and coroner-false-findings. Emit needs-you entries with options and a recommendation for the escalate rule. Acceptance: each new smell has tests with a replayed 2026-10-16 fixture (for example #5439 rounds and #5441 approvals lost); the evidence bundle is under 200 KB; an escalate incident shows in operator-queue with a pick; gate-touching scope always escalates (test). Operator decision 2026-10-17 (c): inefficiency incidents are grouped per cause per day, and filed immediately only once 3 or more PRs hit the same cause.

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
