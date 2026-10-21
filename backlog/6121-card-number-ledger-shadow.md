---
bornAs: x5qtv82
kind: story
size: 5
parent: "6122"
status: open
scope: ["we:scripts/lib/card-number-ledger.mjs", "we:scripts/lib/queue-branch-numbering.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/settings/card-numbering.json", "we:scripts/settings/card-ledger-trust.json", "we:scripts/settings/card-ledger-legacy-identities.json", "we:scripts/lib/policy-cascade.mjs", "we:scripts/backlog/seed-card-number-ledger.mjs", "we:scripts/backlog/card-ledger-checkpoint.mjs", "we:scripts/backlog/card-ledger-signing-key.mjs", "we:scripts/lib/git-transport-branch.mjs", "we:scripts/lib/gate-config.mjs", "we:scripts/lib/__tests__/git-transport-branch.test.mjs", "we:scripts/lib/__tests__/gate-config.test.mjs", "we:scripts/lib/__tests__/card-number-ledger.test.mjs", "we:scripts/lib/__tests__/queue-branch-numbering.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/lib/__tests__/policy-cascade.test.mjs"]
dateOpened: "2026-10-13"
tags: [backlog, drain, numbering, ledger, shadow]
---

# Card-number ledger store and assign-at-land, in shadow

Slice (a) of epic 6122: an append-only id-to-number ledger on ops/card-numbers, written by the drain at land, running beside today's rename numbering and checked against it.

## Ruling 2026-10-19: signed-commit trust root is optional, off by default

