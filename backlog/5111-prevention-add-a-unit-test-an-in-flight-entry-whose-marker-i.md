---
bornAs: xfmvasi
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/verify-dispatch.mjs", "we:skills-src/conveyor/verify-daemon.mjs", "we:scripts/conveyor/__tests__/verify-dispatch.test.mjs", "we:skills-src/conveyor/__tests__/verify-daemon.test.mjs"]
dateOpened: "2026-10-05"
preparedDate: "2026-11-25"
preparedAgainstSha: "5f7b1c25dcf36bf818e86c1361dbdc5f94701889"
tags: []
---

# Prevention — Add a unit test: an in-flight entry whose marker is green, or whose sha differs from HEAD, is kil… (from web-everything/web-everything#3972 review)

Filed mechanically on approval of #3972. Preserve the prevention goal: orphan cleanup must not depend on dispatch eligibility, code changes must not starve restart under continuing requests, and superseded process groups must be killed with the legacy kill flag absent.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3972@b85371716ad65f2bdc42164f035fa9a98dad812d

## Design

Use the existing registry-wide reconciliation in `we:skills-src/conveyor/verify-daemon.mjs:302`, called before dispatch at line 410. Do not add another orphan sweep to `we:scripts/conveyor/verify-dispatch.mjs`. Test the composed daemon tick with real dispatch eligibility: a dead leader with a green marker, or a running marker whose SHA differs from lane HEAD, is released once its process group is confirmed gone. Neither marker is rewritten and neither lane dispatches. A surviving group or an unreadable group probe continues to hold the lane; marker state alone is never permission to kill a live gate.

For restart, latch a positively observed clone HEAD change independently of registry occupancy. Share that latch between the production effects and restart predicate in `we:skills-src/conveyor/verify-daemon.mjs`. Once latched, continue reconciliation and job-store synchronization but suppress new launches, allowing existing in-process gates to settle under their existing ceilings. Exit with `code-changed` when no non-job entries remain. Durable job entries retain their existing handoff behavior and do not delay exit. This uses the original card's stop-launching alternative, without adding a restart deadline or changing kill/adopt policy. Unknown HEAD is not positive change evidence; it must not initiate restart. Once a change has been observed, a later failed HEAD read must not resume dispatch.

Keep the existing default `VERIFY_DISPATCH_KILL_SUPERSEDED !== '0'` in `we:scripts/conveyor/verify-dispatch.mjs:847`. Add deterministic coverage that deletes the environment key explicitly and restores it afterward, with the supersede policy pinned to `newer` and a genuinely changed gate/tree request. Keep explicit `0` and `1` coverage and the assertion that old settlement cannot overwrite a newer request.

## MVP

- Extend `we:skills-src/conveyor/__tests__/verify-daemon.test.mjs` with composed tick coverage for green and mismatched-SHA orphans, including a group that stays alive or whose probe throws. Use temporary local lane repositories and injected process probes; never signal a host process.
- Change only the restart coordination in `we:skills-src/conveyor/verify-daemon.mjs`, wiring the same change latch through the CLI caller, effects factory, and restart guard. Preserve explicit operator draining and job-mode behavior. Update the existing legacy deferral tests to exercise the shared latch and admission suppression.
- Extend `we:scripts/conveyor/__tests__/verify-dispatch.test.mjs` with an explicitly absent kill-flag case. The dispatch source remains in scope as the default/mutation target; no new supersede policy or source rewrite is expected there.

## Done when

[A1] **Executable** — Proposed test `5111 orphan cleanup precedes eligibility for green and stale-SHA lanes` in `we:skills-src/conveyor/__tests__/verify-daemon.test.mjs` exercises the real dispatch caller after reconciliation, asserts release, no launch, and unchanged marker bytes for both cases. Its held-group and throwing-probe variants assert that the entry remains held and no replacement launches. Run with the queued command in Test plan; adding these previously absent cases is required. Moving reconciliation behind the pending-marker filter must make this test fail.

[A2] **Executable** — Proposed test `5111 continuous requests cannot postpone restart after legacy gates settle` in `we:skills-src/conveyor/__tests__/verify-daemon.test.mjs` drives the composed effects and loop: tick 1 launches an existing legacy gate, HEAD changes before tick 2, that gate settles before tick 3, and fresh eligible requests remain available every tick. Assert no launches from tick 2 onward and exactly three ticks ending in `code-changed`. Repeat with mixed legacy/job entries; durable jobs may remain. This fails on current continuing dispatch and passes after shared-latch wiring.

