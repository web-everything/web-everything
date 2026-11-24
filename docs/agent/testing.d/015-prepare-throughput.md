## Prepare throughput

Prepare batches use `prepare.batchSize` (6) and the just-in-time window uses
`prepare.aheadCount` (20), standard → platform `prepare` → tool `prepare` → env
(`WE_PREPARE_BATCH_SIZE`, `WE_PREPARE_AHEAD_COUNT`). Effective values and sources are logged.
An explicit `--prepare-ahead-window` or `WE_BUILD_DAEMON_PREPARE_AHEAD_WINDOW`
overrides that cascade. Resolve it once per tick for planning, replanning, and batch
membership; `off` disables the window while keeping queued cards eligible for batches.
Only build-bound cards in that window are eligible, including stale stamps. Order is
`build.priority`, then ready-queue order. Batch members must belong to the same repository
and have disjoint scopes. Every card gets a fresh worker launch containing only its own
card and scope, and one commit. `prepare.batchParallel` (true) uses separate leased lanes;
`prepare.batchMaxParallel` (3) limits fan-out to the builder external concurrency cap.
Both follow the same cascade with `WE_PREPARE_BATCH_PARALLEL` and
`WE_PREPARE_BATCH_MAX_PARALLEL` overrides, logging effective values and sources.
Sequential mode still launches a fresh worker per card. Worker IO and gates carry the
card session identity; assembly reuses the first surviving card's lane and identity
so verify-lane observes its own lease. Local `lane/prep-<card>` refs
retain individual commits and never open PRs. An assembler lane cherry-picks them in
priority order onto `lane/prepare-batch-<first-id>-<n>`; conflicts are aborted with rerere
disabled and the card is deferred to the next batch, without manual resolution.
Only cherry-pick conflicts enter `deferredToNextBatch`: the daemon releases deferred lead/member
claims without a failure hold, then admits them again on the next tick. Each surviving card
passes its own checks and receives its own stamp; a failed card is restored and its reason
recorded in the batch result and PR body. One PR is titled `prepare: <ids>`.
Worker failures stay in `groupDropped` and enter the normal prepare failure/hold path,
including failed leads and members. A failed assembly gate or publication accounts for
every undelivered card except conflicts. Test consecutive ticks to prevent immediate
readmission; replay `prepare-batch-window-and-failure-accounting` for both cases.
The batch branch uses the first surviving card and surviving count; status reads require
that branch to agree with the exact title membership. Preserve the original group lead
in settlement fixtures, including when that lead failed but a member has a stamped OPEN PR.
Redact diagnostics before any head/tail limit and again at the public body writer;
replay `prepare-batch-publication-boundaries` for credential cuts and claim retirement.

`review.cardOnly.lightLane` (true) seats one blocking Codex correctness juror for a net
diff containing only direct `backlog/*.md` cards. `review.cardOnly.claudeSeat` (false)
adds a Claude seat when enabled. Both resolve standard → platform `review.cardOnly` →
tool `review.json` `cardOnly` → environment (`WE_REVIEW_CARD_ONLY_LIGHT_LANE`,
`WE_REVIEW_CARD_ONLY_CLAUDE_SEAT`), logging sources. Rename sources participate;
unreadable/empty lists keep the full roster. The pinned net read must confirm the
classification before judging, and resumes retain the saved roster.
The existing `redTeam.skipCardOnly` cascade and CI card-only path filter are reused.

