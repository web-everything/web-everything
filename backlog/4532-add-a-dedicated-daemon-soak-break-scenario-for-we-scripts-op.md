---
bornAs: xkp9z65
kind: task
parent: "4075"
status: open
scope: ["we:scripts/conveyor/soak/breaks/review-loop-prevention-card-lands-in-daemon-clone.mjs", "we:scripts/conveyor/soak/breaks/fixtures/review-loop-prevention-probe.mjs", "we:scripts/conveyor/soak/breaks/fixtures/review-loop-prevention-noop-job.mjs", "we:scripts/conveyor/soak/breaks/review-loop-prevention-card-lands-in-daemon-clone.soak.test.mjs", "we:scripts/conveyor/soak/breaks/__tests__/review-loop-prevention-card-lands-in-daemon-clone.test.mjs", "we:scripts/conveyor/soak/breaks/fixtures/__tests__/review-loop-prevention-probe.test.mjs", "we:scripts/conveyor/soak/breaks/fixtures/__tests__/review-loop-prevention-noop-job.test.mjs"]
estimatedLoc: 420
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "32fbad6f48ce3ccdfd1df70dd42ba1a5da64cf96"
tags: []
---

# Add a dedicated daemon-soak break scenario for we:scripts/operations/review-loop-cli.mjs's mechanized prevention filing

Add a caller-level soak regression for #4493: drive the real review loop without overriding its filer, reproduce an untracked prevention card in the pre-fix checkout, and prove the fixed caller dispatches a detached job without dirtying that checkout. The approval-time scenario covers a different caller; the existing unit test does not supply the missing historical soak replay.

## Progress

- Original premise/scope: mirror the approval-time break, use a prevention-outstanding judge with no `fileItem` override, and edit the broad break directory plus we:scripts/operations/review-loop-cli.mjs. No matching test was scoped and no line estimate was supplied.
- Confirmed at inspected HEAD `32fbad6f48ce3ccdfd1df70dd42ba1a5da64cf96`: the dedicated break and fixture do not exist. The actual #4493 implementation commit is `d97b92b0fe` (not the unrelated PR numbered 4493); its diff changes the default filer and introduces the landing-job adapter. This task is not already delivered.
- Corrected scope: four new soak files only, including their matching test. Production already has the intended default at we:scripts/operations/review-loop-cli.mjs:584 and the shared adapter at we:scripts/operations/review-loop-cli.mjs:197. No production edit or registry edit is needed: we:scripts/conveyor/soak/breaks/index.mjs:24 documents automatic discovery.
- Corrected premise: newer acceptance policy must be explicitly disabled in this historical regression fixture, as the existing legacy-filing wrapper does at we:scripts/operations/__tests__/review-loop-cli.test.mjs:59. This is fixture configuration, not a production policy change. The existing no-override test at we:scripts/operations/__tests__/review-loop-cli.test.mjs:1130 mocks the bottom spawn boundary; the new soak must exercise a real detached subprocess.
- Unlike the approval probe's `runScript` override, the review-loop adapter supplies no job-path override (we:scripts/operations/review-loop-cli.mjs:198). Install an inert landing script in the disposable simulated checkout before taking the clean baseline. Preserve the real default filer and shared spawn mechanism. The existing approval scenario at we:scripts/conveyor/soak/breaks/prevention-card-lands-in-daemon-clone.mjs:143 checks only checkout dirt; this new scenario must also reject missing execution evidence.
- Estimate added: 360 changed lines = break approximately 130 + probe approximately 110 + inert receipt job approximately 20 + soak/negative tests approximately 100. The precedent is the approximately 160-line approval break, its small probe, and we:scripts/conveyor/soak/define-break-test.mjs:17. No size existed or was changed. No dependency change is proposed.

- Preparation repair: the previous four-file scope assigned all tests to the soak file, which did not satisfy the required per-source matching test paths. The corrected seven-file scope retains that integration test and adds the three explicit unit-test paths below. Production scope remains unchanged: the adapter and default still exist at we:scripts/operations/review-loop-cli.mjs:197 and we:scripts/operations/review-loop-cli.mjs:584; the approval precedent separates probe execution from classification at we:scripts/conveyor/soak/breaks/prevention-card-lands-in-daemon-clone.mjs:62 and we:scripts/conveyor/soak/breaks/prevention-card-lands-in-daemon-clone.mjs:139. Revised `estimatedLoc`: 360 → 420 = break 130 + probe 110 + receipt job 20 + soak integration tests 60 + break unit tests 50 + probe unit tests 30 + receipt-job unit tests 20. The extra test files cover classification, probe output and receipt behavior independently; no size or dependency change.

