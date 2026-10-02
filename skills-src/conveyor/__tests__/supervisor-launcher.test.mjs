/**
 * @file skills-src/conveyor/__tests__/supervisor-launcher.test.mjs
 * @description Unit proof of #3874's manifest-driven launcher. Every test supplies its OWN fixture manifest
 *   and fake effects, never a real subprocess (see supervisor.mjs's own __tests__ for the real-spawn proof
 *   this launcher reuses unmodified, and see this directory's OWN
 *   supervisor-launcher.integration.test.mjs for the real-spawn / real-lease / real-pacing proof against
 *   this launcher itself — no injected `spawnChild`/`runLoop` there). The handful of tests that DO exercise
 *   the real, shared DAEMON_MANIFEST (proving the "no injection needed" default path) assert against its own
 *   CURRENT state (`Object.keys(DAEMON_MANIFEST)`), never a value hardcoded at write time — that manifest is
 *   a live, mutable export another PR (#3873) populates independently of this one, and a hardcoded literal
 *   here reddened the moment #3873 landed (live-caught in review, PR #2472).
 *
 * ROUND 2 OF PR #2472's REVIEW (see supervisor-launcher.mjs's own header, "CORRECTED PREMISE #3"): every
 * `launchEntry`/`launchAll` test below now injects fake `acquireLease`/`heartbeatLease`/`releaseLease`
 * effects — the launcher now takes a real pass-daemon.mjs-compatible lease before spawning anything, and this
 * unit suite must stay fully hermetic (never touch a real lease file), exactly like it was already hermetic
 * for `spawnChild`/`log`/`runLoop`.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  planLaunchTargets, defaultLaunchNames, resolveScriptPath, entryLogPath, launchEntry, launchAll,
  runPeriodicSupervisorLoop, DEFAULT_PERIODIC_CRASH_THRESHOLD_MS, DEFAULT_LOG_ROOT,
} from '../supervisor-launcher.mjs';
import { DAEMON_MANIFEST } from '../daemon-manifest.mjs';
import { passDaemonLeaseKey } from '../pass-daemon.mjs';

const fixtureManifest = {
  'branch-drift': { script: 'scripts/conveyor/branch-drift.mjs', args: ['sweep'], intervalMs: 120_000 },
  'ci-queue-watch': { script: 'scripts/conveyor/ci-queue-watch.mjs', args: ['sweep'], intervalMs: 60_000 },
  'no-args-entry': { script: 'scripts/conveyor/x.mjs', intervalMs: 1000 },
};

function fakeResolveEntry(name, manifest) {
  const entry = manifest[name];
  if (!entry) throw new Error(`"${name}" is not in the daemon manifest — pass-daemon never takes a raw script path.`);
  return entry;
}

/** Fake lease effects for every `launchEntry`/`launchAll` test below — always grants, heartbeats stay alive,
 *  release always succeeds. Kept in one place so every test asserting on OTHER things doesn't have to repeat
 *  this boilerplate; a test that specifically wants to prove the DENIAL path builds its own instead. */
function grantingLeaseFakes() {
  return { acquireLease: () => ({ ok: true }), heartbeatLease: () => true, releaseLease: () => true };
}

