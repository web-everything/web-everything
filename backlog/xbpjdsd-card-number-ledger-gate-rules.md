---
kind: story
size: 3
parent: "xdlnylv"
status: open
blockedBy: ["x5qtv82", "xy5r0uf"]
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/check-standards.mjs", "we:scripts/lib/duplicate-bornas-added.mjs", "we:scripts/__tests__/check-standards-rules.test.mjs", "we:scripts/__tests__/check-standards.test.mjs", "we:scripts/lib/__tests__/duplicate-bornas-added.test.mjs"]
dateOpened: "2026-10-13"
tags: [backlog, numbering, ledger, gate]
---

# check-standards accepts x-id card file names that the ledger has numbered

Slice (c) of epic xdlnylv: the hash-on-main, duplicate-number and bornAs rules learn the ledger, so a ledger-numbered x-id card on main is legal and an unledgered one is caught.

## Design

The ledger-aware rules below apply in every mode (slice (a)), including `rename-before-enqueue`: a rollback
must accept ledger-numbered x-cards already on main. Unledgered cards keep today's refusal/window behavior.

- `strandedHashesOnMain` (we:scripts/check-standards-rules.mjs:2963, called from
  we:scripts/check-standards.mjs:817): in every mode, an `x<6>` file on `origin/main` is legal when the ledger
  has its row. Without a row it is a warning inside the land window (the existing #2956 commit-time window) and
  an error after it.
- `duplicateBacklogNums` (we:scripts/check-standards-rules.mjs:2842, called at
  we:scripts/check-standards.mjs:775): refuses a ledger number equal to a numeric file name only when the
  ledger id differs from that numeric card's `bornAs` (including missing `bornAs`). Matching identities
  pass: seeded existing cards and cards materialized by the rename batch legitimately have this equality.
  Any ledger conflict (two numbers for one id, two ids for one number) remains an error.
- An x-id may identify at most one backlog file in the effective main-plus-PR tree. Check x-id file tokens
  and numeric cards' `bornAs`, independent of slug and ledger presence. Build the prospective merged tree
  (apply additions, deletions and renames to main); the same file seen on both refs counts once, and a valid
  x-to-numeric rename with matching `bornAs` counts once. Reusing an existing id in a second file errors.
- `duplicateBornAs` (we:scripts/check-standards-rules.mjs:2882): an x-named card needs no `bornAs`; a seed row
  that disagrees with a card's `bornAs` is an error.
- `handNumberedNewItems` (we:scripts/check-standards-rules.mjs:3012): unchanged. Hand-picked numbers stay
  forbidden.
- The gate reads the ledger fetched by CI (slice (b), xy5r0uf wiring, hence blockedBy). Outside merge_group,
  offline/unreadable means warn and skip only the ledger-dependent checks, never "all clear"; duplicate
  file identities still error. Inside merge_group, unreadable (including failed fetch, missing history,
  truncation/over-cap or failed authentication) is an error in every mode, with no window exemption.
  Slice (d) replaces #5057's blanket x-file refusal; until then that refusal remains too.

## MVP

The `strandedHashesOnMain` change plus the ledger-collision check.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the gate consumes slice (a)'s validated rows only.
2. **Truncated reads** — unreadable warns only outside merge_group; inside merge_group it errors.
3. **Shared state files** — read-only.
4. **Fail closed** — an unledgered x-card past the land window errors; in merge_group unreadable ledger
   always errors and, once slice (d) replaces #5057, an unledgered x-card always errors, even inside the window.
5. **Identity scoping** — check uniqueness across the prospective merged tree, keyed on x-id or `bornAs`,
   never the slug; seed/materialization equality is accepted only for the same identity.
6. **State over time** — the land-window warning covers the gap between merge and the drain's row; slice (d)
   closes that gap by assigning before enqueue.
7. **Who wrote it** — n/a: the gate reads, it does not judge authorship beyond slice (a)'s reader.

## Test plan

Rule-level unit tests in the existing check-standards rules suite: ledgered x-card on main passes; unledgered
x-card errors after the window and warns inside it outside merge_group; ledger number colliding with a different identity errors; a
ledger conflict errors; after rollback to `rename-before-enqueue`, ledgered x-cards still pass, while
unledgered cards retain today's window/error behavior.

Required tests in `we:scripts/__tests__/check-standards-rules.test.mjs`:

- **Capability (Red today)** — `sameIdentityLedgerAndNumericCardPass`: matching ledger id and numeric card `bornAs` pass for both seed
  and rename-batch fixtures; different or absent `bornAs` sharing a number fail.
- **Capability (Red today)** — `duplicateXIdAcrossMainAndPrErrors`: a PR adds a differently slugged file with an already ledgered main
  x-id; error. Also cover two PR additions, x-file plus numeric `bornAs`, and two numeric `bornAs` aliases.
  Unchanged same-path files and a proper x-to-numeric rename pass.
- **Capability (Red today)** — `unreadableLedgerInMergeGroupErrors` and `unreadableLedgerOutsideMergeGroupWarns`: paired context tests
  for failed fetch with stale ref, deleted/renamed ledger file, missing history, authentication failure and
  over-cap/truncated read; repeat in all modes and inside the land window.

Integration in `we:scripts/__tests__/check-standards.test.mjs`: exercise the CI-fetched ledger through the
real rule caller in merge_group, then fail the fetch and assert nonzero exit. An injected-ledger unit test
alone is insufficient proof of wiring.

## Proof plan

Live: in a lane, add a fixture x-named card plus a fixture ledger row and run `node
we:scripts/operations/run.mjs verify --checkout=<lane>` with `WE_CARD_NUMBERING_MODE=ledger-only`. Before this slice: the
hash-on-main rule errors. After: clean. Remove the row: the rule errors again. Paste all three outputs.
Also run with merge_group context and the CI fetch path: a failed fetch must error despite a stale ref;
the same unreadable state outside merge_group warns. Record both outputs.

## Done when

- In every mode, a ledger-numbered x-card on main passes the gate and an unledgered one fails after the window.
- In `rename-before-enqueue`, the gate output on today's numeric main is unchanged; ledgered x-cards added
  before a rollback remain accepted.
- CI wiring is exercised, unreadable ledger errors in merge_group, duplicate x-ids fail, and same-identity
  numeric/ledger equality passes in the named tests.

## Acceptance

- [A1] **Executable** — the new rule tests fail before this lands and pass after
  (`npm run test:unit -- we:scripts/__tests__/check-standards-rules*.test.mjs`).

## Non-goals

- [N1] The #5057 merge_group refusal is not touched here; that is slice (d).