## Design

Create we:scripts/conveyor/soak/breaks/review-loop-prevention-card-lands-in-daemon-clone.mjs with the existing break contract: ID `review-loop-prevention-card-lands-in-daemon-clone`, `fixedBy.sha` set to `d97b92b0fe`, and reversal paths limited to we:scripts/operations/review-loop-cli.mjs. Use one `runSoak` round, no fleet/daemons and no main churn, following we:scripts/conveyor/soak/breaks/prevention-card-lands-in-daemon-clone.mjs. `fixPresent` must inspect the actual `runReviewLoopOnce` parameter binding, not merely find the new export name in comments or another function; unreadable/missing source returns false. Classification must not change the probe or suppress violations.

Seed and commit an empty we:backlog/ directory in the simulated checkout, then install and commit the inert fixture at that checkout's we:scripts/operations/land-prevention-card.mjs before recording status. This replaces only the downstream job body, never the filer, default parameter, shared spawn leaf or in-process file-item operation. The fixed path still runs the genuine detached spawn from we:scripts/operations/detached-dispatch.mjs:137. The inert job writes a receipt containing argv and cwd outside the checkout, under the simulator's temporary state root, then exits without acquiring a lane or contacting GitHub. Pass only sandbox state/home settings; we:scripts/conveyor/__tests__/sim/world.mjs:295 supplies isolation including `WE_DAEMON_STATE_DIR` at line 332.

Create we:scripts/conveyor/soak/breaks/fixtures/review-loop-prevention-probe.mjs. Import the operation, registry, memory store and judge helpers from the simulated tree; drive its real `runReviewLoopOnce` in a separate process whose cwd is that checkout. Adapt the stub reader, recording sinks and prevention answer at we:scripts/operations/__tests__/review-loop-cli.test.mjs:86, :111 and :133. Use a pinned 40-hex head, `--json`, an explicit legacy `acceptPolicy` value with `unattendedAcceptRequiresCleanReferrals: false`, lookup misses, advisory recording disabled and recording effect sinks. Do not pass `fileItem` or invoke the new adapter by name. The same probe inputs must work on both sides; older functions ignore newer optional fields.

Read the returned outcome and porcelain status including untracked files. A valid RED requires successful prevention filing plus an actual newly untracked markdown card under we:backlog/, not a crash. A valid GREEN requires successful queued filing with a positive PID handle, a matching inert-job receipt and byte-identical clean status. Validate the receipt's session prefix and cwd. An exception, nonzero exit, malformed/empty JSON, missing filing evidence, missing receipt, or missing seeded backlog must produce a diagnostic violation consumed by `judge`, even when the checkout is clean. Bound the probe to 30 seconds and 1 MiB output; bound receipt completion to 5 seconds. On either bound, fail the scenario and retain the diagnostic in its report for operator inspection; never count infrastructure failure as historical reproduction.

## MVP

1. Add the break, standalone probe and inert receipt job in the scoped locations; discovery supplies registration.
2. Add we:scripts/conveyor/soak/breaks/review-loop-prevention-card-lands-in-daemon-clone.soak.test.mjs using `defineBreakTest`; add targeted evidence-validation tests in the three matching unit-test files listed in Test plan. Keep reusable validation helpers in the break module and fixture helpers in the probe, guarded against import-time execution.
3. Prove the actual default binding using identical probe code on current and historical filing behavior, with real filesystem and subprocess effects and no external landing activity.

## Acceptance

