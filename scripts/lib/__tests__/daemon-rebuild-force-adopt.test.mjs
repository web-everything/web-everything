/** @file R508 force-adopt wiring through the real rebuildClone: smoke still runs, adopts over a failed smoke only with a
 *  ruling+quote, logs, and the watch reverts to last-good. Fixture helpers are copied from the fallback suite. */
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
import { requestForceAdopt, readForceWatch, runForceWatchTick, readForceAdopt, recordForcedAdoption } from '../daemon-force-adopt.mjs';
import { readReadyCandidate } from '../daemon-rebuild/state.mjs';
import { cloneKeyOf } from '../daemon-last-good.mjs';
import { gitRun } from '../main-staleness.mjs';
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
    await rebuildClone({ root: cloneDir, env, runSmoke: failing(), prState: async () => null, lockOpts: LOCK_OPTS });
    expect(headOf(cloneDir)).not.toBe(lastGood);
    // No forceWatchProbe injected: the fixture clone has no scripts/lib/daemon-rebuild.mjs, so the default probe is unhealthy.
    await rebuildClone({ root: cloneDir, env, runSmoke: vi.fn(async () => ({ verdict: 'pass', attempts: 1, smoke: { results: [] } })),
      prState: async () => null, lockOpts: LOCK_OPTS });
    expect(headOf(cloneDir)).toBe(lastGood);
    expect(readFileSync(env.WE_DAEMON_EVENTS, 'utf8')).toMatch(/force-adopt-rolled-back/);
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
    const r = await rebuildClone({ root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS });
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
    const r = await tick(cloneDir, env, { runSmoke: fresh });
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
    const r = await tick(cloneDir, brokenEnv, { runSmoke: fresh });
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
    const r = await tick(cloneDir, env, { runSmoke: sibling });
    expect(r).toMatchObject({ moved: false, adopted: true, reason: 'already-adopted' });
    expect(readForceWatch(cloneDir, env)).toMatchObject({ sha: target });
    expect(handoffOf(env)).not.toMatch(/NOT adopted/);
    expect(readFileSync(env.WE_FORCE_ADOPT_CORONER, 'utf8')).not.toMatch(/force-adopt-aborted/);
    expect(readReadyCandidate(cloneDir, env)).toBeNull();

    await tick(cloneDir, env, { runSmoke: passing(), forceWatchProbe: unhealthy }); // the watch is live: it still rolls the build back
    expect(headOf(cloneDir)).toBe(lastGood);
  });

  it('a rollback never reverts a build a sibling adopted while the health probe ran: the watch closes and the newer build keeps running', async () => {
    const { originDir, cloneDir, env, lastGood, target, arm } = setup();
    arm();
    await tick(cloneDir, env, { runSmoke: failing() }); // the forced build is adopted and watched
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
    await tick(cloneDir, env, { runSmoke: failing() });
    expect(headOf(cloneDir)).toBe(target);
    let gitBroken = false;
    const run = (args, opts) => (gitBroken && args[0] === 'rev-parse' ? { status: 128, stdout: '', stderr: 'fatal' } : gitRun(args, opts));
    const probe = async () => { gitBroken = true; return { healthy: false }; }; // git fails from the probe on (outer head read is already done)
    await tick(cloneDir, env, { runSmoke: passing(), forceWatchProbe: probe, run });
    gitBroken = false;
    expect(headOf(cloneDir)).toBe(target); // not reverted yet ...
    expect(readForceWatch(cloneDir, env)).toMatchObject({ sha: target, rollbackPending: 'health-failed' }); // ... but still owed, watch kept
    expect(readFileSync(env.WE_DAEMON_EVENTS, 'utf8')).not.toMatch(/force-adopt-watch-superseded/);
    await tick(cloneDir, env, { runSmoke: passing(), forceWatchProbe: healthy }); // a healthy probe still honours the owed revert
    expect(headOf(cloneDir)).toBe(lastGood);
    expect(readForceWatch(cloneDir, env)).toBeNull();
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
});
