---
bornAs: xg7whui
kind: story
size: 5
parent: "6122"
status: open
blockedBy: ["6121", "6124", "6125"]
scope: ["we:scripts/card-rename-batch.mjs", "we:scripts/lane-drain.mjs", "we:scripts/backlog/id.mjs", "we:scripts/backlog/__tests__/id.test.mjs", "we:scripts/lib/card-number-ledger.mjs", "we:scripts/settings/card-numbering.json", "we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/card-rename-batch.test.mjs", "we:scripts/__tests__/lane-drain.test.mjs"]
dateOpened: "2026-10-13"
tags: [backlog, drain, merge-queue, numbering, ledger]
---

# Batched rename-after-land job for ledger-numbered cards

Slice (f) of epic 6122: in mode rename-after-land, a batch job opens one PR on a nightly cadence that renames landed x-id cards to their ledger NNN and rewrites references, landing through the merge queue. Idempotent; reuses the rename core in we:scripts/lane-drain.mjs.

## Ruling 2026-10-19: nightly cadence, and x-id references are rewritten

Operator ruling of 2026-10-19 (recorded in epic 6122), point 3: renames are NOT hourly. This job runs NIGHTLY.
The cadence is its own setting, `backlog.cardNumbering.renameCadence`, default `nightly` (source logged through
the cascade); it replaces `renameBatch.everyMinutes` (default 60) as the cadence knob, and `everyMinutes` below
is read as legacy. Each nightly batch renames every fallback `x<6>` card that has a ledger row to `NNN-slug` and
rewrites x-id references to the number everywhere they appear, including the ~830 lines in `backlog/` and the
~890 lines outside it (mostly test fixtures and replays) that cite x-ids today, so humans see numbers, not a mix.
`bornAs:` and `formerSlugs` values stay untouched, as designed below. Where the text below says "hourly", read
"nightly".

## Design

- New job `we:scripts/card-rename-batch.mjs`, run only when `backlog.cardNumbering.mode` is
  `rename-after-land`. `--dry-run` builds the commit and prints it, the rename-set digest and the diff, but
  pushes nothing and opens no PR. `--no-pr` pushes the branch but makes no `gh` call at all (no PR lookup,
  open or close), for fixture runs against a local origin. Cadence is a setting, `backlog.cardNumbering.renameBatch.everyMinutes` (legacy; the nightly `backlog.cardNumbering.renameCadence` replaces it), in
  we:scripts/settings/card-numbering.json through the same cascade.
