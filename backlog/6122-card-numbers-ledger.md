---
bornAs: xdlnylv
kind: epic
status: open
scope: ["we:scripts/lib/queue-branch-numbering.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/lane-drain.mjs", "we:scripts/check-standards.mjs", "we:scripts/check-standards-rules.mjs", "we:src/_data/backlog.js", "we:scripts/backlog.mjs"]
dateOpened: "2026-10-13"
tags: [backlog, drain, merge-queue, numbering, ledger]
---

# Card numbers as a ledger (no rename commits)

Card 265 (operator OK 2026-10-12, reconfirmed 2026-10-13; policy decisions 2026-10-13 ~19:00 ET): x-id cards may land; the drain assigns the display number into an id-to-number ledger on an ops branch at land, and the ledger is the source of truth in every mode. When a card's file is renamed is a policy setting (`backlog.cardNumbering.mode`), defaulting to a nightly batched rename after land (ruling 2026-10-19). New cards are numbered at birth (slice 0); the ledger covers only the fallback. This takes the pre-enqueue numbering commit in we:scripts/lib/queue-branch-numbering.mjs, and its extra CI round, off the default path.

> **Ruling 2026-10-19 supersedes the defaults below.** See "Ruling 2026-10-19". Where this card's older text says
> hourly cadence, rename-after-land as a ledger-only fallback, or a signed-commit trust root, the ruling wins.

## Why now

Under the merge queue, `prepareBranchBeforeEnqueue` (we:scripts/lib/queue-branch-numbering.mjs:238-300) renames every
`x<6>` card on the PR branch to its `NNN` and pushes a new head before enqueue. That new head:

- forces a full extra CI round for every PR that carries a new card (about 14 min each);
- dropped two operator approvals because the head moved (#5025, worked around by #5233);
- is a large share of the drain's 12-minute passes (worktree + full-tree reference rewrite in
  `numberPendingHashes`, we:scripts/lane-drain.mjs:682, plus `sweepQueuedHashCards` at :318 and the land probes
  at :200/:354).

The number is display data. It does not need to live in the file name.

## Ruling 2026-10-19

Operator, verbatim, 2026-10-19 (in conversation, answering the re-check of this epic):

> "Could be nightly even, the down side of hash is if a human loom at the code it might be messy to have a mix and it's not as easy to remember a hash as an id so less usable . Apart from that I am fine with"

The ruling, in five points:

1. Cards are numbered at birth, as new slice 0 (6622, "Card numbers assigned at birth").
2. The ledger is the fallback for cards that could not be numbered at birth.
3. Renames are NOT hourly. A NIGHTLY batch renames any fallback `x<6>` card to `NNN-slug` and rewrites x-id
   references to numbers, including the ~830 backlog lines and ~890 non-backlog lines that cite x-ids today.
   Humans then see numbers, not a mix. So the default mode is `rename-after-land` with cadence `nightly`.
   The cadence is its own setting, `backlog.cardNumbering.renameCadence` (default `nightly`, source logged).
4. The signed-commit trust root of 6121 becomes optional and off by default
   (`backlog.cardNumbering.ledgerAuth: none|signed`, default `none`).
5. The replacement invariant for 6127 is approved with this wording:
   "Every backlog card on `main` has exactly one number, recorded where a reader can find it: in the file name
   (`NNN-slug`) or in exactly one ledger row (`x<6>-slug`). No `x<6>` card file may be added to `main` without a
   ledger row, and no id or number is bound to two cards. A merge group that adds an unledgered `x<6>` card, or
   whose needed ledger is unreadable, is refused."

All of these stay configurable policies (cascade settings), not constants.

## Decision note — replacement invariant, approved 2026-10-19

**Conflict.** #5057 made it "mechanically impossible to add a temp id in the queue": `mergeGroupHashRefusals`
(we:scripts/lib/queue-branch-numbering.mjs:34-37, called from we:scripts/check-standards.mjs:787-789) refuses any
merge group that carries an `x<6>` file name, unconditionally. Card 265 lets `x<6>` file names land on `main`.
The two cannot both hold. Approval of card 265 alone does not establish approval of this specific relaxation.

