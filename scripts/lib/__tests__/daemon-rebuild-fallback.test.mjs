/**
 * @file scripts/lib/__tests__/daemon-rebuild-fallback.test.mjs
 * @description x5wbsbc (epic #4075) — the operator's fallback ruling ("fallback on last working version rather
 *   than block delivery"), covering the parts of `../daemon-rebuild.mjs` that `daemon-rebuild.test.mjs` (the
 *   pre-existing suite) does not: {@link candidateSmokeEnv} (the live-clone-derived env the candidate smoke
 *   runs with), the plain-main fallback (a), the pinned-overlay hold (b), the smoke-harness-broken control (c),
 *   the per-clone candidate lock, and {@link failsSameChecks}. Same fixture conventions as
 *   `daemon-rebuild.test.mjs` (real temp git fixtures, injected `runSmoke` stubs) — the helpers below are
 *   copied from that file rather than imported, per this card's instructions.
 */
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync,
} from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  rebuildClone, readRebuildState, candidateSmokeEnv, rebuildStatePath,
  candidateWorktreePath, failsSameChecks, DISPATCH_CWD_ROOT_ENV,
} from '../daemon-rebuild.mjs';
import { addOverlay, readOverlays, removeOverlay } from '../daemon-overlays.mjs';
import { defaultPoolRoot } from '../lane-pool-paths.mjs';
import { DISPATCH_CWD_ENV } from '../../operations/dispatch-lane-io.mjs';

// Pre-dates daemonRebuild.skipUnrelated: these tests assert a smoke runs for non-code moves, so pin the knob off.
process.env.WE_DAEMON_REBUILD_SKIP_UNRELATED = '0';

// ── fixture helpers — copied from daemon-rebuild.test.mjs (never imported from it) ──────────────────────────

const tempDirs = [];

