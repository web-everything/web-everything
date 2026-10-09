---
kind: story
size: 3
status: open
dateOpened: "2026-10-08"
tags: []
---

# Ledger ruling rows: reach the git store + hash the finding key (slice H shadow fixes)

Slice H shadow (PR #4495) found 7 block + 8 ordinary rulings missing from the git store on ops/review-requests (no ruling/send-back rows at all) and ruling rows storing the raw finding key while referral rows store sha256:<hex>, so rulings never close referrals. Fix both writers, backfill today's rulings on open PRs via the sanctioned writer. Operator ruling 2026-10-09: the derive does NOT tolerate raw-key rows (only hashed `sha256:` keys close a referral); existing raw-key rows are migrated once by `ledger-backfill-rulings --migrate-raw` (appends hashed twins, idempotent, raw rows stay in history).

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