- [A1] Executable — the new soak test `real default queues a detached receipt without checkout dirt` passes after this build and is absent/fails selection before it. It drives `runReviewLoopOnce` without a filer override and verifies the queued result, real job receipt and unchanged porcelain status.
- [A2] Executable — the new test `legacy default writes an untracked prevention card` runs the same probe in a disposable copy with only the default binding reverted to `fileItemForPrevention`; assert a new untracked card and a clean-invariant violation. The new `fixPresent checks the default binding` test covers current, legacy, comment-only and unreadable source. These regression assertions are missing before the build and required to pass after it.
- [A3] Executable — the new parameterized test `incomplete probe evidence never judges green` covers process failure, invalid/empty output, clean-but-no-filing, missing backlog, missing receipt, timeout and output overflow. Assert a nonempty diagnostic from `judge`, including the failed bound and inspection guidance. The assertions are absent before this build and pass afterward.
- [A4] Executable — the queued red/green command in Proof plan must discover this break and report GREEN for current code and RED for successful historical filing that leaves an untracked card. Before this build it fails because the break is unknown. An import failure or failed patch is NOT acceptable RED proof.

## Test plan

A1 and the A2 historical-default integration test live in we:scripts/conveyor/soak/breaks/review-loop-prevention-card-lands-in-daemon-clone.soak.test.mjs. Split the focused coverage across these matching source tests:

- we:scripts/conveyor/soak/breaks/__tests__/review-loop-prevention-card-lands-in-daemon-clone.test.mjs: A2 default-binding classification and A3 incomplete-evidence diagnostics, including timeout and output overflow.
- we:scripts/conveyor/soak/breaks/fixtures/__tests__/review-loop-prevention-probe.test.mjs: A1/A2 probe inputs preserve the real default (no `fileItem` override), and A3 failed execution or malformed/empty output cannot supply successful filing evidence.
- we:scripts/conveyor/soak/breaks/fixtures/__tests__/review-loop-prevention-noop-job.test.mjs: A1 receipt contains the supplied argv and cwd outside the checkout; A3 missing receipt is rejected by the break's evidence validator.

 Use temporary roots under `$TMPDIR`, restore disposable file mutations, and clean up in `finally`. Include a fixture receipt assertion that shows the inert job, not the real lane-acquiring job, executed. Do not weaken the existing review-loop test or modify its production policy to reach this branch.

Run the scoped tests through the host queue. The variables below retain repository-prefixed references and remove the locus only when passing local paths to Node:

```sh
admission=we:scripts/readiness/heavy-admission.mjs
soak_test=we:scripts/conveyor/soak/breaks/review-loop-prevention-card-lands-in-daemon-clone.soak.test.mjs
break_test=we:scripts/conveyor/soak/breaks/__tests__/review-loop-prevention-card-lands-in-daemon-clone.test.mjs
probe_test=we:scripts/conveyor/soak/breaks/fixtures/__tests__/review-loop-prevention-probe.test.mjs
job_test=we:scripts/conveyor/soak/breaks/fixtures/__tests__/review-loop-prevention-noop-job.test.mjs
node "${admission#we:}" run --wait-ms=60000 -- npx vitest run "${soak_test#we:}" "${break_test#we:}" "${probe_test#we:}" "${job_test#we:}"
```

If admission remains busy after that single bounded wait, stop and report it. No full suite is needed for this isolated scenario.

## Proof plan

Run the historical replay through the same queue:

```sh
admission=we:scripts/readiness/heavy-admission.mjs
replay=we:scripts/conveyor/soak/red-green.mjs
node "${admission#we:}" run --wait-ms=60000 -- node "${replay#we:}" --break=review-loop-prevention-card-lands-in-daemon-clone
```

The harness reverse-applies the fix to a disposable copy (we:scripts/conveyor/soak/red-green.mjs:82). Record the actual GREEN queued receipt, unchanged status, RED filed-card path and `fixPresent: false`; the exit-code summary alone is insufficient. Later edits may prevent the old patch applying. If so, use its existing `--at-parent` option with the same scoped path and SHA, documenting that this restores the whole historical caller rather than only the default hunk. If historical imports cannot run against today's dependencies, report the replay as unproven; A2's default-only mutation is useful narrower evidence but cannot substitute for A4. Do not expand this card into a harness refactor or accept an unrelated crash as RED.

The runner owns preparation stamping and checks. Build-time standards validation also runs through we:scripts/readiness/heavy-admission.mjs with `npm run check:standards`; no implementation test result is claimed by this preparation.

## Follow-ups

- Actual lane acquisition, filing, verification and PR landing remain covered by we:scripts/operations/__tests__/land-prevention-card.test.mjs; this break proves dispatch and checkout cleanliness, not eventual landing.
- Recovery of previously orphaned cards and changes to acceptance policy remain outside this regression's scope. No new policy choice or dependency is required here.