function mktemp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd, args) {
  return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
  });
}
function gitOk(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function makeAuthorClone(originDir) {
  const parent = mktemp('we-daemon-rebuild-fb-author-');
  const dir = join(parent, 'w');
  const r = spawnSync('git', ['clone', '-q', originDir, dir], {
    encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
  });
  if (r.status !== 0) throw new Error(`clone failed: ${r.stderr}`);
  return dir;
}

function pushBranch(originDir, ref, mutate, { base = 'origin/main' } = {}) {
  const dir = makeAuthorClone(originDir);
  gitOk(dir, ['fetch', '-q', 'origin']);
  gitOk(dir, ['checkout', '-q', '-B', ref, base]);
  mutate(dir);
  gitOk(dir, ['add', '-A']);
  gitOk(dir, ['commit', '-q', '-m', `overlay: ${ref}`]);
  gitOk(dir, ['push', '-q', 'origin', `HEAD:refs/heads/${ref}`]);
  return gitOk(dir, ['rev-parse', 'HEAD']).trim();
}

function advanceMain(originDir, mutate) {
  return pushBranch(originDir, 'main', mutate, { base: 'origin/main' });
}

function writeFile(dir, name, content) {
  const full = join(dir, name);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** Fresh {origin (bare), clone (working tree under test), env} fixture — same shape as daemon-rebuild.test.mjs,
 *  but with LANE_POOL_ROOT / WE_DISPATCH_CWD_ROOT explicitly ABSENT so candidateSmokeEnv's own derivation
 *  (never an ambient override from this process's real env) is what a test observes. */
function makeFixture() {
  const base = mktemp('we-daemon-rebuild-fb-fixture-');
  const originDir = join(base, 'origin.git');
  const cloneDir = join(base, 'clone');
  mkdirSync(cloneDir, { recursive: true });
  gitOk(base, ['init', '--bare', '-q', originDir]);
  gitOk(cloneDir, ['init', '-q', '-b', 'main']);
  writeFile(cloneDir, 'README.md', 'init\n');
  gitOk(cloneDir, ['add', '-A']);
  gitOk(cloneDir, ['commit', '-q', '-m', 'init']);
  gitOk(cloneDir, ['remote', 'add', 'origin', originDir]);
  gitOk(cloneDir, ['push', '-q', '-u', 'origin', 'main']);
  gitOk(cloneDir, ['fetch', '-q', 'origin']);

  const stateDir = mktemp('we-daemon-rebuild-fb-state-');
  const lockDir = mktemp('we-daemon-rebuild-fb-lock-');
  const overlayDir = mktemp('we-daemon-rebuild-fb-overlay-');
  const env = {
    ...process.env,
    WE_DAEMON_STATE_DIR: stateDir,
    WE_DAEMON_CLONE_LOCK_ROOT: lockDir,
    WE_DAEMON_OVERLAY_DIR: overlayDir,
  };
  delete env.LANE_POOL_ROOT;
  delete env[DISPATCH_CWD_ROOT_ENV];
  return {
    base, originDir, cloneDir, stateDir, lockDir, overlayDir, env,
  };
}

function passSmoke() {
  return vi.fn(async () => ({ verdict: 'pass', attempts: 1, smoke: { results: [] } }));
}

// x5wbsbc — a smoke that fails ONLY the candidate carrying `file` and passes every other tree (in particular the
// last-good control the rebuild smokes before calling a failure a code regression).
function failsWhenFile(file, result) {
  return vi.fn(async ({ root }) => (existsSync(join(root, file))
    ? result
    : { verdict: 'pass', attempts: 1, smoke: { results: [] } }));
}

const LOCK_OPTS = { waitMs: 2000, pollMs: 20 };

beforeEach(() => {
  tempDirs.length = 0;
});

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

// ── a. candidateSmokeEnv — pure ─────────────────────────────────────────────────────────────────────────────

describe('candidateSmokeEnv', () => {
  it('names the same env var as dispatch-lane-io.mjs#DISPATCH_CWD_ENV', () => {
    expect(DISPATCH_CWD_ROOT_ENV).toBe('WE_DISPATCH_CWD_ROOT');
    expect(DISPATCH_CWD_ROOT_ENV).toBe(DISPATCH_CWD_ENV);
  });

  it('LANE_POOL_ROOT resolves from the LIVE clone path, not any candidate path', () => {
    const out = candidateSmokeEnv({ root: '/x/ws/wev-review-daemon', env: {} });
    expect(out.LANE_POOL_ROOT).toBe('/x/ws/.lanes');
  });

  it('an explicit LANE_POOL_ROOT already in env wins over derivation', () => {
    const out = candidateSmokeEnv({ root: '/x/ws/wev-review-daemon', env: { LANE_POOL_ROOT: '/custom/pool' } });
    expect(out.LANE_POOL_ROOT).toBe('/custom/pool');
  });

  it('WE_DISPATCH_CWD_ROOT defaults to <workspace>/.operations/dispatch', () => {
    const out = candidateSmokeEnv({ root: '/x/ws/wev-review-daemon', env: {} });
    expect(out[DISPATCH_CWD_ROOT_ENV]).toBe('/x/ws/.operations/dispatch');
  });

  it('an explicit WE_DISPATCH_CWD_ROOT already in env is kept', () => {
    const out = candidateSmokeEnv({
      root: '/x/ws/wev-review-daemon', env: { [DISPATCH_CWD_ROOT_ENV]: '/explicit/dispatch/root' },
    });
    expect(out[DISPATCH_CWD_ROOT_ENV]).toBe('/explicit/dispatch/root');
  });

  it('fills PATH/HOME when missing from env', () => {
    const out = candidateSmokeEnv({ root: '/x/ws/wev-review-daemon', env: { PATH: '', HOME: '' } });
    expect(out.PATH).toBeTruthy();
    expect(out.HOME).toBeTruthy();
  });

  it('carries an already-present PATH/HOME through untouched', () => {
    const out = candidateSmokeEnv({
      root: '/x/ws/wev-review-daemon', env: { PATH: '/only/here', HOME: '/only/home' },
    });
    expect(out.PATH).toBe('/only/here');
    expect(out.HOME).toBe('/only/home');
  });
});

// ── b. rebuildClone passes candidateSmokeEnv to runSmoke ────────────────────────────────────────────────────

describe('rebuildClone passes candidateSmokeEnv to runSmoke', () => {
  it("runSmoke's env.LANE_POOL_ROOT is derived from the clone root, not the state-dir candidate path", async () => {
    const {
      originDir, cloneDir, env, stateDir,
    } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'z.txt', 'z\n'));

    const calls = [];
    const runSmoke = vi.fn(async (args) => {
      calls.push(args);
      return { verdict: 'pass', attempts: 1, smoke: { results: [] } };
    });
    const result = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.adopted).toBe(true);
    expect(calls).toHaveLength(1);
    const expectedPool = defaultPoolRoot(cloneDir, {});
    expect(calls[0].env.LANE_POOL_ROOT).toBe(expectedPool);
    // the wrong (bug-shaped) derivation: resolving the pool from the candidate worktree path under stateDir.
    const wrongPool = defaultPoolRoot(candidateWorktreePath(cloneDir, env), {});
    expect(calls[0].env.LANE_POOL_ROOT).not.toBe(wrongPool);
    expect(calls[0].env.LANE_POOL_ROOT.startsWith(stateDir)).toBe(false);
  });
});