describe('planLaunchTargets — pure resolution over an injected manifest', () => {
  it('resolves every valid name into a launch target', () => {
    const { targets, failures } = planLaunchTargets(['branch-drift', 'ci-queue-watch'], {
      manifest: fixtureManifest, resolveEntry: fakeResolveEntry,
    });
    expect(failures).toEqual([]);
    expect(targets).toEqual([
      { name: 'branch-drift', script: 'scripts/conveyor/branch-drift.mjs', args: ['sweep'], intervalMs: 120_000 },
      { name: 'ci-queue-watch', script: 'scripts/conveyor/ci-queue-watch.mjs', args: ['sweep'], intervalMs: 60_000 },
    ]);
  });

  it('defaults a missing args field to an empty array', () => {
    const { targets } = planLaunchTargets(['no-args-entry'], { manifest: fixtureManifest, resolveEntry: fakeResolveEntry });
    expect(targets).toEqual([{ name: 'no-args-entry', script: 'scripts/conveyor/x.mjs', args: [], intervalMs: 1000 }]);
  });

  // Live-caught in review (PR #2472, round 2): planLaunchTargets used to carry ONLY script/args into the
  // resolved target, silently dropping the manifest entry's own intervalMs — the exact field
  // launchEntry/runPeriodicSupervisorLoop need to pace a periodic pass instead of respawning it with no
  // delay. Direct regression test for that specific field, not just an incidental part of a shape assertion.
  it('carries the manifest entry\'s own intervalMs through into the resolved target, never dropping it', () => {
    const { targets } = planLaunchTargets(['branch-drift', 'ci-queue-watch', 'no-args-entry'], {
      manifest: fixtureManifest, resolveEntry: fakeResolveEntry,
    });
    expect(targets.map((t) => [t.name, t.intervalMs])).toEqual([
      ['branch-drift', 120_000], ['ci-queue-watch', 60_000], ['no-args-entry', 1000],
    ]);
  });

  it('isolates one unresolvable name — the rest still resolve, never aborted by the bad one', () => {
    const { targets, failures } = planLaunchTargets(['branch-drift', 'totally-made-up', 'ci-queue-watch'], {
      manifest: fixtureManifest, resolveEntry: fakeResolveEntry,
    });
    expect(targets.map((t) => t.name)).toEqual(['branch-drift', 'ci-queue-watch']);
    expect(failures).toEqual([{ name: 'totally-made-up', error: expect.stringMatching(/is not in the daemon manifest/) }]);
  });

  it('an empty/absent names list resolves nothing and fails on nothing', () => {
    expect(planLaunchTargets([], { manifest: fixtureManifest, resolveEntry: fakeResolveEntry })).toEqual({ targets: [], failures: [] });
    expect(planLaunchTargets(undefined, { manifest: fixtureManifest, resolveEntry: fakeResolveEntry })).toEqual({ targets: [], failures: [] });
  });

  // Live-caught in review (PR #2472): this used to hardcode "the real DAEMON_MANIFEST is empty" — true when
  // this file was first written, but #3873 landed 15 real entries onto that SAME shared, mutable export
  // before this PR merged, which reddened the hardcoded literal. Fixed to assert against the manifest's own
  // CURRENT real state (`Object.keys(DAEMON_MANIFEST)`) rather than a value pinned at write time — the fix
  // the review itself prescribed for this whole class of cross-file shared-default test.
  it('defaults resolveEntry/manifest to the real ones when not injected — a name that is not for real registered still refuses', () => {
    const { targets, failures } = planLaunchTargets(['totally-not-a-real-entry-name']);
    expect(targets).toEqual([]);
    expect(failures).toEqual([{ name: 'totally-not-a-real-entry-name', error: expect.stringMatching(/is not in the daemon manifest/) }]);
  });

  it('every REAL currently-registered manifest name resolves with no defaults injected', () => {
    const realNames = Object.keys(DAEMON_MANIFEST);
    if (realNames.length === 0) return; // still true only before #3873 lands; skip rather than assert either shape
    const { targets, failures } = planLaunchTargets(realNames);
    expect(failures).toEqual([]);
    expect(targets.map((t) => t.name).sort()).toEqual([...realNames].sort());
  });

  // Live-caught in review (PR #2472, round 2): proves the intervalMs-carrying fix against the REAL manifest
  // too, not only the fixture — every real entry's own intervalMs (required by daemon-manifest.mjs's own
  // assertValidManifestEntry) must survive resolution unchanged.
  it('every REAL currently-registered manifest entry carries its own positive intervalMs through unchanged', () => {
    const realNames = Object.keys(DAEMON_MANIFEST);
    if (realNames.length === 0) return; // still true only before #3873 lands; skip rather than assert either shape
    const { targets } = planLaunchTargets(realNames);
    for (const t of targets) {
      expect(t.intervalMs).toBe(DAEMON_MANIFEST[t.name].intervalMs);
      expect(Number.isFinite(t.intervalMs) && t.intervalMs > 0).toBe(true);
    }
  });
});

