---
bornAs: xrp3dvt
kind: story
size: 5
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-jobs-runtime.mjs", "we:scripts/lib/daemon-job-snapshots.mjs", "we:scripts/lib/__tests__/daemon-jobs-runtime.test.mjs", "we:scripts/lib/__tests__/daemon-job-snapshots.test.mjs"]
dateOpened: "2026-09-28"
preparedDate: "2026-10-09"
preparedAgainstSha: "0c6c1fb5caf43602aeff444ed5731b4c39e1c1ec"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2848's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

The six review recommendations reduce to five behavioral regressions (the two eviction recommendations share one guard):

1. Snapshot preparation must yield the daemon event loop: current call chain is `we:scripts/lib/daemon-jobs-runtime.mjs:193` → `we:scripts/lib/daemon-jobs-runtime.mjs:162` → synchronous archive/install in `we:scripts/lib/daemon-job-snapshots.mjs:73` and `we:scripts/lib/daemon-job-snapshots.mjs:95`.
2. Exercise eviction through ticks, not just by calling its export: `we:scripts/lib/daemon-job-snapshots.mjs:138` has no production caller; tick admission ends at `we:scripts/lib/daemon-jobs-runtime.mjs:322` without cleanup.
3. Propagate archive failure before publishing a snapshot: the shell pipeline is now at `we:scripts/lib/daemon-job-snapshots.mjs:73`; publication and exception cleanup are at `we:scripts/lib/daemon-job-snapshots.mjs:58`.
4. Re-read the second job after awaiting the first stop: `we:scripts/lib/daemon-jobs-runtime.mjs:282` captures records once and `we:scripts/lib/daemon-jobs-runtime.mjs:292` awaits a stop before processing the next captured record.
5. Contain asynchronous spawn errors: `we:scripts/lib/daemon-jobs-runtime.mjs:176` attaches no error listener; the synchronous catch at `we:scripts/lib/daemon-jobs-runtime.mjs:211` cannot catch a later child error event.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2848@4d34c9fad792f8931e69b4abae695f0a17db4c38

## Progress

- Original premise/scope: six prevention suggestions, historical line citations, two source modules and their two existing test files, size 3. The goal remains regression prevention for the independent review of #2848.
- Corrected premise/scope: the named source modules still exist and the behavioral gaps remain visible in source; implementation repairs are required alongside the guards. Recommendations 2 and 6 concern the same missing eviction wiring. Keep the four scoped files; each source already has its matching test file. Prefer focused behavioral tests over a new repository-wide reachability/dead-export lint policy, as the original recommendations permit.
- Evidence: `we:scripts/lib/__tests__/daemon-jobs-runtime.test.mjs:229` advances an injected clock during synchronous materialization; it does not prove event-loop responsiveness. The single-job staleness case at `we:scripts/lib/__tests__/daemon-jobs-runtime.test.mjs:146` does not interleave two jobs. The preparation-error case at `we:scripts/lib/__tests__/daemon-jobs-runtime.test.mjs:240` does not exercise an actual spawn error. `we:scripts/lib/__tests__/daemon-job-snapshots.test.mjs:31` injects an exception; the real archive case at `we:scripts/lib/__tests__/daemon-job-snapshots.test.mjs:40` covers only success. Eviction tests at `we:scripts/lib/__tests__/daemon-job-snapshots.test.mjs:78` invoke cleanup directly. Production-source search finds no invocation of evictSnapshots outside its definition.
- Bound correction: retention is not an unconditional two-directory cap. `we:scripts/lib/daemon-jobs.mjs:211` preserves every referenced store, allowing the total to exceed the keep value when live references do. Assert at most max(keep, referenced existing stores) per store type after cleanup.
- Size 3 → 5: asynchronous propagation spans preparation, spawning and admission (`we:scripts/lib/daemon-jobs-runtime.mjs:154`, `we:scripts/lib/daemon-jobs-runtime.mjs:188`, `we:scripts/lib/daemon-jobs-runtime.mjs:316`), plus archive/installer changes (`we:scripts/lib/daemon-job-snapshots.mjs:71`, `we:scripts/lib/daemon-job-snapshots.mjs:93`) and five distinct regression scenarios. This is more than adding assertions to existing tests.
- Preparation evidence is source inspection, test inspection and history inspection; no runtime failure is claimed as reproduced. No implementation or preparation stamp is written by this worker.

## Design

Use the review's behavioral-test alternative. Make snapshot materialization and installation asynchronous with bounded child processes, propagate completion through buildOnce, ensureCodeSnapshot, ensureNodeModulesStore, prepareJobCode, launchJob and reattachTick, and preserve synchronous injected callback compatibility by awaiting their results. Keep atomic publication, cleanup on failure, lockfile reuse and launch-time stamping after preparation. No record lock spans an await.

