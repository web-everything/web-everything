---
bornAs: x9qibqz
kind: story
size: 5
parent: "3007"
status: open
scope: ["we:scripts/lib/pr-merge-gate.mjs", "we:scripts/conveyor/merge-ai-prs.mjs", "we:settings/ledger.json"]
dateOpened: "2026-10-17"
tags: []
---

# Gradual ledger authority per fact type and PR class

TOP PRIORITY (operator 2026-10-17). Settings ledger.authority.<fact> for fact in {redTeamResult, carry, ruling, approval}, each labels|both|ledger, plus ledger.authority.prClass (cards-only|low-risk|all). Every value is a cascade setting with its source logged; each fact type is promoted on its own agreement measure. Promotion order: redTeamResult, then carry, then ruling, then approval; cards-only PRs first. Depends on the drain honouring mergeGate.reviewAuthority. Tests per guarantee: each setting resolves via cascade with source logged; invalid value fails closed to labels; per-fact agreement measure gates promotion; prClass scopes authority; order enforced.

## Acceptance

- [A1] **Executable** — npx vitest run we:scripts/lib/__tests__/ledger-authority.test.mjs (tests: 'each ledger.authority.<fact> resolves via cascade with source logged', 'invalid value fails closed to labels', 'promotion gated per fact agreement measure', 'prClass scopes authority', 'promotion order redTeamResult, carry, ruling, approval enforced') fails before and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not promote any fact type itself; each promotion is a separate settings change.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: reads internal ledger rows and settings only.
2. **Truncated reads** — a partial read is scored as unknown and fails closed (ledger holds), never as agree.
3. **Shared state files** — appends only to existing ledger files, no new shared writer.
4. **Fail closed** — any missing or invalid input resolves to labels authority or a ledger hold.
5. **Identity scoping** — rows keyed by PR and head.
6. **State over time** — n/a: a change to scoring resets the 7-day shadow clock, noted in the digest.
7. **Who wrote it** — setting values carry their cascade source in the log.
