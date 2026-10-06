---
bornAs: xqw7hb2
kind: story
size: 8
parent: "4075"
status: open
blockedBy: ["4125"]
scope: ["we:scripts/conveyor/health-watch-core.mjs", "we:scripts/conveyor/health-watch.mjs", "we:scripts/conveyor/__tests__/health-watch-core*.test.mjs", "we:scripts/conveyor/__tests__/health-watch*.test.mjs", "we:scripts/conveyor/health-investigate-dispatch.mjs", "we:scripts/conveyor/__tests__/health-investigate-dispatch.test.mjs", "we:scripts/conveyor/health-watch-job.mjs", "we:scripts/conveyor/__tests__/health-watch-job.test.mjs", "we:scripts/conveyor/health-smells/daemon-job-health.mjs", "we:scripts/conveyor/health-smells/__tests__/daemon-job-health.test.mjs", "we:skills-src/conveyor/daemon-manifest.mjs", "we:skills-src/conveyor/__tests__/daemon-manifest.test.mjs"]
dateOpened: "2026-09-24"
preparedDate: "2026-10-06"
preparedAgainstSha: "bd2018b09f744c819be2b2037109b63f75012419"
tags: []
---

# First adopter: the health daemon runs its probes and investigations as jobs

Adopt the delivered shared job runtime for health watch's slow probes, deterministic diagnoses, and per-episode investigation launch. Keep the health tick responsive while these jobs run, and pull every daemon's job records as health evidence. The governing rule is [we:docs/agent/platform-decisions.md#daemon-jobs](../docs/agent/platform-decisions.md#daemon-jobs), ratified on 2026-09-25. Preserve the existing health and investigation policies; this is the first adopter slice, not a replacement daemon or a new dispatch policy.

## Progress

- **Original premise/scope:** the card described an uncleared design awaiting #4120, located the work only in we:scripts/conveyor/health-watch-core.mjs and we:scripts/conveyor/health-watch.mjs, and assigned size 3 without test scope.
- **Corrected premise:** #4120 is ratified (we:docs/agent/platform-decisions.md:5814); #4125 is resolved and its runtime exists. The adopter is still outstanding: we:scripts/conveyor/health-watch.mjs:964 runs cadenced network probes inline, we:scripts/conveyor/health-watch.mjs:1032 runs diagnoses synchronously, and we:scripts/conveyor/health-watch.mjs:1049 awaits the investigation pass. These are source observations, not a live timing measurement.
- **Already present:** we:scripts/conveyor/health-watch.mjs:172 enumerates daemon job directories as part of `probeOperationRuns`; extend that read rather than inventing a second store. The pure evaluator already skips smells with missing probes (we:scripts/conveyor/health-watch-core.mjs:723). Job launch, reattachment and checkpoints are implemented in we:scripts/lib/daemon-jobs-runtime.mjs:145, we:scripts/lib/daemon-jobs-runtime.mjs:294 and we:scripts/lib/daemon-jobs-runtime.mjs:391.
- **Corrected scope and size: 3 → 8.** Investigation dispatch owns a separate ledger and mutates episode/report state (we:scripts/conveyor/health-investigate-dispatch.mjs:225–341), so simply detaching the existing tick would introduce competing writers. Include that module, a planned child entry, a planned job-health smell, manifest registration, and matching tests for each source. The manifest currently runs the CLI tick every interval (we:skills-src/conveyor/daemon-manifest.mjs:192); it has no health job-kind declarations. Existing test homes include we:scripts/conveyor/__tests__/health-watch.test.mjs:964 (inventory cadence) and we:scripts/conveyor/__tests__/health-watch-core.test.mjs:487 (probe errors).
- **Non-probe work discovered:** maintenance sweep/archive awaits also exist (we:scripts/conveyor/health-watch.mjs:853–860). Preserve those behaviors and include their enabled configuration in timing evidence; this card must not claim the entire tick is nonblocking merely because the probe path is detached. Shared runtime snapshot preparation is synchronous (we:scripts/lib/daemon-jobs-runtime.mjs:203); cold launch cost also needs measurement.

## Design

1. Declare health job kinds in we:skills-src/conveyor/daemon-manifest.mjs using the existing shared kind contract. Use pinned `readonly-tree` code, the existing default daemon concurrency of two, and serial investigation lifecycle work. Add we:scripts/conveyor/health-watch-job.mjs (planned) as the child entry composing `runJob`; reuse the shared runtime without copying its handle, retry, snapshot or lock implementation. Preserve per-kind inline rollout switches until live proof passes; disabling new job admission must still reconcile already-running jobs before returning that kind to inline execution.
2. In we:scripts/conveyor/health-watch.mjs separate cheap local reads from command/network probes. Queue due slow reads: daemon status, command-backed heavy status/process reads, GraphQL/REST budgets, credential inventory, PR/agent/stale-state/merged-PR reads and their dependent command-backed reads. Keep dependent inputs in the same job input/result generation. Queue deterministic diagnosis commands by episode ID. A due probe with a queued or running job gets no duplicate. Persist absolute state, lane-pool, source-repository and log roots in job input/environment so snapshot-relative defaults cannot inspect an empty snapshot instead of the host. Fixture and dry-run paths must remain isolated from host reads and dispatch.
3. Results belong to the job record/checkpoint and contain scrubbed values, sample time, per-probe errors and a generation/job ID. Only the tick writes health episode state, cursors, cadence stamps and reports. It consumes each completion once, independently per probe, retaining partial-success semantics. Queued/running/failed reads never become healthy empty samples. Missing fresh samples suspend the dependent smell's hysteresis; replaying a cached completion must not count as another observation. Adjust we:scripts/conveyor/health-watch-core.mjs so an unsampled tick does not clear a pending probe-error streak (current clearing loop: we:scripts/conveyor/health-watch-core.mjs:707).
4. Refactor we:scripts/conveyor/health-investigate-dispatch.mjs into lifecycle IO and tick-side projection. The serial job owns investigation ledger changes; the tick reads ledger/findings and alone annotates episodes and reports. Keep `dispatch-lane`, recording tokens, one-per-episode admission, running/window/subject caps, wall-clock reap and the dispatch-off default. Persist the episode/session reservation before invoking dispatch; on restart reconcile the deterministic session identity before any retry. An indeterminate launch keeps its slot and is reaped under the existing policy; it must never launch a second investigator. Mechanical job recovery does not resume a bot session. Closed-episode findings still appear once.
5. Reattach health-owned jobs on the first and subsequent ticks, leaving live handles alone and using the core's stop-before-relaunch/backoff rules. Read other daemons' records without mutating or reattaching them. Extend the existing record probe with owner, corruption and liveness evidence needed by we:scripts/conveyor/health-smells/daemon-job-health.mjs (planned). Evaluate overdue running jobs and exhausted/failed retries; include foreign-host and corrupt-record evidence as unavailable/abnormal, never healthy. Report owning daemon, kind, record ID, attempt and bound. Also cover the ruled cap-saturation and orphan-job observations using declared cap/handle evidence; do not infer an orphan merely from an arbitrary Node process. Discovery registers the new smell automatically (we:scripts/conveyor/health-smells/index.mjs:11).

## MVP

- Deliver the job entry and manifest kinds/switches, then convert slow probe and diagnosis execution to enqueue/read-result behavior. Preserve existing cadence, redaction, fixture flags and dry-run behavior.
- Convert investigation lifecycle IO with durable reservation/reconciliation and single-writer ledger ownership; retain tick-owned reports and all existing investigation limits.
- Add the job-health smell and wire cross-daemon record evidence through the existing probe. Add regression cases in every test path listed in scope; new entry/smell tests are planned files.
- Keep this as one adopter PR after #4125. Shared runtime APIs are dependencies, not a new runtime implementation in this slice. Enable job mode by default only after the proof below passes; a failing cold-start or maintenance timing check blocks graduation and must be addressed or explicitly scoped in review.

## Done when

1. The queue-backed focused test command in the test plan passes with new assertions that fail on the current inline path: a pending probe cannot hold a tick, repeated ticks do not duplicate jobs or observations, and restarting during dispatch cannot duplicate an investigator.
2. A real detached five-minute probe overlaps three completed health ticks, each below the configured tick budget, with launch/finish/reattach records and timestamps captured. Investigation launch has equivalent nonblocking and restart evidence through the declared operation.
3. Cross-daemon overdue/failed job fixtures open and recover health episodes; absent/incomplete results never close an existing episode as healthy. Rollback preserves ownership of in-flight work.

## Test plan

Run through the host heavy queue only. Command notation below uses repository-prefixed paths; execute from the WE root with the `we:` locator removed from arguments: `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/conveyor/__tests__/health-watch.test.mjs we:scripts/conveyor/__tests__/health-watch-core.test.mjs we:scripts/conveyor/__tests__/health-watch-job.test.mjs we:scripts/conveyor/__tests__/health-investigate-dispatch.test.mjs we:scripts/conveyor/health-smells/__tests__/daemon-job-health.test.mjs we:skills-src/conveyor/__tests__/daemon-manifest.test.mjs`.

- Shell/child: pending job across ticks; due deduplication; partial probe success; retry backoff; result ingestion once; error streak survives unsampled ticks; snapshot roots; dry-run and fixture isolation; no-inline fallback while a job is in flight. Use temporary stores and injected dispatch/probe seams, not real GitHub or paid agents.
- Core/smell: missing versus empty results, no duplicate hysteresis increments, overdue and exhausted attempts, recovery, foreign/corrupt records, cap saturation and verifiable orphan handles. Preserve existing probe-error and episode tests.
- Investigation: kill/restart at reservation, after dispatch but before acknowledgement, and after completion; verify one session, correct token validation, slot retention on uncertainty, budget accounting, stop deadlines, and closed-episode findings written once. Existing we:scripts/conveyor/__tests__/health-investigate-dispatch.test.mjs remains the policy regression suite.
- Manifest: health kinds resolve to the child entry with pinned-code mode and intended caps/switch defaults. Run existing shared-runtime tests if integration exposes a needed runtime change; add its source/test pair to scope before implementation.
- Run the standards gate through `node we:scripts/readiness/heavy-admission.mjs run -- npm run check:standards` using the same locator convention. Preparation itself does not assert these future cases already pass; the runner owns preparation checks.

## Proof plan

Use a disposable state/jobs/log root and a pinned revision containing the implementation. Run the real health CLI and shared detached runtime with a controlled probe that sleeps for 300 seconds; keep all external probes fixture-backed. Set an explicit accelerated health cadence of 60 seconds so three ticks can finish while that probe is running (the production five-minute interval cannot satisfy that overlap). Record scheduled/start/completed times, duration and the configured 60-second tick budget for each tick, plus job ID, handle, attempt and result-consumption time. Repeat at normal cadence to check scheduling without claiming three overlapping ticks from that run.

Restart the health driver while the child is alive and prove the same handle/attempt is retained, then confirm one result ingestion after completion. Exercise a stalled child and a failed job with bounded test settings and record stop-before-relaunch plus the visible health episode. Exercise investigation dispatch through the declared operation with a controlled sink, then perform the permitted live investigator launch before graduation; verify no duplicate session across the acknowledgement crash window. Retain shadow/dispatch switches and budgets throughout.

Measure both cold snapshot launch and warm launch; also measure ordinary enabled maintenance. Report those costs separately from probe duration. Unit mocks and a detached sleep alone cannot establish production readiness. Attach timelines and record excerpts to the implementation PR; this preparation performs no live dispatch, rollout, or host sleep.

## Follow-ups

Other daemon adopters (#4135, #4126, #4124, #4132) remain separate. Maintenance job adoption is separate from the probe/investigation goal unless timing evidence makes it necessary to meet this slice's tick budget; do not silently disable maintenance to obtain proof. Shared runtime performance defects discovered by cold-launch measurement require their own scoped source/test changes before graduation. No dependency-edge change is proposed: retain #4125 as the existing prerequisite.
