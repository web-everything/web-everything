---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xloy1no-ledger-ruling-migration-writer-fixes-gate-before-running-the.md"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a check:standards rule that a card quoting file paths and defects is re-verified against main… (from web-everything/web-everything#4639 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/xloy1no-ledger-ruling-migration-writer-fixes-gate-before-running-the.md:11` — Add a check:standards rule that a card quoting file paths and defects is re-verified against main before it is filed (or at status:open). Short of that, require the card to cite the commit it was observed at.
2. `we:backlog/xloy1no-ledger-ruling-migration-writer-fixes-gate-before-running-the.md:15` — Add a lint that rejects `status: open` cards whose A1 still contains the template `TODO:` text. If it exists, make sure it also applies to gate cards.
3. `we:backlog/xloy1no-ledger-ruling-migration-writer-fixes-gate-before-running-the.md:24` — Add a check:standards rule that rejects a backlog card with an unfilled `TODO:` in Acceptance or Edge cases once it is gating another action. Better, make the migration script refuse to run unless this card's status is done.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4639@17eb1a2a6f85443ca8955d1940820582c479e47a

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