describe('defaultLaunchNames — every currently-registered name, sorted', () => {
  it('returns every fixture name sorted, regardless of declaration order', () => {
    expect(defaultLaunchNames(fixtureManifest)).toEqual(['branch-drift', 'ci-queue-watch', 'no-args-entry']);
  });

  it('is empty for an empty manifest', () => {
    expect(defaultLaunchNames({})).toEqual([]);
  });

  // Live-caught in review (PR #2472): same class of fix as planLaunchTargets' own test above — assert
  // against DAEMON_MANIFEST's own current real keys, never a value hardcoded at write time.
  it('defaults to the real DAEMON_MANIFEST when none is supplied', () => {
    expect(defaultLaunchNames()).toEqual(Object.keys(DAEMON_MANIFEST).filter((n) => DAEMON_MANIFEST[n].defaultLaunch !== false).sort());
  });

  it('leaves out entries marked defaultLaunch: false, which stay launchable by explicit name', () => {
    const manifest = { ...fixtureManifest, 'resident-only': { script: 'scripts/conveyor/r.mjs', args: ['tick'], intervalMs: 1000, defaultLaunch: false } };
    expect(defaultLaunchNames(manifest)).toEqual(['branch-drift', 'ci-queue-watch', 'no-args-entry']);
    const { targets } = planLaunchTargets(['resident-only'], { manifest, resolveEntry: fakeResolveEntry });
    expect(targets.map((t) => t.name)).toEqual(['resident-only']);
  });
});

