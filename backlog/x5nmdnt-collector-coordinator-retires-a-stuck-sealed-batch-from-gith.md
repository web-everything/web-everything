---
kind: story
size: 5
parent: "x87psvt"
status: open
scope: ["we:scripts/operations/card-batch-seal-io.mjs", "we:scripts/operations/card-batch.mjs", "we:scripts/operations/card-batch-io.mjs", "we:scripts/operations/__tests__/card-batch-seal-io.test.mjs", "we:scripts/operations/__tests__/card-batch.test.mjs", "we:scripts/operations/__tests__/card-batch-io.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Collector coordinator retires a stuck sealed batch from GitHub truth

Priority: top (unblocking). Live: the prevention collector has been stuck since 2026-10-14. Batch 9 (PR 5272) merged but its state file kept sealedAt at seal step ready, so admission refuses every card with batch-sealed and the filer spools it: 327 cards spooled at 2026-10-18 08:06 ET. Fix: the coordinator reads a sealed batch's PR state on GitHub (GitHub is the truth) and acts under the existing per-kind lease. It does this on the next admission for the active slot, and on the seal scan (`sealDueBatches`) for batches already archived under `sealed/`. Each PR state has its own row:

| PR state on GitHub | State file | Members |
| --- | --- | --- |
| open (the normal sealed state, awaiting merge) | untouched: stays sealed, admission keeps refusing `batch-sealed` | untouched |
| merged | retired; the next admission opens a fresh batch | nothing to do: the merge landed them |
| closed by a split (a `sealed/` remainder records `extractedFrom.pr` equal to this PR, or the extract journal for it records a `standalonePr`, which is written before the extract step closes the PR) | retired | nothing to do: the survivors are on the remainder PR and the rejected card on its standalone PR |
| closed otherwise, not merged | archived whole to `sealed/` with a `closedUnmerged` record, then the active slot is retired so admission unblocks | surfaced as needs-you, naming the PR and every recorded member |
| unreadable (API error, unknown state, missing PR number) | stays sealed and held | untouched |

Members of a batch closed without a merge are surfaced, never re-admitted automatically. Who closed it decides what the cards should become, and the coordinator cannot tell: an operator disposition such as close-superseded discards them on purpose, and commits adopted onto the branch at seal (numbering, fix-loop edits) never entered the recorded members. The PR link in the escalation covers those adopted commits. The escalation is driven from the `closedUnmerged` archive and is idempotent: a failed post retries on the next scan and never re-blocks the kind.

Every retired archive gets a terminal marker naming its row (merged, split, or `closedUnmerged` once the escalation is posted). The seal scan honours it: no seal-job relaunch and no further GitHub read. A `closedUnmerged` record alone, before its escalation is posted, already stops seal-job launch and GitHub reads: the scan only retries the post. Today the scan relaunches any `sealed/` archive with `sealedAt` unless it has `sealFailure` or step `label-on-green` (`sealDueBatches` in we:scripts/operations/card-batch-seal-io.mjs), so a retired batch 9 archived at step `ready` would be relaunched against its merged PR on every tick. The `sealFailure` / `label-on-green` skip changes too: such an archive without a terminal marker gets its PR state read (a person may close it later), but never a seal-job launch.

Proof required: before/after on the live 327-card spool draining into a fresh batch. Operator 2026-10-18 verbatim: All ok.

## Acceptance

- [A1] **Executable** — `node --test we:scripts/operations/__tests__/card-batch.test.mjs we:scripts/operations/__tests__/card-batch-seal-io.test.mjs we:scripts/operations/__tests__/card-batch-io.test.mjs` fails before this item lands and passes after. Planned cases:
  - `retires a sealed state whose PR merged on the next admission` (we:scripts/operations/__tests__/card-batch.test.mjs) — admission returns `admit` into a fresh batchRef, never `batch-sealed`.
  - `open sealed PR stays sealed and keeps refusing batch-sealed` (we:scripts/operations/__tests__/card-batch.test.mjs) — with a valid `open` GitHub response (not an API error), the state keeps sealedAt, nothing is archived or escalated, and admission is refused `batch-sealed`.
  - `split-closed batch retires and surfaces nothing` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — with a remainder manifest whose `extractedFrom.pr` is this PR, the state retires and no escalation is written.
  - `journal-only split retires and surfaces nothing` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — with no remainder manifest (no cards remained) and an extract journal for this PR that records `standalonePr` but not yet `closed` (a crash between the PR close and the journal save), the state retires as split, not `closedUnmerged`, and no escalation is written.
  - `archive failure preserves the active slot and retry preserves every member` (we:scripts/operations/__tests__/card-batch-io.test.mjs) — fault injection: a failing archive write leaves the active slot sealed with every member; a crash injected after the archive write and before the slot retirement leaves both the complete archive and the sealed slot; a seal scan may run in that window; the next run completes retirement once, keeps any marker already on the archive, the archive then holds every member, and exactly one escalation is posted across the crash, the scan and the re-run.
  - `open archive is read, not marked and not spawned` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — a `sealed/` archive at `label-on-green` or with `sealFailure` whose PR is `open` gets one PR read, no terminal marker and no seal-job spawn, so a later close is still surfaced.
  - `unmarked archive whose PR merged gets the merged marker` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — a `sealed/` archive without a marker whose PR merged is marked merged, with no seal-job spawn and no escalation.
  - `stale extract audit write is re-marked by the next scan` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — an archive whose terminal marker was overwritten by the extract step's `extractedTo` write gets the marker back on the next scan, with one GitHub read and no seal-job spawn.
  - `closed-unmerged batch is archived, retired and surfaced` (we:scripts/operations/__tests__/card-batch-io.test.mjs) — the `sealed/` archive holds the full member list and a `closedUnmerged` record, the next admission opens a fresh batch, and the escalation names the PR and every member.
  - `closed-unmerged escalation retries without re-blocking admission` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — a failed post leaves the archive pending, the next scan posts once, no seal job is spawned for the archive on any of those scans, and admission is never refused `batch-sealed` meanwhile.
  - `archived sealed batch closed later is surfaced by the seal scan` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — a `sealed/` manifest (including one at `label-on-green` or with `sealFailure`) whose PR closes unmerged after it left the active slot gets the same `closedUnmerged` record and escalation, and no seal job is launched for it.
  - `terminal archive is not spawned and makes no gh call` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — a retired archive at step `ready` with a terminal marker produces no seal-job spawn and no GitHub read on the next scan.
  - `unreadable PR state stays sealed and held` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — no retirement, no member change.
  - `retirement is refused while another owner holds the lease` (we:scripts/operations/__tests__/card-batch.test.mjs) — a concurrent admission gets `lease-held`, and no card lands on the retired batch.
- [A2] **Live** — the 327-card prevention spool drains into a fresh batch: before/after spool count on the real host.

## Non-goals

- [N1] The seal timeout itself (x245i7o), numbering at seal (x1mmp60) and the unextractable-finding age escape (xf1z2w3) are their own slices.
- [N2] No automatic re-admission of a closed batch's cards: a person decides from the escalation.
- [N3] No new setting: retirement is unconditional.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the PR state comes from GitHub; an unknown state is treated as unreadable (fail closed).
2. **Truncated reads** — a failed or partial GitHub read is unreadable, never "closed"; the batch stays sealed and held.
3. **Shared state files** — retirement and archiving run under the existing per-kind lease with the expected-head check; a concurrent admission is refused `lease-held`. The archive is written before the active slot is retired, so a crash between the two leaves the batch sealed and retried, never lost (case `archive failure preserves the active slot and retry preserves every member`). The extract step's final audit write (under its per-PR lock, not the lease) can overwrite an archive's terminal marker from a stale copy; the next scan re-marks it, costing one extra GitHub read, never a card (case `stale extract audit write is re-marked by the next scan`).
4. **Fail closed** — an unreadable PR state keeps the batch sealed and held, never retires.
5. **Identity scoping** — state and archives are keyed by repo and kind; the split check matches the remainder's `extractedFrom.pr` to this PR in the same repo and kind.
6. **State over time** — the five PR-state rows above (open, merged, split by remainder or by journal, closed otherwise, unreadable), one named case each in [A1], for both the active slot and `sealed/` archives. Only merged, split and closed-otherwise are terminal; anything else, including a valid `open`, never retires.
7. **Who wrote it** — the coordinator writes the state and admit commits, but the branch can also carry commits adopted at seal (numbering, fix-loop edits). That is why a closed batch is surfaced with its PR link rather than rebuilt from the recorded members.