Replace the archive shell pipeline with separately checked archive-to-temporary-tar and extraction operations in `we:scripts/lib/daemon-job-snapshots.mjs`. Remove the temporary archive on success and failure. An unknown commit must reject without publishing a completed snapshot; test actual Git failure rather than relying on a platform-specific tar exit status.

In `we:scripts/lib/daemon-jobs-runtime.mjs`, await the child's spawn/error outcome, installing listeners before returning; record launch errors only for the matching launch generation. Retain the existing counted-attempt/launch-grace retry behavior. Re-read and classify each record immediately before deciding whether to stop it, so a heartbeat received during a preceding stop is honored. Keep the existing post-stop generation check.

Wire eviction into completed tick processing using fresh non-terminal records' snapshotKeys, after awaited preparation/admission has recorded its references. Use the existing retention policy, and skip deletion when corrupt records prevent a complete reference set. Preserve the non-overlapping loop. The tick-level retention regression also guards against cleanup becoming a test-only export again.

## MVP

1. Add the five regression scenarios to `we:scripts/lib/__tests__/daemon-jobs-runtime.test.mjs` and `we:scripts/lib/__tests__/daemon-job-snapshots.test.mjs`; demonstrate failures against the current implementation.
2. Apply the minimal asynchronous preparation, checked archive, spawn-error handling, fresh-record classification and eviction wiring changes in the two scoped source modules.
3. Update existing tests to await the changed helpers and retain their current atomicity, timestamp, reuse, dry-run, checkpoint and launch-once assertions. No broad lint framework or daemon policy change is required.

## Test plan

- `we:scripts/lib/__tests__/daemon-jobs-runtime.test.mjs`: run a cold snapshot preparation with a controlled delayed child/materializer and prove an event-loop callback executes before preparation completes. Assert no launch occurs before readiness and launchedAt still follows preparation. Cover delayed dependency installation as well as archive work.
- `we:scripts/lib/__tests__/daemon-jobs-runtime.test.mjs`: drive several ticks over at least five distinct codeShas, completing older jobs and inspecting real snapshot directories. Check the corrected per-type retention bound, preservation of all active references (including more than two), eventual reclamation after completion, and no deletion with corrupt records. Do not call eviction directly in this test.
- `we:scripts/lib/__tests__/daemon-job-snapshots.test.mjs`: initialize a temporary Git repository and request a syntactically safe unknown SHA using the default materializer. Expect rejection, no published directory or completion marker, and no leftover build/archive temporary files. Retain real valid-commit extraction and injected extraction-failure cleanup cases.
- `we:scripts/lib/__tests__/daemon-jobs-runtime.test.mjs`: use distinct handles and a deferred first stop; refresh the second record's heartbeat while that stop is pending, release it, and assert the second handle was never stopped and its record remains live. Avoid timing sleeps for ordering.
- `we:scripts/lib/__tests__/daemon-jobs-runtime.test.mjs`: in a bounded subprocess, run the actual loop and default spawner with a nonexistent worktree directory. Assert the supervisor survives the error event, persists spawn failure, observes another tick and processes a subsequent valid job. Clean up every child and temporary directory; no global uncaught-exception handler may mask the defect.

## Proof plan

Implementation proof must show each new guard failing on its corresponding old behavior and passing with the repair. Capture assertions and exit statuses, including the subprocess continuation signal and on-disk retention counts; a green existing suite alone is insufficient. Exercise real archive and spawn boundaries with temporary local fixtures, without network installs or production daemon state.

Run focused tests only through the host heavy-run queue, targeting `we:scripts/lib/__tests__/daemon-jobs-runtime.test.mjs` and `we:scripts/lib/__tests__/daemon-job-snapshots.test.mjs`. Invoke the queue at `we:scripts/readiness/heavy-admission.mjs` with arguments `run -- npx vitest run` followed by those repository-relative test paths. Run `npm run check:standards` through the same queue. The runner owns preparation stamping and checks; these are implementation acceptance commands, not claims of completed validation.

## Follow-ups

- Repository-wide synchronous-child reachability, shell-pipeline and unused-cleanup-export linting remain optional broader prevention work; the five executable regressions discharge this card's concrete obligations.
- Keep synchronous process-start probing outside this snapshot-focused change; `we:scripts/lib/daemon-jobs-runtime.mjs:60` still uses a bounded synchronous ps call. Do not claim the entire tick call graph is asynchronous.
- No blockedBy change is proposed. Preserve the original approval idempotency key and leave implementation delivery to the subsequent build.

## Done when

All five regression scenarios fail under the corresponding original behavior and pass after repair; existing scoped suites and the queued standards gate pass. Snapshot preparation yields, failed archives publish nothing, refreshed jobs are not stopped from stale records, asynchronous spawn failure does not kill the daemon, and ticks reclaim unreferenced snapshots within the existing retention policy.