// ── c. plain-main fallback (a bad NON-pinned overlay) ───────────────────────────────────────────────────────

describe('smokeAndAdopt fallback-plain-main (x5wbsbc)', () => {
  it('a bad NON-pinned overlay: falls back to plain main, adopts it, drops the overlay, alerts both kinds', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    const prevHead = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();
    // Advance main PAST prevHead first, so plain main is a genuinely different (newer) tree than what the clone
    // is already sitting on — otherwise falling back to "plain main" would be a no-op move (see the sibling
    // test below for that case) rather than exercising the real reset --hard this test is about.
    const mainSha = advanceMain(originDir, (dir) => writeFile(dir, 'main-moved.txt', 'y\n'));
    expect(mainSha).not.toBe(prevHead);
    pushBranch(originDir, 'lane/bad', (dir) => writeFile(dir, 'bad.txt', 'x\n'));
    addOverlay(cloneDir, { ref: 'lane/bad' }, { env });

    const runSmoke = failsWhenFile('bad.txt', {
      verdict: 'code', attempts: 1, smoke: { results: [{ ok: false, name: 'x', detail: 'boom' }] },
    });
    const result = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.reason).toBe('fallback-plain-main');
    expect(result.moved).toBe(true);
    expect(result.adopted).toBe(true);
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(mainSha);
    expect(readOverlays(cloneDir, { env })).toEqual([]);
    expect(result.alerts.some((a) => a.kind === 'fallback-plain-main')).toBe(true);
    expect(result.alerts.some((a) => a.kind === 'overlay-dropped-smoke-failed')).toBe(true);
    expect(readRebuildState(cloneDir, env).held).toBeNull();
    expect(runSmoke).toHaveBeenCalledTimes(2); // A (main+overlay, fails) then B (plain main, passes)
  });

  it('main did not move and the clone is already adopted at main: no second smoke needed', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    const mainSha = gitOk(cloneDir, ['rev-parse', 'origin/main']).trim();

    // First call: nothing to build (clone already at main) — adopts via the up-to-date short-circuit.
    const first = await rebuildClone({
      root: cloneDir, env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(first.reason).toBe('up-to-date');
    expect(readRebuildState(cloneDir, env).adopted?.head).toBe(mainSha);

    pushBranch(originDir, 'lane/bad2', (dir) => writeFile(dir, 'bad2.txt', 'x\n'));
    addOverlay(cloneDir, { ref: 'lane/bad2' }, { env });

    const runSmoke = failsWhenFile('bad2.txt', {
      verdict: 'code', attempts: 1, smoke: { results: [{ ok: false, name: 'x', detail: 'boom' }] },
    });
    const second = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(second.reason).toBe('fallback-plain-main');
    // Plain main IS the tree the clone is already sitting on (main never moved) — nothing to reset, but the
    // overlay is still adopted-away (see finalizeRebuild's own "already-adopted" branch).
    expect(second.moved).toBe(false);
    expect(second.adopted).toBe(true);
    expect(runSmoke).toHaveBeenCalledTimes(1); // only A — B is skipped (plain main == prevHead == adopted head)
    expect(readOverlays(cloneDir, { env })).toEqual([]);
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(mainSha);
  });
});

// ── c2. an ENVIRONMENT timeout never blames an overlay (live 2026-09-26 22:37Z) ─────────────────────────────