**Approved replacement invariant (wording per the ruling, point 5).** *Every backlog card on `main` has exactly
one number, recorded where a reader can find it: in the file name (`NNN-slug`) or in exactly one ledger row
(`x<6>-slug`). No `x<6>` card file may be added to `main` without a ledger row, and no id or number is bound to
two cards. A merge group that adds an unledgered `x<6>` card, or whose needed ledger is unreadable, is
refused.* The earlier draft ("every card gets a ledger number, assigned atomically by the drain's land step;
nothing unnumbered is user-visible") is replaced by this wording. Concretely: in every mode,
the merge_group gate stops refusing ledgered `x<6>` file names and instead refuses any `x<6>`
card in the group that has no ledger row. The "no hash on main" rule becomes "no unledgered hash on main".
In mode `rename-before-enqueue`, new unledgered cards still require pre-enqueue numbering. Ledgered x-cards
already landed in another mode remain legal on rollback and must never receive a replacement number.

**Approval source:** the operator's ruling of 2026-10-19, section "Ruling 2026-10-19" above (verbatim quote,
point 5), given in conversation in answer to the design re-check of this epic. It approves the exact wording of
the replacement invariant. This clears the `humanGate` on 6127. This PR records the operator's ruling; it adds
no reviewer verdict.

## Card naming policy — `backlog.cardNumbering.mode`

A cascade setting resolved through `cascadePolicy` (we:scripts/lib/policy-cascade.mjs): standard default →
platform preference → repo override (we:scripts/settings/card-numbering.json) → env `WE_CARD_NUMBERING_MODE`.
The effective value and the layer it came from are logged once per daemon process (the cascade's source log).
An invalid value never overrides a lower layer; it is named and ignored.

| Mode | What happens to a new card's file name | CI cost |
|---|---|---|
| `rename-before-enqueue` | The drain renames new unledgered cards on the PR branch before enqueue (`prepareBranchBeforeEnqueue`). Already ledgered cards keep their numbers; merge_group checks accept ledgered x-cards and refuse unledgered ones. KEPT and switchable, never deleted. Operator: "make sure the drain steps for the merge queue are just turned off for merge queue, not deleted". | one extra CI round per PR with new cards |
| `rename-after-land` | **THE DEFAULT, cadence `nightly`.** The ledger assigns the number at land; the fallback card lands as an `x<6>-slug` file name. A NIGHTLY batch renames landed ledger-numbered x-id cards to an `NNN-slug` file name and rewrites every x-id reference (backlog and non-backlog) to the number, through the merge queue. Cadence is its own setting, `backlog.cardNumbering.renameCadence` (default `nightly`). | one CI run per nightly batch |
| `ledger-only` | KEPT as a setting. No renames. The x-id file name is permanent; readers show the ledger number. | none |

Cards numbered at birth (slice 0) are `NNN-slug` from the start and appear in no mode's rename set. The ledger
authentication setting `backlog.cardNumbering.ledgerAuth` (`none` default, `signed` optional) is described in
6121.

The ledger is written and read in every mode, including `rename-before-enqueue` (the row records the number
the rename chose). Optional in any mode: a generated by-number lookup (`we:backlog/by-number/NNN.md` pointers or
an index), behind its own setting.

Before slice (d) flips the mode, every rename/repair caller (including `repairHashOnMain`, branch numbering,
queued sweeps/probes and drain-direct via `numberPendingHashes`) must consult the ops ledger under the
numbering lock. Existing rows take precedence over local reservations and allocation; numeric materialization
uses the assigned number, never a newly chosen one. Unreadable or conflicting ledger state blocks mutation.
This prerequisite belongs to slice (d); slice (e)'s later local-ledger retirement is not rollback protection.

## Design

### Ledger format and location

- Branch `ops/card-numbers`, file `card-numbers/we.jsonl` (on the ops branch, not a repo path) (one file per repo, the same shape as
  the per-repo verdict ledger on `ops/review-requests`, we:scripts/lib/verdict-ledger-io.mjs:38-42).
- Append-only JSON lines: `{"id":"x7k2q9a","num":5301,"pr":5240,"at":"<ISO>","by":"drain","kind":"assign"}`.
  Seed rows use `"kind":"seed"`.
- Writes go through the existing transport: `stageOnTransportBranch` / `readFromTransportBranch`
  (we:scripts/lib/git-transport-branch.mjs:230, :354), pinned with `allowRef: 'refs/heads/ops/card-numbers'`.
  The retry loop is modelled on `appendLedgerRows` (we:scripts/lib/verdict-ledger-io.mjs:163) but allocates
  numbers inside the transport's `content({ existing })` callback on every attempt (slice (a)); reusing that
  function as-is would re-append numbers computed before a lost race, and it can only push
  `ops/review-requests`. No new transport.
- Two invariants on the file: one number per id, one id per number. Every reader validates both and fails
  closed on a violation (it shows the x-id and reports the conflict; it never guesses).
- Authenticate each row at its introducing commit, with fetched file history and a verified signature from
  a trusted drain signing key (including seed/shadow rows). Tip authorship, Git author names and `by` are
  insufficient. Reject untrusted rows even beneath a later trusted tip and mark the ledger unreadable;
  any retained trusted mappings are diagnostic only. Missing verification history,
  exceeded read/history budgets or append-only violations make the ledger unreadable.
  The trust root (allowed signing keys, a reviewed checkpoint that bounds the history walk, and the
  quarantine list used for recovery) is a file on `main`, read from the base ref (the merge group's base sha
  in merge_group, `origin/main` elsewhere), never from the tree under check, and verified with an explicit
  signers file, never the host's keyring. It is a `policy` member of `TRUST_CHAIN`, so every change to it is
  held at `review:human`. Recovery from an untrusted row, a leaked key or an exhausted history budget is a
  reviewed quarantine entry or checkpoint advance on that file, never a history rewrite (slice (a)).
- A numeric card and ledger row may share a number only if the numeric card's `bornAs` equals the row id;
  this is the expected seed and materialization case. Different identities sharing a number error.

### The atomic assign-at-land step

- Runs inside `withNumberingLock` (the same mutex `prepareBranchBeforeEnqueue` uses today).
- Under the merge queue, the drain's land action is the enqueue. The assign step runs just before
  `mergeStrategy.enqueue` (we:scripts/merge-ai-prs.mjs:6539-6545). Outside mode `rename-before-enqueue` it
  replaces the branch numbering; in that mode the branch numbering still runs and the row records its number.
  In drain-direct mode it runs just before `mergePr`.
- Steps: fetch `ops/card-numbers`; validate x-id/`bornAs` uniqueness in the prospective merged main-plus-PR
  tree (apply deletions/renames, count the same path once); refuse any id used by two files before assigning.
  List the PR head's `x<6>` cards; skip ids that already have a row (idempotent
  replay, re-enqueue after a dequeue); `next = max(ledger nums, numeric file names on origin/main, open
  reservations) + 1`; append the rows; push. The push is a compare-and-swap: a non-fast-forward refusal re-reads
  and recomputes. That is what makes it atomic across hosts, not only across processes.
