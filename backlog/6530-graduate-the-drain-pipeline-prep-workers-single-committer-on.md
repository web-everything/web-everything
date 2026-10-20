---
bornAs: xyw3et8
kind: story
size: 8
status: open
scope: ["we:scripts/lib/drain-pipeline.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/settings/drain-pipeline.json"]
dateOpened: "2026-10-19"
tags: []
---

# Graduate the drain pipeline (prep workers + single committer) once shadow is safe

**Status: PARKED 2026-10-19 (operator/coordinator).** Prototype is on branch `lane/proto-drain-pipeline-wip` (commit 1589157e3c, based on the drain clone tops 3c31ac7dc3). Not loaded into the drain.

**Precondition to resume:** run shadow only once host load is normal AND the drain data-clone lock fix is live.

## Design (operator-approved 2026-10-19)
Stage 1 one listing per cycle (existing listing, event trigger, context cache). Stage 2 cheap classification of all PRs (held/waiting/candidate). Stage 3 pool of prep workers (drain.pipeline.workers, default 4) doing the fresh live read, red-team hold evaluation and per-PR gate reads, respecting gh-throttle and host load. Stage 4 single committer in today's priority order: re-check head unchanged, queue file-overlap, coupling, batching; numbering and acceptance re-stamp serial; enqueue under the land-write lock. Every hold/guard identical to today's. Setting drain.pipeline = off|shadow|on (default shadow; on is inert in the prototype).

## Shadow evidence (live dry run, host load 27-48)
- 26 of 35 preps finished in the 300 s time box; about 130 s per prep under load (idle host: about 6-7 s per context read).
- First attempts finished 0 of 37 because workers queued for heavy-admission slots behind builds; switched to a host-load-only gate (no slot).
- Result: complete=false (time box exceeded), no would-enqueue list, no serial-vs-shadow comparison.

## Parity gap
Branch preparation and the acceptance re-stamp need writers, so the shadow marks every otherwise-clear candidate "unknown, so refuse". Also unported: pinned workflow-surface read (fetches git), live couple preflight, approved-head handling, request recovery/backoff, some ordering. Serial equivalence and speedup are unproven.

## Guard audit findings (Codex, static; reply began WEAKENING, no hold/guard was weakened)
1. Shadow reads share the gh-throttle budget/slots and can delay the real drain's gh calls (we:scripts/lib/drain-pipeline.mjs:233 to we:scripts/lib/gh-throttle.mjs:2221-2225).
2. Write-capable calls reachable via the throttle: points budget state, slot files, headroom, call log, telemetry (we:scripts/lib/gh-throttle.mjs lines 1173, 1208-1220, 606-624, 1510-1513, 1612-1667); no enqueue, git write or land-lock acquisition.
3. graceMs bounds only the async wait; settings reads, cloning, planning and state reads run synchronously on the drain's event loop.
4. PASS: production evaluators reused; unknown guards refuse; no refuse-to-allow downgrade. 5. PASS: on mode inert.

## Acceptance

- [A1] **Executable** — with the preconditions met, one real shadow cycle logs complete=true with a would-enqueue list equal to the real drain's enqueues and a prep wall time below mergeCascadeMs: `grep "drain-pipeline(shadow)" ~/workspace/plateau-app/.drain-daemon/daemon.log`.
- [A2] **Must** — shadow does not use the shared gh budget at a rate that delays the real drain, and runs its synchronous work off the drain's loop (worker or child process), or the audit finding is explicitly accepted by the operator.
- [A3] **Must** — branch prep and acceptance re-stamp parity is shown on the committer (serial) before any `on` mode.

## Non-goals

- [N1] Turning `on` mode live, or moving card numbering out of the committer.

## Edge cases this change must handle

1. **Untrusted text** — PR bodies and comments are never read by the shadow; only allowlisted gh reads.
2. **Truncated reads** — a cut-off or timed-out read is unknown and refuses, never clears.
3. **Shared state files** — shadow touches only gh-throttle bookkeeping; no drain state files.
4. **Fail closed** — unknown guards refuse; setup or finish errors log one line and the real drain continues.
5. **Identity scoping** — preps are keyed by repo#num and head sha; a head change between prep and commit means no enqueue.
6. **State over time** — a head change after prep invalidates the prep; time box and grace bound the shadow.
7. **Who wrote it** — log lines are written by the drain child; the prototype was authored by Codex under a Claude driver.

## Design note (verbatim)

# Drain pipeline prototype — shadow first

## Inputs and stages

1. Reuse `sweepOnce`'s `listings` / `prsByRepo`, not another listing. The resident plateau-app daemon already consumes `prEventFeed.drain.mode`; its wake is never an order. WE's `drain-pr-state`, `pr-snapshot`, and `drainHeavyCacheByRepo` hydrate heavy fields; they must never supply cached authorization. No trigger or context-cache changes belong to this prototype.
2. Reuse the `buildDrainVerdicts` / `classifyPr` results for all PRs. Bucket these as held, waiting, candidate without introducing a second hold rubric. Keep repo, PR number, listed head, the existing verdict, and its original index together. Do not move numbering here.
3. `mapWithConcurrency` bounds preparation, preserves input order, and never admits more than the configured width. Each callback must use the production decision functions with live safety reads. The orchestration receives read-only capabilities, not an enqueue strategy. The hook injects the existing exported `resolveRequiredCheck` and `revalidateWithUnknownRetry` functions; no cached head authorizes readiness. An abort signal and deadline stop new work. No synchronous child process or synchronous sleep may be introduced into the shadow: a Promise timeout cannot interrupt those.
4. A serial projection walks prepared rows in today's supplied priority order. Head equality is necessary; the supplied production queue-overlap, coupling and batching decision must also pass. This projection has no writers. The real committer remains the current cascade, its `withLandWriteLock`, acceptance re-stamp and card-numbering path. `on` remains explicitly unavailable in this prototype rather than silently enabling an unproven writer.