Operator ruling of 2026-10-19 (recorded in epic 6122), point 4: the signed-commit trust root becomes optional and
off by default. Add a cascade setting `backlog.cardNumbering.ledgerAuth` with values `none` (default) and
`signed`. In `none`, the fence is: the `ops/card-numbers` branch accepts pushes only through the drain transport
(`allowRef`), a strict row-shape parse, and the two uniqueness invariants (one number per id, one id per number).
In `signed`, everything below about the trust root, signing, checkpoints, quarantine and per-row signature
verification applies. Where the Design text below says a row "must" be signed or the ledger "is unreadable"
without a trusted signature, read it as applying in `signed` only. Key provisioning, the bootstrap trust-root PR
and the `review:human` hold are required only when `ledgerAuth` is `signed`; they no longer block `--apply`.
Cards numbered at birth (slice 6622) need no row, so this ledger carries only fallback and seed rows.

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
    and mark the ledger unreadable for consumers; later trusted commits cannot clear that status (only the
    reviewed quarantine below can).
    Missing/shallow history, signature-verification failure or an exceeded history budget makes the ledger
    unreadable; assignment and merge checks fail closed. Display readers may fall back to x-ids.
  - Trust root: we:scripts/settings/card-ledger-trust.json on `main`, holding:
    - `allowedSigners`: the drain's SSH signing public keys, each `{ key, fingerprint, revoked? }`. Keys are
      never removed (that would untrust every row they signed and lock the ledger). Commit dates are set by
      the signer, so no date window is used as revocation: a `revoked` key authenticates only commits at or
      before `checkpoint`, never after.
    - `checkpoint`: `{ commit, fileSha256 }`, a reviewed point on `ops/card-numbers`. Verification walks only
      history after it, and the ledger file at that commit must hash to `fileSha256`; rows at or before it
      are trusted as reviewed. This bounds the history walk as the ledger grows. When the history budget is
      exceeded, or a key leaks, the ledger is unreadable until a reviewed PR advances the checkpoint: a
      script, `we:scripts/backlog/card-ledger-checkpoint.mjs`, verifies all history up to a commit and prints
      the entry to commit.
    - `quarantine`: entries `{ commit, reason, approval }` (below). `commit` must be a full 40-character
      lowercase sha.
    - Readers take it with `git show` from `<base>`: inside merge_group that is the merge group's base sha
      (`merge_group.base_sha`); everywhere else, `origin/main`. It is never read from the working tree or the
      PR/merge-group tree under check, so a PR that adds its own key or quarantine entry gains nothing until
      it is reviewed and merged. A missing or invalid trust root, including a malformed quarantine or
      checkpoint entry, makes the ledger unreadable.
    - The file is registered in `TRUST_CHAIN` (we:scripts/lib/gate-config.mjs:106) as a `policy` member with
      `leash: 'spec'`, so any PR that changes it, including the bootstrap PR adding the first key, is held at
      `review:human` and cannot be merged by the AI drain alone.
  - Verification never uses ambient trust. For each introducing commit, the reader writes an
    `allowed_signers` file built from the base trust root to a temp path and runs
    `git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=<tmp> verify-commit --raw <sha>`, with `GNUPGHOME`
    set to an empty temp dir. It then checks that the reported signer fingerprint is a listed key. A key
    trusted in the host's own keyring or git config never counts.
  - Signing: `stageOnTransportBranch` commits and pushes in one step (`writeCommitPush`,
    we:scripts/lib/git-transport-branch.mjs:334-336). This slice adds an optional `sign: { keyPath }` to it:
    commit with `-S` using that key, verify the new commit as above, and only then push. Without `sign` it
    behaves as today. `appendCardLedgerRows` always passes it, so writers never publish an unsigned row. A
    signing outage refuses the write (shadow warns, assignment refuses) and never poisons the ledger.
  - Key provisioning (owned here): `we:scripts/backlog/card-ledger-signing-key.mjs` creates the drain host's
    signing key if it is absent (private key outside every checkout, mode 600) and prints the public key and
    fingerprint. The bootstrap trust-root PR adds it and goes through `review:human`; the seed `--apply` and
    the live proof run only after that PR lands.
  - Recovery (break-glass): an untrusted introducing commit is cleared by a reviewed PR to `main` adding a
    `quarantine` entry. Readers parse that commit's rows with the same strict row shape (bad lines are
    skipped), drop them, and record their numbers as burned. Burned numbers form an exclusion list: the
    allocator skips them, but they never raise the floor (`max` is over trusted rows and numeric files only),
    so one forged `num: 99999` cannot use up the range. A trusted row always wins: a number held by a trusted
    row is never burned. With every untrusted introducer quarantined (or older than the checkpoint), the
    ledger is readable again. No force push and no history rewrite. An affected x-card that lost its row is
    re-assigned through the normal path. The quarantine PR itself does not need the ledger to merge (slice
    (c) decides "needs the ledger" from the group's own diff), so recovery never deadlocks in the queue.
  - `assignCardNumbers({ repo, ids, pr, floor })` runs inside `withNumberingLock`
    (we:scripts/readiness/drain-lock.mjs). Ids that already have a row return their number (idempotent).
    New ids get `max(ledger, floor) + 1, +2, ...`. Append and push with a new `appendCardLedgerRows` in
    we:scripts/lib/card-number-ledger.mjs, modelled on the bounded-retry loop of `appendLedgerRows`
    (we:scripts/lib/verdict-ledger-io.mjs:163) but not calling it: that loop takes precomputed rows, checks
    them against the verdict schema and pins its push to `refs/heads/ops/review-requests`. The new loop calls
    `stageOnTransportBranch` (we:scripts/lib/git-transport-branch.mjs:230) with
    `allowRef: 'refs/heads/ops/card-numbers'`, and allocates the numbers INSIDE the `content({ existing })`
    callback, from the freshly fetched file, on every attempt. So a non-fast-forward refusal re-reads the
    file and recomputes every `num` (and re-runs the idempotency and uniqueness checks); a number computed
    before the refusal is never re-appended.
  - Row: `{"id","num","pr","at","by":"drain","kind":"assign"|"seed"|"shadow"}`.
- Policy `backlog.cardNumbering.mode` (epic 6122, "Card naming policy"), resolved through `cascadePolicy`
  (we:scripts/lib/policy-cascade.mjs) with its source logged. Declared values: `rename-before-enqueue`,
  `rename-after-land` (standard default), `ledger-only`. This slice adds a repo override in
  we:scripts/settings/card-numbering.json pinning `rename-before-enqueue`, so behaviour does not change until
  slice (d). Env override `WE_CARD_NUMBERING_MODE`.
- Shadow hook: in `prepareBranchBeforeEnqueue` (we:scripts/lib/queue-branch-numbering.mjs:238-300), after
  `numberPendingHashes` returns `n.assigned` (hash to NNN pairs, line 271), write one `kind:"shadow"` row per
  pair with the SAME number the rename chose. The rename path stays the source of truth. A ledger write failure
  is logged as a warning and never blocks the enqueue in shadow mode.
- Seed script `we:scripts/backlog/seed-card-number-ledger.mjs`: one `kind:"seed"` row per distinct `bornAs`
  identity (id = bornAs, num = file number). Dry-run by default; `--apply` pushes once.
  - `bornAs` is read from the card's frontmatter block only, never from body lines. Card 4658's body quotes
    the frontmatter of three other cards, so a line scan finds `x7pj0mw`, `xggb0ep` and `xycb80x` twice;
    frontmatter parsing finds each once (cards 4397, 4383, 4398).
  - Existing duplicate birth identities. On main today, 7 `bornAs` values sit in the frontmatter of two
    cards each: `xzdi27a` (3111, 3112), `x2t6cr5` (3201, 3244), `xu2krte` (3544, 3557), `x8hzy1m` (3660,
    3663), `xhprieg` (3661, 3664), `xldrls6` (3662, 3665), `xp12dod` (4498, 4512). They are not migrated:
    no file and no `bornAs` line changes. Instead a reviewed allowlist,
    `we:scripts/settings/card-ledger-legacy-identities.json`, keyed by repo like the ledger files
    (`{ "we": [...] }`), lists each pair as `{ id, nums: [<a>, <b>], canonical: <a>, reason }`.
    `canonical` is the lower (earlier-filed) number unless the entry says otherwise; the other card is a
    legacy alias.
  - For an allowlisted id the seed writes ONE row, `num = canonical`. The alias card keeps its own numeric
    file name, which is its number (numeric files need no row), so the alias number is never reallocated:
    the allocator floor already covers it. If the entry is stale (the canonical card was deleted or lost its
    `bornAs`), the seed uses the one listed card still carrying the id and warns.
  - The seed refuses (`--apply` pushes nothing, dry-run lists them) when any `bornAs` is shared by two or
    more cards that are not all listed in one entry for that id. An entry is an upper bound (6125): fewer
    listed cards is a warning, never a refusal. So the seed completes on today's main, and a new duplicate
    can never be seeded silently.
  - The allowlist is read from `<base>` with `git show`, like the trust root, never from the tree under
    check. It is registered in `TRUST_CHAIN` (we:scripts/lib/gate-config.mjs:106) as a `policy` member with
    `leash: 'spec'`, so adding an entry is held at `review:human`. It is a closed set: slice (c)'s identity
    check (6125) honours an entry only for the exact numbers it lists.

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
   One row per id: the 7 legacy duplicate `bornAs` pairs seed one row each (the allowlist's `canonical`
   number); any other shared `bornAs` refuses the seed.
6. **State over time** — append-only; a re-enqueue after a dequeue re-reads the existing row instead of minting.
7. **Who wrote it** — authenticate the commit that introduced each row using a trusted drain signing key,
   not a tip commit or `trustedDrainAuthors` author-name comparison. Seed and shadow writers must sign too.
   Row removal/replacement violates append-only history and makes the ledger unreadable. The key list comes
   from the base ref's trust root, never the tree under check; recovery is a reviewed quarantine entry.

## Test plan

Red-green unit tests in `we:scripts/lib/__tests__/card-number-ledger.test.mjs` with injected git and fs:
idempotent replay, two concurrent assigners for different ids (one push refused; on retry it allocates from
the winner's rows, so the two ids get different numbers and the loser's first-attempt number is never
appended), a push to any ref other than `refs/heads/ops/card-numbers` refused before any git call, a conflicting row (same id, two
numbers) reported, a partial last line, the floor taken from numeric file names, seed rows built from
`bornAs`.

- **Capability (Red today)** — `seedHandlesLegacyDuplicateBornAs`: on a fixture holding an allowlisted pair
  (two cards, one `bornAs`), the seed writes exactly one row for that id, at the `canonical` number, and
  `readCardLedger` reports zero conflicts. An unlisted shared `bornAs` and a third card sharing a listed
  id each make the seed refuse with no push. A stale entry (canonical card deleted) seeds the remaining
  listed card's number with a warning. A `bornAs:`
  line in a card's body (the card 4658 shape) is not an identity. An allowlist entry present only in the tree
  under check, not at `<base>`, has no effect. A last fixture is the real list of 7 pairs from main.

Required tests in that same suite:
- **Capability (Red today)** — `rejectsUntrustedIntroducerBehindTrustedTip`: an untrusted commit appends a forged row, then a trusted
  signed commit appends a legitimate row. The forged row is absent from both maps; the legitimate row remains.
  Assert `readable: false`, x-id display fallback and zero assignment/enqueue calls despite that trusted row.
  Repeat with a spoofed trusted author name but no trusted signature, and for seed/shadow/assign kinds.
- **Capability (Red today)** — missing introducing history, invalid signatures and row removal/replacement refuse assignment; no writes.
- **Capability (Red today)** — `trustRootReadFromBaseNotTreeUnderCheck`: the tree under check adds the forger's
  key to the trust root file (and, separately, a quarantine entry for a legitimate commit); the forged row is
  still rejected and the legitimate row kept, because the base ref's copy is the one read. A missing trust
  root at the base is unreadable.
- **Capability (Red today)** — `quarantineRestoresReadabilityAndBurnsNumbers`: with a forged row beneath a
  trusted tip, the ledger is unreadable; after the base trust root quarantines the forging commit, it is
  readable and the forged row's number is never allocated again. A forged `num: 99999` does not raise the
  next number; a burned number that a trusted row holds stays that row's. A short or uppercase quarantine
  sha makes the trust root invalid.
- **Capability (Red today)** — `revokedKeyOnlyBeforeCheckpoint`: a commit signed by a `revoked` key after the
  checkpoint is rejected even with a backdated commit date; the same key's commits at or before the
  checkpoint stay trusted.
- **Capability (Red today)** — `checkpointBoundsHistoryWalk`: verification reads no commit at or before the
  checkpoint; a checkpoint whose `fileSha256` does not match is unreadable; history past the budget after the
  checkpoint is unreadable, and advancing the checkpoint makes it readable.
- **Capability (Red today)** — `ignoresAmbientSignerTrust`: the forger's key is trusted in the host keyring
  and in a local `gpg.ssh.allowedSignersFile`, but is not in the base trust root; its row is rejected.
- **Capability (Red today)** — `signedTransportVerifiesBeforePush` (in
  we:scripts/lib/__tests__/git-transport-branch.test.mjs): with `sign`, a commit whose signature does not
  verify is never pushed; without `sign`, behaviour is unchanged.
- In we:scripts/lib/__tests__/gate-config.test.mjs: a PR touching the trust root file is a `policy`-tier
  trust-chain path.
- **Capability (Red today)** — `writerRefusesUnsignedPush`: a signing failure makes `appendCardLedgerRows`
  push nothing and return no number.
- **Capability (Red today)** — `rejectsOversizedLedgerBeforeAllocation`: enforce a declared byte cap at the transport read boundary,
  fetching at most cap + 1 bytes (the one-byte overflow sentinel), never reading the whole file before checking.
  Assert the actual read range/bytes, zero allocation, append and push calls, and no number returned. Cover
  the initial read. Separately, after one refused push, an overflowing retry read must cause zero further
  allocation, append or push calls and no number returned (the earlier refused attempt is expected).
  History reads also have a declared bounded budget.

## Proof plan

Precondition, owned by this slice: the drain host's signing key exists and the bootstrap trust-root PR
carrying its public key has landed through `review:human`. Then, live: run one drain pass in shadow (the
default `rename-before-enqueue` mode with shadow writes on) that numbers a real new card. Before: `git show
origin/ops/card-numbers:card-numbers/we.jsonl` has no row for it. After: the row exists and its `num` equals the
NNN the rename gave the file. Paste both outputs.

## Done when

- The bootstrap trust-root PR (first drain key, initial checkpoint) has landed through `review:human`.
- The shadow rows for the next 5 real numbered cards match their renamed file numbers exactly.
- The legacy-identities allowlist (the 7 pairs above) has landed through `review:human`.
- The seed run has written one row per distinct `bornAs` identity (one row, at the `canonical` number, for
  each allowlisted pair), and `readCardLedger` reports zero conflicts.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/card-number-ledger.test.mjs` fails before
  this lands and passes after.
- [A2] The named introducer-authentication and bounded-read tests above are required implementation
  acceptance checks; tip-only verification or full-buffer-then-cap checking must make them red.

## Non-goals

- [N1] No reader, renderer or gate reads the ledger yet; that is slices (b) and (c).
- [N3] No mode other than `rename-before-enqueue` is active yet.
- [N2] The rename commit is not removed here; that is slice (d).