describe('smoke-env-timeout: a slow lane scan under load never makes an overlay a suspect', () => {
  it('the 22:37Z shape (clone adopted at main + one NON-pinned overlay): holds, keeps the overlay, records no rejection', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    const mainSha = gitOk(cloneDir, ['rev-parse', 'origin/main']).trim();
    expect((await rebuildClone({ root: cloneDir, env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS })).reason).toBe('up-to-date');
    pushBranch(originDir, 'lane/fix-review-label-exclusive', (dir) => writeFile(dir, 'overlay.txt', 'x\n'));
    addOverlay(cloneDir, { ref: 'lane/fix-review-label-exclusive', pr: 2773 }, { env });

    const detail = 'lane-pool list --acquirable failed: exited 1: ✗ list --acquirable scan exceeded its 120000ms budget at lane-47 (pool "web-everything" under /x) — refusing to return a partial/unsound answer.';
    // Every tree times out the same way — the host is overloaded (plain main would too).
    const runSmoke = vi.fn(async () => ({
      verdict: 'env-timeout',
      attempts: 2,
      smoke: { results: [{ ok: false, name: 'lane-pool-list', ms: 300900, mayBeTransient: false, detail }] },
      envTimeout: { first: [], budgetFactor: 2.5, loadAvg: [25.2, 25.8, 26.3] },
    }));
    const result = await rebuildClone({ root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS });

    expect(result.reason).toBe('smoke-env-timeout');
    expect(result.moved).toBe(false);
    const kinds = result.alerts.map((a) => a.kind);
    expect(kinds).toContain('smoke-env-timeout');
    expect(kinds).not.toContain('smoke-rejected');
    expect(kinds).not.toContain('fallback-plain-main');
    expect(kinds).not.toContain('overlay-dropped-smoke-failed');
    expect(result.alerts.find((a) => a.kind === 'smoke-env-timeout').detail).toMatchObject({ failed: 'lane-pool-list', loadAvg: [25.2, 25.8, 26.3] });
    expect(readOverlays(cloneDir, { env }).map((o) => o.ref)).toEqual(['lane/fix-review-label-exclusive']);
    const state = readRebuildState(cloneDir, env);
    expect(state.rejected).toBeNull();
    expect(state.held?.reason).toBe('smoke-env-timeout');
    expect(runSmoke).toHaveBeenCalledTimes(1); // no plain-main, no last-good control
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(mainSha);
  });
});

// ── d. pinned overlay + bad candidate + passing last-good control ──────────────────────────────────────────

describe('pinned overlay stays held on smoke-rejected when the last-good control passes', () => {
  it('holds the clone on last-good, records state.held, alerts daemon-held-on-last-good', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/pinned-bad', (dir) => writeFile(dir, 'pinned-bad.txt', 'x\n'));
    addOverlay(cloneDir, { ref: 'lane/pinned-bad', pinned: true }, { env });
    const prevHead = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();

    const runSmoke = failsWhenFile('pinned-bad.txt', {
      verdict: 'code', attempts: 1, smoke: { results: [{ ok: false, name: 'x', detail: 'boom' }] },
    });
    const result = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.reason).toBe('smoke-rejected');
    expect(result.moved).toBe(false);
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(prevHead); // HEAD unchanged
    const state = readRebuildState(cloneDir, env);
    expect(state.held?.reason).toBe('smoke-rejected');
    expect(state.held?.lastGood).toBe(prevHead);
    expect(result.alerts.some((a) => a.kind === 'daemon-held-on-last-good')).toBe(true);
    // A (candidate) + C (last-good control) — no B: the overlay is pinned, so the plain-main fallback never runs.
    expect(runSmoke).toHaveBeenCalledTimes(2);
  });
});

// ── e. smoke-harness-broken (the control fails identically) ────────────────────────────────────────────────

