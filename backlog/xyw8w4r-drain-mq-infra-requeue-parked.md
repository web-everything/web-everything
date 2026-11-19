---
kind: task
status: open
dateOpened: "2026-11-19"
tags: []
---

# Parked: drain auto re-enqueue once after an infra-only merge-group failure (revive only if infra merge-group failures recur after #7107)

Branch lane/drain-mq-infra-requeue (head 7f1babb817) adds one automatic same-head re-enqueue after an infra-only merge-group failure (#7103 hit the 20-min integration timeout). Parked: #7107 removes the root cause. Revive only if infra merge-group failures recur after #7107. Audit round 3 stayed WEAKENED; must-fix: (1) we:scripts/lib/drain-queue-safety.mjs:839 legacy cancelled/regroup path bypasses the new safeguards (red main plus assertion failure in the cancelled job log still retried, log unread); (2) we:scripts/lib/drain-mq-infra-evidence.mjs:97 derived aggregates skip the intrinsic-failure checks; (3) we:scripts/lib/drain-queue-safety.mjs:801 main-green selection skips newer cancelled runs without checking current main HEAD. Original refusal cause: repo-name mismatch (web-everything/web-everything in check URLs) in rerun/job identity.

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

## Duplicate admission

Related cards cover ejection handling generally; this is a parked, specific auto-requeue branch with audit must-fix findings
