---
kind: story
size: 5
parent: "xdlnylv"
status: open
scope: ["we:scripts/lib/card-number-ledger.mjs", "we:scripts/lib/queue-branch-numbering.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/settings/card-numbering.json", "we:scripts/lib/policy-cascade.mjs", "we:scripts/backlog/seed-card-number-ledger.mjs", "we:scripts/lib/__tests__/card-number-ledger.test.mjs", "we:scripts/lib/__tests__/queue-branch-numbering.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/lib/__tests__/policy-cascade.test.mjs"]
dateOpened: "2026-10-13"
tags: [backlog, drain, numbering, ledger, shadow]
---

# Card-number ledger store and assign-at-land, in shadow

Slice (a) of epic xdlnylv: an append-only id-to-number ledger on ops/card-numbers, written by the drain at land, running beside today's rename numbering and checked against it.

## Design

- New module `we:scripts/lib/card-number-ledger.mjs`:
  - `readCardLedger({ repo })` reads `card-numbers/<repo>.jsonl` from `ops/card-numbers` through
    `readFromTransportBranch` (we:scripts/lib/git-transport-branch.mjs:354) with the sized-read guard of
    `sizedLedgerRun` (we:scripts/lib/verdict-ledger-io.mjs:92). Returns
    `{ byId, byNum, conflicts, readable, errors }`; consumers must check `readable` before using mappings.
    When false, maps may retain verified rows for diagnostics only; displays fall back to x-ids and
    assignment/merge checks refuse. A missing ledger is unreadable, not an empty successful read.
    Verify each row's introducing commit using the fetched file history and a valid commit signature from
    an explicitly trusted drain signing key. Author names and the row's `by` field are metadata, never
    authentication; checking only the tip is forbidden. This applies to seed, shadow and assign rows.
    Reject and report rows introduced by an untrusted or unsigned commit even beneath a trusted tip,
    and mark the ledger unreadable for consumers; later trusted commits cannot clear that status.
    Missing/shallow history, signature-verification failure or an exceeded history budget makes the ledger
    unreadable; assignment and merge checks fail closed. Display readers may fall back to x-ids.
  - `assignCardNumbers({ repo, ids, pr, floor })` runs inside `withNumberingLock`
    (we:scripts/readiness/drain-lock.mjs). Ids that already have a row return their number (idempotent).
    New ids get `max(ledger, floor) + 1, +2, ...`. Append and push through the fetch / append / bounded-retry
    loop of `appendLedgerRows` (we:scripts/lib/verdict-ledger-io.mjs:163); a non-fast-forward push re-reads and
    recomputes.
  - Row: `{"id","num","pr","at","by":"drain","kind":"assign"|"seed"|"shadow"}`.
- Policy `backlog.cardNumbering.mode` (epic xdlnylv, "Card naming policy"), resolved through `cascadePolicy`
  (we:scripts/lib/policy-cascade.mjs) with its source logged. Declared values: `rename-before-enqueue`,
  `rename-after-land` (standard default), `ledger-only`. This slice adds a repo override in
  we:scripts/settings/card-numbering.json pinning `rename-before-enqueue`, so behaviour does not change until
  slice (d). Env override `WE_CARD_NUMBERING_MODE`.
- Shadow hook: in `prepareBranchBeforeEnqueue` (we:scripts/lib/queue-branch-numbering.mjs:238-300), after
  `numberPendingHashes` returns `n.assigned` (hash to NNN pairs, line 271), write one `kind:"shadow"` row per
  pair with the SAME number the rename chose. The rename path stays the source of truth. A ledger write failure
  is logged as a warning and never blocks the enqueue in shadow mode.
- Seed script `we:scripts/backlog/seed-card-number-ledger.mjs`: one `kind:"seed"` row per existing card with a
  `bornAs: x<6>` line (id = bornAs, num = file number). Dry-run by default; `--apply` pushes once.

## MVP

The store module, the policy key (with the repo override), the shadow write in the enqueue path, and the seed
script. No reader changes.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — rows are parsed with a strict shape (`id` matches `HASH_RE` from
   we:scripts/backlog/id.mjs, `num` a positive integer below 100000); bad lines are counted and skipped.
2. **Truncated reads** — a partial final line is never parsed and marks the ledger unreadable; display
   falls back to x-ids, assignment/merge checks fail closed. A read over the byte cap fails before allocation.
3. **Shared state files** — writes only under `withNumberingLock`; cross-host safety comes from the push
   compare-and-swap; never `--force`.
4. **Fail closed** — in shadow, a failed write warns and the rename path proceeds unchanged; the module itself
   never returns a number it did not read back after the push.
5. **Identity scoping** — the file is per repo (`we.jsonl`, `plateau-app.jsonl`); a row never maps across repos.
6. **State over time** — append-only; a re-enqueue after a dequeue re-reads the existing row instead of minting.
7. **Who wrote it** — authenticate the commit that introduced each row using a trusted drain signing key,
   not a tip commit or `trustedDrainAuthors` author-name comparison. Seed and shadow writers must sign too.
   Row removal/replacement violates append-only history and makes the ledger unreadable.

## Test plan

Red-green unit tests in `we:scripts/lib/__tests__/card-number-ledger.test.mjs` with injected git and fs:
idempotent replay, two concurrent assigners (one push refused, it recomputes), a conflicting row (same id, two
numbers) reported, a partial last line, the floor taken from numeric file names, seed rows built from
`bornAs`.

Required tests in that same suite:
- **Capability (Red today)** — `rejectsUntrustedIntroducerBehindTrustedTip`: an untrusted commit appends a forged row, then a trusted
  signed commit appends a legitimate row. The forged row is absent from both maps; the legitimate row remains.
  Assert `readable: false`, x-id display fallback and zero assignment/enqueue calls despite that trusted row.
  Repeat with a spoofed trusted author name but no trusted signature, and for seed/shadow/assign kinds.
- **Capability (Red today)** — missing introducing history, invalid signatures and row removal/replacement refuse assignment; no writes.
- **Capability (Red today)** — `rejectsOversizedLedgerBeforeAllocation`: enforce a declared byte cap at the transport read boundary,
  fetching at most cap + 1 bytes (the one-byte overflow sentinel), never reading the whole file before checking.
  Assert the actual read range/bytes, zero allocation, append and push calls, and no number returned. Cover
  the initial read. Separately, after one refused push, an overflowing retry read must cause zero further
  allocation, append or push calls and no number returned (the earlier refused attempt is expected).
  History reads also have a declared bounded budget.

## Proof plan

Live: run one drain pass with `mode: shadow` that numbers a real new card. Before: `git show
origin/ops/card-numbers:card-numbers/we.jsonl` has no row for it. After: the row exists and its `num` equals the
NNN the rename gave the file. Paste both outputs.

## Done when

- The shadow rows for the next 5 real numbered cards match their renamed file numbers exactly.
- The seed run has written one row per `bornAs` card, and `readCardLedger` reports zero conflicts.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/card-number-ledger.test.mjs` fails before
  this lands and passes after.
- [A2] The named introducer-authentication and bounded-read tests above are required implementation
  acceptance checks; tip-only verification or full-buffer-then-cap checking must make them red.

## Non-goals

- [N1] No reader, renderer or gate reads the ledger yet; that is slices (b) and (c).
- [N3] No mode other than `rename-before-enqueue` is active yet.
- [N2] The rename commit is not removed here; that is slice (d).