- No commit to the PR branch. No push to `main`. The judged head SHA is unchanged, so approvals and CI stand.

### How readers resolve id to number

- One ESM resolver, `we:scripts/backlog/card-number.mjs`: `displayNum(id)` returns the id itself for a numeric
  file name, the ledger number for a ledgered `x<6>`, and the `x<6>` id as the fallback when no row exists.
  `idFor(ref)` maps a number back to its id (so `#5301` and `x7k2q9a` both resolve).
- The 11ty loader (we:src/_data/backlog.js:60, :370-378) is CommonJS and cannot import it. It reads the same
  JSONL through a small CJS twin, with the same "keep in sync" pointer comment the `ID_TOKEN` mirror already
  uses.
- Read source, in order: a fresh `git fetch` of `ops/card-numbers` (CI and the deploy already fetch
  `ops/quarantine` the same way), then the local remote-tracking ref, then the fallback display. A read failure
  never fails a build. It degrades to showing x-ids.
  This display fallback does not apply to assignment or to a merge group whose own diff needs the ledger
  (it touches an `x<6>` file; in the ledger modes, also any added card or `bornAs`; slice (c)): a failed
  fetch or unreadable ledger errors there, even if a stale local ref exists and even inside the land window.
  Other groups (including a trust-root or quarantine PR) and any check outside merge_group warn and skip the
  ledger-dependent checks; file identity uniqueness is still enforced.

### Migration of the ~6,000 existing NNN cards

- Keep every existing file name. No existing card is ever renamed.
- A numeric file name is its own number. It needs no row.
- Seed one row per existing card that carries `bornAs: x<6>` (id = the bornAs hash, num = its file number), so
  an old x-id still cited anywhere (docs, flows, prose) resolves to the right card. This is the "maps both ways"
  half. Seven `bornAs` values are already shared by two cards each on main; a reviewed allowlist seeds one
  row per id at a chosen `canonical` number, and the identity check accepts only those exact pairs (slices
  (a) and (c)).
- New cards get a row at land. Their file stays `x<6>` until the batched rename (mode `rename-after-land`),
  forever (mode `ledger-only`), or is renamed before enqueue (mode `rename-before-enqueue`).

### URLs and links

