---
kind: story
size: 3
parent: "xdlnylv"
status: open
blockedBy: ["x5qtv82"]
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/check-standards.mjs", "we:scripts/lib/duplicate-bornas-added.mjs", "we:scripts/__tests__/check-standards.test.mjs", "we:scripts/lib/__tests__/duplicate-bornas-added.test.mjs"]
dateOpened: "2026-10-13"
tags: [backlog, numbering, ledger, gate]
---

# check-standards accepts x-id card file names that the ledger has numbered

Slice (c) of epic xdlnylv: the hash-on-main, duplicate-number and bornAs rules learn the ledger, so a ledger-numbered x-id card on main is legal and an unledgered one is caught.

## Design

All changes key on `backlog.cardNumbering.mode` (slice (a)). In `rename-before-enqueue` the rules behave
exactly as today. In `rename-after-land` and `ledger-only` the ledger-aware rules below apply.

- `strandedHashesOnMain` (we:scripts/check-standards-rules.mjs:2963, called from
  we:scripts/check-standards.mjs:817): outside `rename-before-enqueue`, an `x<6>` file on `origin/main` is legal when the ledger
  has its row. Without a row it is a warning inside the land window (the existing #2956 commit-time window) and
  an error after it.
- `duplicateBacklogNums` (we:scripts/check-standards-rules.mjs:2842, called at
  we:scripts/check-standards.mjs:775): also refuses a ledger number that equals a numeric file name, and any
  ledger conflict (two numbers for one id, two ids for one number).
- `duplicateBornAs` (we:scripts/check-standards-rules.mjs:2882): an x-named card needs no `bornAs`; a seed row
  that disagrees with a card's `bornAs` is an error.
- `handNumberedNewItems` (we:scripts/check-standards-rules.mjs:3012): unchanged. Hand-picked numbers stay
  forbidden.
- The gate reads the ledger fetched by CI (slice (b) wiring). Offline or unreadable: warn and skip, the same
  fail-soft shape as the existing origin/main read at we:scripts/check-standards.mjs:795.

## MVP

The `strandedHashesOnMain` change plus the ledger-collision check.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the gate consumes slice (a)'s validated rows only.
2. **Truncated reads** — an unreadable ledger downgrades these checks to a warning, never to "all clear".
3. **Shared state files** — read-only.
4. **Fail closed** — an unledgered x-card past the land window is an error, not a warning.
5. **Identity scoping** — checks key on the id, never on the slug.
6. **State over time** — the land-window warning covers the gap between merge and the drain's row; slice (d)
   closes that gap by assigning before enqueue.
7. **Who wrote it** — n/a: the gate reads, it does not judge authorship beyond slice (a)'s reader.

## Test plan

Rule-level unit tests in the existing check-standards rules suite: ledgered x-card on main passes; unledgered
x-card errors after the window and warns inside it; ledger number colliding with a numeric file errors; a
ledger conflict errors; `rename-before-enqueue` keeps today's behaviour byte-for-byte.

## Proof plan

Live: in a lane, add a fixture x-named card plus a fixture ledger row and run `node
we:scripts/operations/run.mjs verify --checkout=<lane>` with `WE_CARD_NUMBERING_MODE=ledger-only`. Before this slice: the
hash-on-main rule errors. After: clean. Remove the row: the rule errors again. Paste all three outputs.

## Done when

- Outside `rename-before-enqueue`, a ledger-numbered x-card on main passes the gate and an unledgered one fails it.
- In `rename-before-enqueue`, the gate output on current main is unchanged.

## Acceptance

- [A1] **Executable** — the new rule tests fail before this lands and pass after
  (`npm run test:unit -- we:scripts/__tests__/check-standards-rules*.test.mjs`).

## Non-goals

- [N1] The #5057 merge_group refusal is not touched here; that is slice (d).
