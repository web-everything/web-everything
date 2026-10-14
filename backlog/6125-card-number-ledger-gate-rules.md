---
bornAs: xbpjdsd
kind: story
size: 3
parent: "6122"
status: open
blockedBy: ["6121", "6124"]
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/check-standards.mjs", "we:scripts/lib/duplicate-bornas-added.mjs", "we:scripts/__tests__/check-standards-rules.test.mjs", "we:scripts/__tests__/check-standards.test.mjs", "we:scripts/lib/__tests__/duplicate-bornas-added.test.mjs"]
dateOpened: "2026-10-13"
tags: [backlog, numbering, ledger, gate]
---

# check-standards accepts x-id card file names that the ledger has numbered

Slice (c) of epic 6122: the hash-on-main, duplicate-number and bornAs rules learn the ledger, so a ledger-numbered x-id card on main is legal and an unledgered one is caught.

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
  `bornAs` is read from frontmatter only; a `bornAs:` line in a card body (card 4658 quotes three) is not
  an identity.
- Legacy duplicates. Main already holds 7 `bornAs` values shared by two cards each (listed in slice (a),
  6121). The whole-tree check honours slice (a)'s allowlist, `we:scripts/settings/card-ledger-legacy-identities.json`,
  read from `<base>` (never the tree under check): an entry lets exactly its listed numeric files share
  that id. Anything else still errors: a third file with the id, an x-named file with the id, a rename of a
  listed card to an unlisted number, an unlisted shared `bornAs`, and a stale entry (a listed file missing
  from the merged tree or no longer carrying that `bornAs`). Deleting one card of a pair is allowed and
  leaves the entry stale, so the same PR must also drop or shrink the entry.
- `duplicateBornAs` (we:scripts/check-standards-rules.mjs:2882): an x-named card needs no `bornAs`; a seed row
  that disagrees with a card's `bornAs` is an error. For an allowlisted id, the seed row must carry the
  entry's `canonical` number; the alias card sharing that `bornAs` is not a disagreement.
- `handNumberedNewItems` (we:scripts/check-standards-rules.mjs:3012): unchanged. Hand-picked numbers stay
  forbidden.
- The gate reads the ledger fetched by CI (slice (b), 6124 wiring, hence blockedBy). Outside merge_group,
  offline/unreadable means warn and skip only the ledger-dependent checks, never "all clear"; duplicate
  file identities still error. Inside merge_group, unreadable (including failed fetch, missing history,
  truncation/over-cap or failed authentication) is an error, with no window exemption, only when the group
  needs the ledger. That is decided from the group's own diff against its base, never from the mode alone
  or from files the group does not touch:
  - in every mode: the diff adds, renames or modifies an `x<6>` backlog file;
  - in `rename-after-land` and `ledger-only`: also, the diff adds or renames any backlog card file or adds
    or changes a `bornAs`.
  Otherwise the ledger-dependent checks warn and skip, as outside merge_group, and duplicate file identities
  and today's numeric rules still error. Cards already on main that the group does not touch were checked
  when they landed. In `rename-before-enqueue`, a drain-numbered new card (numeric name plus the `bornAs`
  that `stampBornAs` writes, we:scripts/backlog/id.mjs:92) does not need the ledger at the gate: once slice
  (d) lands, the drain reads the ledger under the numbering lock before choosing that number and refuses
  while it is unreadable; before (d) the ledger has no authority. So in `rename-before-enqueue` an
  ops-branch outage blocks only groups that touch an x-file, and a trust-root or quarantine PR (no card
  touched) always merges in every mode, so recovery never deadlocks.
  Slice (d) replaces #5057's blanket x-file refusal; until then that refusal remains too.

## MVP

The `strandedHashesOnMain` change plus the ledger-collision check.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the gate consumes slice (a)'s validated rows only.
2. **Truncated reads** — unreadable warns outside merge_group; inside merge_group it errors whenever the
   group's diff needs the ledger (see Design), and warns otherwise.