## Guard parity and limits

Production guard parity is structural: no production guard, guard order, stamp or lock is replaced. Shadow parity requires calling the SAME decisions with the SAME complete inputs, not recreating a simplified rule. A held/waiting input is never prepared. Candidate snapshots must be copied before production mutates them. The serial projection is injectable so tests can use the very same decisions in serial and parallel runs.

There is a material unresolved seam: enqueue's red-team path also updates pending state, syncs labels and requests work, and `prestage` invokes pinned git preparation. Neither is a safe shadow callback. Head equality alone also cannot prove labels, red-team evidence or main-relative freshness unchanged. Until those reads are separated from effects, a live shadow must refuse those unknown checks explicitly; matching lists are NOT a guard-parity proof. Do not call `enqueue`, even with spies or dry-run, from shadow.

## Isolation and measurements

The module imports production readers/evaluators, the async executor, and admission primitives. It accepts no application writer, numbering or enqueue capability. It invokes those readers and one line logger. Errors including logger failures are contained; a deadline aborts reads and prevents further admissions. Late completions do not log another cycle record. The hook must not await shadow preparation before the normal cascade. Finish consumes real pass outcomes and `timings.mergeCascade`, emits a single `[drain-daemon] <iso> drain-pipeline(shadow): <json>` line, and does not wait. Immediately before the final pass summary, `awaitPipelineShadow` gives `done` at most 5 seconds; expiry aborts and emits an incomplete record before returning. Timings name what was actually measured; unavailable comparisons are null, not invented speedups.

The live adapters use `execDrainAsync`, the SAME throttle CLI as real async drain reads.
Shadow preparation, live head reads and queue projection separately acquire heavy admission
(`acquireSlotBlocking`/`releaseOwnedSlot`), including host-load admission, and refuse disabled
or unslotted results. They do not borrow an inherited real-drain slot. Deferred admission
retries until abort. The admission and throttle's own coordination markers are necessary
infrastructure effects; the shadow has no application/GitHub/git/file writer capability.

Repositories outside the enqueue strategy are skipped without extra API reads.
Fresh preparation reuses `resolveRequiredCheck` and `revalidateWithUnknownRetry` (therefore
`revalidateForMerge`/`classifyPr`), then reads live head/labels/reviews, complete comment pages,
`readDrainQueueSafety`, `readQueueState`, `readDrainRedTeamEvidence`, `sendBackReason` and
`redTeamEnqueueHold`. It does not call `enqueue`, `prestage`, request dispatch or label sync.
`readDrainRedTeamEvidence` receives `savedRedTeamRunsDir` explicitly; its default
`resolveRunsDir` can migrate files and is deliberately not invoked. Its scorecard reader
already uses an explicit path, avoiding lazy store migration.
Local evidence scanning and the existing hold evaluator run in a read-only subprocess
inside the parent preparation slot, so even slow local IO or the production `pidStartTime`
probe cannot block the real drain event loop. Input travels over stdin, never a file.
Abort terminates only the process group belonging to this read, including a throttle
CLI/gh child or evidence-worker/ps child.
Queue projection uses `planLabelDrain`, `planCoupleCascadeStep`, `completeListedFiles`,
`readQueueEntryFiles`/`queueFileOverlap`, and `readQueueFacts`/`admitEnqueue`. Synchronous
production queue readers are replayed against only their own freshly captured throttled
async gh responses; there is no cross-call/head authorization cache. Prior projected
admissions are supplied as landed items, queued files and in-queue numbers. Batching
state is read from disk and changes are projected in memory only.

Parity is NOT proven: the approved-human BEHIND override and
carry/main-fix/overlap-yield ordering, live couple preflight, red-team request recovery/backoff,
pinned workflow surface, branch preparation and acceptance restamping are not fully
projected. In particular `readPinnedChangedFiles` performs git fetch and cannot be
called read-only; every otherwise-clear queue candidate retains an explicit unknown
surface/branch-preparation refusal. This is intentionally conservative and means a
successful stage run can still predict no admissions. The JSON includes prep reasons,
unknowns and projection decisions; `complete` describes orchestration completion,
not serial guard parity. No prediction authorizes production writes.

Settings use the existing standard/platform/tool/env cascade and log sources. `drain.pipeline` is the scalar off|shadow|on; the literal leaf `drain["pipeline.workers"]` configures width (default 4); `drain["pipeline.timeoutMs"]` configures the deadline (default 240000ms, valid 1..600000), avoiding a JSON scalar/object collision. The resolver also accepts `{ pipeline: { mode, workers, timeoutMs } }` for callers preferring nested configuration. The timeout env override is `WE_DRAIN_PIPELINE_TIMEOUT_MS`. Default shadow, off does no work. Worker count, prep wall time and per-candidate durations are logged. Actual outcomes come from confirmed `enqueueOutcomes`; both readiness clocks start at pass-start; serial time ends at last enqueue (null when none). On is logged as requested but has no writer implementation.

