---
kind: task
status: open
scope: ["we:scripts/lib/ledger-readiness-daily.mjs", "we:scripts/lib/ledger-promotion-readiness.mjs", "we:scripts/lib/__tests__/"]
dateOpened: "2026-10-15"
tags: []
---

# Ledger shadow: quiet toggle must not eat the next scheduled check; replay must not over-project agreement

Operator ruling 'card' on PR #5195 red-team breaks (2026-10-15 ~09:45 ET); do before the ledger promotion decision. (1) we:scripts/lib/ledger-readiness-daily.mjs ~89: an overnight quiet toggle records the next day's check at 00:01 so the scheduled 22:00 run is skipped as already-ran; key the daily run by schedule slot, not calendar day. (2) we:scripts/lib/ledger-promotion-readiness.mjs ~95: shadowRow replaces derived.holds with no-ledger-row, hiding an unruled referral, so replay projects agreement it will not reach; keep the real holds. Tests for both.

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
