---
kind: epic
status: open
scope: ["we:scripts/lib/queue-branch-numbering.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/lane-drain.mjs", "we:scripts/check-standards.mjs", "we:scripts/check-standards-rules.mjs", "we:src/_data/backlog.js", "we:scripts/backlog.mjs"]
dateOpened: "2026-10-13"
tags: [backlog, drain, merge-queue, numbering, ledger]
---

# Card numbers as a ledger (no rename commits)

Card 265 (operator OK 2026-10-12, reconfirmed 2026-10-13): keep the x-id as the permanent card file name; the drain assigns the display number into an id-to-number ledger on an ops branch at land. Removes the pre-enqueue numbering commit in we:scripts/lib/queue-branch-numbering.mjs and its extra CI round.

## Why now

Under the merge queue, `prepareBranchBeforeEnqueue` (we:scripts/lib/queue-branch-numbering.mjs:238-300) renames every
`x<6>` card on the PR branch to its `NNN` and pushes a new head before enqueue. That new head:

- forces a full extra CI round for every PR that carries a new card (about 14 min each);
- dropped two operator approvals because the head moved (#5025, worked around by #5233);
- is a large share of the drain's 12-minute passes (worktree + full-tree reference rewrite in
  `numberPendingHashes`, we:scripts/lane-drain.mjs:682, plus `sweepQueuedHashCards` at :318 and the land probes
  at :200/:354).

The number is display data. It does not need to live in the file name.

## Decision note — for the operator to confirm (not ruled here)

**Conflict.** #5057 made it "mechanically impossible to add a temp id in the queue": `mergeGroupHashRefusals`
(we:scripts/lib/queue-branch-numbering.mjs:34-37, called from we:scripts/check-standards.mjs:787-789) refuses any
merge group that carries an `x<6>` file name, unconditionally. Card 265 makes `x<6>` file names permanent on
`main`. The two cannot both hold. The operator's approval of 265 supersedes the file-name half of #5057.

**Proposed replacement invariant.** *Every card on `main` has a ledger number, assigned atomically by the drain's
land step. Nothing on `main` references an unassigned id in a user-visible place.* Concretely: the merge_group
gate stops refusing `x<6>` file names and instead refuses any `x<6>` card in the group that has no ledger row.
The "no hash on main" rule becomes "no unledgered hash on main".

Slice (d) carries a `humanGate` on this note. It does not switch until the operator confirms.

## Design

### Ledger format and location

- Branch `ops/card-numbers`, file `card-numbers/we.jsonl` (on the ops branch, not a repo path) (one file per repo, the same shape as
  the per-repo verdict ledger on `ops/review-requests`, we:scripts/lib/verdict-ledger-io.mjs:38-42).
- Append-only JSON lines: `{"id":"x7k2q9a","num":5301,"pr":5240,"at":"<ISO>","by":"drain","kind":"assign"}`.
  Seed rows use `"kind":"seed"`.
- Writes go through the existing transport: `stageOnTransportBranch` / `readFromTransportBranch`
  (we:scripts/lib/git-transport-branch.mjs:230, :354) and the fetch / idempotent-append / bounded-retry loop of
  `appendLedgerRows` (we:scripts/lib/verdict-ledger-io.mjs:163). No new transport.
- Two invariants on the file: one number per id, one id per number. Every reader validates both and fails
  closed on a violation (it shows the x-id and reports the conflict; it never guesses).

### The atomic assign-at-land step

- Runs inside `withNumberingLock` (the same mutex `prepareBranchBeforeEnqueue` uses today).
- Under the merge queue, the drain's land action is the enqueue. The assign step runs just before
  `mergeStrategy.enqueue` (we:scripts/merge-ai-prs.mjs:6539-6545), in place of the branch numbering. In
  drain-direct mode it runs just before `mergePr`.
- Steps: fetch `ops/card-numbers`; list the PR head's `x<6>` cards; skip ids that already have a row (idempotent
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

### Migration of the ~6,000 existing NNN cards

- Keep every existing file name. No renames, ever.
- A numeric file name is its own number. It needs no row.
- Seed one row per existing card that carries `bornAs: x<6>` (id = the bornAs hash, num = its file number), so
  an old x-id still cited anywhere (docs, flows, prose) resolves to the right card. This is the "maps both ways"
  half.
- New cards are `x<6>` on disk forever and get a row at land.

### URLs and links

- Canonical page stays `/backlog/<file stem>/` (we:src/backlog-pages.njk:7). For a new card that is
  `/backlog/x7k2q9a-slug/`. It never changes, so links never break.
- `/backlog/<NNN>/` keeps working: `backlogRedirects` (we:src/_data/backlogRedirects.js:18) emits a redirect for
  each ledgered x-card's number, the same way it does for numeric cards (we:src/backlog-redirects.njk:13).
- `/backlog/<x-id>/` also redirects to the canonical page.
- Old `/backlog/NNN-slug/` URLs are untouched.
- `blockedBy`, `parent` and `#ref` may cite either form. New cards should cite the x-id: it is stable from
  birth, so no reference rewrite is ever needed again.

## Slices

| Slice | Card | Size | blockedBy |
|---|---|---|---|
| (a) ledger store and assign-at-land, in shadow | x5qtv82 | 5 | — |
| (b) readers and renderers use the ledger | xy5r0uf | 5 | x5qtv82 |
| (c) check-standards rules accept ledger-numbered x-id file names | xbpjdsd | 3 | x5qtv82 |
| (d) switch: stop the pre-enqueue rename, relax #5057 to the new invariant (humanGate) | xk60q6s | 5 | x5qtv82, xy5r0uf, xbpjdsd |
| (e) cleanup of the rename machinery | x2cdum4 | 3 | xk60q6s |

## Estimated saving

- One full CI round (about 14 min of wall time) per PR that carries a new card, and no approval drop from a
  moved head.
- The numbering worktree, the full-tree reference rewrite and the queued-hash sweep leave the drain pass. The
  ledger append is one fetch plus one small push.

## Acceptance

- [A1] **Executable** — a PR that carries a new `x<6>` card is enqueued at its judged head SHA (no drain commit
  on the branch), lands with its x-id file name, and `node we:scripts/backlog.mjs show <its number>` resolves it
  through the ledger.

## Non-goals

- [N1] Renaming any existing card, or changing any existing URL.
- [N2] Moving the resolve-on-land commit. If a resolve commit is ever added before enqueue, it still costs a CI
  round. That is a separate card.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — ledger rows are parsed as JSON with a strict shape (`id` matches `HASH_RE`, `num` a
   positive integer); anything else is dropped and reported, never interpolated.
2. **Truncated reads** — the JSONL read uses the sized-read pattern of `sizedLedgerRun`
   (we:scripts/lib/verdict-ledger-io.mjs:92); a partial last line is ignored; an over-cap read fails closed.
3. **Shared state files** — the only writer is the drain under `withNumberingLock`; the push is the
   cross-host compare-and-swap; readers never write.
4. **Fail closed** — the assign step refuses to enqueue when it cannot write the row; readers fall back to the
   x-id display, never to a guessed number.
5. **Identity scoping** — one ledger file per repo; the id is the global key; the number is never reused.
6. **State over time** — the ledger is append-only; a closed-unmerged PR leaves a burned number (a gap), the
   same as today's reservations.
7. **Who wrote it** — only drain-authored rows count (the `by` field plus the trusted-author check of
   `trustedDrainAuthors`, we:scripts/lib/queue-branch-numbering.mjs:17).