// Live-caught in review (PR #2472, round 2): NEW pure-core function, built to close the finding that a
// launched entry's clean exit fell straight into supervisor.mjs's own decideRestart, which gives an ordinary
// clean exit `delayMs: 0` — an immediate, unpaced respawn forever, ignoring the entry's own intervalMs. Every
// effect here is a fake (never a real subprocess/timer) — see supervisor-launcher.integration.test.mjs for
// the real-spawn proof of this same function driven through launchEntry with nothing injected.
describe('runPeriodicSupervisorLoop — pure run/pace/backoff control flow over injected effects', () => {
  it('requires a spawnChild effect and a positive intervalMs', async () => {
    await expect(runPeriodicSupervisorLoop({ intervalMs: 1000 })).rejects.toThrow(/requires a spawnChild effect/);
    await expect(runPeriodicSupervisorLoop({ spawnChild: async () => ({ code: 0, ranMs: 5000 }), intervalMs: 0 }))
      .rejects.toThrow(/requires a positive intervalMs/);
    await expect(runPeriodicSupervisorLoop({ spawnChild: async () => ({ code: 0, ranMs: 5000 }), intervalMs: -1 }))
      .rejects.toThrow(/requires a positive intervalMs/);
  });

  it('a CLEAN exit paces the next run by intervalMs — never supervisor.mjs\'s delayMs:0 for a plain exit:0', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const spawnChild = vi.fn(async () => { calls += 1; return { code: 0, signal: null, ranMs: 5000 }; });
    const out = await runPeriodicSupervisorLoop({ spawnChild, sleep, intervalMs: 120_000, maxRestarts: 2 });
    expect(spawnChild).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(120_000);
    expect(out).toEqual({ restarts: 2, stoppedReason: 'max-restarts' });
  });

  it('DEFAULT_PERIODIC_CRASH_THRESHOLD_MS (0) means a genuinely FAST clean exit is still paced by intervalMs, never misread as "too-short"', async () => {
    expect(DEFAULT_PERIODIC_CRASH_THRESHOLD_MS).toBe(0);
    const sleep = vi.fn(async () => {});
    // ranMs: 5 — under supervisor.mjs's own 3_000ms crash threshold, which WOULD misclassify this as a crash
    // if reused at its own default. Proves the disabled-heuristic default actually takes effect here.
    const spawnChild = vi.fn(async () => ({ code: 0, signal: null, ranMs: 5 }));
    const out = await runPeriodicSupervisorLoop({ spawnChild, sleep, intervalMs: 300, maxRestarts: 1 });
    expect(sleep).not.toHaveBeenCalled(); // only 1 restart requested — no next-run pacing needed yet
    expect(out).toEqual({ restarts: 1, stoppedReason: 'max-restarts' });
  });

  it('a genuine crash (non-zero exit) still gets supervisor.mjs\'s own doubling backoff, reused unmodified', async () => {
    const sleep = vi.fn(async () => {});
    const spawnChild = vi.fn(async () => ({ code: 1, signal: null, ranMs: 5000 }));
    const out = await runPeriodicSupervisorLoop({
      spawnChild, sleep, intervalMs: 120_000, maxRestarts: 3, baseBackoffMs: 100, maxBackoffMs: 1000,
    });
    expect(spawnChild).toHaveBeenCalledTimes(3);
    // Crash streak: 100ms, then 200ms (doubling) — never the 120_000ms interval, since these exits are crashes.
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
    expect(out).toEqual({ restarts: 3, stoppedReason: 'max-restarts' });
  });

  it('a crash streak reset by a clean run: the NEXT crash backs off from the base again, not from where the streak left off', async () => {
    const sleep = vi.fn(async () => {});
    const results = [
      { code: 1, ranMs: 10 }, { code: 1, ranMs: 10 }, { code: 0, ranMs: 5000 }, { code: 1, ranMs: 10 }, { code: 0, ranMs: 5000 },
    ];
    let i = 0;
    const spawnChild = vi.fn(async () => results[i++]);
    await runPeriodicSupervisorLoop({ spawnChild, sleep, intervalMs: 500, maxRestarts: 5, baseBackoffMs: 100, maxBackoffMs: 1000 });
    // crash→100 (streak 1); crash→200 (streak 2, doubling); clean→500 (interval, streak reset);
    // crash→100 AGAIN (streak back to 1, not continuing at 400 as an unreset streak would demand).
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200, 500, 100]);
  });

  it('respects shouldStop before the next spawn — never launches one more run after a stop signal', async () => {
    const sleep = vi.fn(async () => {});
    let stop = false;
    const spawnChild = vi.fn(async () => { stop = true; return { code: 0, signal: null, ranMs: 5000 }; });
    const out = await runPeriodicSupervisorLoop({ spawnChild, sleep, intervalMs: 100, shouldStop: () => stop });
    expect(spawnChild).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ restarts: 1, stoppedReason: 'signal' });
  });
});

describe('resolveScriptPath / entryLogPath — pure path joins', () => {
  it('joins a repo-relative script against the given root', () => {
    expect(resolveScriptPath('scripts/conveyor/branch-drift.mjs', { root: '/repo' })).toBe('/repo/scripts/conveyor/branch-drift.mjs');
  });

  it('gives each entry name its own JSONL path under the given log root', () => {
    expect(entryLogPath('branch-drift', { logRoot: '/locks/supervisor-launcher' })).toBe('/locks/supervisor-launcher/branch-drift.jsonl');
  });

  it('defaults the log root to DEFAULT_LOG_ROOT', () => {
    expect(entryLogPath('x')).toBe(`${DEFAULT_LOG_ROOT}/x.jsonl`);
  });
});

