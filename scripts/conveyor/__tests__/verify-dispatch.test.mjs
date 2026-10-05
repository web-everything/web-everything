/**
 * @file scripts/conveyor/__tests__/verify-dispatch.test.mjs
 * @description Regression for #3105 — a delivery agent's gate legitimately outruns the agent tool's ~120s
 *   foreground window, so it gets auto-backgrounded and the agent stalls, silently. This pass is the fix: the
 *   runner (not the agent) runs the gate, picking up a `request`-stamped `.lane-verify` marker
 *   (`scripts/verify-lane.mjs request`) on its own tick — a plain long-lived process with no per-turn ceiling.
 *   {@link laneNeedsVerifyDispatch} is the pure decision (unit-tested against fixtures below); the CLI section
 *   spawns the real `verify-lane.mjs`/`verify-dispatch.mjs` against a throwaway git fixture, no network, and
 *   asserts the full request → dispatch → green round trip a delivery agent would actually rely on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync, spawn as spawnProcess, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { laneNeedsVerifyDispatch, inFlightSuperseded, resolveMaxInFlight, laneIndicesIn, spawnGateBounded, runVerifyDispatch, recordKilledVerification, GATE_STARTED_MARKER } from '../verify-dispatch.mjs';
import { heldSlots, admissionLockRoot } from '../../readiness/heavy-admission.mjs';
import { acquireRunnerLease, makeOwner } from '../../../skills-src/conveyor/runner-lock.mjs';
import { VERIFY_DAEMON_LEASE_KEY } from '../../../skills-src/conveyor/verify-daemon.mjs';

describe('laneNeedsVerifyDispatch — the pure dispatch decision', () => {
  it('dispatches a running marker for the lane\'s own current HEAD', () => {
    expect(laneNeedsVerifyDispatch({ status: 'running', sha: 'abc123' }, 'abc123')).toBe(true);
  });

  it('does NOT dispatch a running marker for a sha that is no longer HEAD (stale request)', () => {
    expect(laneNeedsVerifyDispatch({ status: 'running', sha: 'old111' }, 'new222')).toBe(false);
  });

  it('does NOT dispatch a terminal green/red marker — nothing was asked for the new HEAD', () => {
    expect(laneNeedsVerifyDispatch({ status: 'green', sha: 'abc123' }, 'abc123')).toBe(false);
    expect(laneNeedsVerifyDispatch({ status: 'red', sha: 'abc123' }, 'abc123')).toBe(false);
  });

  it('does NOT dispatch a corrupt marker or an absent one', () => {
    expect(laneNeedsVerifyDispatch({ corrupt: true }, 'abc123')).toBe(false);
    expect(laneNeedsVerifyDispatch(null, 'abc123')).toBe(false);
  });

  it('does NOT dispatch when HEAD is unresolvable', () => {
    expect(laneNeedsVerifyDispatch({ status: 'running', sha: 'abc123' }, null)).toBe(false);
  });
});

const SCRIPT = resolve(process.cwd(), 'scripts/conveyor/verify-dispatch.mjs');
const VERIFY_LANE = resolve(process.cwd(), 'scripts/verify-lane.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function runDispatch(args, extraEnv = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...extraEnv } });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

function runVerifyLane(args, cwd) {
  const r = spawnSync('node', [VERIFY_LANE, ...args], { encoding: 'utf8', cwd, env: { ...process.env, CONVEYOR_RUNNER_LOCK_ROOT: verifyLockRoot } });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

/** Init + first commit for one lane dir — factored out so multi-lane tests (#4360) can stamp several lanes
 *  without repeating the same five git calls. */
function makeLane(dir) {
  mkdirSync(dir, { recursive: true });
  git(['init', '--quiet', '--initial-branch=main', dir]);
  writeFileSync(join(dir, 'f.txt'), 'a\n');
  git(['add', 'f.txt'], dir);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'v1'], dir);
  return dir;
}

let base, poolRoot, poolDir, laneDir, verifyLockRoot;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'verify-dispatch-'));
  // #4161 — `verify-lane request` refuses (exit 3) unless a verify daemon holds a live lease; seed one.
  verifyLockRoot = join(base, 'runner-locks');
  acquireRunnerLease(verifyLockRoot, makeOwner('verify-dispatch-test'), { key: VERIFY_DAEMON_LEASE_KEY });
  poolRoot = join(base, 'pool');
  poolDir = join(poolRoot, 'flagtest');
  laneDir = makeLane(join(poolDir, 'lane-1'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('verify-dispatch — a plain FILE in the pool root never fails the tick (2026-10-04 ENOTDIR outage)', () => {
  it('skips a non-directory entry beside the pools and still dispatches the real lane', () => {
    // macOS drops `.metadata_never_index` (a 0-byte FILE) into `~/workspace/.lanes`; readdirSync on it threw
    // ENOTDIR and the whole tick failed, every tick, so no requested gate ever ran.
    writeFileSync(join(poolRoot, '.metadata_never_index'), '');
    expect(laneIndicesIn(join(poolRoot, '.metadata_never_index'))).toEqual([]);
    runVerifyLane(['request', `--repo=${laneDir}`, '--gate=true', '--json'], laneDir);
    const r = runDispatch(['--json'], { LANE_POOL_ROOT: poolRoot });
    expect(r.err).not.toMatch(/ENOTDIR/);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).dispatched).toHaveLength(1);
  });
});