describe('smoke-harness-broken (x5wbsbc)', () => {
  it('rejects as smoke-harness-broken when the last-good control fails the same check, backs off, then retries', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    env.WE_DAEMON_HARNESS_BROKEN_ADOPT_NOT_WORSE = '0';
    pushBranch(originDir, 'lane/harness', (dir) => writeFile(dir, 'harness.txt', 'x\n'));
    addOverlay(cloneDir, { ref: 'lane/harness', pinned: true }, { env }); // pinned: skip the plain-main fallback

    let t = 1_000_000;
    const runSmoke = vi.fn(async () => ({
      verdict: 'code', attempts: 1, smoke: { results: [{ ok: false, name: 'harness-check', detail: 'boom' }] },
    }));

    const first = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS, now: () => t,
    });
    expect(first.reason).toBe('smoke-harness-broken');
    const state1 = readRebuildState(cloneDir, env);
    expect(state1.rejected?.harnessBroken).toBe(true);
    expect(state1.rejected?.retryAt).toBeTruthy();
    expect(state1.held?.reason).toBe('smoke-harness-broken');
    const callsAfterFirst = runSmoke.mock.calls.length;
    expect(callsAfterFirst).toBe(2); // A + C, no B (pinned)

    // New inputs (main moves again) — the backoff still applies even to a brand-new plan.
    advanceMain(originDir, (dir) => writeFile(dir, 'harness-main.txt', 'y\n'));
    const second = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS, now: () => t,
    });
    expect(second.reason).toBe('smoke-harness-broken-backoff');
    const state2 = readRebuildState(cloneDir, env);
    expect(second.plan.inputsKey).not.toBe(state2.rejected.inputsKey);
    const stale = second.alerts.find((a) => a.kind === 'clone-held-stale').detail;
    expect(stale.retryAt).not.toBeNull();
    expect(stale.retryAt).toBe(state2.rejected.retryAt);
    expect(stale.attempts).toBe(state2.rejected.attempts);
    expect(stale.broken).toEqual({ failed: 'harness-check', detail: 'boom' });
    expect(runSmoke.mock.calls.length).toBe(callsAfterFirst); // not called again

    t += 24 * 60 * 60_000; // comfortably past the default retry backoff (minutes, not hours)
    const third = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS, now: () => t,
    });
    expect(runSmoke.mock.calls.length).toBeGreaterThan(callsAfterFirst); // smoked again
    expect(third.reason).toBe('smoke-harness-broken');
    // The backoff GROWS on a repeat (attempts 2 => 2x the base delay), never pinned at the base delay.
    const state3 = readRebuildState(cloneDir, env);
    expect(state3.rejected.attempts).toBe(2);
    expect(Date.parse(state3.rejected.retryAt)).toBe(t + 2 * 5 * 60_000);
  });

  it('adopts a pinned candidate by default when the last-good control fails the same cross-org check', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    delete env.WE_DAEMON_HARNESS_BROKEN_ADOPT_NOT_WORSE;
    pushBranch(originDir, 'lane/harness-fix', (dir) => writeFile(dir, 'harness-fix.txt', 'fix\n'));
    addOverlay(cloneDir, { ref: 'lane/harness-fix', pinned: true }, { env });
    const prevHead = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();
    const runSmoke = vi.fn(async () => ({
      verdict: 'code', attempts: 1,
      smoke: { results: [{ ok: false, name: 'reconcile-dry-run', detail: 'gh pr list --repo frontier-ui/frontierui: Command failed (cross-org auth)' }] },
    }));

    const result = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.adopted).toBe(true);
    expect(result.reason).toBe('harness-broken-adopted-not-worse');
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(result.plan.finalSha);
    expect(result.plan.finalSha).not.toBe(prevHead);
    expect(result.alerts.find((a) => a.kind === 'smoke-harness-broken-adopted-not-worse')?.detail).toMatchObject({
      failed: 'reconcile-dry-run', alsoFailedOn: ['last-good'], message: expect.any(String),
    });
    expect(readRebuildState(cloneDir, env).held).toBeNull();
    expect(runSmoke).toHaveBeenCalledTimes(2);
  });

  it('rejects a candidate failing x and y when the last-good control fails only x', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    delete env.WE_DAEMON_HARNESS_BROKEN_ADOPT_NOT_WORSE;
    pushBranch(originDir, 'lane/worse', (dir) => writeFile(dir, 'worse.txt', 'bad\n'));
    addOverlay(cloneDir, { ref: 'lane/worse', pinned: true }, { env });
    const prevHead = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();
    const runSmoke = vi.fn(async ({ root }) => ({
      verdict: 'code', attempts: 1,
      smoke: { results: [
        { ok: false, name: 'x', detail: 'shared failure' },
        { ok: !existsSync(join(root, 'worse.txt')), name: 'y', detail: 'candidate regression' },
      ] },
    }));

    const result = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.adopted).not.toBe(true);
    expect(result.reason).toBe('smoke-rejected');
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(prevHead);
    expect(result.alerts.some((a) => a.kind === 'smoke-harness-broken-adopted-not-worse')).toBe(false);
    expect(readRebuildState(cloneDir, env).held?.reason).toBe('smoke-rejected');
    expect(runSmoke).toHaveBeenCalledTimes(2);
  });

});

