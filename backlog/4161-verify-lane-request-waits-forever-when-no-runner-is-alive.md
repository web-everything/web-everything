---
bornAs: x3337wu
kind: story
size: 3
parent: "3383"
status: resolved
scope: ["we:scripts/verify-lane.mjs", "we:scripts/lib/lane-verify.mjs", "we:scripts/__tests__/verify-lane.test.mjs", "we:scripts/__tests__/lane-verify.test.mjs"]
dateOpened: "2026-09-25"
dateResolved: "2026-10-03"
preparedDate: "2026-10-03"
preparedAgainstSha: "e1f0523e0881357fc863f3e88da72e0164eb7091"
tags: []
---

# verify-lane request waits forever when no runner is alive

Live 2026-09-25: an interactive session ran we:scripts/verify-lane.mjs request (the sanctioned call for agent sessions, #3105) while no conveyor runner was alive. Nothing ever serves a request except a we:scripts/conveyor/verify-dispatch.mjs tick, so the running marker sat untouched for 30+ minutes and blocked open-pr. Make request detect runner liveness (the runner-activity read) and refuse loudly with 'no runner alive' plus the next step, or have a resident daemon serve requests independently of the conveyor runner. Prove on a live case: request with no runner alive must fail fast, not strand.

## Progress

Premise checked against main at `e1f0523e0`.

- **Old premise:** "nothing serves a request except a conveyor runner tick". **Corrected:** the conveyor runner never served requests. `we:skills-src/conveyor/runner.mjs` has no reference to verify-dispatch (see the CORRECTION note at `we:scripts/conveyor/verify-dispatch.mjs:52`). The only server is the standalone verify daemon, `we:skills-src/conveyor/verify-daemon.mjs` (#3878, commit `96fccb68b`, landed 2026-09-22). It ticks `runVerifyDispatch` under its own keyed lease `VERIFY_DAEMON_LEASE_KEY = '<conveyor:verify-daemon-lease>'` (`we:skills-src/conveyor/verify-daemon.mjs:62`). On this host launchd runs it as `com.we.verify-daemon`.
- **So the "resident daemon" option is already delivered.** What is left is the other half: when that daemon is not alive, `request` still stamps `running` and returns 0 (`we:scripts/verify-lane.mjs:356` writeMarker, then `we:scripts/verify-lane.mjs:367` emit `requested`). Nothing then ever picks it up. The two options are not a fork. The refusal guards the daemon path; it does not replace it.
- **Old premise:** "the runner-activity read". **Corrected:** that read (`we:scripts/operations/runner-activity-io.mjs:54` `KNOWN_DAEMONS`) lists dispatcher, fix-dispatch and review only, not the verify daemon. The right liveness signal is the verify daemon's own lease, read with `runnerLeaseStatus` (`we:skills-src/conveyor/runner-lock.mjs:150`) plus the same-host pid probe `probeRunnerLeaseLiveness` (`we:skills-src/conveyor/runner-lock.mjs:102`).
- **Scope corrected:** `we:scripts/conveyor/verify-dispatch.mjs` needs no change. Added the pure helper's home (`we:scripts/lib/lane-verify.mjs`) and both test files.

### Implementation and observed proof — 2026-10-03

- Implemented the pure lease/PID verdict in `we:scripts/lib/lane-verify.mjs` and the request-only IO guard in `we:scripts/verify-lane.mjs`, after cache reuse and before the running marker write. Missing, expired, and confirmed-dead holders refuse with exit 3, `status: no-server`, recovery instructions, and no new marker. Updated the usage/exit-code banner.
- Regression-first: the new verdict cases failed against the unchanged implementation (missing export); all three unavailable-server CLI cases returned exit 0 instead of 3. The cache fixture initially lacked `origin/main`; added that real local branch, matching the existing cache tests so the content hash can resolve. No production cache behavior or test expectation was weakened.
- **Before, real CLI + 61-second soak:** in a temporary Git repository with one untracked edit and an empty lock root selected through `CONVEYOR_RUNNER_LOCK_ROOT`, `request --gate=true --json` returned exit 0, `{"status":"requested","reason":"requested"}`. After 61 seconds, `check --json` returned exit 2, `{"ok":false,"status":"running","reason":"verify-unfinished"}`. The marker was stranded.
- **After, real CLI:** the same absent-lease setup returned exit 3 in **160 ms**, `{"status":"no-server","reason":"verify-daemon-not-alive","ok":false}`. The detail named `no-lease`, `<conveyor:verify-daemon-lease>`, `last heartbeat: none`, said `no marker was written`, and included the launchctl and Node recovery steps. An explicit filesystem assertion confirmed marker absence.
- **Recovery, real daemon/dispatcher path:** acquired the keyed lease for the live proof process in the isolated root. Request returned exit 0 / `requested` in **148 ms**. Ran `runDaemonLoop` → `runVerifyTick` → the real `runVerifyDispatch` against a temporary one-lane pool, using the real bounded child spawn and `--gate=true` for this transport proof. Dispatch reported one lane, zero failures; `check --wait=540000 --json` returned exit 0, `{"ok":true,"status":"green","reason":"verified","settled":true}` in **178 ms**. Released the proof lease and removed temporary fixtures in `finally`; no helper files added.
- **Host-proof limitation:** the prescribed `launchctl bootout` returned `Boot-out failed: 1: Operation not permitted`. Therefore the launchd stop/bootstrap cycle was not performed; the isolated-root exercise above is the observed substitute, not a claim that the host lifecycle was tested. A subsequent launchctl read confirmed the original service remained `state = running`, PID 33692, so no restart was needed.
- **Scoped validation:** `npx vitest run verify-lane.test lane-verify.test` passed **171/171 tests**, including absent/stale/dead holders, live and unknown PID verdicts, unchanged cache reuse without a daemon, and live request marker creation. The refusal subprocesses have a two-second timeout.

- **Required wider gate:** `node we:scripts/verify-lane.mjs` ran 107 test files: **6,189 passed, 1 failed**. The failing existing case in `we:scripts/operations/__tests__/heavy-queue-io-real.test.mjs` requires the real process command line. `we:scripts/operations/heavy-queue-io.mjs` calls `ps` and returns null on execution failure; a direct `ps -p $$ -o command=` probe returned exit 126, `/bin/ps: Operation not permitted`. The sandbox blocks the required host capability. No test, gate, or out-of-scope source was changed. The verification marker is red; resolution is intentionally pending an unrestricted verification run and the host lifecycle proof.

- **Standards validation:** `npm run check:standards` passed with **0 errors** (5,292 warnings). `git diff --check` passed. Only the four declared source/test files and this card changed.

## Design

1. **Pure verdict** in `we:scripts/lib/lane-verify.mjs`: new export `verifyServerVerdict({ leaseStatus, pidLiveness })`.
   - `leaseStatus` is the `runnerLeaseStatus` shape `{ held, stale, owner, heartbeatAt }`. `pidLiveness` is `'alive' | 'dead' | 'unknown'`.
   - Returns `{ alive: true, owner }` when `leaseStatus.held && pidLiveness !== 'dead'`.
   - Otherwise returns `{ alive: false, reason }`. Reason is `'no-lease'` (no lease at all), `'stale-lease'` (heartbeat past TTL), or `'holder-dead'` (lease fresh but the same-host pid is gone).
2. **IO read** in `we:scripts/verify-lane.mjs`, request mode only.
   - Lock root: `process.env.CONVEYOR_RUNNER_LOCK_ROOT || RUNNER_LOCK_ROOT`. This is the same override `we:scripts/operations/runner-activity-io.mjs:143` already uses. No new env name.
   - Read `runnerLeaseStatus(lockRoot, { key: VERIFY_DAEMON_LEASE_KEY })`. Read the raw entry with `readLockEntry(lockRoot, VERIFY_DAEMON_LEASE_KEY)` (`we:scripts/readiness/file-locks.mjs:225`) and pass it to `probeRunnerLeaseLiveness`.
   - Import `VERIFY_DAEMON_LEASE_KEY` from `we:skills-src/conveyor/verify-daemon.mjs`. Its `main()` is gated on direct invocation, so the import has no side effects.
3. **Where the check sits:** after the cache-hit block (`we:scripts/verify-lane.mjs:343`) and **before** the `writeMarker(verifyStartBody(...))` at `we:scripts/verify-lane.mjs:356`. Only when `MODE === 'request'`.
   - A cache hit still returns `cached` with no daemon. It needs no server.
   - On `alive: false`: write **no** marker. Emit `{ sha, status: 'no-server', reason: 'verify-daemon-not-alive', ok: false, detail }` with exit **3**.
   - `detail` says plainly: no verify daemon is alive (the reason, the lease key, the last heartbeat if any), no marker was written, and the next step. Next step: start it with `launchctl kickstart -k gui/$(id -u)/com.we.verify-daemon`, or run the daemon file `we:skills-src/conveyor/verify-daemon.mjs` with node, then re-run `request`.
4. Update the usage banner (`we:scripts/verify-lane.mjs:49`) and the exit-code note (`we:scripts/verify-lane.mjs:58`): `request` now refuses with exit 3 when no verify daemon is alive. Also fix the banner's stale "mechanical runner pass" wording to name the verify daemon.
5. `verify`, `run`, `check` and `reset` modes are unchanged.

## MVP

Design items 1–3. The banner text (item 4) ships in the same change.

## Test plan

Both files run under vitest (they import from `vitest`).

`we:scripts/__tests__/lane-verify.test.mjs`, new `describe('verifyServerVerdict (#4161)')`:
- `held lease + alive pid → alive`
- `held lease + unknown pid → alive (TTL-only, never false-refuse)`
- `held lease + dead pid → not alive, reason holder-dead`
- `stale lease → not alive, reason stale-lease`
- `no lease → not alive, reason no-lease`

`we:scripts/__tests__/verify-lane.test.mjs`:
- Add a file-level helper that makes a temp lock root and seeds a live lease with `acquireRunnerLease(root, owner, { key: VERIFY_DAEMON_LEASE_KEY })`. The owner uses this host's name and the holder pid is the test process, so the probe says alive. Set `process.env.CONVEYOR_RUNNER_LOCK_ROOT` to it in `beforeEach`; restore it and remove the dir in `afterEach`. This keeps every existing `request` test green.
- New `describe('verify-lane request refuses fast when no verify daemon is alive (#4161)')`:
  - `request with no verify-daemon lease exits 3, status no-server, and writes no marker` — empty lock root. Assert exit 3, `json.status === 'no-server'`, `json.reason === 'verify-daemon-not-alive'`, no marker file, and detail contains `verify-daemon`.
  - `request with a stale verify-daemon lease is refused the same way` — seed a lease, then rewrite its heartbeat older than the TTL.
  - `request on an unchanged tree with a cached green still returns cached with no daemon alive`.
  - `request with a live verify-daemon lease still stamps running` (the existing happy path, now explicit).

## Proof plan

Live case on this host (launchd runs the verify daemon as `com.we.verify-daemon`):

1. **Before (main):** stop the daemon with `launchctl bootout gui/$(id -u)/com.we.verify-daemon`. In a scratch lane clone with one edit, run `request --json` on `we:scripts/verify-lane.mjs`. Expect exit 0 and `requested`. A minute later, `check` still shows `running` — stranded.
2. **After (this branch):** same steps. Expect exit 3 in under 2 seconds, `status: no-server`, the next-step text, and no marker file written.
3. Restart the daemon with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.we.verify-daemon.plist`. Re-run `request`. Expect `requested`, then `check --wait=540000` reaches a terminal result.
4. Record both outputs (before and after) in this card's `## Progress`. Always restart the daemon at the end.

## Done when

1. **Executable** — `npx vitest run verify-lane.test lane-verify.test` passes (vitest file filters that match exactly `we:scripts/__tests__/verify-lane.test.mjs` and `we:scripts/__tests__/lane-verify.test.mjs`). The new tests fail on main (no `verifyServerVerdict` export; `request` returns `requested` with no daemon) and pass after.
2. `request` with no live verify-daemon lease exits 3 with `status: no-server`, writes no marker, and names the next step.
3. `request` with a live lease behaves exactly as before. A cache hit still returns `cached` with no daemon.
4. The live before/after proof from `## Proof plan` is recorded in `## Progress`.

## Follow-ups

- Re-run `node we:scripts/verify-lane.mjs` with process inspection permitted, then resolve through `node we:scripts/operations/run.mjs resolve --ref=4161` once the remaining proof is complete.
- Repeat the prescribed launchd stop/bootstrap proof from an unrestricted host session; this checkout session could not stop the service. The isolated-root proof above covers request refusal and real dispatch recovery, but not launchd lifecycle control.

- Add the verify daemon to `KNOWN_DAEMONS` in `we:scripts/operations/runner-activity-io.mjs:54`, so `/runner-status` shows its liveness too.
- Commit a verify-daemon launchd plist example under `we:skills-src/conveyor/launchd/`. The live plist exists on this host, but the repo has no example, so a fresh host gets no resident server.
- Optional: have `check --wait` also report `no-server` when it sees a `running` marker and no live verify daemon, for markers stamped before this fix.