describe('verify-dispatch CLI — the request → dispatch → green round trip (#3105)', () => {
  it('a fresh lane with no request has nothing to dispatch', () => {
    const r = runDispatch(['--json'], { LANE_POOL_ROOT: poolRoot });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).dispatched).toEqual([]);
  });

  it('picks up a `request`-stamped marker and runs the gate to a GREEN terminal record', () => {
    const req = runVerifyLane(['request', `--repo=${laneDir}`, '--gate=true', '--json'], laneDir);
    expect(req.code).toBe(0);
    expect(JSON.parse(req.out).status).toBe('requested');

    // Before dispatch: check reads it as an ordinary in-flight running marker — no new vocabulary.
    const before = runVerifyLane(['check', `--repo=${laneDir}`, '--json'], laneDir);
    expect(JSON.parse(before.out).status).toBe('running');

    const r = runDispatch(['--json'], { LANE_POOL_ROOT: poolRoot });
    expect(r.code).toBe(0);
    const body = JSON.parse(r.out);
    expect(body.dispatched).toHaveLength(1);
    expect(body.dispatched[0]).toMatchObject({ pool: 'flagtest', lane: 1 });

    const after = runVerifyLane(['check', `--repo=${laneDir}`, '--json'], laneDir);
    const afterBody = JSON.parse(after.out);
    expect(afterBody.status).toBe('green');
    expect(afterBody.ok).toBe(true);
  });

  it('a request for a sha that is no longer HEAD is left alone (nobody asked to verify the new one)', () => {
    runVerifyLane(['request', `--repo=${laneDir}`, '--gate=true', '--json'], laneDir);
    // Advance HEAD past the requested sha without a new request.
    writeFileSync(join(laneDir, 'f.txt'), 'b\n');
    git(['add', 'f.txt'], laneDir);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'v2'], laneDir);

    const r = runDispatch(['--json'], { LANE_POOL_ROOT: poolRoot });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).dispatched).toEqual([]);
  });

  it('records a RED dispatch as success (the marker recorded the fact — not a pass failure)', () => {
    runVerifyLane(['request', `--repo=${laneDir}`, '--gate=false', '--json'], laneDir);
    const r = runDispatch(['--json'], { LANE_POOL_ROOT: poolRoot });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).dispatched[0]).toMatchObject({ red: true });

    const after = runVerifyLane(['check', `--repo=${laneDir}`, '--json'], laneDir);
    expect(JSON.parse(after.out).status).toBe('red');
  });
});

describe('verify-dispatch CLI — the hard wall-clock ceiling (epic #3383, live incident 2026-09-14)', () => {
  // A real hang, simulated: the gate sleeps far longer than the test-scoped ceiling, then touches a marker
  // file — the marker file existing later is proof the CHAIN kept running (an orphan), not just that the one
  // pid `execFileSync`'s own `timeout` option signals directly.
  it('kills a gate that outruns VERIFY_DISPATCH_TIMEOUT_MS — including the tree beneath it, not just the pid dispatch spawned', async () => {
    // #4075 follow-up (ci-heal-2721, 2026-09-26): this test's own fixture sleep (was 3s) and its "returns
    // promptly" bound (was 2500ms against a 300ms ceiling — under 10x headroom) both flaked TWICE under real
    // load (~3 runnable procs/core): killing the whole shell→sleep→touch tree and propagating the exit back
    // through `verify-dispatch.mjs`/`spawnSync` costs real OS scheduling time that grows with contention, not
    // with the ceiling being tested. The fixture sleep is widened to GATE_SLEEP_MS so a much larger, load-
    // tolerant return bound still lands comfortably before the sleep would finish on its own — preserving the
    // one thing this test actually proves (the process was PREEMPTED, not merely fast) — and the later proof
    // check polls instead of firing one fixed-delay `setTimeout`, so a delayed poll only means "checked later
    // and still absent", never a false failure.
    const GATE_SLEEP_MS = 15_000;
    const RETURN_CEILING_MS = 9_000; // generous vs. the 300ms ceiling under test; still « GATE_SLEEP_MS
    const proofFile = join(base, 'still-running.proof');
    const req = runVerifyLane(['request', `--repo=${laneDir}`, `--gate=sleep ${GATE_SLEEP_MS / 1000} && touch ${proofFile}`, '--json'], laneDir);
    expect(req.code).toBe(0);

    const started = Date.now();
    const r = runDispatch(['--json'], { LANE_POOL_ROOT: poolRoot, VERIFY_DISPATCH_TIMEOUT_MS: '300' });
    const elapsedMs = Date.now() - started;

    // The dispatch call itself returns promptly (near the 300ms ceiling), never waiting out the whole
    // sleep — this is the actual driver-unblocking behavior: the tick moves on instead of hanging. The bound
    // is generous (load-tolerant) but still well under GATE_SLEEP_MS, so a pass still proves preemption.
    expect(elapsedMs).toBeLessThan(RETURN_CEILING_MS);

    const body = JSON.parse(r.out);
    expect(body.dispatched).toEqual([]);
    expect(body.failures).toHaveLength(1);
    expect(body.failures[0]).toMatchObject({ pool: 'flagtest', lane: 1, timedOut: true });

    // The dispatcher records the kill, and the next sweep must not re-run it silently.
    const after = runVerifyLane(['check', `--repo=${laneDir}`, '--json'], laneDir);
    expect(JSON.parse(after.out)).toMatchObject({ status: 'infrastructure-failure', reason: 'verify-timeout' });
    const retry = JSON.parse(runDispatch(['--json'], { LANE_POOL_ROOT: poolRoot }).out);
    expect(retry.dispatched).toEqual([]);
    expect(retry.failures).toEqual([]);

    // Proof the WHOLE tree died, not just the immediate `verify-lane.mjs` pid: poll until well past the
    // original sleep the gate was running, confirming the `touch` after it never runs at any check point. A
    // naive single-pid SIGTERM would leave the shell → sleep → touch chain orphaned and it WOULD still create
    // this file once the sleep naturally elapses; polling (rather than one delayed check) means a slow test
    // process only delays when we look, never causes us to look too early.
    const deadline = started + GATE_SLEEP_MS + 5_000; // generous margin past the natural sleep completion
    while (Date.now() < deadline) {
      expect(existsSync(proofFile)).toBe(false);
      // eslint-disable-next-line no-await-in-loop -- deliberate poll, not a fixed single sleep
      await new Promise((res) => setTimeout(res, 250));
    }
    expect(existsSync(proofFile)).toBe(false);
  }, 30_000);

  it('a run that finishes within the ceiling is never touched by it', () => {
    const req = runVerifyLane(['request', `--repo=${laneDir}`, '--gate=true', '--json'], laneDir);
    expect(req.code).toBe(0);

    // A generous ceiling relative to the fast `true` gate — this is the "must not kill a legitimately slow
    // but healthy run" guarantee, exercised at the opposite extreme (a near-instant one).
    const r = runDispatch(['--json'], { LANE_POOL_ROOT: poolRoot, VERIFY_DISPATCH_TIMEOUT_MS: '5000' });
    const body = JSON.parse(r.out);
    expect(body.failures).toEqual([]);
    expect(body.dispatched[0]).toMatchObject({ pool: 'flagtest', lane: 1 });

    const after = runVerifyLane(['check', `--repo=${laneDir}`, '--json'], laneDir);
    expect(JSON.parse(after.out).status).toBe('green');
  });

  // Independent-review finding (2026-09-14, epic #3383, PR #2236): an EXTERNAL actor killing the spawned
  // verify-lane.mjs process (an operator's `kill -9`, an OS OOM-kill, a host restart) produces the exact same
  // exit shape (`status: null`, a signal present) as OUR OWN ceiling firing — a prior version of the outer
  // classifier re-derived "timed out" from that shape alone and would misattribute the external kill as
  // "exceeded the ceiling". The gate here sends itself SIGTERM via `$PPID` (verify-lane.mjs's own pid, its
  // direct parent) — simulating exactly that external-kill scenario — with both ceilings set far longer than
  // this test could ever run, so NEITHER of our own timers can legitimately fire.
  it('an EXTERNAL kill of the verify-lane child is reported as a plain failure, never mislabeled as a ceiling timeout', () => {
    const req = runVerifyLane(['request', `--repo=${laneDir}`, '--gate=kill -TERM $PPID', '--json'], laneDir);
    expect(req.code).toBe(0);

    const r = runDispatch(['--json'], {
      LANE_POOL_ROOT: poolRoot,
      VERIFY_DISPATCH_TIMEOUT_MS: '60000',
      VERIFY_DISPATCH_QUEUE_CEILING_MS: '60000',
    });
    const body = JSON.parse(r.out);
    expect(body.dispatched).toEqual([]);
    expect(body.failures).toHaveLength(1);
    // A real failure IS reported (the lane still needs a retry) — but NOT as a ceiling timeout, since neither
    // of our own timers fired.
    expect(body.failures[0]).toMatchObject({ pool: 'flagtest', lane: 1 });
    expect(body.failures[0].timedOut).toBeFalsy();
    expect(body.failures[0].timedOutPhase).toBeUndefined();
    const after = runVerifyLane(['check', `--repo=${laneDir}`, '--json'], laneDir);
    expect(JSON.parse(after.out)).toMatchObject({ status: 'infrastructure-failure', reason: 'verify-signal' });
  });
});

