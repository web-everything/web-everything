// @vitest-environment node
/**
 * @file skills-src/conveyor/__tests__/pass-daemon.test.mjs
 * @description Unit proof of #3871's generic single-pass daemon — the pure loop only (no real child process,
 *   no real timer, no real lease): injected effects, mirroring #3870's own `runDaemonLoop` tests.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  runPassDaemonLoop, passDaemonLeaseKey, realSleep, DEFAULT_HEARTBEAT_INTERVAL_MS,
  PASS_DAEMON_SELF_SYNC_ENV, passDaemonSelfSyncEnabled, MAIN_ONLY_PASSES, spawnPassOnce,
  waitForManifestEntry,
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
  const fakeChild = () => {
    const emitter = new EventEmitter();
    // A real ChildProcess emits 'close' once stdio is drained, right after 'exit'; spawnPassOnce finishes on 'close'.
    setImmediate(() => { emitter.emit('exit', 0, null); emitter.emit('close', 0, null); });
    return emitter;
  };

  it('defaults to process.env when no env override is given (unchanged for every existing caller)', async () => {
    const spawnFn = vi.fn(() => fakeChild());
    await spawnPassOnce({ script: 'scripts/x.mjs' }, { root: '/repo', spawnFn });
    const [, , opts] = spawnFn.mock.calls.at(-1);
    expect(opts.env).toBe(process.env);
  });

  it('forwards an explicit env override unchanged — this is how GH_CALLER=<passName> reaches the child', async () => {
    const spawnFn = vi.fn(() => fakeChild());
    const env = { ...process.env, GH_CALLER: 'parked-pr-conflict-watch-we' };
    await spawnPassOnce({ script: 'scripts/x.mjs' }, { root: '/repo', env, spawnFn });
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
  const { mkdtempSync, rmSync } = await import('node:fs');
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
