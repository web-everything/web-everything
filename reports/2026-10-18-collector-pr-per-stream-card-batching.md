# Collector PRs per stream - session report (2026-10-18)

Prep session for the decision "collector PRs batch card-only filings per stream (count or age flush)".

## Findings

1. The operator's idea is mostly shipped: epic 4703 (rolling card-only PRs). Kinds `prevention`, `filing`, `prepare`;
   count-or-age seal; high and urgent priority bypass; per-card extraction on a review finding; settings cascade with
   the source logged.
2. The prevention collector has been stuck since 2026-10-14. Batch 9 (PR 5272) merged, but its state file never
   retired (seal step `ready`, the seal job timed out before `label-on-green`). Every later card is refused with
   `batch-sealed` and written to a spool. 327 cards were spooled by 2026-10-18 08:06 ET.
3. The unbatched single-card PRs seen overnight are what the filer falls back to and what other paths still open.
   The rule-file conflicts (5515, 5524, 5527, 5532) were code PRs that edit one shared file. A card-only collector
   cannot absorb those; the file-claim and stacking machinery has to.
4. The card named "372" in the brief is a different item (loan data table). The matching card is 6250 (the prevention
   filer batches its standards rules).

## Prior art

Renovate groups and schedules, Dependabot groups, bors-ng and the GitHub merge queue batch size and wait timer,
Gerrit topics. Shared shape: group key, count cap, time window, and a way to remove one bad member without
discarding the batch. None re-queues the removed member into the next batch.