// ── Skeptic-review fix (2026-09-14, epic #3383): GATE time only, not queue-plus-gate ───────────────────────
// The first cut of the ceiling above measured wall-clock from SPAWN, which silently includes whatever time
// `verify-lane.mjs` spends waiting on `heavy-admission.mjs`'s own capacity semaphore (up to its own 20-minute
// fail-open) BEFORE the real gate even starts. A healthy run that legitimately queues and then runs a normal
// (or contention-slowed) gate could total more than the 30-minute ceiling and get killed anyway — exactly the
// "hung vs merely-queued" distinction the ceiling exists to draw, defeated by its own design. These tests
// reproduce that incoherence directly against {@link spawnGateBounded} (deterministic, no real timing flake)
// and then prove it against the REAL `verify-lane.mjs` + `heavy-admission.mjs` integration (genuine slot
// contention, not a fixture) — confirming the marker line `verify-lane.mjs` now emits is the one
// `verify-dispatch.mjs` actually watches for.

function writeFixtureGate(dir, { queueDelayMs, gateDurationMs, exitCode = 0 }) {
  const p = join(dir, `fixture-gate-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    p,
    [
      `setTimeout(() => {`,
      `  process.stderr.write(${JSON.stringify(GATE_STARTED_MARKER)} + '\\n');`,
      `  setTimeout(() => process.exit(${exitCode}), ${gateDurationMs});`,
      `}, ${queueDelayMs});`,
    ].join('\n'),
    'utf8',
  );
  return p;
}

describe('spawnGateBounded — gate-only timing (Skeptic-review fix, epic #3383)', () => {
  it('does NOT kill a run whose QUEUE phase is long but whose GATE phase is short (the exact incoherence)', async () => {
    // Total wall-clock (queue 800ms + gate 100ms = 900ms) exceeds gateCeilingMs (500ms) — the OLD single
    // spawn-to-exit ceiling would have killed this. The gate ceiling here applies ONLY after the marker, and
    // the real gate-only time (100ms) is comfortably inside it, so this must resolve, not reject.
    const script = writeFixtureGate(base, { queueDelayMs: 800, gateDurationMs: 100 });
    await expect(spawnGateBounded([script], { queueCeilingMs: 5000, gateCeilingMs: 500 })).resolves.toBeTruthy();
  });

  it('still kills a run whose GATE phase itself hangs past gateCeilingMs (the original protection, preserved)', async () => {
    const script = writeFixtureGate(base, { queueDelayMs: 50, gateDurationMs: 5000 });
    await expect(spawnGateBounded([script], { queueCeilingMs: 5000, gateCeilingMs: 300 })).rejects.toMatchObject({ timedOutPhase: 'gate' });
  });

  it('kills a run that never reaches the gate at all — a hang BEFORE the marker ever appears', async () => {
    const script = writeFixtureGate(base, { queueDelayMs: 5000, gateDurationMs: 100 });
    await expect(spawnGateBounded([script], { queueCeilingMs: 300, gateCeilingMs: 5000 })).rejects.toMatchObject({ timedOutPhase: 'queue' });
  });
});

// #4360 — `onGateStarted`'s two documented guarantees (see the JSDoc at `spawnGateBounded`'s definition),
// exercised against the REAL function and a real fixture child (never a fake `spawnGate`) — the concurrent-
// dispatch tests below use a fake `spawnGate` entirely, so they never touch this hook's own implementation.
describe('spawnGateBounded — onGateStarted hook (#4360)', () => {
  it('fires onGateStarted exactly once, the instant GATE_STARTED_MARKER is seen on stderr', async () => {
    const script = writeFixtureGate(base, { queueDelayMs: 50, gateDurationMs: 100 });
    let calls = 0;
    await expect(
      spawnGateBounded([script], { queueCeilingMs: 5000, gateCeilingMs: 5000, onGateStarted: () => { calls += 1; } }),
    ).resolves.toBeTruthy();
    expect(calls).toBe(1);
  });

  it('swallows a throwing onGateStarted — the gate run still resolves normally, never rejects because of it', async () => {
    const script = writeFixtureGate(base, { queueDelayMs: 50, gateDurationMs: 100 });
    // A logging hook's own bug (or a full disk, a broken stream, etc.) must never be able to turn a healthy
    // gate run into a reported dispatch failure — the hook is an observer, never a participant.
    await expect(
      spawnGateBounded([script], {
        queueCeilingMs: 5000,
        gateCeilingMs: 5000,
        onGateStarted: () => { throw new Error('logging hook exploded'); },
      }),
    ).resolves.toBeTruthy();
  });
});

describe('verify-dispatch CLI — real admission-queue contention does not trip the gate ceiling (integration)', () => {
  // A REAL holder occupies the (capped-to-1) heavy-admission slot for `HOLD_MS` using the actual production
  // `heavy-admission.mjs run` CLI — not a bespoke fixture — so `verify-lane.mjs`'s own `acquireSlotBlocking`
  // call genuinely queues behind it, exactly as it would in production contention.
  const HOLD_MS = 2000;

  it('a lane queued behind real admission contention, then a fast gate, is NOT killed by the gate-only ceiling', async () => {
    const cli = resolve(process.cwd(), 'scripts/readiness/heavy-admission.mjs');
    const admissionEnv = { ...process.env, LANE_POOL_ROOT: poolRoot, WE_HEAVY_ADMISSION_CAP: '1' };
    // xaipsbs — the `run` wrapper is a pass-through under CI, the off switch, or an outer wrapper's held flag
    // (this suite itself runs inside `npm run test:unit`, which sets it). The holder must really hold a slot.
    delete admissionEnv.CI; delete admissionEnv.WE_HEAVY_ADMISSION; delete admissionEnv.WE_HEAVY_ADMISSION_HELD;
    const holder = spawnProcess('node', [cli, 'run', '--owner=test-holder', `--repo=${poolRoot}`, '--', 'sleep', '2'], {
      env: admissionEnv,
      stdio: 'ignore',
    });
    // #4075 follow-up (ci-heal-2721, 2026-09-26): a fixed "give the holder a moment" 200ms sleep flaked under
    // real load — spawning + scheduling the holder process itself can take longer than 200ms when the host is
    // busy, so `started` below could begin BEFORE the holder actually won its slot, or well after part of its
    // hold was already spent; either way the fixed `elapsedMs >= HOLD_MS - 300` bound below no longer means
    // what it says. Fix: poll the REAL slot-lock state (`heldSlots`, the same primitive `heavy-admission.mjs
    // status` reads) until the holder provably has the slot, and read the lock's own real acquisition instant
    // off it — never guess from our own polling latency — so the "how much hold is left" math stays correct
    // regardless of how long detection itself took under load.
    const lockRoot = admissionLockRoot(poolRoot, admissionEnv);
    const pollDeadline = Date.now() + 10_000;
    let holderEntry;
    while (Date.now() < pollDeadline) {
      holderEntry = heldSlots({ lockRoot, cap: 1 }).find((s) => s.owner === 'test-holder');
      if (holderEntry) break;
      // eslint-disable-next-line no-await-in-loop -- deliberate poll, not a fixed single sleep
      await new Promise((res) => setTimeout(res, 25));
    }
    expect(holderEntry, 'the holder never showed up as holding slot-0 within 10s').toBeTruthy();
    const holderAcquiredAt = Date.parse(holderEntry.meta?.acquiredAt || holderEntry.heartbeatAt);
    expect(Number.isFinite(holderAcquiredAt)).toBe(true);

    const req = runVerifyLane(['request', `--repo=${laneDir}`, '--gate=true', '--json'], laneDir);
    expect(req.code).toBe(0);

    const started = Date.now();
    const r = runDispatch(['--json'], {
      LANE_POOL_ROOT: poolRoot,
      WE_HEAVY_ADMISSION_CAP: '1',
      WE_HEAVY_ADMISSION_TIMEOUT_MS: '10000', // must actually WAIT for the holder, never fail open, in this test
      // The gate-only ceiling is smaller than (queue wait + gate), which is exactly what would have tripped
      // the OLD single spawn-to-exit ceiling — proving THIS run survives because only gate time counts.
      VERIFY_DISPATCH_TIMEOUT_MS: '1500',
    });
    const elapsedMs = Date.now() - started;

    const body = JSON.parse(r.out);
    expect(body.failures).toEqual([]);
    expect(body.dispatched[0]).toMatchObject({ pool: 'flagtest', lane: 1 });
    // Proof real queuing happened, not a lucky fast path: total elapsed must have actually included whatever
    // of the holder's real HOLD_MS was still remaining at the moment WE started measuring — computed from the
    // holder's own real acquisition timestamp, never assumed to equal the nominal HOLD_MS.
    const remainingHoldMsAtStart = Math.max(0, HOLD_MS - (started - holderAcquiredAt));
    expect(elapsedMs).toBeGreaterThanOrEqual(Math.max(0, remainingHoldMsAtStart - 300));

    const after = runVerifyLane(['check', `--repo=${laneDir}`, '--json'], laneDir);
    expect(JSON.parse(after.out).status).toBe('green');

    await new Promise((res) => holder.on('exit', res));
  }, 30_000);
});

