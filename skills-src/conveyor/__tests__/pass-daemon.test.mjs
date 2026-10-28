// @vitest-environment node
/**
 * @file skills-src/conveyor/__tests__/pass-daemon.test.mjs
 * @description Unit proof of #3871's generic single-pass daemon — the pure loop only (no real child process,
 *   no real timer, no real lease): injected effects, mirroring #3870's own `runDaemonLoop` tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createJobStore } from '../../../scripts/lib/daemon-jobs-runtime.mjs';
import { keepAliveScript } from '../../../scripts/lib/test-keepalive.mjs';
import { EventEmitter } from 'node:events';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  runPassDaemonLoop, passDaemonLeaseKey, realSleep, DEFAULT_HEARTBEAT_INTERVAL_MS,
  PASS_DAEMON_SELF_SYNC_ENV, passDaemonSelfSyncEnabled, MAIN_ONLY_PASSES, spawnPassOnce,
  waitForManifestEntry, passEnvFor, makePassRestartCheck,
} from '../pass-daemon.mjs';
import { DAEMON_MANIFEST } from '../daemon-manifest.mjs';
import { withSelfSync, DAEMON_SELF_SYNC_BRANCH_ENV } from '../../../scripts/lib/daemon-self-sync.mjs';

describe('waitForManifestEntry — missing clone entry (#5129)', () => {
  it('keeps the actual CLI alive when its manifest entry is absent', () => {
    const child = spawnSync(process.execPath, [
      fileURLToPath(new URL('../pass-daemon.mjs', import.meta.url)), '--pass=missing-entry-5129',
    ], { encoding: 'utf8', timeout: 2000 });
    expect(child.stderr).toMatch(/missing-entry-5129.*idle.*manifest-entry-missing/);
    expect(child.error?.code).toBe('ETIMEDOUT');
    expect(child.signal).toBe('SIGTERM');
  });

  it('idles with a named reason and a paced sleep until the entry is available', async () => {
    const manifest = {};
    const entry = { script: 'scripts/pass.mjs', intervalMs: 1000 };
    const log = { error: vi.fn() };
    const sleep = vi.fn(async () => {
      if (sleep.mock.calls.length === 2) manifest['load-flake-reverify'] = entry;
    });
    await expect(waitForManifestEntry('load-flake-reverify', { manifest, sleep, log })).resolves.toBe(entry);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(60_000);
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/load-flake-reverify.*idle.*manifest-entry-missing/));
  });

  it('returns a valid registered entry without idling', async () => {
    const entry = { script: 'scripts/pass.mjs', intervalMs: 1000 };
    const sleep = vi.fn();
    await expect(waitForManifestEntry('pass', { manifest: { pass: entry }, sleep })).resolves.toBe(entry);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([null, { script: '../escape.mjs', intervalMs: 1000 }, { script: 'scripts/pass.mjs', intervalMs: 0 }])(
    'still refuses a malformed registered entry: %j', async (entry) => {
      const sleep = vi.fn();
      await expect(waitForManifestEntry('pass', { manifest: { pass: entry }, sleep })).rejects.toThrow();
      expect(sleep).not.toHaveBeenCalled();
    },
  );
});

describe('runPassDaemonLoop — the pure run/sleep control flow', () => {
  it('requires a runPass effect and a positive intervalMs', async () => {
    await expect(runPassDaemonLoop({ intervalMs: 1000 })).rejects.toThrow(/requires a runPass effect/);
    await expect(runPassDaemonLoop({ runPass: async () => ({}), intervalMs: 0 })).rejects.toThrow(/requires a positive intervalMs/);
    await expect(runPassDaemonLoop({ runPass: async () => ({}), intervalMs: -1 })).rejects.toThrow(/requires a positive intervalMs/);
  });

  it('runs, sleeps between runs, and stops at maxRuns', async () => {
    const sleep = vi.fn(async () => {});
    const runPass = vi.fn(async () => ({ code: 0 }));
    const out = await runPassDaemonLoop({ runPass, sleep, intervalMs: 5000, maxRuns: 3 });
    expect(runPass).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5000);
    expect(out).toEqual({ runs: 3, stoppedReason: 'max-runs' });
  });

  it('a failing/throwing run is isolated — onRunError fires, the loop continues', async () => {
    const onRunError = vi.fn();
    let n = 0;
    const runPass = vi.fn(async () => { n += 1; if (n === 1) throw new Error('spawn failed'); return { code: 0 }; });
    const out = await runPassDaemonLoop({ runPass, sleep: async () => {}, onRunError, maxRuns: 2, intervalMs: 1000 });
    expect(runPass).toHaveBeenCalledTimes(2);
    expect(onRunError).toHaveBeenCalledTimes(1);
    expect(onRunError.mock.calls[0][0].message).toBe('spawn failed');
    expect(out).toEqual({ runs: 2, stoppedReason: 'max-runs' });
  });

  it('checks isAlive AFTER each run, before sleeping — a lost lease stops immediately, no extra sleep or run', async () => {
    let calls = 0;
    const isAlive = vi.fn(() => { calls += 1; return calls < 2; }); // alive after run 1, lost after run 2
    const sleep = vi.fn(async () => {});
    const runPass = vi.fn(async () => ({ code: 0 }));
    const out = await runPassDaemonLoop({ runPass, sleep, isAlive, intervalMs: 1000, maxRuns: Infinity });
    expect(runPass).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1); // slept after run 1 only
    expect(out).toEqual({ runs: 2, stoppedReason: 'lease-lost' });
  });

  it('onRun observes every successful result, in order, with the right run index', async () => {
    const seen = [];
    const results = [{ code: 0 }, { code: 1 }];
    let i = 0;
    const runPass = async () => results[i++];
    await runPassDaemonLoop({ runPass, sleep: async () => {}, onRun: (r, run) => seen.push([run, r]), maxRuns: 2, intervalMs: 1000 });
    expect(seen).toEqual([[0, results[0]], [1, results[1]]]);
  });
});

describe('runPassDaemonLoop — refreshAuth (GitHub App token, xsdm0n7) runs before every spawn', () => {
  it('awaits refreshAuth before each runPass call, in order', async () => {
    const order = [];
    const refreshAuth = vi.fn(async () => { order.push('refresh'); });
    const runPass = vi.fn(async () => { order.push('run'); return { code: 0 }; });
    const out = await runPassDaemonLoop({ runPass, refreshAuth, sleep: async () => {}, intervalMs: 1000, maxRuns: 3 });
    expect(refreshAuth).toHaveBeenCalledTimes(3);
    expect(runPass).toHaveBeenCalledTimes(3);
    expect(order).toEqual(['refresh', 'run', 'refresh', 'run', 'refresh', 'run']);
    expect(out).toEqual({ runs: 3, stoppedReason: 'max-runs' });
  });

  it('a failed refresh never prevents the spawn — onRefreshError fires, runPass still runs', async () => {
    const onRefreshError = vi.fn();
    const refreshAuth = vi.fn(async () => { throw new Error('mint failed'); });
    const runPass = vi.fn(async () => ({ code: 0 }));
    const out = await runPassDaemonLoop({ runPass, refreshAuth, onRefreshError, sleep: async () => {}, intervalMs: 1000, maxRuns: 2 });
    expect(refreshAuth).toHaveBeenCalledTimes(2);
    expect(runPass).toHaveBeenCalledTimes(2);
    expect(onRefreshError).toHaveBeenCalledTimes(2);
    expect(onRefreshError.mock.calls[0][0].message).toBe('mint failed');
    expect(out).toEqual({ runs: 2, stoppedReason: 'max-runs' });
  });

  it('defaults refreshAuth to a no-op — existing callers with no App auth configured are unaffected', async () => {
    const runPass = vi.fn(async () => ({ code: 0 }));
    const out = await runPassDaemonLoop({ runPass, sleep: async () => {}, intervalMs: 1000, maxRuns: 1 });
    expect(runPass).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ runs: 1, stoppedReason: 'max-runs' });
  });
});

describe('passDaemonLeaseKey — one distinct key per pass name', () => {
  it('two different pass names never collide', () => {
    expect(passDaemonLeaseKey('branch-drift')).not.toBe(passDaemonLeaseKey('ci-queue-watch'));
  });
  it('the same pass name is always the same key (idempotent)', () => {
    expect(passDaemonLeaseKey('branch-drift')).toBe(passDaemonLeaseKey('branch-drift'));
  });
  it('never equals the Dispatcher default sentinel or #3870\'s own Fix-dispatch key', () => {
    expect(passDaemonLeaseKey('branch-drift')).not.toBe('<conveyor:runner-singleton-lease>');
    expect(passDaemonLeaseKey('branch-drift')).not.toBe('<conveyor:reconcile-fix-dispatch-daemon-lease>');
  });
});

describe('DEFAULT_HEARTBEAT_INTERVAL_MS — the independent-timer property this item exists for', () => {
  it('is meaningfully shorter than a realistic pass interval, so it can beat DURING a long single run', () => {
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBe(30_000);
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBeLessThan(120_000); // the runner's own tick cadence, for scale
  });
});

describe('passDaemonSelfSyncEnabled — xdpemd4, opt-in (unset = byte-identical, never self-syncs)', () => {
  it('unset entirely → disabled — today\'s "never update" behavior, unchanged', () => {
    expect(passDaemonSelfSyncEnabled({})).toBe(false);
  });
  it(`${PASS_DAEMON_SELF_SYNC_ENV}=1 → enabled (plain main-tracking self-sync)`, () => {
    expect(passDaemonSelfSyncEnabled({ [PASS_DAEMON_SELF_SYNC_ENV]: '1' })).toBe(true);
  });
  it('any other value of the plain flag → disabled (only the literal "1" opts in)', () => {
    expect(passDaemonSelfSyncEnabled({ [PASS_DAEMON_SELF_SYNC_ENV]: 'true' })).toBe(false);
    expect(passDaemonSelfSyncEnabled({ [PASS_DAEMON_SELF_SYNC_ENV]: '0' })).toBe(false);
  });
  it(`${DAEMON_SELF_SYNC_BRANCH_ENV} set (POC mode) ALSO enables self-sync — no second flag needed`, () => {
    expect(passDaemonSelfSyncEnabled({ [DAEMON_SELF_SYNC_BRANCH_ENV]: 'lane/daemon-poc' })).toBe(true);
  });
  it('a blank POC-branch env is treated as unset, same as daemon-self-sync.mjs itself does', () => {
    expect(passDaemonSelfSyncEnabled({ [DAEMON_SELF_SYNC_BRANCH_ENV]: '   ' })).toBe(false);
  });
});

describe('the self-sync wiring pattern main() uses — proven against the real withSelfSync', () => {
  // main() itself is IO shell (real child process, real lease, real timers) and is not unit-tested directly —
  // this proves the exact wiring shape it uses (`withSelfSync({ tickOnce: runPass }, { root, onRestart }).tickOnce`
  // as the loop's `runPass`) behaves correctly: restart-instead-of-run on new code, run-through otherwise.
  // #4044 Module E — the default path is now rebuild-driven (`daemon-rebuild.mjs#rebuildClone`); a fake
  // `rebuild`/`acquireRead`/`releaseRead`/`readState` keeps this a pure wiring proof, never touching real git
  // or `~/.claude/*` (that proof lives in daemon-rebuild.test.mjs and daemon-self-sync.test.mjs).
  const emptyState = () => ({
    adopted: null, rejected: null, inProgress: null, quarantine: null,
  });
  const okLock = () => ({ ok: true });

  it('when self-sync reports new code, the wrapped tickOnce restarts INSTEAD of running the pass', async () => {
    const runPass = vi.fn(async () => ({ code: 0 }));
    const onRestart = vi.fn(() => ({ code: null, signal: null, restarted: true }));
    const { tickOnce } = withSelfSync(
      { tickOnce: runPass },
      {
        root: '/x',
        onRestart,
        rebuild: async () => ({ moved: true, adopted: true, head: 'deadbeef' }),
        log: { error: vi.fn() },
      },
    );
    const result = await tickOnce();
    expect(runPass).not.toHaveBeenCalled();
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ code: null, signal: null, restarted: true });
  });

  it('up to date → the pass runs exactly as it would with self-sync disabled', async () => {
    const runPass = vi.fn(async () => ({ code: 0 }));
    const { tickOnce } = withSelfSync(
      { tickOnce: runPass },
      {
        root: '/x',
        onRestart: vi.fn(),
        rebuild: async () => ({ moved: false, reason: 'up-to-date' }),
        acquireRead: okLock,
        releaseRead: vi.fn(),
        readState: emptyState,
      },
    );
    await expect(tickOnce()).resolves.toEqual({ code: 0 });
    expect(runPass).toHaveBeenCalledTimes(1);
  });
});

describe('MAIN_ONLY_PASSES — #4044 Module E, merge-orphan-sweep never self-syncs onto an overlay', () => {
  it('contains exactly the landing passes', () => {
    expect([...MAIN_ONLY_PASSES]).toEqual(['merge-orphan-sweep']);
  });
  // A name that is not a DAEMON_MANIFEST key can never reach `MAIN_ONLY_PASSES.has(passName)` —
  // `resolveManifestEntry` throws first — so listing it would only look like a guarantee that isn't enforced.
  it('every entry is a real --pass= name (a DAEMON_MANIFEST key)', () => {
    for (const name of MAIN_ONLY_PASSES) expect(Object.keys(DAEMON_MANIFEST)).toContain(name);
  });
  it('an ordinary watcher pass is NOT main-only', () => {
    expect(MAIN_ONLY_PASSES.has('branch-drift')).toBe(false);
    expect(MAIN_ONLY_PASSES.has('lane-pool-health-watch-we')).toBe(false);
    for (const name of Object.keys(DAEMON_MANIFEST)) {
      if (name !== 'merge-orphan-sweep') expect(MAIN_ONLY_PASSES.has(name)).toBe(false);
    }
  });
});

describe('realSleep — regression, live-caught on the sibling #3870/#3876 daemons', () => {
  // Both sibling daemons built on this exact `realSleep` pattern died right after their first run/tick
  // instead of looping: `.unref()`-ing the timer told Node it was fine to exit before it fired, and nothing
  // else kept the event loop alive between runs. This file shipped the same bug (confirmed by direct read)
  // — never caught live only because DAEMON_MANIFEST is still empty, so nothing has run through it yet.
  it('realSleep\'s own timer is REF\'d — a resident daemon must not let Node exit before it fires', () => {
    const real = global.setTimeout;
    let captured;
    global.setTimeout = (fn, ms) => { captured = real(fn, ms); return captured; };
    try {
      realSleep(60_000); // never awaited — only the timer's own ref state is asserted, then cleared
      expect(captured.hasRef()).toBe(true); // FAILS if realSleep re-adds `.unref()`
    } finally {
      clearTimeout(captured);
      global.setTimeout = real;
    }
  });
});

// #gh-write-burst — the child env every spawned pass runs with. Before this, a spawned pass shared its calls.jsonl
// lines with every other pass on the box, distinguishable only by argv[1]'s basename (which every per-repo
// instance of the SAME script, e.g. parked-pr-conflict-watch-we vs -frontierui, shares) — this is what lets
// `main()` set GH_CALLER=<passName> so the sidecar log attributes precisely.
describe('spawnPassOnce — env passthrough to the child process (#gh-write-burst)', () => {
  let dir;
  let ports;
  beforeEach(() => {
    dir = mkdtempSync(join(process.env.TMPDIR, 'pass-env-'));
    ports = { store: createJobStore(join(dir, 'jobs')), readStart: () => 'fixture-start',
      // Synthetic children own no real process group; never probe host pids for them.
      probe: () => 'dead', reapGroup: () => true,
      policyOptions: { platform: null, env: {} } };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const fakeChild = () => {
    const emitter = new EventEmitter();
    emitter.pid = 7000;
    // A real ChildProcess emits 'close' once stdio is drained, right after 'exit'; spawnPassOnce finishes on 'close'.
    setImmediate(() => { emitter.emit('exit', 0, null); emitter.emit('close', 0, null); });
    return emitter;
  };

  it('times out a real hung child and confirms its process is gone', async () => {
    writeFileSync(join(dir, 'hang.mjs'), keepAliveScript({ maxLifetimeMs: 10_000 }));
    let pid;
    const lines = [];
    const result = await spawnPassOnce({ script: 'hang.mjs' }, {
      store: ports.store, root: dir, readStart: () => 'fixture-start',
      // The sandbox restricts ps; this fixture owns the fresh child and probes
      // its actual pid/group with signal 0 while using the real stopHandle.
      probe: () => {
        try { process.kill(pid, 0); return 'alive'; }
        catch (error) { return error.code === 'ESRCH' ? 'dead' : 'unknown'; }
      },
      reapGroup: () => {
        try { process.kill(-pid, 0); return false; }
        catch (error) { return error.code === 'ESRCH'; }
      },
      policyOptions: { platform: null, env: {}, tool: { timeoutMs: 100 } },
      spawnFn: (...args) => { const child = spawn(...args); pid = child.pid; return child; },
      log: line => lines.push(line),
    });
    expect(result).toEqual({ outcome: 'timeout' });
    expect(() => process.kill(pid, 0)).toThrow();
    expect(lines.filter(line => line.includes('task-timing'))).toHaveLength(1);
  });

  it('preserves a synchronous spawn failure as a pass result', async () => {
    const result = await spawnPassOnce({ script: 'scripts/x.mjs' }, {
      ...ports, root: dir, log: () => {},
      spawnFn: () => { throw new Error('fixture spawn refused'); },
    });
    expect(result).toEqual({ code: null, signal: null, spawnError: 'fixture spawn refused' });
    expect(ports.store.list().records[0].job.status).toBe('failed');
  });

  it('refuses oversized captured output with an operator-visible fallback', async () => {
    const result = await spawnPassOnce({ script: 'scripts/x.mjs', capture: true }, {
      ...ports, root: dir, log: () => {},
      spawnFn: () => {
        const child = new EventEmitter();
        child.pid = 7000;
        child.stdout = new EventEmitter();
        setImmediate(() => {
          child.stdout.emit('data', Buffer.alloc(32 * 1024 * 1024 + 1, 97));
          child.emit('exit', 0, null);
          child.emit('close', 0, null);
        });
        return child;
      },
    });
    expect(result.spawnError).toMatch(/exceeded 32 MiB; inspect pass output before retrying/);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(ports.store.list().records[0].job.status).toBe('failed');
  });

  it('defaults to process.env when no env override is given (unchanged for every existing caller)', async () => {
    const spawnFn = vi.fn(() => fakeChild());
    await spawnPassOnce({ script: 'scripts/x.mjs' }, { ...ports, root: '/repo', spawnFn });
    const [, , opts] = spawnFn.mock.calls.at(-1);
    expect(opts.env).toBe(process.env);
  });

  it('forwards an explicit env override unchanged — this is how GH_CALLER=<passName> reaches the child', async () => {
    const spawnFn = vi.fn(() => fakeChild());
    const env = { ...process.env, GH_CALLER: 'parked-pr-conflict-watch-we' };
    await spawnPassOnce({ script: 'scripts/x.mjs' }, { ...ports, root: '/repo', env, spawnFn });
    const [, , opts] = spawnFn.mock.calls.at(-1);
    expect(opts.env).toBe(env);
    expect(opts.env.GH_CALLER).toBe('parked-pr-conflict-watch-we');
  });
});

it('health responder uses its own existing lease key and stops after lease loss', async () => {
  expect(passDaemonLeaseKey('health-responder')).toBe('<conveyor:pass-daemon:health-responder-lease>');
  const runPass = vi.fn(async () => ({ code: 0 }));
  const sleep = vi.fn();
  const result = await runPassDaemonLoop({ runPass, sleep, isAlive: () => false, intervalMs: 60_000 });
  expect(result.stoppedReason).toBe('lease-lost'); expect(runPass).toHaveBeenCalledTimes(1); expect(sleep).not.toHaveBeenCalled();
});

it('two real processes contend on the responder runner-lock; losing owner cannot heartbeat or release', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { acquireRunnerLease, heartbeatRunnerLease, releaseRunnerLeaseIfOwned, makeOwner } = await import('../runner-lock.mjs');
  const root = mkdtempSync(join(tmpdir(), 'responder-lease-'));
  const key = passDaemonLeaseKey('health-responder'), owner = makeOwner('test-responder');
  try {
    expect(acquireRunnerLease(root, owner, { key }).ok).toBe(true);
    const url = new URL('../runner-lock.mjs', import.meta.url).href;
    const source = `import { acquireRunnerLease, makeOwner } from ${JSON.stringify(url)}; console.log(JSON.stringify(acquireRunnerLease(process.argv[1], makeOwner('competitor'), { key: process.argv[2] })));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, root, key], { encoding: 'utf8', timeout: 10_000 });
    expect(child.status).toBe(0); expect(JSON.parse(child.stdout).ok).toBe(false);
    expect(heartbeatRunnerLease(root, 'wrong-owner', { key })).toBe(false);
    expect(releaseRunnerLeaseIfOwned(root, 'wrong-owner', { key })).toBe(false);
    expect(heartbeatRunnerLease(root, owner, { key })).toBe(true);
    releaseRunnerLeaseIfOwned(root, owner, { key });
    expect(heartbeatRunnerLease(root, owner, { key })).toBe(false);
  } finally { releaseRunnerLeaseIfOwned(root, owner, { key }); rmSync(root, { recursive: true, force: true }); }
});

describe('who watches the watcher — consecutive failed runs raise an operator alert', () => {
  const run = (results, extra = {}) => {
    const alerts = [];
    let i = 0;
    return runPassDaemonLoop({
      runPass: async () => { const r = results[i]; i += 1; if (r instanceof Error) throw r; return r; },
      sleep: async () => {}, intervalMs: 1000, maxRuns: results.length,
      onConsecutiveFailures: (a) => alerts.push(a), ...extra,
    }).then(() => alerts);
  };
  it('alerts at the 2nd consecutive failure (OOM abort, watchdog kill, throw all count)', async () => {
    expect(await run([{ code: 1 }, { code: 3 }], { failureAlertAfter: 2 })).toHaveLength(1);
    expect(await run([{ code: null, signal: 'SIGABRT' }, new Error('boom')], { failureAlertAfter: 2 })).toHaveLength(1);
  });
  it('a success resets the streak, and a lone failure never alerts', async () => {
    expect(await run([{ code: 1 }, { code: 0 }, { code: 1 }], { failureAlertAfter: 2 })).toEqual([]);
  });
  it('does not alert every tick: next alert is 6 thresholds later', async () => {
    const alerts = await run(Array.from({ length: 8 }, () => ({ code: 1 })), { failureAlertAfter: 2 });
    expect(alerts.map((a) => a.count)).toEqual([2]);
  });
  it('is off by default (threshold 0) and the health-watch manifest entry opts in', async () => {
    expect(await run([{ code: 1 }, { code: 1 }, { code: 1 }])).toEqual([]);
    const { resolveFailureAlertAfter } = await import('../pass-daemon.mjs');
    const { DAEMON_MANIFEST } = await import('../daemon-manifest.mjs');
    expect(resolveFailureAlertAfter(DAEMON_MANIFEST['health-watch'], {})).toBe(2);
    expect(resolveFailureAlertAfter(DAEMON_MANIFEST['health-watch'], { WE_PASS_FAILURE_ALERT_AFTER: '5' })).toBe(5);
    expect(resolveFailureAlertAfter(DAEMON_MANIFEST['health-watch'], { WE_PASS_FAILURE_ALERT_AFTER: '0' })).toBe(0);
    expect(resolveFailureAlertAfter({}, {})).toBe(0);
  });
  it('alertConsecutiveFailures sends the desktop notification and logs', async () => {
    const { alertConsecutiveFailures } = await import('../pass-daemon.mjs');
    const sent = []; const lines = [];
    alertConsecutiveFailures('health-watch', 2, { code: 134 }, { notify: (n) => { sent.push(n); return { ok: true }; }, log: { error: (l) => lines.push(l) } });
    expect(sent[0].title).toMatch(/health-watch is failing/);
    expect(sent[0].body).toMatch(/2 runs in a row/);
    expect(lines[0]).toMatch(/ALERT/);
  });
});

describe('passEnvFor — the pass child env is read at spawn time (2026-10-09 personal-login leak)', () => {
  it('sees the gh shim PATH that refreshAuth put on the env AFTER the daemon started', () => {
    const env = { PATH: '/usr/bin' };
    const atStart = passEnvFor('lease-reaper', env); // BEFORE: the old code spawned every pass with this snapshot
    env.PATH = '/home/.claude/github-app-token/gh-shim.d/abc:/usr/bin'; // what per-owner refreshAuth does
    expect(atStart.PATH).toBe('/usr/bin');
    expect(passEnvFor('lease-reaper', env)).toEqual({ PATH: '/home/.claude/github-app-token/gh-shim.d/abc:/usr/bin', GH_CALLER: 'lease-reaper' });
  });

  it('main() builds the env per spawn, never once before the loop', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(fileURLToPath(new URL('../pass-daemon.mjs', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/const passEnv = \{ \.\.\.process\.env/);
    expect(src).toMatch(/env: passEnv\(\)/);
  });
});


describe('adopted pass daemon restart', () => {
  const setup = (overrides = {}) => {
    const gate = vi.fn(() => ({ restart: true, relevant: ['scripts/lib/shared.mjs'] }));
    const appendEvent = vi.fn(async () => true);
    const check = makePassRestartCheck({ root: '.', passName: 'health-watch', bootSha: 'boot',
      readHead: () => 'adopted', readState: () => ({ adopted: { head: 'adopted' } }),
      gate, appendEvent, log: { error: vi.fn() }, ...overrides });
    return { check, gate, appendEvent };
  };
  it.each([null, {}, { adopted: {} }, { adopted: { head: 'other' } }])(
    'no restart on missing, incomplete or mismatched adoption: %j', async (state) => {
      const { check, gate, appendEvent } = setup({ readState: () => state });
      expect(await check()).toBe(false);
      expect(gate).not.toHaveBeenCalled();
      expect(appendEvent).not.toHaveBeenCalled();
    });
  it.each([null, 'boot'])('no restart on unreadable or unchanged HEAD: %j', async (head) => {
    const { check, gate } = setup({ readHead: () => head });
    expect(await check()).toBe(false);
    expect(gate).not.toHaveBeenCalled();
  });
  it('no restart when adoption evidence is unreadable', async () => {
    const { check, gate } = setup({ readState: () => { throw new Error('unreadable'); } });
    expect(await check()).toBe(false);
    expect(gate).not.toHaveBeenCalled();
  });
  it.each(['no-imported-change', 'min-interval'])('honors the shared gate: %s', async (reason) => {
    const { check, appendEvent } = setup({ gate: () => ({ restart: false, reason }) });
    expect(await check()).toBe(false);
    expect(appendEvent).not.toHaveBeenCalled();
  });
  it('awaits writing pass-daemon-restarted with from/to/relevant before allowing restart', async () => {
    let finish;
    const written = new Promise((resolve) => { finish = resolve; });
    const appendEvent = vi.fn(() => written);
    const { check, gate } = setup({ appendEvent });
    let settled = false;
    const result = check().then((value) => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(gate).toHaveBeenCalledWith('adopted');
    expect(appendEvent).toHaveBeenCalledWith({ kind: 'pass-daemon-restarted',
      daemon: 'pass-daemon:health-watch', detail: { from: 'boot', to: 'adopted', relevant: ['scripts/lib/shared.mjs'] } });
    finish(true);
    expect(await result).toBe(true);
  });
  it('does not restart when the event write returns false and retries on the next run', async () => {
    const appendEvent = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { check, gate } = setup({ appendEvent });
    expect(await check()).toBe(false);
    expect(await check()).toBe(true);
    expect(appendEvent).toHaveBeenCalledTimes(2);
    expect(gate).toHaveBeenCalledTimes(2);
  });
  it.each(['other', 'boot', null, new Error('unreadable')])(
    'does not restart if HEAD changes or becomes unreadable during the event write: %s', async (nextHead) => {
      let head = 'adopted', finish;
      const written = new Promise((resolve) => { finish = resolve; });
      const readHead = vi.fn(() => {
        if (head instanceof Error) throw head;
        return head;
      });
      const appendEvent = vi.fn(() => written);
      const { check } = setup({ readHead, appendEvent });
      const result = check();
      expect(appendEvent).toHaveBeenCalledTimes(1);
      expect(readHead).toHaveBeenCalledTimes(1);
      head = nextHead;
      finish(true);
      expect(await result).toBe(false);
      expect(readHead).toHaveBeenCalledTimes(2);
      expect(readHead).toHaveBeenLastCalledWith({ root: '.' });
      head = 'adopted';
      expect(await check()).toBe(true);
    });
  it('checks after onRun and noteRun, then stops with restart', async () => {
    const order = [];
    const result = await runPassDaemonLoop({ intervalMs: 1, maxRuns: 1, sleep: vi.fn(),
      runPass: async () => ({ code: 1 }), onRun: () => order.push('onRun'),
      failureAlertAfter: 1, onConsecutiveFailures: () => order.push('noteRun'),
      shouldRestart: async () => { order.push('restart'); return true; } });
    expect(order).toEqual(['onRun', 'noteRun', 'restart']);
    expect(result.stoppedReason).toBe('restart');
  });
  it('tickWhileRunning never checks or stops until the in-flight run settles', async () => {
    let finishRun, finishSleep, reachedTick;
    const running = new Promise((resolve) => { finishRun = resolve; });
    const sleeping = new Promise((resolve) => { finishSleep = resolve; });
    const tick = new Promise((resolve) => { reachedTick = resolve; });
    const shouldRestart = vi.fn(async () => true), onRun = vi.fn();
    const runPass = vi.fn(() => running);
    let settled = false;
    const loop = runPassDaemonLoop({ runPass, shouldRestart, onRun, tickWhileRunning: true,
      intervalMs: 1, maxRuns: 2, sleep: () => { reachedTick(); return sleeping; } })
      .then((result) => { settled = true; return result; });
    await tick;
    expect(shouldRestart).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    finishSleep();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(shouldRestart).not.toHaveBeenCalled();
    finishRun({ code: 0 });
    expect((await loop).stoppedReason).toBe('restart');
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(shouldRestart).toHaveBeenCalledTimes(1);
    expect(runPass).toHaveBeenCalledTimes(1);
  });
});
