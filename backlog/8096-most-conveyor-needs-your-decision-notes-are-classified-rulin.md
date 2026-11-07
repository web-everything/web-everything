---
bornAs: xnz8ffr
kind: story
size: 3
status: open
scope: ["we:scripts/operations/operator-queue-needs-person.mjs", "we:scripts/operations/needs-you-feed.mjs", "we:scripts/lib/ruling-ledger.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Most conveyor 'needs your decision' notes are classified 'ruling-needed' by the feed, and the ruling gate the…

Flow-sim gap R8b-G2, class K13 (precondition mismatch fails closed to the operator). Failing input: Open PR with an unanswered trusted note comment of kind awaiting-permission, permission-blocked, session-overrun, infra-retry-exhausted, liveness-wait-exhausted, review-churn or draft-withdrawn (headline 'needs your decision: ...', key 'conveyor-note-key: <kind>:<pr>:...'). No ledger findings on the PR.' 'needs-you-feed tick: o… Cited: we:scripts/operations/operator-queue-needs-person.mjs:13, we:scripts/operations/needs-you-feed.mjs:80, we:scripts/operations/needs-you-feed.mjs:298, we:scripts/operations/needs-you-feed.mjs:305, we:scripts/lib/ruling-ledger.mjs:123. Soak-break sketch: Fixture: item {kind:'ruling-needed', pr:9, repo, head:<40hex>} built via itemsFromReport from a report.needsPerson row {kind:'permission-blocked', headline:'needs your decision: fixer blocked by a permission denial'}; injected lookup=rulingNeeded over a PR wh…

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