// ── #4360: dispatch up to the heavy-admission cap concurrently, never one-at-a-time ────────────────────────
// `runVerifyDispatch`'s `spawnGate` (and `poolRoot`) injection points exist ONLY so these tests can prove the
// loop's own timing/failure-isolation behavior deterministically, against a controllable fake — never a real
// `verify-lane.mjs` child (that round trip is already covered by the CLI-level tests above). A production call
// never passes either override; both default to the real thing.
describe('runVerifyDispatch — concurrent dispatch, never awaiting between lanes (#4360)', () => {
  it('fires spawnGate for a SECOND pending lane before the FIRST lane\'s promise has resolved (no await between lanes)', async () => {
    const lane2Dir = makeLane(join(poolDir, 'lane-2'));
    expect(runVerifyLane(['request', `--repo=${laneDir}`, '--gate=true', '--json'], laneDir).code).toBe(0);
    expect(runVerifyLane(['request', `--repo=${lane2Dir}`, '--gate=true', '--json'], lane2Dir).code).toBe(0);

    const calls = [];
    const releasers = [];
    const spawnGate = (args) => {
      calls.push(args[1]); // `--repo=<dir>`
      return new Promise((resolvePromise) => releasers.push(() => resolvePromise({ pid: 1 })));
    };

    const runPromise = runVerifyDispatch({ poolRoot, spawnGate });

    // The synchronous scan + `pending.map(...)` call BOTH lanes' `spawnGate` before `runVerifyDispatch`'s own
    // first `await` ever yields — so both calls have already happened by this point, with NEITHER promise told
    // to resolve yet. The old serial loop could never reach lane 2's call until lane 1's promise settled.
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.includes('lane-1'))).toBe(true);
    expect(calls.some((c) => c.includes('lane-2'))).toBe(true);

    releasers.forEach((release) => release());
    const result = await runPromise;
    expect(result.dispatched).toHaveLength(2);
  });

  it('one lane\'s spawnGate rejection does not block another lane\'s own dispatched/failures entry (Promise.allSettled, not Promise.all)', async () => {
    const lane2Dir = makeLane(join(poolDir, 'lane-2'));
    expect(runVerifyLane(['request', `--repo=${laneDir}`, '--gate=true', '--json'], laneDir).code).toBe(0);
    expect(runVerifyLane(['request', `--repo=${lane2Dir}`, '--gate=true', '--json'], lane2Dir).code).toBe(0);

    const spawnGate = (args) => {
      if (args[1].includes('lane-1')) {
        const e = new Error('verify-lane exceeded the gate-phase ceiling');
        e.timedOutPhase = 'gate';
        return Promise.reject(e);
      }
      return Promise.resolve({ pid: 2 });
    };

    const result = await runVerifyDispatch({ poolRoot, spawnGate });
    // Had the loop used `Promise.all`, lane 1's rejection would have rejected the whole batch and lost lane 2's
    // entry entirely — both must be present.
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ pool: 'flagtest', lane: 1, timedOut: true, timedOutPhase: 'gate' });
    expect(result.dispatched).toHaveLength(1);
    expect(result.dispatched[0]).toMatchObject({ pool: 'flagtest', lane: 2 });
  });

  // NOTE: an earlier revision had a third test here ("dispatches each pending lane exactly once per sweep")
  // that only asserted `calls.length === 2` and `new Set(calls).size === 2` against a fake `spawnGate` — an
  // assertion the OLD serial `await`-in-a-loop code would have satisfied identically, so it defended nothing
  // about THIS change. The "once per lane" invariant it was trying to cover is already proven, for real, by
  // the first test above: its `expect(calls).toHaveLength(2)` plus the per-lane-name assertions ARE the
  // exactly-once-per-lane check, taken at the point both calls have already fired concurrently. Removed rather
  // than kept as dead weight.
});