- Canonical page stays `/backlog/<file stem>/` (we:src/backlog-pages.njk:7). For a new card that is
  `/backlog/x7k2q9a-slug/` until it is renamed. After a batched rename, the old `/backlog/x7k2q9a-slug/` and
  `/backlog/x7k2q9a/` routes redirect to the new `NNN-slug` page (the x-id is kept as `bornAs`), so links
  never break. The batched rename (slice (f)) records the old full stem and the bare x-id in `formerSlugs`,
  which the existing old-slug redirect pages serve; slice (b) emits `/backlog/<x-id>/` and
  `/backlog/<NNN>/` while the card is still x-named.
- `/backlog/<NNN>/` keeps working: `backlogRedirects` (we:src/_data/backlogRedirects.js:18) emits a redirect for
  each ledgered x-card's number, the same way it does for numeric cards (we:src/backlog-redirects.njk:13).
- `/backlog/<x-id>/` also redirects to the canonical page.
- Old `/backlog/NNN-slug/` URLs are untouched.
- `blockedBy`, `parent` and `#ref` may cite either form; both resolve through the ledger in every mode. The
  batched rename rewrites references as the drain does today; an x-id reference it misses still resolves.

## Slices

| Slice | Card | Size | blockedBy |
|---|---|---|---|
| (0) card numbers assigned at birth | 6622 | 5 | — |
| (a) ledger store and assign-at-land, in shadow | 6121 | 5 | — |
| (b) readers and renderers use the ledger | 6124 | 5 | 6121 |
| (c) check-standards rules accept ledger-numbered x-id file names | 6125 | 3 | 6121, 6124 |
| (f) nightly batched rename-after-land job (cadence setting, merge queue, idempotent, rewrites x-id references) | 6126 | 5 | 6121, 6124, 6125 |
| (d) switch: flip `backlog.cardNumbering.mode` to `rename-after-land` (approved invariant, humanGate cleared); removes no code path | 6127 | 5 | 6121, 6124, 6125, 6126 |
| (e) policy docs, retire the local hash ledger, optional by-number lookup | 6128 | 3 | 6127 |

Review prevention is tracked separately in 6123 (spec dependency/scope integrity and security evidence).

## Estimated saving

- One full CI round (about 14 min of wall time) per PR that carries a new card, and no approval drop from a
  moved head. In the default mode that is replaced by one CI run per nightly rename batch.
- The numbering worktree, the full-tree reference rewrite and the queued-hash sweep leave the drain pass. The
  ledger append is one fetch plus one small push.

## Acceptance

- [A1] **Executable** — in the default mode, a PR that carries a new `x<6>` card is enqueued at its judged
  head SHA (no drain commit on the branch), lands with its x-id file name, `node we:scripts/backlog.mjs show
  <its number>` resolves it through the ledger, and the next nightly rename batch renames it to an `NNN-slug` file name.
- [A2] Setting `backlog.cardNumbering.mode` to `rename-before-enqueue` restores today's behaviour with no code
  change for new unledgered cards. Ledger-numbered cards already on main retain their mappings through main
  repair, branch numbering, queued sweeps/probes and merge_group checks. Slice (d)'s integration fixture must
  prove both ledger modes can roll back safely, including retries and unreadable/conflicting ledger state.

## Non-goals

- [N1] Renaming any existing NNN card, or breaking any existing URL.
- [N3] Deleting the rename-before-enqueue path. It stays as a switchable mode.
- [N2] Moving the resolve-on-land commit. If a resolve commit is ever added before enqueue, it still costs a CI
  round. That is a separate card.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — ledger rows are parsed as JSON with a strict shape (`id` matches `HASH_RE`, `num` a
   positive integer); anything else is dropped and reported, never interpolated.
2. **Truncated reads** — the JSONL read uses the sized-read pattern of `sizedLedgerRun`
   (we:scripts/lib/verdict-ledger-io.mjs:92); partial lines are never parsed and mark the ledger unreadable;
   an over-cap read fails closed before allocation, append or push. Slice (a)'s
   `rejectsOversizedLedgerBeforeAllocation` asserts the actual cap + 1 read bound and absence of writes.
3. **Shared state files** — the only writer is the drain under `withNumberingLock`; the push is the
   cross-host compare-and-swap; readers never write.
4. **Fail closed** — the assign step refuses to enqueue when it cannot write the row; readers fall back to the
   x-id display, never to a guessed number.
5. **Identity scoping** — one ledger file per repo; the id is the global key; the number is never reused.
6. **State over time** — the ledger is append-only; a closed-unmerged PR leaves a burned number (a gap), the
   same as today's reservations.
7. **Who wrote it** — only rows with authenticated introducing commits count; trusted drain signing keys
   authenticate provenance, not author-name strings or a later trusted tip. Both ESM and CJS readers must
   pass slice (a)'s forged-row-under-trusted-tip fixture.
