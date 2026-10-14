---
kind: story
size: 5
parent: "xdlnylv"
status: open
blockedBy: ["x5qtv82", "xy5r0uf", "xbpjdsd"]
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
- Refresh keeps the branch's ancestry, so every push is a fast-forward. Never `--force`, never close-and-reopen
  on the same branch (that does not change the branch's history, so the push would still be refused).
  - Build the renamed tree from current `origin/main` (step 2). Read the branch's live tip with
    `git ls-remote origin refs/heads/lane/card-rename-batch`, not a cached ref (the drain may have advanced it).
  - Branch absent: commit the tree with one parent, `origin/main`.
  - Branch present (PR open, or a stale branch left by a landed/closed batch): `git commit-tree <tree>
    -p origin/main -p <live tip>`. Main is the first parent, so the PR diff is exactly the renames; the old tip
    is the second parent, so an ordinary push is a fast-forward. This is the drain's own rebuild
    (we:scripts/lib/rebase-drop-manifest.mjs, steps 3–4 of its header). Before pushing, assert
    `git merge-base --is-ancestor <live tip> <new commit>`; a stale branch with no open PR gets a new PR.
  - No-op: if `origin/main` is already an ancestor of the live tip and the rebuilt tree equals the tip's tree,
    mint no commit and push nothing (the `current` short-circuit of `rebaseDropManifest`).
  - Push refused (the branch moved between the read and the push): re-read the tip, rebuild with it as the
    second parent, retry at most 3 times; then end the run with no PR change and report it.
  - A card already renamed on main is skipped. Same input, same tree.
- Gate: `handNumberedNewItems` (we:scripts/check-standards-rules.mjs:3012) accepts a new numeric file whose
  number and `bornAs` match a ledger row, as `exemptDrainNumberedItems` does for drain commits today.
  Slice (c)'s collision rule also accepts that same-identity equality; it rejects a different/missing
  `bornAs` for the number. Validate unique x-id/`bornAs` identities in the prospective merged tree before
  building the batch; the valid rename replaces one file rather than adding a second identity alias.
- Redirects: the renamed card keeps `bornAs`, so slice (b)'s x-id redirects keep old links working.

## MVP

The job, the cadence setting, the gate exemption, run by hand once.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — only ids matching `HASH_RE` and numbers from validated ledger rows are used; slugs come
   from existing file names.
2. **Truncated reads** — an unreadable ledger or a failed `ls-tree` ends the run with no PR.
3. **Shared state files** — one fixed branch and at most one open batch PR; the run holds the numbering lock
   while it builds the branch. The push is a fast-forward onto the live tip; a refused push re-reads the tip
   and rebuilds (bounded), never `--force`.
4. **Fail closed** — a card whose ledger row conflicts is left as x-id and reported; the rest of the batch
   proceeds.
5. **Identity scoping** — one batch PR per repo; it touches only `backlog/` cards and references to them.
6. **State over time** — a card landed after the batch was built goes into the next batch; an open PR still
   citing the old x-id resolves through the ledger and `bornAs`. Main advancing under an open batch PR is
   handled by the two-parent refresh (first parent main, second the old tip).
7. **Who wrote it** — the batch PR is authored by the drain identity and changes only renames and reference
   rewrites; anything else in its diff fails the job's own self-check.

## Test plan

Fixture repo: two ledgered x-cards and one unledgered → the batch renames the two, leaves the third, rewrites a
`blockedBy` reference; a second run with nothing new opens no PR and pushes nothing;
main advancing under an open batch PR, against a bare remote with `receive.denyNonFastForwards`: build B1
from M0 and push it, land an unrelated commit M1, rerun → B2's parents are (M1, B1), its tree equals a fresh
build on M1, the plain push is accepted, the PR number is unchanged, and no `--force` is used; the same
sequence with a one-parent B2 is refused (the regression this guards). A concurrent push between the read and
the push is refused once, then the retry with the re-read tip succeeds; a stale branch with no open PR gets a
fast-forward commit and a new PR;
`handNumberedNewItems` accepts the renamed files when the ledger matches and refuses a mismatched number.
Run the collision rule on the materialized tree too: matching `bornAs` passes, a different identity errors.
Unreadable introducing history/signatures and duplicate identities abort without creating a PR.

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