// ── #4373: cap-bounded execution, onGateStarted wiring, and "no second chokepoint" ─────────────────────────
// Tests only. Real concurrent gate execution is bounded by each spawned `verify-lane.mjs` child's own
// `acquireSlotBlocking`, never by the daemon; these pin the properties that keep that safe.

/** Run `fn` with `process.env` overridden (undefined deletes), restoring every key afterwards — the spawned
 *  `verify-lane.mjs` children inherit `process.env`. */
async function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k]; else process.env[k] = overrides[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

/** A gate that logs `start`/`end` intervals to a shared file, so real overlap is measured independently of the
 *  semaphore (`heldSlots` only scans `cap` files and could never exceed it by construction). */
function writeIntervalGate(dir, logFile, sleepMs) {
  const p = join(dir, 'interval-gate.mjs');
  writeFileSync(
    p,
    [
      `import { appendFileSync } from 'node:fs';`,
      `const tag = process.argv[2];`,
      `appendFileSync(${JSON.stringify(logFile)}, 'start ' + tag + ' ' + Date.now() + '\\n');`,
      `await new Promise((r) => setTimeout(r, ${sleepMs}));`,
      `appendFileSync(${JSON.stringify(logFile)}, 'end ' + tag + ' ' + Date.now() + '\\n');`,
    ].join('\n'),
    'utf8',
  );
  return p;
}

function peakOverlap(logFile) {
  const events = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => {
    const [kind, , ts] = l.split(' ');
    return { kind, ts: Number(ts) };
  });
  // Ends sort before starts at the same instant so back-to-back gates are not counted as overlapping.
  events.sort((a, b) => a.ts - b.ts || (a.kind === 'end' ? -1 : 1));
  let cur = 0; let peak = 0;
  for (const e of events) { cur += e.kind === 'start' ? 1 : -1; peak = Math.max(peak, cur); }
  return peak;
}

