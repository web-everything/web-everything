---
bornAs: x56k4dz
kind: story
size: 5
status: open
scope: ["we:scripts/lib/merge-gate-inventory.mjs", "we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/lib/review-escalation.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Direct merge has no red-team gate: red-team:blocked / pending / confirmed break does not stop a non-local rep…

Flow-sim gap D-C3, class K9 (divergent predicates for one state). Failing input: non-local repo; labels [ready-to-merge, review:accepted, red-team:blocked]; red-team break comment on head; CI green' 'post-accept red team confirms a break (labels red-team:blocked), or has no result yet (red-team:pending) Cited: we:scripts/lib/merge-gate-inventory.mjs:32-65, we:scripts/lib/drain-merge-strategy.mjs:354-505, we:scripts/lib/drain-merge-strategy.mjs:352-353, we:scripts/lib/drain-merge-strategy.mjs:300, we:scripts/merge-ai-prs.mjs:1001-1104. Soak-break sketch: ready-red-team-blocked-pr-enqueued (fixPresent=true) covers the QUEUE path only; red-team-deadline-merges-without-result (true) likewise; neither covers direct merge

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