// ── f. single flight — #2731's build lease covers the WHOLE fallback (A, B, C), not just the first smoke ──────

describe('single-flight build lease across the fallback (x5wbsbc on #2731)', () => {
  const writeBuilding = (cloneDir, env, building) => {
    const file = rebuildStatePath(cloneDir, env);
    mkdirSync(dirname(file), { recursive: true });
    const cur = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    writeFileSync(file, JSON.stringify({ ...cur, building }));
  };

  it('a live sibling lease returns rebuild-in-progress without smoking', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'lock1.txt', 'x\n'));
    writeBuilding(cloneDir, env, {
      token: 'sib', pid: process.ppid, host: hostname(), startedAt: new Date().toISOString(), path: '/nonexistent',
    });
    const runSmoke = passSmoke();
    const result = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(result.reason).toBe('rebuild-in-progress');
    expect(runSmoke).not.toHaveBeenCalled();
  });

  it('a dead-pid lease is taken over and the build adopts', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'lock2.txt', 'x\n'));
    writeBuilding(cloneDir, env, {
      token: 'dead', pid: 999999, host: hostname(), startedAt: new Date().toISOString(), path: '/nonexistent',
    });
    const runSmoke = passSmoke();
    const result = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(result.adopted).toBe(true);
    expect(runSmoke).toHaveBeenCalledTimes(1);
    expect(readRebuildState(cloneDir, env).building).toBeNull();
  });

  it('the lease stays held through the plain-main and last-good smokes, and is released at the end', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/lease-bad', (dir) => writeFile(dir, 'lease-bad.txt', 'x\n'));
    addOverlay(cloneDir, { ref: 'lane/lease-bad', pinned: true }, { env });
    const heldDuring = [];
    const runSmoke = vi.fn(async ({ root }) => {
      heldDuring.push(!!readRebuildState(cloneDir, env).building);
      return existsSync(join(root, 'lease-bad.txt'))
        ? { verdict: 'code', attempts: 1, smoke: { results: [{ ok: false, name: 'x', detail: 'boom' }] } }
        : { verdict: 'pass', attempts: 1, smoke: { results: [] } };
    });
    const result = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(result.reason).toBe('smoke-rejected');
    expect(heldDuring).toEqual([true, true]); // candidate + last-good control, both under the lease
    expect(readRebuildState(cloneDir, env).building).toBeNull();
  });
});

// ── g. adoption after a hold clears state.held ──────────────────────────────────────────────────────────────

