/**
 * @file scripts/lib/__tests__/daemon-rebuild-ready.test.mjs
 * @description fix-rebuild-finalize — a candidate that PASSED its live smoke but could not be adopted because a
 *   reader (a sibling daemon's tick) held the clone's read lock through the finalize wait is recorded as the
 *   clone's READY candidate, and the next write-lock holder adopts it without re-smoking. Live 2026-09-26 on
 *   `wev-review-daemon`: "could not take the write lock to finalize <sha> after a passing smoke" followed by a
 *   fresh smoke of a new sha every tick, and `rebuild-in-progress` from the lease the failed finalize left behind —
 *   registered overlay fixes were never adopted. Same fixture conventions as `daemon-rebuild-fallback.test.mjs`
 *   (real temp git fixtures, injected `runSmoke` stubs); helpers copied, never imported.
 */
import { describe, it, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  rebuildClone, readRebuildState, rebuildStatePath, readReadyCandidate, readyCandidatePath, matchReadyCandidate,
} from '../../../../scripts/lib/daemon-rebuild.mjs';
import { acquireRead, releaseRead } from '../../../../scripts/lib/daemon-clone-lock.mjs';
import { addOverlay, readOverlays, removeOverlay } from '../../../../scripts/lib/daemon-overlays.mjs';

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
function writeFile(dir, name, content) {
  const full = join(dir, name);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}
