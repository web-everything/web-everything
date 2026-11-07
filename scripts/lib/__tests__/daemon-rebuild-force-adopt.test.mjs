/** @file R508 force-adopt wiring through the real rebuildClone: smoke still runs, adopts over a failed smoke only with a
 *  ruling+quote, logs, and the watch reverts to last-good. Fixture helpers are copied from the fallback suite. */
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, chmodSync,
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
import { requestForceAdopt, readForceWatch, runForceWatchTick, readForceAdopt, recordForcedAdoption, forceBlockedReason } from '../daemon-force-adopt.mjs';
import { readReadyCandidate, alertsFilePath } from '../daemon-rebuild/state.mjs';
import { cloneKeyOf } from '../daemon-last-good.mjs';
import { gitRun } from '../main-staleness.mjs';
import { withWriteLock } from '../daemon-clone-lock.mjs';
// Pre-dates daemonRebuild.skipUnrelated: these tests assert a smoke runs for non-code moves, so pin the knob off.
process.env.WE_DAEMON_REBUILD_SKIP_UNRELATED = '0';

// Same precedent as daemon-rebuild.test.mjs:43. Every case here drives real `git` through rebuildClone (about 40 git
// calls per rebuild: worktree add/remove/prune/list, rev-parse, merge-base), measured at 2-4s per case at load ~30 and
// 7-12s at load ~70, so the 5s default timed out on a loaded CI shard (main red @ 4535653df). Cached fixtures and
// splitting the slowest case did not help (rebuildClone itself is the cost). 60s stays a hang guard.
vi.setConfig({ testTimeout: 60_000 });

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

const LOCK_OPTS = { waitMs: 2000, pollMs: 20 };

beforeEach(() => {
  tempDirs.length = 0;
});

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});


const RULINGS = '## R508 — x\nOperator "Yes": adopt the build even though smoke failed for infra.\n';
const QUOTE = 'adopt the build even though smoke failed for infra';
const failing = () => vi.fn(async () => ({ verdict: 'code', attempts: 1, smoke: { results: [{ ok: false, name: 'daemon-entries-boot', detail: 'boom', mayBeTransient: false }] } }));
const headOf = (dir) => gitOk(dir, ['rev-parse', 'HEAD']).trim();
const forceEnv = (env, base) => ({ ...env, WE_FORCE_ADOPT_HANDOFF: join(base, 'handoff.md'), WE_FORCE_ADOPT_CORONER: join(base, 'coroner.jsonl'), WE_DAEMON_EVENTS: join(base, 'events.jsonl') });