3. **Shared state files** — read-only.
4. **Fail closed** — an unledgered x-card past the land window errors; in merge_group an unreadable ledger
   errors for every group whose diff needs it (see Design) and, once slice (d) replaces #5057, an unledgered x-card always errors, even inside the window.
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
- **Capability (Red today)** — `legacyDuplicateBornAsAllowlisted`: with the real 7-pair allowlist at the
  base, today's main passes the whole-tree check. Each of these errors: a third file reusing an allowlisted
  id, an unlisted shared `bornAs`, a stale entry, a rename of a listed card to an unlisted number, and an
  allowlist entry added only in the tree under check. A body-text `bornAs:` line (card 4658 shape) never
  counts as a duplicate. The seed row for an allowlisted id passes `duplicateBornAs` at `canonical` and
  errors at the alias number.
- **Capability (Red today)** — `unreadableLedgerInMergeGroupErrors` and `unreadableLedgerOutsideMergeGroupWarns`: paired context tests
  for failed fetch with stale ref, deleted/renamed ledger file, missing history, authentication failure,
  over-cap/truncated read, and a missing or invalid base trust root (including a malformed quarantine or
  checkpoint entry). The error case: a diff touching an x-file in every mode, and a diff adding a card or a
  `bornAs` in `rename-after-land` and `ledger-only`; also inside the land window.
- **Capability (Red today)** — `unreadableLedgerUnaffectedGroupsPass`: the same unreadable states, in
  merge_group, pass with a ledger-skipped warning for (i) a `rename-before-enqueue` group adding a
  drain-numbered card (numeric name plus stamped `bornAs`), (ii) a group touching no card, in every mode,
  including a trust-root quarantine PR, and (iii) a group that leaves untouched x-cards on main alone. A
  duplicate numeric file still errors in each (the unaffected population keeps working while the dependency
  is down).

Integration in `we:scripts/__tests__/check-standards.test.mjs`: exercise the CI-fetched ledger through the
real rule caller in merge_group, then fail the fetch and assert nonzero exit. An injected-ledger unit test
alone is insufficient proof of wiring.

## Proof plan

On a fixture, never the real ledger: the trust root is read from the base ref, so a fixture row on the
real `ops/card-numbers` would be untrusted and would lock the ledger for everyone. In a lane, make a scratch
clone whose `origin` is a local bare copy of the lane; on its main, commit a test trust root listing a test
signing key, and push a fixture `ops/card-numbers` branch (one row signed by that key) to the scratch origin.
Commit a fixture x-named card and run `node we:scripts/operations/run.mjs verify --checkout=<scratch>` with
`WE_CARD_NUMBERING_MODE=ledger-only`. Before this slice: the hash-on-main rule errors. After: clean. Remove the
row (a new signed commit on the scratch ops branch): the rule errors again. Paste all three outputs.
Also run with merge_group context and the CI fetch path against the scratch origin: a failed fetch must error
for a group touching the x-card despite a stale ref, and warn for a group touching no card. Record both.

## Done when

- In every mode, a ledger-numbered x-card on main passes the gate and an unledgered one fails after the window.
- In `rename-before-enqueue`, the gate output on today's numeric main is unchanged; ledgered x-cards added
  before a rollback remain accepted.
- CI wiring is exercised, an unreadable ledger errors in every merge group whose diff needs it and not in
  the unaffected groups named above, duplicate x-ids fail, and same-identity
  numeric/ledger equality passes in the named tests.
- The whole-tree identity check passes on today's main only through the 7 allowlisted legacy pairs, and
  `legacyDuplicateBornAsAllowlisted` shows any other shared `bornAs` still errors.

## Acceptance

- [A1] **Executable** — the new rule tests fail before this lands and pass after
  (`npm run test:unit -- we:scripts/__tests__/check-standards-rules*.test.mjs`).

## Non-goals

- [N1] The #5057 merge_group refusal is not touched here; that is slice (d).