describe('launchEntry — wires one target through injected (never real) spawn/log/loop/lease effects', () => {
  it('builds the spawnChild effect with the resolved runnerPath + the entry\'s own args', async () => {
    const makeSpawnChild = vi.fn(() => async () => ({ code: 0, signal: null, ranMs: 10 }));
    const makeLog = vi.fn(() => () => {});
    const runLoop = vi.fn(async ({ spawnChild }) => {
      const result = await spawnChild();
      return { restarts: 1, stoppedReason: 'signal', lastResult: result };
    });
    const out = await launchEntry(
      { name: 'branch-drift', script: 'scripts/conveyor/branch-drift.mjs', args: ['sweep'], intervalMs: 120_000 },
      { root: '/repo', logRoot: '/locks', makeSpawnChild, makeLog, runLoop, shouldStop: () => true, ...grantingLeaseFakes() },
    );
    expect(makeSpawnChild).toHaveBeenCalledWith(expect.objectContaining({
      runnerPath: '/repo/scripts/conveyor/branch-drift.mjs', extraArgs: ['sweep'],
    }));
    expect(makeLog).toHaveBeenCalledWith('/locks/branch-drift.jsonl');
    expect(out).toEqual({ restarts: 1, stoppedReason: 'signal', lastResult: { code: 0, signal: null, ranMs: 10 } });
  });

  it('forwards onChild(name, child) so a multi-entry caller can track live children by name', async () => {
    const seen = [];
    const fakeChild = { pid: 4242 };
    const makeSpawnChild = vi.fn(({ onChild }) => {
      onChild(fakeChild);
      return async () => ({ code: 0, signal: null, ranMs: 5 });
    });
    const runLoop = vi.fn(async ({ spawnChild }) => { await spawnChild(); return { restarts: 1, stoppedReason: 'signal' }; });
    await launchEntry(
      { name: 'ci-queue-watch', script: 'scripts/conveyor/ci-queue-watch.mjs', args: [], intervalMs: 60_000 },
      {
        makeSpawnChild, makeLog: () => () => {}, runLoop, onChild: (name, child) => seen.push({ name, child }),
        shouldStop: () => true, ...grantingLeaseFakes(),
      },
    );
    expect(seen).toEqual([{ name: 'ci-queue-watch', child: fakeChild }]);
  });

  it('every logged entry carries its own name, never bleeding into a sibling entry\'s log', async () => {
    const entries = [];
    const makeLog = () => (entry) => entries.push(entry);
    const runLoop = vi.fn(async ({ log }) => { log({ event: 'spawn', attempt: 1 }); return { restarts: 1, stoppedReason: 'signal' }; });
    await launchEntry(
      { name: 'branch-drift', script: 'x.mjs', args: [], intervalMs: 1000 },
      { makeSpawnChild: () => async () => ({ code: 0 }), makeLog, runLoop, shouldStop: () => true, ...grantingLeaseFakes() },
    );
    expect(entries).toEqual([{ name: 'branch-drift', event: 'spawn', attempt: 1 }]);
  });

  it('passes sleep straight through to runLoop, unmodified, and intervalMs from the target', async () => {
    const sleep = async () => {};
    const runLoop = vi.fn(async (o) => {
      expect(o.sleep).toBe(sleep);
      expect(o.intervalMs).toBe(1000);
      expect(o.shouldStop()).toBe(true); // wrapped (lease-aware), but still reflects the injected shouldStop
      return { restarts: 0, stoppedReason: 'signal' };
    });
    await launchEntry(
      { name: 'x', script: 'x.mjs', args: [], intervalMs: 1000 },
      { makeSpawnChild: () => async () => ({ code: 0 }), makeLog: () => () => {}, runLoop, shouldStop: () => true, sleep, ...grantingLeaseFakes() },
    );
    expect(runLoop).toHaveBeenCalledTimes(1);
  });

  // Live-caught in review (PR #2472, round 2): launchEntry used to spawn every entry with no lease at all —
  // a real concurrent pass-daemon.mjs --pass=<name> and this launcher's own copy of the same entry could both
  // run it at once. Now takes the SAME key pass-daemon.mjs would (passDaemonLeaseKey), and a denial means
  // NOTHING is spawned.
  describe('lease-taking (round 2 of PR #2472\'s review — the duplicate-run race)', () => {
    it('acquires the SAME passDaemonLeaseKey(name) pass-daemon.mjs itself would use for --pass=<name>', async () => {
      const acquireLease = vi.fn(() => ({ ok: true }));
      const runLoop = vi.fn(async () => ({ restarts: 0, stoppedReason: 'signal' }));
      await launchEntry(
        { name: 'branch-drift', script: 'x.mjs', args: [], intervalMs: 1000 },
        {
          makeSpawnChild: () => async () => ({ code: 0 }), makeLog: () => () => {}, runLoop, shouldStop: () => true,
          acquireLease, heartbeatLease: () => true, releaseLease: () => true,
        },
      );
      expect(acquireLease).toHaveBeenCalledWith(expect.anything(), expect.any(String), { key: passDaemonLeaseKey('branch-drift') });
    });

    it('a DENIED lease (already held — a live pass-daemon.mjs or a sibling launcher) never spawns anything', async () => {
      const makeSpawnChild = vi.fn();
      const runLoop = vi.fn();
      const acquireLease = () => ({ ok: false, heldBy: 'pass-daemon:branch-drift' });
      const out = await launchEntry(
        { name: 'branch-drift', script: 'x.mjs', args: [], intervalMs: 1000 },
        { makeSpawnChild, makeLog: () => () => {}, runLoop, acquireLease, heartbeatLease: () => true, releaseLease: () => true },
      );
      expect(makeSpawnChild).not.toHaveBeenCalled();
      expect(runLoop).not.toHaveBeenCalled();
      expect(out).toEqual({ restarts: 0, stoppedReason: 'lease-denied' });
    });

    it('the lease is released even when runLoop throws — never leaked on an unexpected error', async () => {
      const releaseLease = vi.fn(() => true);
      const runLoop = vi.fn(async () => { throw new Error('boom'); });
      await expect(launchEntry(
        { name: 'branch-drift', script: 'x.mjs', args: [], intervalMs: 1000 },
        { makeSpawnChild: () => async () => ({ code: 0 }), makeLog: () => () => {}, runLoop, ...grantingLeaseFakes(), releaseLease },
      )).rejects.toThrow('boom');
      expect(releaseLease).toHaveBeenCalledTimes(1);
    });

    it('a lost heartbeat (lease reclaimed away mid-run) folds into shouldStop, stopping after the current run', async () => {
      // A REAL, short-interval setInterval (this is launchEntry's own IO-shell timer, never faked) fires at
      // least once during runLoop's own real 30ms wait below, calling the injected heartbeatLease — which
      // reports the lease lost on its very first tick, flipping the wrapped shouldStop() launchEntry passes
      // to runLoop from false to true mid-run, with no cooperation from runLoop itself.
      const heartbeatLease = vi.fn(() => false);
      let observedStop = null;
      const runLoop = vi.fn(async ({ shouldStop }) => {
        await new Promise((r) => setTimeout(r, 30));
        observedStop = shouldStop();
        return { restarts: 1, stoppedReason: observedStop ? 'signal' : 'never' };
      });
      const out = await launchEntry(
        { name: 'branch-drift', script: 'x.mjs', args: [], intervalMs: 1000 },
        {
          makeSpawnChild: () => async () => ({ code: 0 }), makeLog: () => () => {}, runLoop,
          acquireLease: () => ({ ok: true }), heartbeatLease, releaseLease: () => true,
          heartbeatIntervalMs: 5,
        },
      );
      expect(heartbeatLease).toHaveBeenCalled();
      expect(observedStop).toBe(true);
      expect(out.stoppedReason).toBe('signal');
    });
  });
});