describe('an adoption after a hold clears state.held', () => {
  it('clears state.held once a later rebuild actually adopts', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/heldbad', (dir) => writeFile(dir, 'heldbad.txt', 'x\n'));
    addOverlay(cloneDir, { ref: 'lane/heldbad', pinned: true }, { env });

    const failing = failsWhenFile('heldbad.txt', {
      verdict: 'code', attempts: 1, smoke: { results: [{ ok: false, name: 'x', detail: 'boom' }] },
    });
    const held = await rebuildClone({
      root: cloneDir, env, runSmoke: failing, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(held.reason).toBe('smoke-rejected');
    expect(readRebuildState(cloneDir, env).held).not.toBeNull();

    // Simulate the fix that would let a later tick adopt: drop the bad overlay and move main again.
    removeOverlay(cloneDir, 'lane/heldbad', { env });
    advanceMain(originDir, (dir) => writeFile(dir, 'fixed.txt', 'y\n'));

    const adopted = await rebuildClone({
      root: cloneDir, env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(adopted.moved).toBe(true);
    expect(adopted.adopted).toBe(true);
    expect(readRebuildState(cloneDir, env).held).toBeNull();
  });
});

// ── h. failsSameChecks — pure ────────────────────────────────────────────────────────────────────────────────

describe('failsSameChecks', () => {
  it('true when the control fails every check the candidate failed', () => {
    const candidate = [{ name: 'a' }, { name: 'b' }];
    const control = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    expect(failsSameChecks(candidate, control)).toBe(true);
  });

  it('false when the control is missing one of the candidate\'s failed checks', () => {
    const candidate = [{ name: 'a' }, { name: 'b' }];
    const control = [{ name: 'a' }];
    expect(failsSameChecks(candidate, control)).toBe(false);
  });

  it('false when the control fails a disjoint set of checks', () => {
    expect(failsSameChecks([{ name: 'a' }], [{ name: 'b' }])).toBe(false);
  });

  it('false when the candidate has no failures at all (nothing to compare)', () => {
    expect(failsSameChecks([], [{ name: 'a' }])).toBe(false);
  });

  it('false when the control is empty/absent, whatever the candidate failed', () => {
    expect(failsSameChecks([{ name: 'a' }], [])).toBe(false);
    expect(failsSameChecks([{ name: 'a' }], null)).toBe(false);
    expect(failsSameChecks([{ name: 'a' }], undefined)).toBe(false);
  });
});

// ── h. a LOAD-shaped smoke failure blames an overlay only through a same-run differential (live 2026-10-04) ──
// Live 16:02Z / 16:26Z, wev-control: A (main + PR #3903) failed `lane-acquire-release` (lane-pool's own "lock
// contention" refusal) and `dispatch-dry-run` ("timed out after 45000ms"). Plain main smoked minutes later, once
// the contention cleared, and passed — so the healthy overlay was dropped, twice. Plain main fails the same two
// checks under the same load.

const CONTENTION = 'lane-pool acquire --purpose=smoke failed: exited 1: ✗ no lane within 30000ms in pool "web-everything" — a different acquire\'s shared acquirability scan was still running when this call\'s --wait-ms elapsed (lock contention); this is NOT necessarily because all 90 lane(s) are held/dirty — retry, or raise --wait-ms';
const DISPATCH_TIMEOUT = 'dispatch dry-run child failed: timed out after 45000ms (process group killed)';
const loadFail = () => ({
  verdict: 'code',
  attempts: 1,
  smoke: {
    results: [
      { ok: false, name: 'lane-acquire-release', ms: 31_000, mayBeTransient: false, detail: CONTENTION },
      { ok: false, name: 'dispatch-dry-run', ms: 45_100, mayBeTransient: false, detail: DISPATCH_TIMEOUT },
    ],
  },
});
const PASS = () => ({ verdict: 'pass', attempts: 1, smoke: { results: [] } });

async function loadFixture(ref = 'lane/verify-pool-scan-non-dir', pr = 3903) {
  const fx = makeFixture();
  // Main moves past the clone, so plain main is a real (newer) build, as live.
  const mainSha = advanceMain(fx.originDir, (dir) => writeFile(dir, 'main-moved.txt', 'y\n'));
  pushBranch(fx.originDir, ref, (dir) => writeFile(dir, 'overlay.txt', 'x\n'));
  addOverlay(fx.cloneDir, { ref, pr }, { env: fx.env });
  return { ...fx, mainSha, ref };
}

describe('load-shaped smoke failure: an overlay is blamed only by a same-run differential', () => {
  it('A fails under load, plain main passes, A re-smoked passes: adopts A and KEEPS the overlay', async () => {
    const { cloneDir, env, ref } = await loadFixture();
    let aCalls = 0;
    const runSmoke = vi.fn(async ({ root }) => {
      if (!existsSync(join(root, 'overlay.txt'))) return PASS();
      aCalls += 1;
      return aCalls === 1 ? loadFail() : PASS();
    });
    const result = await rebuildClone({ root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS });

    expect(result.adopted).toBe(true);
    expect(existsSync(join(cloneDir, 'overlay.txt'))).toBe(true);
    expect(readOverlays(cloneDir, { env }).map((o) => o.ref)).toEqual([ref]);
    const kinds = result.alerts.map((a) => a.kind);
    expect(kinds).not.toContain('overlay-dropped-smoke-failed');
    expect(kinds).toContain('smoke-load-confirm-passed');
    expect(runSmoke).toHaveBeenCalledTimes(3); // A, B (plain main), A again
  });

  it('A fails under load twice while plain main passes: environment — adopts plain main, keeps the overlay, backs off A', async () => {
    const { cloneDir, env, ref, mainSha } = await loadFixture();
    const t = 5_000_000;
    const runSmoke = vi.fn(async ({ root }) => (existsSync(join(root, 'overlay.txt')) ? loadFail() : PASS()));
    const result = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS, now: () => t,
    });

    expect(result.reason).toBe('smoke-env-load');
    expect(result.adopted).toBe(true);
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(mainSha); // clone is current on main
    expect(readOverlays(cloneDir, { env }).map((o) => o.ref)).toEqual([ref]);
    expect(result.alerts.map((a) => a.kind)).not.toContain('overlay-dropped-smoke-failed');
    const st = readRebuildState(cloneDir, env);
    expect(st.rejected).toMatchObject({ envLoad: true, attempts: 1 });
    expect(Date.parse(st.rejected.retryAt)).toBe(t + 5 * 60_000);

    // Inside the backoff the same inputs are not re-smoked.
    const again = await rebuildClone({ root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS, now: () => t + 1000 });
    expect(again.reason).toBe('still-rejected');
    expect(runSmoke).toHaveBeenCalledTimes(3);
  });

  it('A and plain main both fail under load: environment hold with backoff — no last-good control, no harness-broken, overlay kept', async () => {
    const { cloneDir, env, ref } = await loadFixture();
    const runSmoke = vi.fn(async () => loadFail());
    const result = await rebuildClone({ root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS });

    expect(result.reason).toBe('smoke-env-load');
    expect(result.moved).toBe(false);
    expect(readOverlays(cloneDir, { env }).map((o) => o.ref)).toEqual([ref]);
    const st = readRebuildState(cloneDir, env);
    expect(st.held?.reason).toBe('smoke-env-load');
    expect(st.rejected).toMatchObject({ envLoad: true });
    expect(st.rejected.harnessBroken).toBeUndefined();
    expect(runSmoke).toHaveBeenCalledTimes(2); // A + B only
  });

  it('a load-shaped A failure never takes the "plain main is already running" no-smoke shortcut', async () => {
    const fx = makeFixture();
    expect((await rebuildClone({ root: fx.cloneDir, env: fx.env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS })).reason).toBe('up-to-date');
    pushBranch(fx.originDir, 'lane/x', (dir) => writeFile(dir, 'overlay.txt', 'x\n'));
    addOverlay(fx.cloneDir, { ref: 'lane/x', pr: 1 }, { env: fx.env });
    let aCalls = 0;
    const runSmoke = vi.fn(async ({ root }) => {
      if (!existsSync(join(root, 'overlay.txt'))) return PASS();
      aCalls += 1;
      return aCalls === 1 ? loadFail() : PASS();
    });
    const result = await rebuildClone({ root: fx.cloneDir, env: fx.env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS });
    expect(result.adopted).toBe(true);
    expect(readOverlays(fx.cloneDir, { env: fx.env }).map((o) => o.ref)).toEqual(['lane/x']);
    expect(runSmoke).toHaveBeenCalledTimes(3);
  });

  it('A re-smoke reproduces a CODE-shaped failure on the same check while plain main passed: the overlay is dropped', async () => {
    const { cloneDir, env } = await loadFixture();
    let aCalls = 0;
    const runSmoke = vi.fn(async ({ root }) => {
      if (!existsSync(join(root, 'overlay.txt'))) return PASS();
      aCalls += 1;
      return aCalls === 1 ? loadFail() : {
        verdict: 'code', attempts: 1, smoke: { results: [{ ok: false, name: 'dispatch-dry-run', ms: 900, mayBeTransient: false, detail: 'dispatch dry-run failed (1/3): review: Cannot find module x' }] },
      };
    });
    const result = await rebuildClone({ root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS });
    expect(result.reason).toBe('fallback-plain-main');
    expect(readOverlays(cloneDir, { env })).toEqual([]);
    expect(result.alerts.map((a) => a.kind)).toContain('overlay-dropped-smoke-failed');
  });

  it('knob WE_DAEMON_SMOKE_LOAD_DIFFERENTIAL=0 restores the single plain-main comparison', async () => {
    const { cloneDir, env } = await loadFixture();
    const runSmoke = vi.fn(async ({ root }) => (existsSync(join(root, 'overlay.txt')) ? loadFail() : PASS()));
    const result = await rebuildClone({
      root: cloneDir, env: { ...env, WE_DAEMON_SMOKE_LOAD_DIFFERENTIAL: '0' }, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(result.reason).toBe('fallback-plain-main');
    expect(runSmoke).toHaveBeenCalledTimes(2);
  });
});
