---
kind: story
size: 5
parent: "xdlnylv"
status: open
blockedBy: ["x5qtv82", "xbpjdsd"]
scope: ["we:scripts/card-rename-batch.mjs", "we:scripts/lane-drain.mjs", "we:scripts/lib/card-number-ledger.mjs", "we:scripts/settings/card-numbering.json", "we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/card-rename-batch.test.mjs", "we:scripts/__tests__/lane-drain.test.mjs"]
dateOpened: "2026-10-13"
tags: [backlog, drain, merge-queue, numbering, ledger]
---

# Batched rename-after-land job for ledger-numbered cards

Slice (f) of epic xdlnylv: in mode rename-after-land, a batch job opens one PR on a set cadence that renames landed x-id cards to their ledger NNN and rewrites references, landing through the merge queue. Idempotent; reuses the rename core in we:scripts/lane-drain.mjs.

## Design

- New job `we:scripts/card-rename-batch.mjs`, run only when `backlog.cardNumbering.mode` is
  `rename-after-land`. Cadence is a setting, `backlog.cardNumbering.renameBatch.everyMinutes` (default 60), in
  we:scripts/settings/card-numbering.json through the same cascade.
- Each run, in a fresh worktree from `origin/main`:
  1. List `x<6>` cards on main that have a ledger row. None: exit, no PR.
  2. Rename each to the `<NNN>-<slug>` file name, add `bornAs: <x-id>`, and rewrite references with the existing
     rename-and-rewrite core of `numberPendingHashes` (we:scripts/lane-drain.mjs:682), fed the ledger numbers
     (it never allocates a number).
  3. Commit once and open or refresh ONE PR on a fixed branch (`lane/card-rename-batch`), marked for the drain
     like any other PR. It lands through the merge queue: one CI run per batch.
- Idempotent: a rerun with the batch PR still open rebuilds the same branch from current main (a normal push of
  a new commit, never `--force`; if the branch has diverged, it closes the PR and opens a new one). A card
  already renamed on main is skipped. Same input, same tree.
- Gate: `handNumberedNewItems` (we:scripts/check-standards-rules.mjs:3012) accepts a new numeric file whose
  number and `bornAs` match a ledger row, as `exemptDrainNumberedItems` does for drain commits today.
- Redirects: the renamed card keeps `bornAs`, so slice (b)'s x-id redirects keep old links working.

## MVP

The job, the cadence setting, the gate exemption, run by hand once.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — only ids matching `HASH_RE` and numbers from validated ledger rows are used; slugs come
   from existing file names.
2. **Truncated reads** — an unreadable ledger or a failed `ls-tree` ends the run with no PR.
3. **Shared state files** — one fixed branch and at most one open batch PR; the run holds the numbering lock
   while it builds the branch.
4. **Fail closed** — a card whose ledger row conflicts is left as x-id and reported; the rest of the batch
   proceeds.
5. **Identity scoping** — one batch PR per repo; it touches only `backlog/` cards and references to them.
6. **State over time** — a card landed after the batch was built goes into the next batch; an open PR still
   citing the old x-id resolves through the ledger and `bornAs`.
7. **Who wrote it** — the batch PR is authored by the drain identity and changes only renames and reference
   rewrites; anything else in its diff fails the job's own self-check.

## Test plan

Fixture repo: two ledgered x-cards and one unledgered → the batch renames the two, leaves the third, rewrites a
`blockedBy` reference; a second run with nothing new opens no PR; a run with an open batch PR refreshes it;
`handNumberedNewItems` accepts the renamed files when the ledger matches and refuses a mismatched number.

## Proof plan

Live, after slice (d) has landed some x-id cards: before, `git ls-tree origin/main backlog/ | grep '/x'` lists
them. Run the job; it opens one PR; after it lands through the queue the same command lists none of them and
each renamed card shows its ledger number and `bornAs`. Paste both listings and the PR's CI run count (one).

## Done when

- One real batch PR has landed through the merge queue with a single CI run.
- A second run with no new x-id cards on main opens nothing.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/__tests__/card-rename-batch.test.mjs` fails before this
  lands and passes after.

## Non-goals

- [N1] Renaming cards in modes other than `rename-after-land`.
- [N2] Renaming existing NNN cards.