describe('R508 force-adopt through rebuildClone', () => {
  it('without a force request a failed smoke still holds on last-good (unchanged)', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    env.WE_DAEMON_HARNESS_BROKEN_ADOPT_NOT_WORSE = '0';
    const before = headOf(cloneDir);
    advanceMain(originDir, (dir) => writeFile(dir, 'm.txt', 'x\n'));
    const r = await rebuildClone({ root: cloneDir, env, runSmoke: failing(), prState: async () => null, lockOpts: LOCK_OPTS });
    expect(r.moved).not.toBe(true);
    expect(headOf(cloneDir)).toBe(before);
  });

  it('does not adopt when an audit sink cannot be written (events path unwritable)', async () => {
    const { base, originDir, cloneDir, env: env0 } = makeFixture();
    writeFileSync(join(base, 'blocker'), 'x');
    const env = { ...forceEnv(env0, base), WE_DAEMON_EVENTS: join(base, 'blocker', 'events.jsonl'), WE_DAEMON_HARNESS_BROKEN_ADOPT_NOT_WORSE: '0' };
    const lastGood = headOf(cloneDir);
    const target = advanceMain(originDir, (dir) => writeFile(dir, 'm.txt', 'x\n')); // no overlays: the plan's finalSha is main's tip
    requestForceAdopt({ root: cloneDir, env, daemon: 'review', ruling: 'R508', quote: QUOTE, sha: target, rulingsText: RULINGS });
    const r = await rebuildClone({ root: cloneDir, env, runSmoke: failing(), prState: async () => null, lockOpts: LOCK_OPTS });
    expect(r.moved).not.toBe(true);
    expect(headOf(cloneDir)).toBe(lastGood);
    expect(readForceWatch(cloneDir, env)).toBeNull();
  });

  it('does not adopt when the coroner sink cannot be written, retracts the log, and leaves no adoptable ready candidate', async () => {
    const { base, originDir, cloneDir, env: env0 } = makeFixture();
    writeFileSync(join(base, 'blocker'), 'x');
    const env = { ...forceEnv(env0, base), WE_FORCE_ADOPT_CORONER: join(base, 'blocker', 'coroner.jsonl'), WE_DAEMON_HARNESS_BROKEN_ADOPT_NOT_WORSE: '0' };
    const lastGood = headOf(cloneDir);
    const target = advanceMain(originDir, (dir) => writeFile(dir, 'm.txt', 'x\n')); // no overlays: the plan's finalSha is main's tip
    requestForceAdopt({ root: cloneDir, env, daemon: 'review', ruling: 'R508', quote: QUOTE, sha: target, rulingsText: RULINGS });
    const r = await rebuildClone({ root: cloneDir, env, runSmoke: failing(), prState: async () => null, lockOpts: LOCK_OPTS });
    expect(r.moved).not.toBe(true);
    expect(r.reason).toBe('force-adopt-refused');
    expect(headOf(cloneDir)).toBe(lastGood);
    expect(readForceWatch(cloneDir, env)).toBeNull();
    expect(readReadyCandidate(cloneDir, env)).toBeNull();
    expect(readForceAdopt(cloneDir, env)).toBeNull(); // consumed, so the next tick does not re-log "adopting"
    expect(readFileSync(env.WE_FORCE_ADOPT_HANDOFF, 'utf8')).toMatch(/NOT adopted[^\n]*audit-sink-failed/);
  });

  it('the default health probe fails closed: a clone whose entry module cannot load is rolled back', async () => {
    const { base, originDir, cloneDir, env: env0 } = makeFixture();
    const env = forceEnv(env0, base);
    const lastGood = headOf(cloneDir);
    const target = advanceMain(originDir, (dir) => writeFile(dir, 'm.txt', 'x\n')); // no overlays: the plan's finalSha is main's tip
    requestForceAdopt({ root: cloneDir, env, daemon: 'review', ruling: 'R508', quote: QUOTE, sha: target, rulingsText: RULINGS });
    // No forceWatchProbe injected: the fixture clone has no scripts/lib/daemon-rebuild.mjs, so the default probe (a fresh import of the
    // entry module) is unhealthy. It runs on the ADOPTION tick itself, while the running process still has the old code: a build that
    // cannot import is reverted before the restart onto it, never left installed waiting for a watcher that can no longer start.
    await rebuildClone({ root: cloneDir, env, runSmoke: failing(), prState: async () => null, lockOpts: LOCK_OPTS });
    expect(headOf(cloneDir)).toBe(lastGood);
    expect(readForceWatch(cloneDir, env)).toBeNull();
    expect(readFileSync(env.WE_DAEMON_EVENTS, 'utf8')).toMatch(/force-adopt-rolled-back/);
    expect(handoffOf(env)).toMatch(/ROLLED BACK [0-9a-f]{40} -> [0-9a-f]{40} \(health-failed\)/);
  });

  it('a request for build X never force-adopts build Y: Y gets the normal failed-smoke ladder and the request stays pending', async () => {
    const run = async (withRequest) => {
      const { base, originDir, cloneDir, env: env0 } = makeFixture();
      const env = { ...forceEnv(env0, base), WE_DAEMON_HARNESS_BROKEN_ADOPT_NOT_WORSE: '0' };
      const lastGood = headOf(cloneDir);
      const other = advanceMain(originDir, (dir) => writeFile(dir, 'm.txt', 'x\n'));
      const wrong = other.replace(/.$/, other.endsWith('0') ? '1' : '0'); // a different, well-formed sha
      if (withRequest) expect(requestForceAdopt({ root: cloneDir, env, daemon: 'review', ruling: 'R508', quote: QUOTE, sha: wrong, rulingsText: RULINGS }).ok).toBe(true);
      const r = await rebuildClone({ root: cloneDir, env, runSmoke: failing(), prState: async () => null, lockOpts: LOCK_OPTS });
      return { r, env, cloneDir, lastGood, wrong, state: readRebuildState(cloneDir, env) };
    };
    const plain = await run(false);
    const forced = await run(true);
    expect(forced.r.reason).not.toBe('force-adopt-refused');
    expect(forced.r.reason).toBe(plain.r.reason); // identical outcome to a clone with no request pending
    expect(forced.state.rejected?.reason).toBe(plain.state.rejected?.reason); // the sticky rejection is recorded, so Y is not re-smoked every tick
    expect(forced.state.rejected).toBeTruthy();
    expect(headOf(forced.cloneDir)).toBe(forced.lastGood);
    expect(readForceWatch(forced.cloneDir, forced.env)).toBeNull();
    expect(readReadyCandidate(forced.cloneDir, forced.env)).toBeNull();
    expect(existsSync(forced.env.WE_FORCE_ADOPT_HANDOFF)).toBe(false); // nothing was logged as an adoption
    expect(readForceAdopt(forced.cloneDir, forced.env)).toMatchObject({ sha: forced.wrong }); // still pending for ITS build
    // the refusal is visible to the operator: a sha mismatch is logged, naming both builds (never silent)
    const alerts = readFileSync(alertsFilePath(forced.cloneDir, forced.env), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(alerts.find((a) => a.kind === 'force-adopt-sha-mismatch')?.detail).toMatchObject({ requested: forced.wrong });
    const plainFile = alertsFilePath(plain.cloneDir, plain.env);
    expect(existsSync(plainFile) ? readFileSync(plainFile, 'utf8') : '').not.toMatch(/force-adopt-sha-mismatch/);
  });

  it('an old request record with no sha never applies to any build, and does not block the normal ladder', async () => {
    const run = async (withRecord) => {
      const { base, originDir, cloneDir, env: env0 } = makeFixture();
      const env = { ...forceEnv(env0, base), WE_DAEMON_HARNESS_BROKEN_ADOPT_NOT_WORSE: '0' };
      const lastGood = headOf(cloneDir);
      advanceMain(originDir, (dir) => writeFile(dir, 'm.txt', 'x\n'));
      const now = Date.now();
      if (withRecord) writeFileSync(join(env.WE_DAEMON_STATE_DIR, `${cloneKeyOf(cloneDir)}.force-adopt.json`), JSON.stringify({ daemon: 'review', ruling: 'R508', quote: QUOTE, requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + 3600_000).toISOString() }));
      const r = await rebuildClone({ root: cloneDir, env, runSmoke: failing(), prState: async () => null, lockOpts: LOCK_OPTS });
      return { r, cloneDir, env, lastGood };
    };
    const plain = await run(false);
    const old = await run(true);
    expect(old.r.reason).not.toBe('force-adopt-refused');
    expect(old.r.reason).toBe(plain.r.reason);
    expect(headOf(old.cloneDir)).toBe(old.lastGood);
    expect(readForceWatch(old.cloneDir, old.env)).toBeNull();
  });

  it('a request without a ruling is refused and changes nothing', () => {
    const { cloneDir, env } = makeFixture();
    expect(requestForceAdopt({ root: cloneDir, env, daemon: 'review', quote: QUOTE, rulingsText: RULINGS }).ok).toBe(false);
    expect(readForceAdopt(cloneDir, env)).toBeNull();
  });

  it('with ruling+quote: the smoke runs, the failed build is adopted, logged, coroner-recorded, and the watch rolls it back on bad health', async () => {
    const { base, originDir, cloneDir, env: env0 } = makeFixture();
    const env = forceEnv(env0, base);
    const lastGood = headOf(cloneDir);
    const target = advanceMain(originDir, (dir) => writeFile(dir, 'm.txt', 'x\n'));
    expect(requestForceAdopt({ root: cloneDir, env, daemon: 'review', ruling: 'R508', quote: QUOTE, sha: target, rulingsText: RULINGS }).ok).toBe(true);
    const runSmoke = failing();
    const r = await rebuildClone({ root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS, forceWatchProbe: async () => ({ healthy: true }) });
    expect(runSmoke).toHaveBeenCalled(); // smoke is never skipped
    expect(r.moved).toBe(true);
    expect(headOf(cloneDir)).not.toBe(lastGood);
    // The failed check's NAME is recorded next to the force: it comes from smoke.mjs mapping the real smoke rows.
    expect(readFileSync(env.WE_FORCE_ADOPT_HANDOFF, 'utf8')).toMatch(/FORCE-ADOPT [^\n]*R508: adopting [^\n]*\(failed: daemon-entries-boot\)/);
    const coroner = JSON.parse(readFileSync(env.WE_FORCE_ADOPT_CORONER, 'utf8').trim().split('\n')[0]);
    expect(coroner).toMatchObject({ kind: 'force-adopt-review', ruling: 'R508', smoke: { failed: ['daemon-entries-boot'] } });
    const forceEvent = readFileSync(env.WE_DAEMON_EVENTS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.kind === 'force-adopt');
    expect(forceEvent.detail.smoke.failed).toEqual(['daemon-entries-boot']);
    expect(readFileSync(env.WE_DAEMON_EVENTS, 'utf8')).toMatch(/"kind":"force-adopt"/);
    expect(readForceAdopt(cloneDir, env)).toBeNull(); // one-shot
    expect(readForceWatch(cloneDir, env)).not.toBeNull(); // opened now, first checked on the NEXT tick
    expect(headOf(cloneDir)).not.toBe(lastGood);

    // next tick: health fails -> reverted to the last-good build
    await rebuildClone({ root: cloneDir, env, runSmoke: vi.fn(async () => ({ verdict: 'pass', attempts: 1, smoke: { results: [] } })),
      prState: async () => null, lockOpts: LOCK_OPTS, forceWatchProbe: async () => ({ healthy: false }) });
    expect(headOf(cloneDir)).toBe(lastGood);
    expect(readForceWatch(cloneDir, env)).toBeNull();
    expect(readFileSync(env.WE_DAEMON_EVENTS, 'utf8')).toMatch(/force-adopt-rolled-back/);
  });
});