describe('runVerifyDispatch — real cap-bounded execution (#4373)', () => {
  const CAP = 2;

  for (const [label, n] of [['2×cap (4)', 4], ['3×cap (6)', 6]]) {
    it(`#4373 peak concurrent gates ≤ cap with ${label} pending lanes, all reaching green`, async () => {
      const logFile = join(base, 'intervals.log');
      writeFileSync(logFile, '');
      const gateScript = writeIntervalGate(base, logFile, 3000);
      const dirs = [laneDir];
      for (let i = 2; i <= n; i += 1) dirs.push(makeLane(join(poolDir, `lane-${i}`)));
      dirs.forEach((d, i) => {
        const gate = `node ${gateScript} lane-${i + 1}`;
        expect(runVerifyLane(['request', `--repo=${d}`, `--gate=${gate}`, '--json'], d).code).toBe(0);
      });

      const result = await withEnv(
        { LANE_POOL_ROOT: poolRoot, WE_HEAVY_ADMISSION_CAP: String(CAP), WE_HEAVY_ADMISSION: undefined, CI: undefined, WE_HEAVY_ADMISSION_HELD: undefined },
        () => runVerifyDispatch({ poolRoot }),
      );

      const peak = peakOverlap(logFile);
      console.info(`#4373 N=${n} cap=${CAP} measured peak gate overlap = ${peak}`);
      expect(result.failures).toEqual([]);
      expect(result.dispatched).toHaveLength(n);
      expect(peak).toBeLessThanOrEqual(CAP);
      expect(peak).toBeGreaterThanOrEqual(CAP); // overlap really happened, so the bound is not vacuous
      for (const d of dirs) {
        expect(JSON.parse(runVerifyLane(['check', `--repo=${d}`, '--json'], d).out).status).toBe('green');
      }
    }, 90_000);
  }

  it('#4373 an unslotted (admission off) lane is still counted in dispatched, not failures', async () => {
    expect(runVerifyLane(['request', `--repo=${laneDir}`, '--gate=true', '--json'], laneDir).code).toBe(0);
    const result = await withEnv(
      { LANE_POOL_ROOT: poolRoot, WE_HEAVY_ADMISSION: 'off' },
      () => runVerifyDispatch({ poolRoot }),
    );
    expect(result.failures).toEqual([]);
    expect(result.dispatched).toHaveLength(1);
    expect(JSON.parse(runVerifyLane(['check', `--repo=${laneDir}`, '--json'], laneDir).out).status).toBe('green');
  }, 30_000);
});

describe('runVerifyDispatch — onGateStarted wiring (#4373)', () => {
  /** Capture everything written to stderr while `fn` runs. */
  async function captureStderr(fn) {
    const lines = [];
    const orig = process.stderr.write;
    process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return orig.call(process.stderr, chunk, ...rest); };
    try { await fn(); } finally { process.stderr.write = orig; }
    return lines.join('');
  }

  it('#4373 runVerifyDispatch passes its own onGateStarted to spawnGate and logs one gate-started line per real lane', async () => {
    expect(runVerifyLane(['request', `--repo=${laneDir}`, '--gate=true', '--json'], laneDir).code).toBe(0);
    let received;
    const spawnGate = (args, opts) => { received = opts; return spawnGateBounded(args, opts); };
    const err = await withEnv(
      { LANE_POOL_ROOT: poolRoot, WE_HEAVY_ADMISSION: undefined },
      () => captureStderr(() => runVerifyDispatch({ poolRoot, spawnGate })),
    );
    expect(typeof received.onGateStarted).toBe('function');
    const started = err.split('\n').filter((l) => l.includes('▶ gate started for flagtest/lane-1 @ '));
    expect(started).toHaveLength(1);
    expect(started[0]).toMatch(/@ [0-9a-f]{8} — \d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  }, 30_000);

  it('#4373 gate-started timestamp reflects gate start, not offer time', async () => {
    const cli = resolve(process.cwd(), 'scripts/readiness/heavy-admission.mjs');
    const env = { ...process.env, LANE_POOL_ROOT: poolRoot, WE_HEAVY_ADMISSION_CAP: '1' };
    delete env.CI; delete env.WE_HEAVY_ADMISSION; delete env.WE_HEAVY_ADMISSION_HELD;
    const holder = spawnProcess('node', [cli, 'run', '--owner=test-holder', `--repo=${poolRoot}`, '--', 'sleep', '2'], { env, stdio: 'ignore' });
    const lockRoot = admissionLockRoot(poolRoot, env);
    const pollDeadline = Date.now() + 10_000;
    let entry;
    while (Date.now() < pollDeadline) {
      entry = heldSlots({ lockRoot, cap: 1 }).find((s) => s.owner === 'test-holder');
      if (entry) break;
      // eslint-disable-next-line no-await-in-loop -- deliberate poll
      await new Promise((res) => setTimeout(res, 25));
    }
    expect(entry, 'the holder never showed up as holding the slot within 10s').toBeTruthy();
    const holdEndsAt = Date.parse(entry.meta?.acquiredAt || entry.heartbeatAt) + 2000;

    expect(runVerifyLane(['request', `--repo=${laneDir}`, '--gate=true', '--json'], laneDir).code).toBe(0);
    const err = await withEnv(
      { LANE_POOL_ROOT: poolRoot, WE_HEAVY_ADMISSION_CAP: '1', WE_HEAVY_ADMISSION: undefined, WE_HEAVY_ADMISSION_TIMEOUT_MS: '10000' },
      () => captureStderr(() => runVerifyDispatch({ poolRoot })),
    );
    const line = err.split('\n').find((l) => l.includes('▶ gate started for flagtest/lane-1'));
    expect(line).toBeTruthy();
    const loggedAt = Date.parse(line.split(' — ').pop());
    // The gate could only start once the holder released — never at offer time.
    expect(loggedAt).toBeGreaterThanOrEqual(holdEndsAt - 300);
    if (holder.exitCode === null && holder.signalCode === null) await new Promise((res) => holder.on('exit', res));
  }, 30_000);
});

/** Strip `//` and block comments from JS source, string/template/regex-naive but string-aware. */
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i]; const d = src[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1); i = j + 1;
    } else if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (c === '/' && d === '*') {
      const j = src.indexOf('*/', i + 2);
      i = j === -1 ? src.length : j + 2;
    } else { out += c; i += 1; }
  }
  return out;
}

describe('verify-dispatch — no second admission chokepoint (#4373)', () => {
  it('#4373 dispatch source code never references acquireSlotBlocking or tryAcquireSlot', () => {
    // Source scan is the mechanism: the property is "a future edit must not add a call", with no runtime hook.
    // Known limit: aliased or dynamic access (e.g. `mod['acquire' + 'SlotBlocking']`) is not caught.
    const code = stripComments(readFileSync(SCRIPT, 'utf8'));
    expect(code).not.toMatch(/\bacquireSlotBlocking\b/);
    expect(code).not.toMatch(/\btryAcquireSlot\b/);
  });
});