- Each run, in a fresh worktree from `origin/main`:
  1. List `x<6>` cards on main that have a ledger row. None: exit, no PR.
  2. Rename each to the `<NNN>-<slug>` file name, add `bornAs: <x-id>`, and rewrite references with the
     existing rename-and-rewrite core of `numberPendingHashes` (we:scripts/lane-drain.mjs:682), fed the ledger
     numbers (it never allocates a number). Then append two entries to the card's `formerSlugs` (create the
     array if absent, keep existing entries, never add one twice): the old full file stem (`<x-id>-<slug>`,
     exactly as on main) and the bare `<x-id>`.
     - The rewrite must leave every `formerSlugs` value alone, as it already leaves `bornAs:` lines alone.
       Today `applyLedger` (we:scripts/backlog/id.mjs:234) rewrites every whole-token hash on every line
       except `bornAs:`, and a hyphen is a token boundary. So it would turn `x7k2q9a-slug` into
       `<NNN>-slug` (the card's own id, which the `formerSlugs` rule rejects) and erase older entries such as
       `x7k2q9a-old-wording`. Extend that exemption to the `formerSlugs` frontmatter value, in both the
       inline (`formerSlugs: [...]`) and block-list (`- ...` items) forms, and only inside the frontmatter
       block.
  3. Commit once and open or refresh ONE PR on a fixed branch (`lane/card-rename-batch`), marked for the drain
     like any other PR. It lands through the merge queue: one CI run per batch.
- Refresh keeps the branch's ancestry, so every push is a fast-forward. Never `--force`, never close-and-reopen
  on the same branch (that does not change the branch's history, so the push would still be refused).
  - Rename set: the sorted list of `(x-id, new path)` pairs the run would apply. Its digest is written into the
    commit message and the PR body (`rename-set: <sha256>`).
  - Push only when the rename set changed. If the live tip's digest equals this run's, mint no commit and push
    nothing, even if main moved: a PR that is merely behind main is the drain's to bring up to date
    (`rebaseDropManifest`), so the nightly cadence never restarts CI on its own. Never push while the batch PR
    is in the merge queue; a head change would drop it from the queue. Wait for the next run.
  - Each attempt (at most 3) starts over, under the numbering lock:
    1. `git ls-remote origin refs/heads/lane/card-rename-batch`. Failure ends the run; only a successful empty
       answer means "branch absent".
    2. Fetch `origin/main` and, if present, the lane ref into the worktree with full history (deepen a shallow
       clone, as `ensureFullHistory` in we:scripts/lib/rebase-drop-manifest.mjs does). A missing tip commit
       ends the run; `commit-tree -p` and `is-ancestor` are never run on an unfetched sha.
    3. Rebuild the tree from this attempt's `origin/main` (step 2 above). Never reuse an earlier attempt's tree
       or main.
    4. Branch absent: commit the tree with one parent, `origin/main`. Branch present (PR open, or a stale
       branch left by a landed/closed batch): `git commit-tree <tree> -p origin/main -p <live tip>`. Main is
       the first parent, so the PR diff is exactly the renames; the old tip is the second parent, so an
       ordinary push is a fast-forward. This is the drain's own rebuild (we:scripts/lib/rebase-drop-manifest.mjs,
       steps 3–4 of its header).
    5. Before pushing, assert `git merge-base --is-ancestor <live tip> <new commit>` and
       `git merge-base --is-ancestor <live tip>^1 origin/main`. Both writers (this job and the drain) put main
       first, so `<tip>^1` is the main the tip was built on; a tip built on a newer main than ours means our
       main is stale, so start the next attempt (a stale tree would revert that main's changes).
    6. Self-check: `git diff <fresh origin/main>...<new commit>` holds only the renames, the `bornAs` and
       `formerSlugs` lines, and the reference rewrites of this rename set (edge case 7). Every renamed card's
       `formerSlugs` holds its old stem and its bare x-id, and no earlier entry changed.
    7. Plain push. Refused (the branch moved): next attempt. After 3, end the run with no PR change and report.
  - PR: after a successful push, or a no-op, make sure one batch PR is open on the branch, so a crash between
    push and `gh pr create` is healed by the next run. A batch PR closed unmerged by a person with the same
    rename-set digest is a veto: open nothing and report it until the set changes.
  - Mode switch: outside `rename-after-land` the job opens and pushes nothing. It closes an open batch PR that
    is not in the merge queue, with a comment naming the mode; an enqueued one may land, since its names are
    the ledger's numbers and valid in every mode.
  - A card already renamed on main is skipped. Same input, same tree.
- Gate: `handNumberedNewItems` (we:scripts/check-standards-rules.mjs:3012) accepts a new numeric file whose
  number and `bornAs` match a ledger row, as `exemptDrainNumberedItems` does for drain commits today.
  Slice (c)'s collision rule also accepts that same-identity equality; it rejects a different/missing
  `bornAs` for the number. Validate unique x-id/`bornAs` identities in the prospective merged tree before
  building the batch; the valid rename replaces one file rather than adding a second identity alias.
  Identities are read from frontmatter only (as slices (a) and (c) do), never from a `^bornAs:` line scan
  over whole files, which also matches body text such as card 4658's.
- Redirects: every published route of the x-named card keeps resolving after the rename.
  - `/backlog/<x-id>-<slug>/` (the old canonical page) and `/backlog/<x-id>/`: served by the two
    `formerSlugs` entries from step 2, through the existing old-slug redirect pages
    (`we:src/_data/backlogAliases.js`, `we:src/backlog-slug-redirects.njk`), validated by the existing
    `formerSlugs` rule in we:scripts/check-standards.mjs (6d-bis). Slice (b) emits `/backlog/<x-id>/` only
    while the card is x-named and emits neither route for a numeric card, so this slice owns both. Only the
    renamed card gets these entries, so the bare x-id never maps to two pages.
  - `/backlog/<NNN>/`: today's numeric-card redirect (we:src/_data/backlogRedirects.js), once the file is
    numeric.

## MVP

The job, the cadence setting, the gate exemption, run by hand once.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — only ids matching `HASH_RE` and numbers from validated ledger rows are used; slugs come
   from existing file names.
2. **Truncated reads** — an unreadable ledger or a failed `ls-tree` ends the run with no PR.
3. **Shared state files** — one fixed branch and at most one open batch PR; the run holds the numbering lock
   while it builds the branch. The push is a fast-forward onto the live tip; a refused push starts a fresh
   attempt (re-read tip, re-fetch main, rebuild the tree; at most 3), never `--force`. A tip built on a newer
   main than the job's own makes the job refetch, so it never pushes a tree that reverts main.
4. **Fail closed** — a card whose ledger row conflicts is left as x-id and reported; the rest of the batch
   proceeds.
5. **Identity scoping** — one batch PR per repo; it touches only `backlog/` cards and references to them.
6. **State over time** — a card landed after the batch was built goes into the next batch; an open PR still
   citing the old x-id resolves through the ledger and `bornAs`. Main advancing under an open batch PR is
   handled by the two-parent refresh (first parent main, second the old tip).
7. **Who wrote it** — the batch PR is authored by the drain identity and changes only renames, the
   `bornAs`/`formerSlugs` lines and reference rewrites; anything else in its diff fails the job's own
   self-check.

## Test plan

Fixture repo: two ledgered x-cards and one unledgered → the batch renames the two, leaves the third, rewrites a
`blockedBy` reference; a second run with nothing new opens no PR and pushes nothing, also after main moved
(same rename set, no new head).
Against a bare remote with `receive.denyNonFastForwards`:
- Main advances with a new ledgered card: build B1 from M0 and push it, land M1 (one more ledgered x-card plus
  an unrelated change), rerun → B2's parents are (M1, B1), its tree equals a fresh build on M1, the plain push
  is accepted, the PR number is unchanged, and no `--force` is used. The same sequence with a one-parent B2 is
  refused (the regression this guards).
- The drain rebuilds the tip onto M2 between the job's main fetch (M1) and its push → the job does not push a
  tree built on M1; it refetches, rebuilds on M2, and the final `M2...head` diff has only renames.
- A concurrent push between the read and the push is refused once; the retry re-reads the tip and main and
  succeeds. Three refusals end the run with no PR change.
- A shallow worktree that lacks the tip commit deepens before `commit-tree`; an unreachable tip ends the run.
- A failed `ls-remote` ends the run (not treated as "branch absent").
- A stale branch with no open PR gets a fast-forward commit and a new PR; a push followed by a crash before
  PR creation gets its PR on the next run; a PR closed unmerged with the same digest is not reopened.
- An enqueued batch PR is not pushed to. Mode `ledger-only` closes an unenqueued batch PR and pushes nothing.
`handNumberedNewItems` accepts the renamed files when the ledger matches and refuses a mismatched number.
Run the collision rule on the materialized tree too: matching `bornAs` passes, a different identity errors.
Unreadable introducing history/signatures and duplicate identities abort without creating a PR.
- **Capability (Red today)** — `materializedCardKeepsFullStemRoute`: after the batch renames the fixture
  card with stem `x7k2q9a-slug` to stem `<NNN>-slug`, the card's `formerSlugs` holds `x7k2q9a-slug` and
  `x7k2q9a`; a card that already had `formerSlugs: [x7k2q9a-old-wording]` (inline and block-list forms)
  keeps that entry unchanged through the reference rewrite; a body reference to `x7k2q9a` is still
  rewritten; a second run adds no duplicate. Through the real loaders, `backlogAliases` yields rows from
  both `x7k2q9a-slug` and `x7k2q9a` to `<NNN>-slug`, and the existing `formerSlugs` rule passes. A batch
  commit missing either entry fails the job's self-check.
- In we:scripts/backlog/__tests__/id.test.mjs, `applyLedgerSkipsFormerSlugs`: `applyLedger` leaves
  `formerSlugs` values (both forms) untouched and still rewrites the same hash elsewhere in the file.

## Proof plan

This slice lands BEFORE slice (d) (6127 lists it in `blockedBy`), while the repo override still pins
`rename-before-enqueue`, so real main has no ledgered x-id cards yet. Its proof therefore runs against a
fixture, never real main, and the live landed batch is slice (d)'s proof:

- In a lane, make a scratch clone whose `origin` is a local bare copy of the lane. On its main, commit two
  fixture x-cards, one unledgered x-card and a fixture `ops/card-numbers` ledger signed by a test key that
  the scratch's trust root (slice (a)) lists. Run the job by hand with `WE_CARD_NUMBERING_MODE=rename-after-land`
  (env beats the repo override in the cascade) and `--no-pr`, against the scratch origin only.
- Before: `git ls-tree origin/main backlog/ | grep '/x'` lists the three x-cards.
- Run 1 creates `lane/card-rename-batch` on the scratch origin with B1 (one parent, main). Its `main...B1`
  diff renames exactly the two ledgered cards with `bornAs`.
- Run 2, unchanged inputs (also after an unrelated commit on scratch main): same digest as B1, "no push",
  the branch tip is still B1.
- Advance scratch main with one more ledgered card. Run 3: B2's parents are (new main, B1), the plain push
  is accepted as a fast-forward, and `main...B2` renames all three ledgered cards.
- Build the scratch site from B2's tree on a throwaway dev server (spare port, stopped by PID after) and
  curl one renamed card's old `/backlog/<x-id>-<slug>/` and `/backlog/<x-id>/`: before the rename the
  first is the card's page, after it both redirect to `/backlog/<NNN>-<slug>/`.
- Paste the listings, the three digests, the parents of B1 and B2, both push lines and the curl output.

## Done when

- The fixture proof above is pasted, and the named tests pass.
- Every card the batch renames keeps its old routes: `/backlog/<x-id>-<slug>/` and `/backlog/<x-id>/`
  redirect to the new `NNN-slug` page through `formerSlugs` (`materializedCardKeepsFullStemRoute`,
  `applyLedgerSkipsFormerSlugs` and the curl proof).
- The job is wired to the cadence and exits early outside `rename-after-land`, so landing it changes nothing
  on real main until slice (d) flips the mode. The first real batch PR landing through the merge queue with
  one CI run is in slice (d)'s Done-when.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/__tests__/card-rename-batch.test.mjs` fails before this
  lands and passes after.

## Non-goals

- [N1] Renaming cards in modes other than `rename-after-land`.
- [N2] Renaming existing NNN cards.