// ── round 4: the three red-team breaks, the finalization paths and the default health probe ─────────────────────────
const passing = () => vi.fn(async () => ({ verdict: 'pass', attempts: 1, smoke: { results: [] } }));
const tick = (cloneDir, env, extra = {}) => rebuildClone({ root: cloneDir, env, prState: async () => null, lockOpts: LOCK_OPTS, ...extra });
const unhealthy = async () => ({ healthy: false });
const healthy = async () => ({ healthy: true });
const handoffOf = (env) => readFileSync(env.WE_FORCE_ADOPT_HANDOFF, 'utf8');

/** An empty commit on main: a new sha with the SAME tree as its parent. */
function advanceMainEmpty(originDir) {
  const dir = makeAuthorClone(originDir);
  gitOk(dir, ['fetch', '-q', 'origin']);
  gitOk(dir, ['checkout', '-q', '-B', 'main', 'origin/main']);
  gitOk(dir, ['commit', '-q', '--allow-empty', '-m', 'empty successor']);
  gitOk(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  return gitOk(dir, ['rev-parse', 'HEAD']).trim();
}

describe('R508 force-adopt: sticky rejection, pinned ready record, finalization', () => {
  const setup = () => {
    const { base, originDir, cloneDir, env: env0 } = makeFixture();
    const env = { ...forceEnv(env0, base), WE_DAEMON_HARNESS_BROKEN_ADOPT_NOT_WORSE: '0' };
    const lastGood = headOf(cloneDir);
    const target = advanceMain(originDir, (dir) => writeFile(dir, 'm.txt', 'x\n')); // no overlays: the plan's finalSha is main's tip
    const arm = (sha = target) => expect(requestForceAdopt({ root: cloneDir, env, daemon: 'review', ruling: 'R508', quote: QUOTE, sha, rulingsText: RULINGS }).ok).toBe(true);
    return { originDir, cloneDir, env, lastGood, target, arm };
  };

  it('a request for the held candidate reaches a fresh smoke through a sticky rejection and is consumed; a request for another build does not lift it', async () => {
    const { cloneDir, env, lastGood, target, arm } = setup();
    // The candidate fails and the last-good control passes: a plain candidate rejection, not a broken harness.
    const failThenPass = vi.fn().mockResolvedValueOnce((await failing()()))
      .mockResolvedValue({ verdict: 'pass', attempts: 1, smoke: { results: [] } });
    await tick(cloneDir, env, { runSmoke: failThenPass });
    expect(readRebuildState(cloneDir, env).rejected).toMatchObject({ reason: 'daemon-entries-boot' });
    expect(readRebuildState(cloneDir, env).rejected.retryAt).toBeUndefined(); // sticky: no retryAt for a non-external failure
    const held = failing();
    expect((await tick(cloneDir, env, { runSmoke: held })).reason).toBe('still-rejected'); // control: no request, no smoke
    expect(held).not.toHaveBeenCalled();

    arm(target.replace(/.$/, target.endsWith('0') ? '1' : '0')); // a well-formed request for ANOTHER build
    const other = failing();
    expect((await tick(cloneDir, env, { runSmoke: other })).reason).toBe('still-rejected');
    expect(other).not.toHaveBeenCalled();
    expect(headOf(cloneDir)).toBe(lastGood);

    arm(); // now the one that names the held candidate
    const fresh = failing();
    const r = await tick(cloneDir, env, { runSmoke: fresh, forceWatchProbe: healthy });
    expect(fresh).toHaveBeenCalled(); // a FRESH smoke ran, then the force applied over its failure
    expect(r.moved).toBe(true);
    expect(headOf(cloneDir)).toBe(target);
    expect(readForceAdopt(cloneDir, env)).toBeNull(); // consumed
    expect(handoffOf(env)).toMatch(/adopting [0-9a-f]{40} though smoke code \(failed: daemon-entries-boot\)/);
  });

  it('a request for the held candidate also lifts the harness-broken backoff', async () => {
    const { cloneDir, env, target, arm } = setup();
    const brokenEnv = { ...env, WE_DAEMON_HARNESS_BROKEN_ADOPT_NOT_WORSE: '1' };
    // Seed the held state a broken harness leaves: held smoke-harness-broken + a rejection with a far-future retryAt.
    await tick(cloneDir, env, { runSmoke: failing() });
    const key = readRebuildState(cloneDir, env).rejected.inputsKey;
    const statePath = rebuildStatePath(cloneDir, env);
    const st = JSON.parse(readFileSync(statePath, 'utf8'));
    st.held = { reason: 'smoke-harness-broken', since: new Date().toISOString() };
    st.rejected = { inputsKey: key, reason: 'daemon-entries-boot', at: new Date().toISOString(), harnessBroken: true, retryAt: new Date(Date.now() + 3600_000).toISOString() };
    writeFileSync(statePath, JSON.stringify(st));
    const blocked = failing();
    expect((await tick(cloneDir, env, { runSmoke: blocked })).reason).toBe('smoke-harness-broken-backoff');
    expect(blocked).not.toHaveBeenCalled();
    arm();
    const fresh = failing();
    const r = await tick(cloneDir, brokenEnv, { runSmoke: fresh, forceWatchProbe: healthy });
    expect(fresh).toHaveBeenCalled();
    expect(r.moved).toBe(true);
    expect(headOf(cloneDir)).toBe(target);
  });

  it('a forced ready record is pinned to its sha: an empty-commit successor is not adopted off it, and the watch is closed', async () => {
    const { originDir, cloneDir, env, lastGood, target, arm } = setup();
    arm();
    const job = await tick(cloneDir, env, { runSmoke: failing(), readyOnly: true });
    expect(job).toMatchObject({ reason: 'ready-recorded', readyRecorded: true });
    expect(readReadyCandidate(cloneDir, env)).toMatchObject({ forced: true, adopt: { finalSha: target } });
    expect(readForceWatch(cloneDir, env)).toMatchObject({ sha: target });
    expect(headOf(cloneDir)).toBe(lastGood);

    const successor = advanceMainEmpty(originDir); // same tree, new sha: `same-tree` would substitute it for the forced build
    const smoke = failing();
    await tick(cloneDir, env, { runSmoke: smoke, forceWatchProbe: unhealthy });
    expect(headOf(cloneDir)).not.toBe(successor); // not adopted off the forced record
    expect(headOf(cloneDir)).toBe(lastGood);
    expect(smoke).toHaveBeenCalled(); // the successor got its own fresh smoke instead
    expect(readReadyCandidate(cloneDir, env)).toBeNull();
    expect(readForceWatch(cloneDir, env)).toBeNull(); // not left to wait out the TTL and block the next force
    expect(handoffOf(env)).toMatch(new RegExp(`NOT adopted ${target} \\(forced-sha-pinned\\); watch closed`));
    expect(readFileSync(env.WE_DAEMON_EVENTS, 'utf8')).toMatch(/force-adopt-aborted/);
  });

  it('while a force watch is open a request for the held candidate does not lift the rejection (no re-smoke every tick)', async () => {
    const { cloneDir, env, target, arm, lastGood } = setup();
    const failThenPass = vi.fn().mockResolvedValueOnce((await failing()()))
      .mockResolvedValue({ verdict: 'pass', attempts: 1, smoke: { results: [] } });
    await tick(cloneDir, env, { runSmoke: failThenPass });
    // an earlier forced adoption of some other build is still under watch: a second force is refused, never consumed
    const opened = await recordForcedAdoption({ root: cloneDir, env, request: { daemon: 'review', ruling: 'R508', quote: QUOTE }, sha: 'e'.repeat(40), lastGood: { head: lastGood }, smoke: { verdict: 'code', failed: [] }, emit: async () => true });
    expect(opened.ok).toBe(true);
    arm();
    const smoke = failing();
    for (let i = 0; i < 2; i += 1) expect((await tick(cloneDir, env, { runSmoke: smoke, forceWatchProbe: healthy })).reason).toBe('still-rejected');
    expect(smoke).not.toHaveBeenCalled();
    expect(readForceAdopt(cloneDir, env)).toMatchObject({ sha: target }); // still pending for when the watch ends
    expect(headOf(cloneDir)).toBe(lastGood);
  });

  it.each([
    ['an unreadable watch file', (cloneDir, env) => writeFileSync(join(env.WE_DAEMON_STATE_DIR, `${cloneKeyOf(cloneDir)}.force-watch.json`), '{corrupt')],
  ])('%s: a request for the held candidate does not lift the rejection either (no re-smoke every tick)', async (_name, block) => {
    const { cloneDir, env, target, arm, lastGood } = setup();
    const failThenPass = vi.fn().mockResolvedValueOnce((await failing()()))
      .mockResolvedValue({ verdict: 'pass', attempts: 1, smoke: { results: [] } });
    await tick(cloneDir, env, { runSmoke: failThenPass });
    block(cloneDir, env);
    arm();
    const smoke = failing();
    for (let i = 0; i < 2; i += 1) expect((await tick(cloneDir, env, { runSmoke: smoke, forceWatchProbe: healthy })).reason).toBe('still-rejected');
    expect(smoke).not.toHaveBeenCalled();
    expect(readForceAdopt(cloneDir, env)).toMatchObject({ sha: target });
    expect(headOf(cloneDir)).toBe(lastGood);
  });

  it.each([
    ['up-to-date', 'the clone already runs another current build'],
    ['untracked-collision', 'an untracked file collides with the forced build'],
  ])('a forced ready record dropped as %s (%s) also closes its watch', async (why) => {
    const { originDir, cloneDir, env, target, arm } = setup();
    arm();
    await tick(cloneDir, env, { runSmoke: failing(), readyOnly: true });
    expect(readReadyCandidate(cloneDir, env)).toMatchObject({ forced: true });
    if (why === 'up-to-date') {
      const successor = advanceMainEmpty(originDir);
      gitOk(cloneDir, ['fetch', '-q', 'origin']);
      gitOk(cloneDir, ['reset', '-q', '--hard', successor]); // the clone now runs main's tip, not the forced build
    } else {
      writeFile(cloneDir, 'm.txt', 'untracked and different\n');
    }
    const r = await tick(cloneDir, env, { runSmoke: failing(), forceWatchProbe: unhealthy });
    expect(r.reason).toBe(why);
    expect(readReadyCandidate(cloneDir, env)).toBeNull();
    expect(readForceWatch(cloneDir, env)).toBeNull(); // not stranded: the next force is not refused with watch-already-open
    expect(handoffOf(env)).toMatch(new RegExp(`NOT adopted ${target} \\(${why}\\); watch closed`));
    expect(headOf(cloneDir)).not.toBe(target); // the forced build was never adopted
  });

  const alertsOf = (cloneDir, env) => readFileSync(alertsFilePath(cloneDir, env), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const watchFileOf = (cloneDir, env) => join(env.WE_DAEMON_STATE_DIR, `${cloneKeyOf(cloneDir)}.force-watch.json`);

  it('a forced ready candidate whose rollback watch is missing is never adopted (fail closed), and is dropped', async () => {
    const { cloneDir, env, lastGood, target, arm } = setup();
    arm();
    await tick(cloneDir, env, { runSmoke: failing(), readyOnly: true });
    expect(readReadyCandidate(cloneDir, env)).toMatchObject({ forced: true });
    rmSync(watchFileOf(cloneDir, env), { force: true });
    // The ordinary ladder runs after the drop and its smoke fails too, so the only way the head could move is the forced record.
    const r = await tick(cloneDir, env, { runSmoke: failing(), forceWatchProbe: healthy });
    expect(r.reason).not.toBe('ready-adopted');
    expect(headOf(cloneDir)).toBe(lastGood); // never adopted without its rollback watch
    expect(headOf(cloneDir)).not.toBe(target);
    expect(readReadyCandidate(cloneDir, env)).toBeNull();
    const discarded = alertsOf(cloneDir, env).find((a) => a.kind === 'ready-candidate-discarded');
    expect(discarded?.detail).toMatchObject({ target, reason: 'forced-watch-missing' });
  });

  it('a forced ready candidate whose rollback watch is UNREADABLE is not adopted, but is KEPT: a transient read failure must not throw the build away', async () => {
    const { cloneDir, env, lastGood, target, arm } = setup();
    arm();
    await tick(cloneDir, env, { runSmoke: failing(), readyOnly: true });
    expect(readReadyCandidate(cloneDir, env)).toMatchObject({ forced: true });
    const intact = readFileSync(watchFileOf(cloneDir, env), 'utf8');
    writeFileSync(watchFileOf(cloneDir, env), '{corrupt');
    const r = await tick(cloneDir, env, { runSmoke: failing(), forceWatchProbe: healthy });
    expect(r.reason).toBe('forced-watch-unreadable');
    expect(headOf(cloneDir)).toBe(lastGood); // fail closed: never adopted while its watch cannot be read
    expect(readReadyCandidate(cloneDir, env)).toMatchObject({ forced: true }); // kept, not dropped
    expect(alertsOf(cloneDir, env).some((a) => a.kind === 'forced-watch-unreadable')).toBe(true);
    expect(alertsOf(cloneDir, env).some((a) => a.kind === 'ready-candidate-discarded')).toBe(false);
    writeFileSync(watchFileOf(cloneDir, env), intact); // the read recovers
    const again = await tick(cloneDir, env, { runSmoke: failing(), forceWatchProbe: healthy });
    expect(again.reason).toBe('ready-adopted');
    expect(headOf(cloneDir)).toBe(target);
  });

  describe('a refused force-adopt (a watch is open / unreadable, or a rollback is owed) is a sticky rejection that consumes the request', () => {
    const blockers = {
      'watch-already-open': async ({ cloneDir, env, lastGood }) => {
        await recordForcedAdoption({ root: cloneDir, env, request: { daemon: 'review', ruling: 'R508', quote: QUOTE }, sha: 'c'.repeat(40),
          lastGood: { head: lastGood }, smoke: { verdict: 'code', failed: [] }, emit: async () => {} });
      },
      'watch-unreadable': async ({ cloneDir, env }) => { writeFileSync(watchFileOf(cloneDir, env), '{corrupt'); },
      'rollback-owed': async ({ cloneDir, env, lastGood }) => {
        await recordForcedAdoption({ root: cloneDir, env, request: { daemon: 'review', ruling: 'R508', quote: QUOTE }, sha: 'c'.repeat(40),
          lastGood: { head: lastGood }, smoke: { verdict: 'code', failed: [] }, emit: async () => {} });
        chmodSync(env.WE_DAEMON_STATE_DIR, 0o500); // the owed-rollback marker cannot be saved
        try { await runForceWatchTick({ root: cloneDir, env, currentHead: 'c'.repeat(40), probe: unhealthy, rollback: async () => ({ ok: false }) }); } finally { chmodSync(env.WE_DAEMON_STATE_DIR, 0o700); }
        rmSync(watchFileOf(cloneDir, env), { force: true }); // the obligation now lives only in memory
      },
    };
    it.each(Object.keys(blockers))('%s', async (reason) => {
      const { cloneDir, env, lastGood, arm } = setup();
      await blockers[reason]({ cloneDir, env, lastGood });
      expect(forceBlockedReason(cloneDir, env)).toBe(reason);
      arm();
      const smoke = failing();
      const r = await tick(cloneDir, env, { runSmoke: smoke, forceWatchProbe: healthy });
      expect(r).toMatchObject({ moved: false, reason: 'force-adopt-refused', detail: reason });
      expect(headOf(cloneDir)).toBe(lastGood);
      expect(readForceAdopt(cloneDir, env)).toBeNull(); // consumed: it does not stay pending for the next build
      expect(readRebuildState(cloneDir, env).rejected).toMatchObject({ reason: 'daemon-entries-boot' }); // sticky
      const refused = alertsOf(cloneDir, env).find((a) => a.kind === 'force-adopt-refused');
      expect(refused?.detail).toMatchObject({ reason, requestConsumed: true });
      // the next tick does not re-smoke the rejected inputs
      expect((await tick(cloneDir, env, { runSmoke: smoke, forceWatchProbe: healthy })).reason).toBe('still-rejected');
      expect(smoke).toHaveBeenCalledTimes(1);
    });
  });

  it('a deferred forced adoption keeps its watch until the exact build is adopted, then the watch still rolls it back', async () => {
    const { cloneDir, env, lastGood, target, arm } = setup();
    arm();
    await tick(cloneDir, env, { runSmoke: failing(), readyOnly: true });
    expect(readReadyCandidate(cloneDir, env)).not.toBeNull();
    const rollback = vi.fn(async () => ({ ok: true }));
    // before adoption the build is not head: the watch waits and keeps its state
    const early = await runForceWatchTick({ root: cloneDir, env, probe: unhealthy, rollback, currentHead: () => lastGood });
    expect(early.action).toBe('waiting');
    expect(rollback).not.toHaveBeenCalled();
    expect(readForceWatch(cloneDir, env)).toMatchObject({ sha: target });

    const adopt = passing();
    const r = await tick(cloneDir, env, { runSmoke: adopt, forceWatchProbe: healthy });
    expect(r).toMatchObject({ moved: true, reason: 'ready-adopted' });
    expect(adopt).not.toHaveBeenCalled(); // adopted from the record, no re-smoke
    expect(headOf(cloneDir)).toBe(target);
    expect(readForceWatch(cloneDir, env)).toMatchObject({ sha: target, adoptedSeen: true });

    await tick(cloneDir, env, { runSmoke: passing(), forceWatchProbe: unhealthy });
    expect(headOf(cloneDir)).toBe(lastGood);
    expect(readForceWatch(cloneDir, env)).toBeNull();
    expect(readFileSync(env.WE_DAEMON_EVENTS, 'utf8')).toMatch(/force-adopt-rolled-back/);
  });

  it('a sibling that adopts the forced build first leaves the watch in place and logs no "NOT adopted"', async () => {
    const { cloneDir, env, lastGood, target, arm } = setup();
    arm();
    const sibling = vi.fn(async () => {
      gitOk(cloneDir, ['reset', '--hard', target]); // a sibling process lands this exact build during the unlocked smoke
      return { verdict: 'code', attempts: 1, smoke: { results: [{ ok: false, name: 'daemon-entries-boot', detail: 'boom', mayBeTransient: false }] } };
    });
    const r = await tick(cloneDir, env, { runSmoke: sibling, forceWatchProbe: healthy });
    expect(r).toMatchObject({ moved: false, adopted: true, reason: 'already-adopted' });
    expect(readForceWatch(cloneDir, env)).toMatchObject({ sha: target });
    expect(handoffOf(env)).not.toMatch(/NOT adopted/);
    expect(readFileSync(env.WE_FORCE_ADOPT_CORONER, 'utf8')).not.toMatch(/force-adopt-aborted/);
    expect(readReadyCandidate(cloneDir, env)).toBeNull();

    await tick(cloneDir, env, { runSmoke: passing(), forceWatchProbe: unhealthy }); // the watch is live: it still rolls the build back
    expect(headOf(cloneDir)).toBe(lastGood);
  });

  it('an unsmoked documentation successor keeps the open watch (and the original last-good): the forced code is still rolled back if unhealthy', async () => {
    const { originDir, cloneDir, env, lastGood, target, arm } = setup();
    arm();
    await tick(cloneDir, env, { runSmoke: failing(), forceWatchProbe: healthy }); // adopted; opening tick checks health only
    await tick(cloneDir, env, { runSmoke: passing(), forceWatchProbe: healthy }); // one counted healthy tick
    expect(readForceWatch(cloneDir, env)).toMatchObject({ sha: target, ticksLeft: 4 });
    const successor = advanceMainEmpty(originDir); // README-only style move: same code, never smoked
    const smoke = passing();
    const r = await tick(cloneDir, env, { runSmoke: smoke, forceWatchProbe: healthy, skipCheck: () => ({ skip: true, reason: 'docs-only' }) });
    expect(r).toMatchObject({ reason: 'skipped-unrelated', skippedSmoke: true });
    expect(smoke).not.toHaveBeenCalled();
    expect(headOf(cloneDir)).toBe(successor);
    // carried, not erased: this tick's own watch step already counted the (healthy) successor once more
    expect(readForceWatch(cloneDir, env)).toMatchObject({ sha: successor, ticksLeft: 3, lastGood: { head: lastGood } });
    expect(readFileSync(env.WE_DAEMON_EVENTS, 'utf8')).toMatch(/force-adopt-watch-carried/);
    expect(readFileSync(env.WE_DAEMON_EVENTS, 'utf8')).not.toMatch(/force-adopt-watch-superseded/);
    await tick(cloneDir, env, { runSmoke: passing(), forceWatchProbe: unhealthy });
    expect(headOf(cloneDir)).toBe(lastGood); // the unverified forced code is still reverted
    expect(readForceWatch(cloneDir, env)).toBeNull();
  });

  it('an unsmoked successor is NOT adopted when the open watch cannot be told about the move: it is built and smoked instead (fail closed)', async () => {
    const { originDir, cloneDir, env, target, arm } = setup();
    arm();
    await tick(cloneDir, env, { runSmoke: failing(), forceWatchProbe: healthy }); // forced build adopted and watched
    const before = readForceWatch(cloneDir, env);
    expect(before).toMatchObject({ sha: target });
    const successor = advanceMainEmpty(originDir);
    // every watch write fails (the atomic temp path is occupied by a directory) while the rest of the state dir stays writable
    mkdirSync(`${join(env.WE_DAEMON_STATE_DIR, `${cloneKeyOf(cloneDir)}.force-watch.json`)}.${process.pid}.tmp`);
    const smoke = passing();
    const r = await tick(cloneDir, env, { runSmoke: smoke, forceWatchProbe: healthy, skipCheck: () => ({ skip: true, reason: 'docs-only' }) });
    expect(r.reason).not.toBe('skipped-unrelated');
    expect(r.skippedSmoke).toBeUndefined();
    expect(smoke).toHaveBeenCalled(); // the successor got a smoke of its own instead of riding the forced build's watch unprotected
    expect(headOf(cloneDir)).toBe(successor); // and, smoked green, it is adopted normally
  });

  it('a rollback never reverts a build a sibling adopted while the health probe ran: the watch closes and the newer build keeps running', async () => {
    const { originDir, cloneDir, env, lastGood, target, arm } = setup();
    arm();
    await tick(cloneDir, env, { runSmoke: failing(), forceWatchProbe: healthy }); // the forced build is adopted and watched
    expect(headOf(cloneDir)).toBe(target);
    let successor = null;
    const probe = async () => { // a sibling lands a newer healthy build while this probe is in flight, then this probe reports unhealthy
      successor = advanceMainEmpty(originDir);
      gitOk(cloneDir, ['fetch', '-q', 'origin']);
      gitOk(cloneDir, ['reset', '-q', '--hard', successor]);
      return { healthy: false };
    };
    await tick(cloneDir, env, { runSmoke: passing(), forceWatchProbe: probe });
    expect(successor).not.toBeNull();
    expect(headOf(cloneDir)).toBe(successor); // NOT reset to last-good
    expect(headOf(cloneDir)).not.toBe(lastGood);
    expect(readForceWatch(cloneDir, env)).toBeNull();
    const events = readFileSync(env.WE_DAEMON_EVENTS, 'utf8');
    expect(events).toMatch(/force-adopt-watch-superseded/);
    expect(events).not.toMatch(/force-adopt-rolled-back/);
    expect(handoffOf(env)).not.toMatch(/ROLLED BACK/);
  });

  it('an unreadable HEAD inside the rollback is not "superseded": the revert stays owed and is retried', async () => {
    const { cloneDir, env, lastGood, target, arm } = setup();
    arm();
    await tick(cloneDir, env, { runSmoke: failing(), forceWatchProbe: healthy });
    expect(headOf(cloneDir)).toBe(target);
    let gitBroken = false;
    const run = (args, opts) => (gitBroken && args[0] === 'rev-parse' ? { status: 128, stdout: '', stderr: 'fatal' } : gitRun(args, opts));
    const probe = async () => { gitBroken = true; return { healthy: false }; }; // git fails from the probe on (outer head read is already done)
    await tick(cloneDir, env, { runSmoke: passing(), forceWatchProbe: probe, run });
    gitBroken = false;
    expect(headOf(cloneDir)).toBe(target); // not reverted yet ...
    expect(readForceWatch(cloneDir, env)).toMatchObject({ sha: target, rollbackPending: 'head-unreadable' }); // ... but still owed (an unreadable HEAD after the probe is itself the failure reason), watch kept
    expect(readFileSync(env.WE_DAEMON_EVENTS, 'utf8')).not.toMatch(/force-adopt-watch-superseded/);
    await tick(cloneDir, env, { runSmoke: passing(), forceWatchProbe: healthy }); // a healthy probe still honours the owed revert
    expect(headOf(cloneDir)).toBe(lastGood);
    expect(readForceWatch(cloneDir, env)).toBeNull();
  });

  it('a HEAD that git cannot read on the watch tick is a failure: the watch is neither counted down nor completed', async () => {
    const { cloneDir, env, target, arm } = setup();
    arm();
    await tick(cloneDir, env, { runSmoke: failing(), forceWatchProbe: healthy });
    expect(headOf(cloneDir)).toBe(target);
    const ticksBefore = readForceWatch(cloneDir, env).ticksLeft;
    let gitBroken = false;
    const run = (args, opts) => (gitBroken && args[0] === 'rev-parse' ? { status: 128, stdout: '', stderr: 'fatal' } : gitRun(args, opts));
    const probe = vi.fn(async () => { gitBroken = true; return { healthy: true }; }); // the first (pre-probe) head read succeeds; every later one fails
    await tick(cloneDir, env, { runSmoke: passing(), forceWatchProbe: probe, run });
    gitBroken = false;
    const watch = readForceWatch(cloneDir, env);
    expect(watch).not.toBeNull(); // not completed
    expect(watch.ticksLeft).toBe(ticksBefore); // not counted down by the healthy probe
    expect(watch.rollbackPending).toBe('head-unreadable');
    expect(headOf(cloneDir)).toBe(target); // nothing reverted blind
  });

  it('a finalization that fails clears the watch AND the ready candidate, and logs the build as not adopted', async () => {
    const { cloneDir, env, lastGood, target, arm } = setup();
    arm();
    const run = (args, opts) => (args[0] === 'reset' && args.includes('--hard') && args.includes(target) && opts?.cwd === cloneDir
      ? { status: 1, stdout: '', stderr: 'boom' } : gitRun(args, opts));
    const r = await tick(cloneDir, env, { runSmoke: failing(), run });
    expect(r).toMatchObject({ moved: false, reason: 'reset-failed' });
    expect(headOf(cloneDir)).toBe(lastGood);
    expect(readForceWatch(cloneDir, env)).toBeNull();
    expect(readReadyCandidate(cloneDir, env)).toBeNull();
    expect(readForceAdopt(cloneDir, env)).toBeNull();
    expect(handoffOf(env)).toMatch(/NOT adopted [0-9a-f]{40} \(adoption did not complete\)/);
  });

  it('a finalization that throws clears the watch AND the ready candidate before the error propagates', async () => {
    const { cloneDir, env, lastGood, arm } = setup();
    arm();
    let smoked = false;
    const runSmoke = vi.fn(async () => { smoked = true; return { verdict: 'code', attempts: 1, smoke: { results: [{ ok: false, name: 'daemon-entries-boot', detail: 'boom', mayBeTransient: false }] } }; });
    const run = (args, opts) => {
      if (smoked && args[0] === 'rev-parse' && args.some((a) => String(a).endsWith('^{tree}'))) throw new Error('git gone');
      return gitRun(args, opts);
    };
    await tick(cloneDir, env, { runSmoke, run }).catch(() => null);
    expect(handoffOf(env)).toMatch(/NOT adopted [0-9a-f]{40} \(adoption did not complete\)/); // the abort ran: the throw was inside finalize
    expect(headOf(cloneDir)).toBe(lastGood);
    expect(readForceWatch(cloneDir, env)).toBeNull();
    expect(readReadyCandidate(cloneDir, env)).toBeNull();
  });

  it('the default health probe passes a healthy clone: the forced build is kept and the watch counts down', async () => {
    const { base, originDir, cloneDir, env: env0 } = makeFixture();
    const env = forceEnv(env0, base);
    const lastGood = headOf(cloneDir);
    // The probe loads ./scripts/lib/daemon-rebuild.mjs from the clone: give the forced build a loadable one (tracked, clean).
    const target = advanceMain(originDir, (dir) => writeFile(dir, 'scripts/lib/daemon-rebuild.mjs', 'export const ok = true;\n'));
    expect(requestForceAdopt({ root: cloneDir, env, daemon: 'review', ruling: 'R508', quote: QUOTE, sha: target, rulingsText: RULINGS }).ok).toBe(true);
    await tick(cloneDir, env, { runSmoke: failing() });
    expect(headOf(cloneDir)).toBe(target);
    await tick(cloneDir, env, { runSmoke: passing() }); // no forceWatchProbe injected: the real default probe runs
    expect(headOf(cloneDir)).toBe(target); // healthy: not rolled back
    expect(headOf(cloneDir)).not.toBe(lastGood);
    expect(readForceWatch(cloneDir, env)).toMatchObject({ sha: target, ticksLeft: 4, adoptedSeen: true });
    expect(readFileSync(env.WE_DAEMON_EVENTS, 'utf8')).not.toMatch(/force-adopt-rolled-back/);
  });

  it('the default health probe fails a forced build whose tracked tree was modified (dirty-tree check): never counted healthy', async () => {
    const { base, originDir, cloneDir, env: env0 } = makeFixture();
    const env = forceEnv(env0, base);
    // Loadable entry module AND a second tracked file: only the tree check can tell this clone from a healthy one.
    const target = advanceMain(originDir, (dir) => { writeFile(dir, 'scripts/lib/daemon-rebuild.mjs', 'export const ok = true;\n'); writeFile(dir, 'tracked.txt', 'clean\n'); });
    expect(requestForceAdopt({ root: cloneDir, env, daemon: 'review', ruling: 'R508', quote: QUOTE, sha: target, rulingsText: RULINGS }).ok).toBe(true);
    await tick(cloneDir, env, { runSmoke: failing() });
    expect(headOf(cloneDir)).toBe(target);
    writeFileSync(join(cloneDir, 'tracked.txt'), 'locally modified\n'); // tracked file modified after the adoption
    await tick(cloneDir, env, { runSmoke: passing() }); // no forceWatchProbe injected: the real default probe runs
    // not healthy: the watch did not count down (a healthy tick leaves ticksLeft 4); it either rolled back or still owes the revert
    expect(readFileSync(env.WE_DAEMON_EVENTS, 'utf8')).toMatch(/force-adopt-rolled-back|force-adopt-rollback-failed/);
    const w = readForceWatch(cloneDir, env);
    if (w) expect(w).toMatchObject({ sha: target, rollbackPending: 'health-failed' });
  });
});

describe('R508 force-adopt: a force-adopted build stays unverified (never the incremental-smoke baseline)', () => {
  // The real smoke skips a check when the files changed since the adopted build do not touch its code (`changedFiles` non-null).
  // Emulate that: the defect of the force-adopted build is only visible to a FULL smoke (`changedFiles === null`).
  const incrementalAware = () => vi.fn(async ({ changedFiles }) => (changedFiles === null
    ? { verdict: 'code', attempts: 1, smoke: { results: [{ ok: false, name: 'dispatch-dry-run', detail: 'F defect', mayBeTransient: false }, { ok: false, name: 'reconcile-dry-run', detail: 'F defect', mayBeTransient: false }] } }
    : { verdict: 'pass', attempts: 1, smoke: { results: [] } }));
  const forceAdoptF = async () => {
    const { base, originDir, cloneDir, env: env0 } = makeFixture();
    const env = { ...forceEnv(env0, base), WE_DAEMON_HARNESS_BROKEN_ADOPT_NOT_WORSE: '0' };
    const F = advanceMain(originDir, (dir) => writeFile(dir, 'm.txt', 'x\n'));
    expect(requestForceAdopt({ root: cloneDir, env, daemon: 'review', ruling: 'R508', quote: QUOTE, sha: F, rulingsText: RULINGS }).ok).toBe(true);
    const failF = vi.fn(async () => ({ verdict: 'code', attempts: 1, smoke: { results: [{ ok: false, name: 'dispatch-dry-run', detail: 'F defect', mayBeTransient: false }] } }));
    await tick(cloneDir, env, { runSmoke: failF, forceWatchProbe: healthy });
    expect(headOf(cloneDir)).toBe(F); // F is force-adopted
    return { originDir, cloneDir, env, F };
  };

  it('a successor touching only an unrelated file re-runs the checks F failed (full smoke) and is not adopted while they fail', async () => {
    const { originDir, cloneDir, env, F } = await forceAdoptF();
    const S = advanceMain(originDir, (dir) => writeFile(dir, 'scripts/lane-pool.mjs', '// only the pool changed\n'));
    const runSmoke = incrementalAware();
    await tick(cloneDir, env, { runSmoke, forceWatchProbe: healthy });
    expect(runSmoke).toHaveBeenCalled();
    expect(runSmoke.mock.calls[0][0].changedFiles).toBeNull(); // NOT the incremental F→S file list: F is not a trusted baseline
    expect(headOf(cloneDir)).not.toBe(S); // the failing full smoke keeps S out (it would have been adopted with F's defect before)
  });

  it('F → docs-only successor D (adopted unsmoked) → S touching only scripts/lane-pool.mjs: D inherits the unverified status, S gets a full smoke', async () => {
    const { originDir, cloneDir, env, F } = await forceAdoptF();
    const D = advanceMain(originDir, (dir) => writeFile(dir, 'docs.md', 'docs only\n')); // a DIFFERENT tree from F, adopted without a smoke
    const skipped = passing();
    const r = await tick(cloneDir, env, { runSmoke: skipped, forceWatchProbe: healthy, skipCheck: () => ({ skip: true, reason: 'docs-only' }) });
    expect(r).toMatchObject({ reason: 'skipped-unrelated', skippedSmoke: true });
    expect(headOf(cloneDir)).toBe(D);
    expect(D).not.toBe(F);
    const S = advanceMain(originDir, (dir) => writeFile(dir, 'scripts/lane-pool.mjs', '// only the pool changed\n'));
    const runSmoke = incrementalAware();
    await tick(cloneDir, env, { runSmoke, forceWatchProbe: healthy });
    expect(runSmoke.mock.calls[0][0].changedFiles).toBeNull(); // not the incremental D→S list: D carries F's unverified status
    expect(headOf(cloneDir)).not.toBe(S); // F's failing check re-runs and keeps S out
  });

  it('a force-adopted build whose unverified record cannot be written (write lock refused) is not finalized: no adoption, no watch', async () => {
    const { base, originDir, cloneDir, env: env0 } = makeFixture();
    const env = { ...forceEnv(env0, base), WE_DAEMON_HARNESS_BROKEN_ADOPT_NOT_WORSE: '0' };
    const lastGood = headOf(cloneDir);
    const F = advanceMain(originDir, (dir) => writeFile(dir, 'm.txt', 'x\n'));
    expect(requestForceAdopt({ root: cloneDir, env, daemon: 'review', ruling: 'R508', quote: QUOTE, sha: F, rulingsText: RULINGS }).ok).toBe(true);
    const lockRoot = env.WE_DAEMON_CLONE_LOCK_ROOT;
    let releaseForeign;
    // The smoke runs unlocked: a foreign live process (our parent) takes the clone write lock and keeps it through finalize.
    const runSmoke = vi.fn(async () => {
      void withWriteLock(cloneDir, () => new Promise((resolve) => { releaseForeign = resolve; }), { lockRoot, pid: process.ppid, owner: 'foreign-writer', waitMs: 2000 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { verdict: 'code', attempts: 1, smoke: { results: [{ ok: false, name: 'dispatch-dry-run', detail: 'F defect', mayBeTransient: false }] } };
    });
    try {
      // like any finalize that throws: the watch and ready candidate are cleared (abort) before the error propagates
      await expect(tick(cloneDir, env, { runSmoke, forceWatchProbe: healthy, lockOpts: { ...LOCK_OPTS, lockRoot, waitMs: 300 } }))
        .rejects.toThrow(/could not record it as unverified/);
    } finally { releaseForeign?.(); }
    expect(headOf(cloneDir)).toBe(lastGood); // never adopted with no unverified record
    expect(readForceWatch(cloneDir, env)).toBeNull();
    expect(readReadyCandidate(cloneDir, env)).toBeNull();
  });

  it('the same successor IS adopted once the full smoke passes, and a later successor goes back to the incremental smoke', async () => {
    const { originDir, cloneDir, env } = await forceAdoptF();
    const S = advanceMain(originDir, (dir) => writeFile(dir, 'scripts/lane-pool.mjs', '// only the pool changed\n'));
    const full = passing();
    await tick(cloneDir, env, { runSmoke: full, forceWatchProbe: healthy });
    expect(full.mock.calls[0][0].changedFiles).toBeNull();
    expect(headOf(cloneDir)).toBe(S); // a build that passes the full smoke is a trusted baseline again
    advanceMain(originDir, (dir) => writeFile(dir, 'other.txt', 'y\n'));
    const next = passing();
    await tick(cloneDir, env, { runSmoke: next, forceWatchProbe: healthy });
    expect(Array.isArray(next.mock.calls[0][0].changedFiles)).toBe(true);
  });
});
