---
bornAs: xloy1no
kind: story
size: 3
status: open
scope: ["we:scripts/operations/ledger-backfill-rulings.mjs", "we:scripts/operations/record-referral-ruling-io.mjs", "we:scripts/operations/__tests__/"]
dateOpened: "2026-10-09"
tags: []
---

# Ledger ruling migration + writer fixes — GATE before running the raw-key migration

Gated follow-up from #4502 (operator approved with gate 2026-10-09: do NOT run the raw-key migration until this lands). In we:scripts/operations/ledger-backfill-rulings.mjs: (1) the raw-key migration can overwrite an authoritative ruling at the same timestamp — key by event id, never overwrite; (2) planRawKeyMigration can turn an inert raw-key CLEARING ruling into a live hashed one — apply the same thread-comment check as the home backfill. In we:scripts/operations/record-referral-ruling-io.mjs: (3) a multi-event batch stops at the first git miss — write all to home, retry git, report partial; (4) use the async store contract (appendVerdictAsync) so plugged async stores work; (5) test the default store mode, not only dual.

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