describe('killed verification ownership', () => {
  it('never overwrites a newer request for the same SHA and gate', () => {
    const root = mkdtempSync(join(tmpdir(), 'killed-verify-owner-'));
    try {
      makeLane(root);
      const path = join(root, '.git', '.lane-verify');
      const expected = { sha: git(['rev-parse', 'HEAD'], root), status: 'running', suites: 'true', treeHash: 'same', startedAt: 'old' };
      const newer = { ...expected, startedAt: 'new' };
      writeFileSync(path, JSON.stringify(newer));
      recordKilledVerification(root, expected, { signal: 'SIGKILL', timedOutPhase: 'gate' }, 1800000);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(newer);
      writeFileSync(path, JSON.stringify(expected));
      recordKilledVerification(root, expected, { signal: 'SIGKILL', timedOutPhase: 'gate' }, 1800000);
      const record = JSON.parse(readFileSync(path, 'utf8'));
      expect(record).toMatchObject({ status: 'infrastructure-failure', exitCode: null,
        infrastructure: { reason: 'verify-timeout', signal: 'SIGKILL', phase: 'gate', ceilingMs: 1800000 } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('killed verification ownership — queue phase (null startedAt), run identity', () => {
  const kill = { signal: 'SIGKILL', timedOutPhase: 'queue' };
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'killed-verify-queue-'));
    makeLane(root);
    const path = join(root, '.git', '.lane-verify');
    const base = { sha: git(['rev-parse', 'HEAD'], root), status: 'running', suites: 'true', treeHash: 'same', finishedAt: null, exitCode: null };
    // What the dispatcher owns the instant it spawns the child: the request it observed, no gate-start yet.
    const owned = { ...base, startedAt: null, requestStartedAt: 't0', runId: 'run-1' };
    return { root, path, base, owned };
  };

  it('never overwrites a newer same-sha/suites/tree request when the kill lands before gate start', () => {
    const { root, path, base, owned } = setup();
    try {
      const newer = { ...base, startedAt: 't-newer' };
      writeFileSync(path, JSON.stringify(newer));
      recordKilledVerification(root, owned, kill, 1000);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(newer);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('never overwrites a marker stamped by a different run', () => {
    const { root, path, base, owned } = setup();
    try {
      const other = { ...base, startedAt: 't1', runId: 'run-2' };
      writeFileSync(path, JSON.stringify(other));
      recordKilledVerification(root, owned, kill, 1000);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(other);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ['the pristine request the child never got to restamp', { startedAt: 't0' }],
    ['the marker the killed child itself restamped', { startedAt: 't1', runId: 'run-1' }],
  ])('still settles %s as an infrastructure failure', (_label, extra) => {
    const { root, path, base, owned } = setup();
    try {
      writeFileSync(path, JSON.stringify({ ...base, ...extra }));
      recordKilledVerification(root, owned, kill, 1000);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ status: 'infrastructure-failure',
        infrastructure: { reason: 'verify-timeout', phase: 'queue', ceilingMs: 1000 } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('settles a marker our child restamped even when the tree/sha it captured differs from the request (edited after `request`)', () => {
    const { root, path, base, owned } = setup();
    try {
      writeFileSync(path, JSON.stringify({ ...base, treeHash: 'edited-after-request', startedAt: 't1', runId: 'run-1' }));
      recordKilledVerification(root, owned, { signal: 'SIGKILL', timedOutPhase: 'gate' }, 1000);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ status: 'infrastructure-failure', sha: base.sha });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('runVerifyDispatch — run identity wiring (a fake spawnGate, a real marker)', () => {
  const killed = (phase) => Object.assign(new Error('killed'), { status: null, signal: 'SIGKILL', timedOutPhase: phase });
  const dispatchKilled = async ({ phase, mutate = () => {} }) => {
    expect(runVerifyLane(['request', `--repo=${laneDir}`, '--gate=true', '--json'], laneDir).code).toBe(0);
    const markerPath = join(laneDir, '.git', '.lane-verify');
    const requested = JSON.parse(readFileSync(markerPath, 'utf8'));
    let runId;
    const spawnGate = (args, opts) => {
      const flag = args.find((a) => a.startsWith('--run-id='));
      runId = flag?.slice('--run-id='.length);
      mutate({ markerPath, requested, runId, opts });
      return Promise.reject(killed(phase));
    };
    await runVerifyDispatch({ poolRoot, spawnGate });
    return { runId, requested, after: JSON.parse(readFileSync(markerPath, 'utf8')) };
  };

  it('passes a fresh uuid --run-id to every verify-lane child', async () => {
    const { runId } = await dispatchKilled({ phase: 'queue' });
    expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('a queue-phase kill of a never-restamped request settles it', async () => {
    const { after } = await dispatchKilled({ phase: 'queue' });
    expect(after).toMatchObject({ status: 'infrastructure-failure', infrastructure: { phase: 'queue' } });
  });

  it('a gate-phase kill of the marker our child restamped (runId, new startedAt, edited tree) settles it', async () => {
    const { after } = await dispatchKilled({
      phase: 'gate',
      mutate: ({ markerPath, requested, runId, opts }) => {
        writeFileSync(markerPath, JSON.stringify({ ...requested, startedAt: 't-child', treeHash: 'edited-after-request', runId }));
        opts.onGateStarted();
      },
    });
    expect(after).toMatchObject({ status: 'infrastructure-failure', infrastructure: { phase: 'gate' } });
  });

  it('a queue-phase kill never touches a newer same-sha/suites/tree request the agent re-filed meanwhile', async () => {
    const { after } = await dispatchKilled({
      phase: 'queue',
      mutate: ({ markerPath, requested }) => writeFileSync(markerPath, JSON.stringify({ ...requested, startedAt: 't-newer' })),
    });
    expect(after).toMatchObject({ status: 'running', startedAt: 't-newer' });
    expect(after.runId).toBeUndefined();
  });
});


describe('2026-10-05 hung gate starvation', () => {
  it('detects the marker before truncating a single large stderr write', async () => {
    const script = join(base, 'chatty-gate.mjs');
    writeFileSync(script, `process.stderr.write(${JSON.stringify(GATE_STARTED_MARKER)} + 'x'.repeat(9000)); setTimeout(() => {}, 30000);`);
    let started = 0;
    const pids = [];
    await expect(spawnGateBounded([script], {
      queueCeilingMs: 2000, gateCeilingMs: 100,
      onGateStarted: () => { started += 1; }, onSpawn: pid => pids.push(pid),
    })).rejects.toMatchObject({ timedOutPhase: 'gate' });
    expect(started).toBe(1);
    expect(pids).toHaveLength(1);
    expect(pids[0]).toBeGreaterThan(0);
  });

  it('returns without settlement, remembers the pid, and never dispatches the same lane twice', async () => {
    runVerifyLane(['request', `--repo=${laneDir}`, '--gate=true', '--json'], laneDir);
    const inFlight = new Map();
    let calls = 0;
    const spawnGate = (_args, { onSpawn }) => {
      calls += 1;
      onSpawn?.(12345);
      return new Promise(() => {});
    };
    const opts = { poolRoot, spawnGate, inFlight, awaitSettle: false };
    const result = await runVerifyDispatch(opts);
    expect(result.dispatched).toMatchObject([{ lane: 1, launched: true }]);
    expect(inFlight.get(laneDir)).toMatchObject({ lane: 1, pid: 12345 });
    expect((await runVerifyDispatch(opts)).dispatched).toEqual([]);
    expect(calls).toBe(1);
  }, 2000);

  it('leaves excess requests untouched for a later tick', async () => {
    const lane2 = makeLane(join(poolDir, 'lane-2'));
    for (const dir of [laneDir, lane2]) runVerifyLane(['request', `--repo=${dir}`, '--gate=true'], dir);
    const before = readFileSync(join(lane2, '.git', '.lane-verify'), 'utf8');
    const result = await runVerifyDispatch({ poolRoot, inFlight: new Map(), awaitSettle: false,
      maxInFlight: 1, spawnGate: () => new Promise(() => {}) });
    expect(result.dispatched).toMatchObject([{ lane: 1, launched: true }]);
    expect(result.deferred).toMatchObject([{ pool: 'flagtest', lane: 2, reason: 'max-in-flight' }]);
    expect(readFileSync(join(lane2, '.git', '.lane-verify'), 'utf8')).toBe(before);
  }, 2000);

  it('recognizes only a different run and request that still needs dispatch', () => {
    const entry = { runId: 'old', requestStartedAt: 'before' };
    const marker = { status: 'running', sha: 'head', runId: 'new', startedAt: 'after' };
    expect(inFlightSuperseded(entry, marker, 'head')).toBe(true);
    expect(inFlightSuperseded(entry, { ...marker, runId: 'old' }, 'head')).toBe(false);
    expect(inFlightSuperseded(entry, { ...marker, startedAt: 'before' }, 'head')).toBe(false);
    expect(inFlightSuperseded(entry, marker, 'other')).toBe(false);
  });

  it('resolves a positive integer concurrency limit, otherwise eight', () => {
    for (const value of [undefined, '0', '-1', '1.5', 'nope']) {
      expect(resolveMaxInFlight({ VERIFY_DISPATCH_MAX_IN_FLIGHT: value })).toBe(8);
    }
    expect(resolveMaxInFlight({ VERIFY_DISPATCH_MAX_IN_FLIGHT: '3' })).toBe(3);
  });
});


it('settles a superseded run in the background without overwriting the newer request', async () => {
  runVerifyLane(['request', `--repo=${laneDir}`, '--gate=true'], laneDir);
  const inFlight = new Map();
  let rejectGate;
  const spawnGate = vi.fn((_args, { onSpawn }) => {
    onSpawn(12345);
    return new Promise((_resolve, reject) => { rejectGate = reject; });
  });
  const opts = { poolRoot, inFlight, spawnGate, awaitSettle: false };
  await runVerifyDispatch(opts);
  const old = inFlight.get(laneDir);
  const path = join(laneDir, '.git', '.lane-verify');
  const newer = { ...JSON.parse(readFileSync(path, 'utf8')), runId: 'new-request', startedAt: '2099-01-01T00:00:00.000Z' };
  writeFileSync(path, JSON.stringify(newer));
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  try {
    vi.stubEnv('VERIFY_DISPATCH_KILL_SUPERSEDED', '0');
    expect((await runVerifyDispatch(opts)).superseded).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
    vi.stubEnv('VERIFY_DISPATCH_KILL_SUPERSEDED', '1');
    const result = await runVerifyDispatch(opts);
    expect(result.superseded).toEqual([{ pool: 'flagtest', lane: 1, runId: old.runId }]);
    expect(kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
    expect(spawnGate).toHaveBeenCalledTimes(1);
    expect(inFlight.size).toBe(1);
    rejectGate(Object.assign(new Error('killed'), { signal: 'SIGKILL', status: null }));
    await new Promise(resolve => setImmediate(resolve));
    expect(inFlight.size).toBe(0);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(newer);
    await runVerifyDispatch({ ...opts, spawnGate: async () => ({ pid: 42 }) });
    await new Promise(resolve => setImmediate(resolve));
    expect(inFlight.size).toBe(0);
  } finally {
    kill.mockRestore();
    vi.unstubAllEnvs();
  }
});


it('detects a gate marker split across stderr chunks', async () => {
  const script = join(base, 'split-marker.mjs');
  writeFileSync(script, `process.stderr.write('gate execution '); setTimeout(() => process.stderr.write('starting' + 'x'.repeat(9000)), 100); setTimeout(() => {}, 30000);`);
  let started = 0;
  await expect(spawnGateBounded([script], { queueCeilingMs: 2000, gateCeilingMs: 100,
    onGateStarted: () => { started += 1; },
  })).rejects.toMatchObject({ timedOutPhase: 'gate' });
  expect(started).toBe(1);
});
