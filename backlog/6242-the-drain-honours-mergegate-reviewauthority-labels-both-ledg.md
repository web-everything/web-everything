---
bornAs: x2sgweq
kind: story
size: 3
parent: "3007"
status: open
scope: ["we:scripts/conveyor/merge-ai-prs.mjs", "we:scripts/lib/pr-merge-gate.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# The drain honours mergeGate.reviewAuthority (labels|both|ledger)

TOP PRIORITY (operator 2026-10-17): the missing slice, it is the switch. Today only the CI check reads mergeGate.reviewAuthority; the drain only logs a shadow comparison. Done when merge-ai-prs honours labels (unchanged), both (clears only if labels AND ledger clear) and ledger (label input dropped). Cards 3007 / 4284 cover the area. Tests per guarantee: labels mode unchanged; both mode blocks when ledger holds and labels clear; ledger mode ignores labels; unknown value fails closed to labels; setting source logged.

## Acceptance

- [A1] **Executable** — npx vitest run we:scripts/conveyor/__tests__/merge-ai-prs-authority.test.mjs (tests: 'labels mode unchanged', 'both mode blocks when ledger holds', 'ledger mode ignores labels', 'unknown value fails closed to labels', 'setting source logged') fails before and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not flip the setting itself; the flip to ledger waits on the readiness bar.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: reads internal ledger rows and settings only.
2. **Truncated reads** — a partial read is scored as unknown and fails closed (ledger holds), never as agree.
3. **Shared state files** — appends only to existing ledger files, no new shared writer.
4. **Fail closed** — any missing or invalid input resolves to labels authority or a ledger hold.
5. **Identity scoping** — rows keyed by PR and head.
6. **State over time** — n/a: a change to scoring resets the 7-day shadow clock, noted in the digest.
7. **Who wrote it** — setting values carry their cascade source in the log.