[A3] **Executable** — Proposed test `5111 restart latch requires positive HEAD evidence and survives later read failure` in `we:skills-src/conveyor/__tests__/verify-daemon.test.mjs` asserts unchanged or null HEAD does not initiate restart, a real change suppresses admission even while legacy entries exist, and a later null read cannot clear that suppression. Exercise the same coordinator used by the CLI and preserve explicit drain behavior. The occupied-registry change/read-failure sequence fails before the latch exists and passes afterward.

[A4] **Executable** — Proposed test `5111 absent kill flag kills the superseded process group` in `we:scripts/conveyor/__tests__/verify-dispatch.test.mjs` explicitly removes the environment key, asserts SIGKILL to the negative group PID, no overlapping replacement, and preservation of the newer marker after old settlement. Parameterize explicit `0` (no kill) and `1` (kill). Run the queued command in Test plan. The new absent-key regression must fail with the guard mutated to `=== '1'` and pass with the shipped default; this is coverage debt, not a requested default change.

## Test plan

Run only the two affected suites through host admission. This executable shell command uses repo-prefixed path variables with the prefix removed only at execution:

```sh
admission=we:scripts/readiness/heavy-admission.mjs
dispatch=we:scripts/conveyor/__tests__/verify-dispatch.test.mjs
daemon=we:skills-src/conveyor/__tests__/verify-daemon.test.mjs
node "${admission#we:}" run --wait-ms=60000 -- npx vitest run "${dispatch#we:}" "${daemon#we:}"
```

New fixtures must isolate environment settings, restore spies, use task temporary storage, and inject time/settlement instead of sleeping. Include existing job handoff, PID reuse, held-group, operator drain, supersede policy and marker-preservation cases in these suites; do not weaken their assertions to accommodate the latch.

## Proof plan

Capture the new continuous-load and latch cases failing against the pre-build implementation, then passing after implementation. For coverage-only A1 and A4, demonstrate sensitivity with temporary mutations: move reconciliation behind dispatch eligibility, and change the kill guard to explicit opt-in, respectively. Each corresponding named test must fail, then pass after restoring production behavior. Keep mutation runs in the same host queue and never leave mutations in the diff. Record exact commands, test counts and failures in the build evidence; do not claim tests were run during this preparation.

Check that CLI wiring shares one latch, that reconciliation still runs while admission is suppressed, and that job-only restart remains immediate at the next between-tick check. The three-tick assertion assumes the existing legacy gate settles before tick 3; this does not promise a three-tick bound for hung processes or blocked I/O. Existing gate ceilings remain responsible for eventual settlement. The runner owns preparation stamping and standards checks.

## Follow-ups

No new deadline, settings, marker vocabulary, job-store lifecycle policy, or process identity rules are needed. Broader restart wall-clock bounds and job-store changes remain outside this card. No blockedBy changes proposed.

## Progress

- Original premise/scope: dispatch-local orphan cleanup at `we:scripts/conveyor/verify-dispatch.mjs:478`, daemon restart behavior at `we:skills-src/conveyor/verify-daemon.mjs:273`, and an explicit kill-default case around `we:scripts/conveyor/__tests__/verify-dispatch.test.mjs:834`; four source/test paths, size 3.
- Corrected premise: dispatch eligibility now filters at `we:scripts/conveyor/verify-dispatch.mjs:827`, but registry reconciliation already runs independently at `we:skills-src/conveyor/verify-daemon.mjs:410`. Existing green-marker preservation coverage is at `we:skills-src/conveyor/__tests__/verify-daemon.test.mjs:1093`; the missing prevention is a composed green/stale-SHA lane case, not another sweep or unconditional killing of healthy gates.
- Restart scope narrowed to legacy/adopted non-job entries: `we:skills-src/conveyor/verify-daemon.mjs:569` ignores job entries when deciding whether restart can proceed, while `we:skills-src/conveyor/verify-daemon.mjs:417` still dispatches unless operator-draining. Existing tests at `we:skills-src/conveyor/__tests__/verify-daemon.test.mjs:799` clear the registry artificially, so they do not prove admission stops under continuous load. Production wiring is at `we:skills-src/conveyor/verify-daemon.mjs:655` and line 685.
- The superseded settlement test moved to `we:scripts/conveyor/__tests__/verify-dispatch.test.mjs:943` and explicitly tests only `0` and `1` at lines 965–968. Default-policy cases at line 1061 exercise kills but do not explicitly remove an inherited kill flag. The current default guard is at `we:scripts/conveyor/verify-dispatch.mjs:847`; keep that behavior and make its regression deterministic.
- Scope remains the same four paths; size remains 3. Expected touch estimate: daemon coordination/comments approximately 40–70 changed lines, daemon tests approximately 100–150, dispatch tests approximately 25–45, dispatch source zero expected permanent lines (mutation target only). This story does not receive estimatedLoc. Preparation is based on source inspection, with no runtime or test-pass claim and no stamp authored.