function pushBranch(originDir, ref, mutate) {
  const parent = mktemp('we-rebuild-ready-author-');
  const dir = join(parent, 'w');
  const r = spawnSync('git', ['clone', '-q', originDir, dir], { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' });
  if (r.status !== 0) throw new Error(`clone failed: ${r.stderr}`);
  gitOk(dir, ['checkout', '-q', '-B', ref, 'origin/main']);
  mutate(dir);
  gitOk(dir, ['add', '-A']);
  gitOk(dir, ['commit', '-q', '-m', `change: ${ref}`]);
  gitOk(dir, ['push', '-q', 'origin', `HEAD:refs/heads/${ref}`]);
  return gitOk(dir, ['rev-parse', 'HEAD']).trim();
}
const advanceMain = (originDir, mutate) => pushBranch(originDir, 'main', mutate);

function makeFixture() {
  const base = mktemp('we-rebuild-ready-fixture-');
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
  const env = {
    ...process.env,
    WE_DAEMON_STATE_DIR: mktemp('we-rebuild-ready-state-'),
    WE_DAEMON_CLONE_LOCK_ROOT: mktemp('we-rebuild-ready-lock-'),
    WE_DAEMON_OVERLAY_DIR: mktemp('we-rebuild-ready-overlay-'),
  };
  return { originDir, cloneDir, env };
}

const LOCK_OPTS = { waitMs: 1500, pollMs: 20 };
const PASS = { verdict: 'pass', attempts: 1, smoke: { results: [] } };
const FAIL = { verdict: 'code', attempts: 1, smoke: { results: [{ ok: false, name: 'x', detail: 'boom' }] } };

/** A passing smoke during which a SIBLING daemon starts a tick (takes a read slot) and is still ticking when the
 *  finalize tries the write lock — the live shape. Call `endTick()` for the sibling's tick boundary. */
function passWhileSiblingStartsTick(cloneDir, env, { failWhenFile } = {}) {
  const lockOpts = { lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT, owner: 'sibling-daemon' };
  const runSmoke = mock(async ({ root }) => {
    if (failWhenFile && existsSync(join(root, failWhenFile))) return FAIL;
    const r = acquireRead(cloneDir, lockOpts);
    if (!r.ok) throw new Error(`sibling could not start its tick: ${r.reason}`);
    return PASS;
  });
  return { runSmoke, endTick: () => releaseRead(cloneDir, lockOpts) };
}

beforeEach(() => { tempDirs.length = 0; });
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe('a passed candidate blocked at finalize by a long reader tick is adopted later without re-smoking', () => {
  it('records it as ready, then the next rebuild adopts it even though main moved again', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    const target = advanceMain(originDir, (dir) => writeFile(dir, 'a.txt', 'a\n'));
    const { runSmoke, endTick } = passWhileSiblingStartsTick(cloneDir, env);

    const first = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(first.adopted).not.toBe(true);
    expect(first.reason).toBe('tick-in-progress');
    expect(readReadyCandidate(cloneDir, env)?.adopt.finalSha).toBe(target);

    endTick(); // the sibling's tick boundary
    advanceMain(originDir, (dir) => writeFile(dir, 'b.txt', 'b\n')); // the live churn: a new candidate sha
    const noSmoke = mock(async () => PASS);
    const second = await rebuildClone({
      root: cloneDir, env, runSmoke: noSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(second.moved).toBe(true);
    expect(second.adopted).toBe(true);
    expect(second.reason).toBe('ready-adopted');
    expect(second.readyMatch).toBe('superseded');
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(target);
    expect(noSmoke).not.toHaveBeenCalled();
    expect(existsSync(readyCandidatePath(cloneDir, env))).toBe(false);
    expect(readRebuildState(cloneDir, env).adopted?.head).toBe(target);
  });

  it('a sibling process adopts it at its tick start despite the build lease the blocked mover left behind', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    const target = advanceMain(originDir, (dir) => writeFile(dir, 'c.txt', 'c\n'));
    const { runSmoke, endTick } = passWhileSiblingStartsTick(cloneDir, env);
    await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    endTick();
    // The lease on disk belongs to the mover — make it look like a still-live OTHER process (the live shape:
    // the sibling logged "rebuild-in-progress — pid 95311 is already smoking" for up to 20 min).
    const file = rebuildStatePath(cloneDir, env);
    const st = JSON.parse(readFileSync(file, 'utf8'));
    expect(st.building?.token).toBeTruthy();
    writeFileSync(file, JSON.stringify({ ...st, building: { ...st.building, pid: process.ppid } }));

    const noSmoke = mock(async () => PASS);
    const second = await rebuildClone({
      root: cloneDir, env, runSmoke: noSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(second.reason).toBe('ready-adopted');
    expect(second.readyMatch).toBe('exact');
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(target);
    expect(noSmoke).not.toHaveBeenCalled();
    expect(readRebuildState(cloneDir, env).building).toBeNull();
  });

  it('a passed plain-main fallback blocked at finalize is adopted later, and still drops the bad overlay', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    const mainSha = advanceMain(originDir, (dir) => writeFile(dir, 'm.txt', 'm\n'));
    pushBranch(originDir, 'lane/bad', (dir) => writeFile(dir, 'bad.txt', 'x\n'));
    addOverlay(cloneDir, { ref: 'lane/bad' }, { env });
    const { runSmoke, endTick } = passWhileSiblingStartsTick(cloneDir, env, { failWhenFile: 'bad.txt' });

    const first = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(first.adopted).not.toBe(true);
    expect(readReadyCandidate(cloneDir, env)?.kind).toBe('fallback');

    endTick();
    const noSmoke = mock(async () => PASS);
    const second = await rebuildClone({
      root: cloneDir, env, runSmoke: noSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(second.reason).toBe('ready-adopted');
    expect(second.readyMatch).toBe('fallback');
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(mainSha);
    expect(readOverlays(cloneDir, { env })).toEqual([]);
    expect(second.alerts.some((a) => a.kind === 'overlay-dropped-smoke-failed')).toBe(true);
    expect(noSmoke).not.toHaveBeenCalled();
  });

  it('never brings back an overlay the operator removed after the pass — smokes the current plan instead', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/ov', (dir) => writeFile(dir, 'ov.txt', 'o\n'));
    addOverlay(cloneDir, { ref: 'lane/ov' }, { env });
    const { runSmoke, endTick } = passWhileSiblingStartsTick(cloneDir, env);
    await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    endTick();
    removeOverlay(cloneDir, 'lane/ov', { env });
    const mainSha = advanceMain(originDir, (dir) => writeFile(dir, 'n.txt', 'n\n'));

    const smoke = mock(async () => PASS);
    const second = await rebuildClone({
      root: cloneDir, env, runSmoke: smoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(second.adopted).toBe(true);
    expect(second.reason).not.toBe('ready-adopted');
    expect(smoke).toHaveBeenCalledTimes(1);
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(mainSha);
    expect(second.alerts.some((a) => a.kind === 'ready-candidate-discarded')).toBe(true);
  });

  it('adopts a superseded build that carries a still-registered overlay (the build is re-verified from git)', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/ok', (dir) => writeFile(dir, 'ok.txt', 'o\n'));
    addOverlay(cloneDir, { ref: 'lane/ok' }, { env });
    const { runSmoke, endTick } = passWhileSiblingStartsTick(cloneDir, env);
    await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    const target = readReadyCandidate(cloneDir, env)?.adopt.finalSha;
    expect(target).toBeTruthy();
    endTick();
    advanceMain(originDir, (dir) => writeFile(dir, 'p.txt', 'p\n'));

    const noSmoke = mock(async () => PASS);
    const second = await rebuildClone({
      root: cloneDir, env, runSmoke: noSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(second.reason).toBe('ready-adopted');
    expect(second.readyMatch).toBe('superseded');
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(target);
    expect(noSmoke).not.toHaveBeenCalled();
  });

  it('never brings back an overlay whose PR closed in the SAME tick that finds the ready candidate', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/bad-pr', (dir) => writeFile(dir, 'bad.txt', 'x\n'));
    addOverlay(cloneDir, { ref: 'lane/bad-pr', pr: 99 }, { env });
    const { runSmoke, endTick } = passWhileSiblingStartsTick(cloneDir, env);
    await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => 'OPEN', lockOpts: LOCK_OPTS,
    });
    expect(readReadyCandidate(cloneDir, env)?.adopt.applied?.map((a) => a.ref)).toEqual(['lane/bad-pr']);
    endTick();
    const mainSha = advanceMain(originDir, (dir) => writeFile(dir, 'q.txt', 'q\n'));

    const smoke = mock(async () => PASS);
    const second = await rebuildClone({
      root: cloneDir, env, runSmoke: smoke, prState: async () => 'CLOSED', lockOpts: LOCK_OPTS,
    });
    expect(readOverlays(cloneDir, { env })).toEqual([]);
    expect(second.reason).not.toBe('ready-adopted');
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(mainSha);
    expect(existsSync(join(cloneDir, 'bad.txt'))).toBe(false);
    expect(second.alerts.some((a) => a.kind === 'ready-candidate-discarded')).toBe(true);
  });

  it('a mainOnly rebuild never adopts a ready candidate that carries an overlay', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/ov', (dir) => writeFile(dir, 'ov.txt', 'o\n'));
    addOverlay(cloneDir, { ref: 'lane/ov' }, { env });
    const { runSmoke, endTick } = passWhileSiblingStartsTick(cloneDir, env);
    await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    endTick();
    const mainSha = advanceMain(originDir, (dir) => writeFile(dir, 'r.txt', 'r\n'));

    const smoke = mock(async () => PASS);
    const second = await rebuildClone({
      root: cloneDir, env, runSmoke: smoke, prState: async () => null, lockOpts: LOCK_OPTS, mainOnly: true,
    });
    expect(second.reason).not.toBe('ready-adopted');
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(mainSha);
    expect(existsSync(join(cloneDir, 'ov.txt'))).toBe(false);
  });

  it('refuses a forged ready record pointing at a commit this module never built (overlay-free, empty applied)', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    const evil = pushBranch(originDir, 'lane/evil', (dir) => writeFile(dir, 'evil.txt', 'e\n'));
    const mainSha = advanceMain(originDir, (dir) => writeFile(dir, 's.txt', 's\n'));
    gitOk(cloneDir, ['fetch', '-q', 'origin', '+refs/heads/lane/evil:refs/remotes/origin/lane/evil']);
    const head = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();
    const file = readyCandidatePath(cloneDir, env);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      kind: 'candidate', prevHead: head, tree: 'x', passedAt: new Date().toISOString(),
      adopt: {
        finalSha: evil, inputsKey: 'forged', mainSha: evil, applied: [],
      },
    }));

    const smoke = mock(async () => PASS);
    const second = await rebuildClone({
      root: cloneDir, env, runSmoke: smoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(second.reason).not.toBe('ready-adopted');
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(mainSha);
    expect(smoke).toHaveBeenCalledTimes(1);
    expect(second.alerts.some((a) => a.kind === 'ready-candidate-discarded' && a.detail?.reason === 'unverified-build'))
      .toBe(true);
  });

  it('refuses a forged record whose overlay merge carries an arbitrary tree (right parents, wrong content)', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    const ovSha = pushBranch(originDir, 'lane/ok', (dir) => writeFile(dir, 'ok.txt', 'o\n'));
    addOverlay(cloneDir, { ref: 'lane/ok' }, { env });
    const mainSha = advanceMain(originDir, (dir) => writeFile(dir, 'u.txt', 'u\n'));
    gitOk(cloneDir, ['fetch', '-q', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
    // A tree nobody minted: main's tree plus an injected file, committed with the "right" parents.
    const author = join(mktemp('we-rebuild-ready-author-'), 'w');
    gitOk(dirname(author), ['clone', '-q', originDir, author]);
    writeFile(author, 'evil.txt', 'e\n');
    gitOk(author, ['add', '-A']);
    const tree = gitOk(author, ['write-tree']).trim();
    gitOk(author, ['push', '-q', 'origin', `${gitOk(author, ['commit-tree', tree, '-m', 't']).trim()}:refs/heads/scratch`]);
    gitOk(cloneDir, ['fetch', '-q', 'origin', '+refs/heads/scratch:refs/remotes/origin/scratch']);
    const forged = gitOk(cloneDir, ['commit-tree', tree, '-p', mainSha, '-p', ovSha, '-m', 'forged']).trim();
    const file = readyCandidatePath(cloneDir, env);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      kind: 'candidate', prevHead: gitOk(cloneDir, ['rev-parse', 'HEAD']).trim(), tree: 'x', passedAt: new Date().toISOString(),
      adopt: {
        finalSha: forged, inputsKey: 'forged', mainSha, applied: [{ ref: 'lane/ok', pr: null, sha: ovSha }],
      },
    }));

    const smoke = mock(async () => PASS);
    const second = await rebuildClone({
      root: cloneDir, env, runSmoke: smoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(second.reason).not.toBe('ready-adopted');
    expect(existsSync(join(cloneDir, 'evil.txt'))).toBe(false);
    expect(second.alerts.some((a) => a.kind === 'ready-candidate-discarded' && a.detail?.reason === 'unverified-build'))
      .toBe(true);
  });

  it('refuses a forged record that would roll the clone back to an older main commit', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    const old = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();
    const built = advanceMain(originDir, (dir) => writeFile(dir, 'v.txt', 'v\n'));
    await rebuildClone({
      root: cloneDir, env, runSmoke: async () => PASS, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(built);
    const mainSha = advanceMain(originDir, (dir) => writeFile(dir, 'w.txt', 'w\n'));
    const file = readyCandidatePath(cloneDir, env);
    writeFileSync(file, JSON.stringify({
      kind: 'candidate', prevHead: built, tree: 'x', passedAt: new Date().toISOString(),
      adopt: {
        finalSha: old, inputsKey: 'forged', mainSha: old, applied: [],
      },
    }));

    const second = await rebuildClone({
      root: cloneDir, env, runSmoke: async () => PASS, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(second.reason).not.toBe('ready-adopted');
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(mainSha);
  });

  it('a mainOnly rebuild never adopts a fallback, so never drops a suspect', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'm.txt', 'm\n'));
    pushBranch(originDir, 'lane/bad', (dir) => writeFile(dir, 'bad.txt', 'x\n'));
    addOverlay(cloneDir, { ref: 'lane/bad' }, { env });
    const { runSmoke, endTick } = passWhileSiblingStartsTick(cloneDir, env, { failWhenFile: 'bad.txt' });
    await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(readReadyCandidate(cloneDir, env)?.kind).toBe('fallback');
    endTick();
    advanceMain(originDir, (dir) => writeFile(dir, 'x.txt', 'x\n'));

    const second = await rebuildClone({
      root: cloneDir, env, runSmoke: async () => PASS, prState: async () => null, lockOpts: LOCK_OPTS, mainOnly: true,
    });
    expect(second.reason).not.toBe('ready-adopted');
    expect(readOverlays(cloneDir, { env }).map((o) => o.ref)).toEqual(['lane/bad']);
  });

  it('a passed fallback is still adopted (and still drops the bad overlay) after main moved', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    const mainSha = advanceMain(originDir, (dir) => writeFile(dir, 'm.txt', 'm\n'));
    pushBranch(originDir, 'lane/bad', (dir) => writeFile(dir, 'bad.txt', 'x\n'));
    addOverlay(cloneDir, { ref: 'lane/bad' }, { env });
    const { runSmoke, endTick } = passWhileSiblingStartsTick(cloneDir, env, { failWhenFile: 'bad.txt' });
    await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(readReadyCandidate(cloneDir, env)?.kind).toBe('fallback');
    endTick();
    advanceMain(originDir, (dir) => writeFile(dir, 't.txt', 't\n'));

    const noSmoke = mock(async () => PASS);
    const second = await rebuildClone({
      root: cloneDir, env, runSmoke: noSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(second.reason).toBe('ready-adopted');
    expect(second.readyMatch).toBe('fallback-main-moved');
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(mainSha);
    expect(readOverlays(cloneDir, { env })).toEqual([]);
    expect(noSmoke).not.toHaveBeenCalled();
  });

  it('a passed fallback is NOT adopted once the suspect overlay itself was re-pushed', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'm.txt', 'm\n'));
    pushBranch(originDir, 'lane/bad', (dir) => writeFile(dir, 'bad.txt', 'x\n'));
    addOverlay(cloneDir, { ref: 'lane/bad' }, { env });
    const { runSmoke, endTick } = passWhileSiblingStartsTick(cloneDir, env, { failWhenFile: 'bad.txt' });
    await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    endTick();
    // A new push of the suspect, on top of its old tip.
    const author = join(mktemp('we-rebuild-ready-author-'), 'w');
    gitOk(dirname(author), ['clone', '-q', '-b', 'lane/bad', originDir, author]);
    writeFile(author, 'fixed.txt', 'f\n');
    gitOk(author, ['add', '-A']);
    gitOk(author, ['commit', '-q', '-m', 'fix: lane/bad']);
    gitOk(author, ['push', '-q', 'origin', 'HEAD:refs/heads/lane/bad']);

    const smoke = mock(async () => PASS);
    const second = await rebuildClone({
      root: cloneDir, env, runSmoke: smoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(second.reason).not.toBe('ready-adopted');
    expect(readOverlays(cloneDir, { env }).map((o) => o.ref)).toEqual(['lane/bad']);
    expect(smoke).toHaveBeenCalled();
  });
// Each case drives several real-git rebuilds; the 5s default times out on a loaded host.
}, 60_000);

describe('matchReadyCandidate — pure', () => {
  const base = {
    kind: 'candidate', prevHead: 'H', tree: 'T1', passedAt: new Date(1_000_000).toISOString(),
    adopt: {
      finalSha: 'S1', inputsKey: 'K1', mainSha: 'M1', applied: [{ ref: 'lane/a', sha: 'a1' }],
    },
  };
  const plan = {
    finalSha: 'S2', inputsKey: 'K2', mainSha: 'M2', applied: [],
  };
  const args = (over = {}) => ({
    ready: base,
    plan,
    prevHead: 'H',
    treeOf: () => 'T2',
    stillWanted: () => true,
    verifyBuilt: () => true,
    nowMs: 1_000_000 + 60_000,
    maxAgeMs: 3_600_000,
    ...over,
  });
  const fallback = {
    ...base,
    kind: 'fallback',
    forInputsKey: 'KF',
    dropRefs: [{ ref: 'lane/bad', sha: 'b1' }],
    adopt: { ...base.adopt, applied: [] },
  };

  it('never adopts an unverified superseded build — even an overlay-free one (`applied: []`)', () => {
    const ready = { ...base, adopt: { ...base.adopt, finalSha: 'EVIL', mainSha: 'EVIL', applied: [] } };
    expect(matchReadyCandidate(args({ ready, verifyBuilt: () => false })).reason).toBe('unverified-build');
    const noVerifier = args({ ready });
    delete noVerifier.verifyBuilt;
    expect(matchReadyCandidate(noVerifier).reason).toBe('unverified-build'); // refuses by default
  });
  it('a fallback for the same inputs adopts; after main moved only while the suspect is unchanged', () => {
    expect(matchReadyCandidate(args({ ready: fallback, plan: { ...plan, inputsKey: 'KF' } })).match).toBe('fallback');
    expect(matchReadyCandidate(args({ ready: fallback, overlayTip: () => 'b1' })).match).toBe('fallback-main-moved');
    expect(matchReadyCandidate(args({ ready: fallback, overlayTip: () => 'b2' })).reason).toBe('fallback-inputs-moved');
    const gone = matchReadyCandidate(args({ ready: fallback, overlayTip: () => 'b2', registered: (r) => r !== 'lane/bad' }));
    expect(gone.match).toBe('fallback-main-moved');
    expect(gone.dropRefs).toEqual([]); // already off the list — nothing to drop, no misleading alert
    expect(matchReadyCandidate(args({ ready: fallback, verifyBuilt: () => false })).reason).toBe('unverified-build');
  });
  it('a mainOnly rebuild (allowFallback: false) never adopts a fallback, even one whose wanted set is empty', () => {
    const m = matchReadyCandidate(args({
      ready: fallback, allowFallback: false, stillWanted: () => false, registered: () => true, overlayTip: () => 'b2',
    }));
    expect(m.reason).toBe('fallback-not-allowed');
  });

  it('ignores a ready candidate verified on another base', () => {
    expect(matchReadyCandidate(args({ prevHead: 'OTHER' })).adopt).toBeNull();
  });
  it('ignores an expired one', () => {
    expect(matchReadyCandidate(args({ nowMs: 1_000_000 + 7_200_000 })).reason).toBe('expired');
  });
  it('same tree under a new sha adopts the CURRENT plan commit', () => {
    const m = matchReadyCandidate(args({ treeOf: () => 'T1' }));
    expect(m.match).toBe('same-tree');
    expect(m.adopt.finalSha).toBe('S2');
  });
  it('superseded only while every carried overlay is still wanted', () => {
    expect(matchReadyCandidate(args()).match).toBe('superseded');
    expect(matchReadyCandidate(args({ stillWanted: () => false })).reason).toBe('overlay-no-longer-wanted');
  });
  it('a rejection of the same inputs recorded after the pass wins', () => {
    const rejected = { inputsKey: 'K1', at: new Date(1_000_000 + 1000).toISOString() };
    expect(matchReadyCandidate(args({ rejected })).reason).toBe('rejected-since');
  });
});