describe('launchAll — resolves + launches every target concurrently, isolating failures', () => {
  it('launches one entry per resolvable name and reports failures via onFailure without launching them', async () => {
    const launchedNames = [];
    const runLoop = vi.fn(async ({ spawnChild }) => { await spawnChild(); return { restarts: 1, stoppedReason: 'signal' }; });
    const makeSpawnChild = ({ runnerPath }) => { launchedNames.push(runnerPath); return async () => ({ code: 0 }); };
    const failures = [];
    const { launched, running } = launchAll(['branch-drift', 'totally-made-up', 'ci-queue-watch'], {
      manifest: fixtureManifest, resolveEntry: fakeResolveEntry,
      root: '/repo', makeSpawnChild, makeLog: () => () => {}, runLoop, shouldStop: () => true,
      onFailure: (f) => failures.push(f), ...grantingLeaseFakes(),
    });
    expect(launched.map((t) => t.name)).toEqual(['branch-drift', 'ci-queue-watch']);
    expect(failures).toEqual([{ name: 'totally-made-up', error: expect.stringMatching(/is not in the daemon manifest/) }]);
    expect(running).toHaveLength(2);
    await Promise.all(running);
    expect(launchedNames).toEqual(['/repo/scripts/conveyor/branch-drift.mjs', '/repo/scripts/conveyor/ci-queue-watch.mjs']);
  });

  it('with no names given, launches every entry currently in the manifest (default order = sorted keys)', async () => {
    const order = [];
    const runLoop = vi.fn(async ({ spawnChild }) => { await spawnChild(); return { restarts: 1, stoppedReason: 'signal' }; });
    const { launched, running } = launchAll(undefined, {
      manifest: fixtureManifest, resolveEntry: fakeResolveEntry,
      makeSpawnChild: () => async () => ({ code: 0 }),
      makeLog: () => () => {}, runLoop, shouldStop: () => true,
      onChild: () => {}, ...grantingLeaseFakes(),
    });
    order.push(...launched.map((t) => t.name));
    await Promise.all(running);
    expect(order).toEqual(['branch-drift', 'ci-queue-watch', 'no-args-entry']);
  });

  it('an empty manifest with no --only launches nothing and fails on nothing', () => {
    const { launched, failures, running } = launchAll(undefined, {
      manifest: {}, resolveEntry: fakeResolveEntry,
      makeSpawnChild: () => async () => ({ code: 0 }), makeLog: () => () => {},
    });
    expect(launched).toEqual([]);
    expect(failures).toEqual([]);
    expect(running).toEqual([]);
  });

  // Live-caught in review (PR #2472, round 2): one entry's lease already held elsewhere (a live
  // pass-daemon.mjs, or a sibling launcher) must isolate to THAT entry only — mirrors the established
  // "one bad entry never aborts the rest" discipline this file already gives a plan-time resolution failure.
  it('one entry whose lease is already held elsewhere still lets its siblings launch normally', async () => {
    const spawned = [];
    const runLoop = vi.fn(async ({ spawnChild }) => { const r = await spawnChild(); spawned.push(r); return { restarts: 1, stoppedReason: 'signal' }; });
    const acquireLease = (lockRoot, owner, { key }) => (
      key === passDaemonLeaseKey('ci-queue-watch') ? { ok: false, heldBy: 'pass-daemon:ci-queue-watch' } : { ok: true }
    );
    const { launched, running } = launchAll(['branch-drift', 'ci-queue-watch'], {
      manifest: fixtureManifest, resolveEntry: fakeResolveEntry,
      makeSpawnChild: () => async () => ({ code: 0 }), makeLog: () => () => {}, runLoop, shouldStop: () => true,
      acquireLease, heartbeatLease: () => true, releaseLease: () => true,
    });
    expect(launched.map((t) => t.name)).toEqual(['branch-drift', 'ci-queue-watch']); // both PLANNED — the lease
    // denial happens per-entry inside launchEntry, not at plan time, so both still appear in `launched`.
    const results = await Promise.all(running);
    expect(results).toEqual([{ restarts: 1, stoppedReason: 'signal' }, { restarts: 0, stoppedReason: 'lease-denied' }]);
    expect(spawned).toHaveLength(1); // only branch-drift actually spawned
  });
});
