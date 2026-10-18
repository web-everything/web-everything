---
kind: story
size: 3
status: open
scope: ["we:scripts/operations/run-store.mjs", "we:scripts/operations/run-record.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Run-record retention: tiered prune and archive of old operations run records

The primary operations runs dir holds 133,181 run files (28 GB), and every scan of it pays for them. Count by operation: runner-activity 55,680, live-state 18,930, heavy-queue 18,235, sessions 11,901, review-seat-caps 6,139, review-pr 5,951, drain-ledger-shadow 4,974, open-pr 4,133.

Add TIERED retention. Each tier is a setting under `operations.runs`.

- **Tier A, status snapshots** (runner-activity, live-state, heavy-queue, sessions, review-seat-caps): keep `snapshotRetentionDays` (default 2), then delete. No backup; they have no lasting value.
- **Tier B, decision and evidence records** (review-pr, rulings, open-pr, verify, drain-ledger-shadow, extend-rounds, record-referral-ruling, land, enqueue): after `evidenceCompressAfterDays` (default 14), compress into monthly archives (`.jsonl.gz`, one per month). Archives are kept for good and never deleted. They stay readable by the coroner, delivery metrics, advisory lessons and ledger backfill.
- **Open PRs**: a record tied to an open PR is always kept uncompressed, in either tier.

The tier list is data (a setting), so a new operation is classified in one place; an unclassified operation is treated as Tier B (never deleted).

## Acceptance

- [A1] **Executable** — `npm run test:unit -- run-store-retention` fails before and passes after, covering: tier classification of every operation named above plus an unknown one (falls to Tier B); Tier A deleted past 2 days and kept inside it; Tier B compressed past 14 days into the month's archive; the archive round-trip (each reader above still returns the same records from an archive as from the loose file); open-PR records kept uncompressed in both tiers; scans stay bounded (a store with thousands of old records lists in a bounded number of reads).
- [A2] The prune/compress step is a declared operation with a `--preview` that lists what it would delete and compress, and changes nothing.

## Non-goals

- [N1] No deletion of Tier B records, ever; archives are permanent.
- [N2] No change to what a run record contains.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: run records are written by our own operations; the step reads them as data and never evaluates them.
2. **Truncated reads** — a half-written record or archive is skipped and left in place, never deleted; archive writes go to a temp file then rename.
3. **Shared state files** — many sessions write the runs dir; the step only touches records older than the cutoff and tolerates a file vanishing mid-run. A monthly archive is appended under a lock or rewritten atomically.
4. **Fail closed** — if the open-PR list cannot be read, no record is deleted or compressed; if an archive cannot be verified readable, the loose files stay.
5. **Identity scoping** — open-PR matching uses the repo plus PR number, so a same-numbered PR in another repo does not protect (or expose) a record.
6. **State over time** — age comes from the record's own timestamp, not file mtime; a PR that closes later has its records age out on the next pass.
7. **Who wrote it** — n/a: the step does not trust or alter authorship fields; it moves records unchanged.
