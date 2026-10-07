/**
 * @file scripts/lib/__tests__/daemon-rebuild.test.mjs
 * @description Module C (`../daemon-rebuild.mjs`) — real temp git repos throughout: a bare `origin.git`, a
 *   working `clone` (the thing under test, exactly the shape a real daemon clone has: on `main`, tracking
 *   `origin`), and throwaway "author" clones used only to push commits/branches from OUTSIDE the daemon clone's
 *   own working tree — the daemon clone itself must stay clean and on `main` for `findUnsafeLocalState` to pass,
 *   so no test ever runs a mutating git command directly against it except through `rebuildClone`/
 *   `dryRunRebuild` themselves (the two "dirty"/"local-commits" tests are the deliberate exceptions — they
 *   dirty the clone on purpose to prove it gets refused). `runSmoke` and `prState` are always injected fakes —
 *   this suite never spawns the real live smoke gate or a real `gh` call. Every state/lock/overlay dir is a
 *   fresh mkdtemp per fixture via `env`, never `~/.claude/*`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, utimesSync, symlinkSync, lstatSync, chmodSync,
} from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  isClaimStampOnlyEdit, restoreStrayClaimStamps,
  planRebuild, findUnsafeLocalState, rebuildClone, dryRunRebuild, readRebuildState, rebuildStatePath, readRebuildStarvation,
  isDaemonManagedClone, daemonConveyorStateRoot, materializeCandidate, removeCandidate, previewOverlayConflict,
  readyBuildVerified, resolveOverlayConflict, OVERLAY_EDGE_RESOLVE_ENV,
} from '../daemon-rebuild.mjs';
import {
  addOverlay, removeOverlay, readOverlays, overlayFilePath, writeOverlays, recordEdgeResolution,
} from '../daemon-overlays.mjs';
import { acquireRead, releaseRead } from '../daemon-clone-lock.mjs';
import { gitRun } from '../main-staleness.mjs';
import { readOverlayConflictWakes, markOverlayConflictWake } from '../overlay-conflict-wake.mjs';

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

/** A throwaway clone of `originDir`, used to push commits/branches without ever touching the daemon clone
 *  under test. Its parent dir is registered for cleanup (the clone itself doesn't need separate registration). */
function makeAuthorClone(originDir) {
  const parent = mktemp('we-daemon-rebuild-author-');
  const dir = join(parent, 'w');
  const r = spawnSync('git', ['clone', '-q', originDir, dir], {
    encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
  });
  if (r.status !== 0) throw new Error(`clone failed: ${r.stderr}`);
  return dir;
}

/** Push one new commit onto `ref` (created from `base`, default `origin/main`) via a throwaway author clone.
 *  Returns the pushed commit sha. */
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

/** Advance `main` on origin with one new commit via a throwaway author clone. */
function advanceMain(originDir, mutate) {
  return pushBranch(originDir, 'main', mutate, { base: 'origin/main' });
}

function deleteBranch(originDir, ref) {
  const dir = makeAuthorClone(originDir);
  gitOk(dir, ['push', '-q', 'origin', '--delete', ref]);
}

function writeFile(dir, name, content) {
  const full = join(dir, name);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** Fresh {origin (bare), clone (working tree under test), env} fixture. The clone starts on `main`, clean,
 *  tracking `origin`, one commit. Every per-clone state/lock/overlay dir is a fresh mkdtemp threaded via `env`. */
function makeFixture() {
  const base = mktemp('we-daemon-rebuild-fixture-');
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
  gitOk(cloneDir, ['fetch', '-q', 'origin']); // guarantee refs/remotes/origin/main exists locally

  const stateDir = mktemp('we-daemon-rebuild-state-');
  const lockDir = mktemp('we-daemon-rebuild-lock-');
  const overlayDir = mktemp('we-daemon-rebuild-overlay-');
  const env = {
    ...process.env,
    WE_DAEMON_STATE_DIR: stateDir,
    WE_DAEMON_CLONE_LOCK_ROOT: lockDir,
    WE_DAEMON_OVERLAY_DIR: overlayDir,
  };
  return { base, originDir, cloneDir, stateDir, lockDir, overlayDir, env };
}

function passSmoke() {
  return vi.fn(async () => ({ verdict: 'pass', attempts: 1, smoke: { results: [] } }));
}

function conflictFixture({ replay = false } = {}) {
  const f = makeFixture();
  const a = pushBranch(f.originDir, 'lane/a', (dir) => writeFile(dir, 'README.md', 'A\n'));
  let b = pushBranch(f.originDir, 'lane/b', (dir) => writeFile(dir, 'README.md', replay ? 'A\n' : 'B\n'));
  if (replay) b = pushBranch(f.originDir, 'lane/b', (dir) => {
    writeFile(dir, 'README.md', 'B\n');
    writeFile(dir, 'extra.txt', 'extra\n');
  }, { base: 'origin/lane/b' });
  gitOk(f.cloneDir, ['fetch', '-q', 'origin']);
  const runGit = (args, opts = {}) => gitRun(args, { cwd: f.cloneDir, env: { ...f.env, ...opts.env } });
  const main = gitOk(f.cloneDir, ['rev-parse', 'origin/main']).trim();
  const overlays = [{ ref: 'lane/a', pr: 1 }, { ref: 'lane/b', pr: 2 }];
  return { ...f, a, b, runGit, main, overlays };
}

describe('overlay conflict resolution', () => {
  const plan = (f, options = {}) => planRebuild({
    git: f.runGit, headSha: f.main, mainRef: 'origin/main', overlays: f.overlays, ...options,
  });

  it('replays a conflicting overlay deterministically and verifies the ready build', async () => {
    const f = conflictFixture({ replay: true });
    const result = await plan(f);
    expect(result.decisions[1]).toMatchObject({ action: 'apply', reason: 'applied-replay', sha: f.b });
    expect(result.applied[1]).toMatchObject({ sha: f.b, resolvedVia: 'replay' });
    expect(result.alerts).toContainEqual({ kind: 'overlay-conflict-resolved', detail: { ref: 'lane/b', pr: 2, via: 'replay' } });
    expect(gitOk(f.cloneDir, ['show', `${result.finalSha}:README.md`])).toBe('B\n');
    expect(gitOk(f.cloneDir, ['show', `${result.finalSha}:extra.txt`])).toBe('extra\n');
    expect(gitOk(f.cloneDir, ['log', '-1', '--format=%B', result.finalSha])).toContain('(resolved via replay)');
    expect((await plan(f)).finalSha).toBe(result.finalSha);
    expect(readyBuildVerified({ git: f.runGit, adopt: result, mainTip: f.main, prevHead: f.main })).toBe(true);
    const plain = { ...result, applied: result.applied.map(({ resolvedVia, ...a }) => a) };
    expect(readyBuildVerified({ git: f.runGit, adopt: plain, mainTip: f.main, prevHead: f.main })).toBe(false);
  });

  it('refuses to replay an overlay whose branch has merge-only changes instead of adopting a partial tree', async () => {
    const f = makeFixture();
    const a = pushBranch(f.originDir, 'lane/a', (dir) => writeFile(dir, 'README.md', 'A\n'));
    pushBranch(f.originDir, 'lane/b', (dir) => writeFile(dir, 'README.md', 'A\n'));
    // whole-branch merge against `a` conflicts on README, but commit-by-commit replay would apply cleanly
    pushBranch(f.originDir, 'lane/b', (dir) => writeFile(dir, 'README.md', 'B\n'), { base: 'origin/lane/b' });
    pushBranch(f.originDir, 'side', (dir) => writeFile(dir, 'side.txt', 'side\n'));
    // lane/b = merge of `side` into lane/b whose resolution adds a file that exists in NO non-merge commit.
    const author = makeAuthorClone(f.originDir);
    gitOk(author, ['fetch', '-q', 'origin']);
    gitOk(author, ['checkout', '-q', '-B', 'lane/b', 'origin/lane/b']);
    gitOk(author, ['merge', '-q', '--no-ff', '--no-commit', 'origin/side']);
    writeFile(author, 'merge-only.txt', 'only in the merge resolution\n');
    gitOk(author, ['add', '-A']);
    gitOk(author, ['commit', '-q', '-m', 'merge side with adaptation']);
    gitOk(author, ['push', '-q', 'origin', 'HEAD:refs/heads/lane/b']);
    const b = gitOk(author, ['rev-parse', 'HEAD']).trim();
    gitOk(f.cloneDir, ['fetch', '-q', 'origin']);
    const runGit = (args, opts = {}) => gitRun(args, { cwd: f.cloneDir, env: { ...f.env, ...opts.env } });
    const main = gitOk(f.cloneDir, ['rev-parse', 'origin/main']).trim();

    expect(resolveOverlayConflict({ git: runGit, cur: a, ovSha: b, ref: 'lane/b' }))
      .toMatchObject({ ok: false, tried: ['replay'] });

    const result = await planRebuild({
      git: runGit, headSha: main, mainRef: 'origin/main', overlays: [{ ref: 'lane/a', pr: 1 }, { ref: 'lane/b', pr: 2 }],
    });
    expect(result.decisions[1]).toMatchObject({ action: 'drop', reason: 'conflict' });
    expect(result.alerts.map((x) => x.kind)).not.toContain('overlay-conflict-resolved');
    expect(gitOk(f.cloneDir, ['ls-tree', '-r', '--name-only', result.finalSha])).not.toContain('side.txt');
  });

  it('uses a reviewed edge containing the current head and keeps the PR parent', async () => {
    const f = conflictFixture();
    const edgeSha = pushBranch(f.originDir, 'edge/lane/b', (dir) => {
      writeFile(dir, 'README.md', 'A\n');
      writeFile(dir, 'reviewed.txt', 'resolution\n');
    }, { base: 'origin/lane/b' });
    gitOk(f.cloneDir, ['fetch', '-q', 'origin']);
    f.overlays[1] = { ...f.overlays[1], edgeResolution: { sha: edgeSha, by: 'operator', at: '2026-10-05T00:00:00Z' } };
    const result = await plan(f);
    expect(result.decisions[1]).toMatchObject({ action: 'apply', reason: 'applied-edge-ref', sha: f.b });
    expect(result.applied[1]).toMatchObject({ resolvedVia: 'edge-ref', edgeSha });
    expect(gitOk(f.cloneDir, ['rev-parse', `${result.finalSha}^2`]).trim()).toBe(f.b);
    expect(result.alerts).toContainEqual({ kind: 'overlay-conflict-resolved', detail: { ref: 'lane/b', pr: 2, via: 'edge-ref', edgeSha } });
  });

  it('ignores an edge for an older head and reports the unresolved files', async () => {
    const f = conflictFixture();
    gitOk(f.cloneDir, ['update-ref', 'refs/remotes/origin/edge/lane/b', f.main]);
    f.overlays[1] = { ...f.overlays[1], edgeResolution: { sha: f.main, by: 'operator', at: '2026-10-05T00:00:00Z' } };
    const result = await plan(f);
    expect(result.decisions[1]).toMatchObject({ action: 'drop', reason: 'conflict', files: ['README.md'] });
    expect(result.alerts).toContainEqual({
      kind: 'overlay-conflict-unresolved',
      detail: { ref: 'lane/b', pr: 2, sha: f.b, files: ['README.md'], tried: ['edge-ref', 'replay'] },
    });
  });

  // Review round 1, finding 2 (trust): an `origin/edge/<ref>` branch is adopted only because it EXISTS and contains
  // the PR head — anyone with push access could plant one and the daemon would run its tree. Adoption now needs a
  // recorded resolution (actor + sha) on the overlay entry, and the fetched tip must equal that sha.
  describe('edge provenance', () => {
    const pushEdge = (f) => {
      const edgeSha = pushBranch(f.originDir, 'edge/lane/b', (dir) => {
        writeFile(dir, 'README.md', 'A\n');
        writeFile(dir, 'reviewed.txt', 'resolution\n');
      }, { base: 'origin/lane/b' });
      gitOk(f.cloneDir, ['fetch', '-q', 'origin']);
      return edgeSha;
    };

    it('never adopts an arbitrary pushed edge branch that has no recorded resolution', async () => {
      const f = conflictFixture();
      pushEdge(f);
      const result = await plan(f);
      expect(result.decisions[1]).toMatchObject({ action: 'drop', reason: 'conflict' });
      expect(gitOk(f.cloneDir, ['ls-tree', '-r', '--name-only', result.finalSha])).not.toContain('reviewed.txt');
      expect(result.alerts).toContainEqual({
        kind: 'overlay-conflict-unresolved',
        detail: { ref: 'lane/b', pr: 2, sha: f.b, files: ['README.md'], tried: ['replay'] },
      });
    });

    it('never adopts an edge whose tip differs from the recorded resolution sha', async () => {
      const f = conflictFixture();
      pushEdge(f);
      f.overlays[1] = { ...f.overlays[1], edgeResolution: { sha: f.a, by: 'operator', at: '2026-10-05T00:00:00Z' } };
      const result = await plan(f);
      expect(result.decisions[1]).toMatchObject({ action: 'drop', reason: 'conflict' });
      expect(result.applied.map((a) => a.resolvedVia)).not.toContain('edge-ref');
    });

    it('adopts the edge when its tip equals the recorded resolution sha', async () => {
      const f = conflictFixture();
      const edgeSha = pushEdge(f);
      f.overlays[1] = { ...f.overlays[1], edgeResolution: { sha: edgeSha, by: 'operator', at: '2026-10-05T00:00:00Z' } };
      const result = await plan(f);
      expect(result.applied[1]).toMatchObject({ resolvedVia: 'edge-ref', edgeSha });
    });

    it('verifies a ready edge-resolved build only against the current recorded approval', async () => {
      const f = conflictFixture();
      const edgeSha = pushEdge(f);
      f.overlays[1] = { ...f.overlays[1], edgeResolution: { sha: edgeSha, by: 'operator' } };
      const result = await plan(f);
      expect(result.applied[1]).toMatchObject({ resolvedVia: 'edge-ref', edgeSha });
      const verify = (approvedEdgeShaFor) => readyBuildVerified({
        git: f.runGit, adopt: result, mainTip: f.main, prevHead: f.main, approvedEdgeShaFor,
      });
      expect(verify(() => edgeSha)).toBe(true);
      expect(verify(() => null)).toBe(false); // approval withdrawn / never recorded
      expect(verify(() => f.a)).toBe(false); // approval now names a different tip
    });

    it('refuses a malformed recorded sha instead of matching it loosely', async () => {
      const f = conflictFixture();
      const edgeSha = pushEdge(f);
      for (const sha of [edgeSha.slice(0, 12), edgeSha.toUpperCase(), '', null, 7]) {
        const overlays = [f.overlays[0], { ...f.overlays[1], edgeResolution: { sha, by: 'operator' } }];
        const result = await plan(f, { overlays });
        expect(result.decisions[1]).toMatchObject({ action: 'drop', reason: 'conflict' });
      }
    });
  });

  // Review round 1, finding 1 (fail closed): a failed `ls-remote` / edge `fetch` left a previously fetched
  // `origin/edge/<ref>` in place, so a branch whose remote was deleted (or just not re-confirmed this run) stayed
  // eligible for conflict resolution. Any edge not re-confirmed on THIS run must be unavailable.
  describe('edge discovery fails closed', () => {
    const seeded = (f) => {
      const edgeSha = pushBranch(f.originDir, 'edge/lane/b', (dir) => {
        writeFile(dir, 'README.md', 'A\n');
        writeFile(dir, 'reviewed.txt', 'resolution\n');
      }, { base: 'origin/lane/b' });
      gitOk(f.cloneDir, ['fetch', '-q', 'origin']); // the "previous run" left a cached edge ref behind
      const list = f.overlays.map((o) => (o.ref === 'lane/b'
        ? { ...o, edgeResolution: { sha: edgeSha, by: 'operator', at: '2026-10-05T00:00:00Z' } } : o));
      writeOverlays(f.cloneDir, list, { env: f.env });
      return edgeSha;
    };
    const failing = (match) => vi.fn((args, opts) => (match(args)
      ? { status: 128, stdout: '', stderr: 'simulated failure' } : gitRun(args, opts)));
    const cachedEdge = (f) => git(f.cloneDir, ['rev-parse', '--verify', 'refs/remotes/origin/edge/lane/b']).status === 0;

    it.each([
      ['ls-remote fails', (args) => args[0] === 'ls-remote'],
      ['the edge fetch fails', (args) => args[0] === 'fetch' && args.some((a) => a.startsWith('+refs/heads/edge/'))],
    ])('does not reuse a cached edge when %s (rebuild)', async (_name, match) => {
      const f = conflictFixture();
      seeded(f);
      const result = await rebuildClone({
        root: f.cloneDir, env: f.env, run: failing(match), runSmoke: passSmoke(), prState: () => null, lockOpts: LOCK_OPTS,
      });
      expect(result.plan.decisions[1]).toMatchObject({ action: 'drop', reason: 'conflict' });
      expect(result.plan.applied.map((a) => a.resolvedVia)).not.toContain('edge-ref');
      expect(cachedEdge(f)).toBe(false);
    });

    it('does not fetch an edge the remote advertises at a different tip than the recorded sha', async () => {
      const f = conflictFixture();
      seeded(f);
      const other = 'c'.repeat(40);
      writeOverlays(f.cloneDir, f.overlays.map((o) => (o.ref === 'lane/b'
        ? { ...o, edgeResolution: { sha: other, by: 'operator' } } : o)), { env: f.env });
      const run = vi.fn(gitRun);
      const result = await rebuildClone({
        root: f.cloneDir, env: f.env, run, runSmoke: passSmoke(), prState: () => null, lockOpts: LOCK_OPTS,
      });
      expect(result.plan.decisions[1]).toMatchObject({ action: 'drop', reason: 'conflict' });
      expect(run.mock.calls.some(([args]) => args[0] === 'fetch' && args.some((a) => a.startsWith('+refs/heads/edge/')))).toBe(false);
      expect(cachedEdge(f)).toBe(false);
    });

    it('stops edge discovery for the run when a cached edge cannot be deleted', async () => {
      const f = conflictFixture();
      seeded(f);
      const run = failing((args) => args[0] === 'update-ref' && args[1] === '-d' && args[2].includes('/edge/'));
      await rebuildClone({
        root: f.cloneDir, env: f.env, run, runSmoke: passSmoke(), prState: () => null, lockOpts: LOCK_OPTS,
      });
      // no ls-remote/fetch is attempted on top of a ref we could not clear. (Residual, by design: a ref that
      // survives a failed delete is still adopted only while its tip equals the operator-recorded sha.)
      expect(run.mock.calls.some(([args]) => args[0] === 'ls-remote' || args[0] === 'fetch' && args.some((a) => a.startsWith('+refs/heads/edge/')))).toBe(false);
    });

    it('never deletes the tracking ref of an overlay that is itself named edge/<x>', async () => {
      const f = conflictFixture();
      pushBranch(f.originDir, 'edge/lane/b', (dir) => writeFile(dir, 'edge-only.txt', 'x\n'));
      gitOk(f.cloneDir, ['fetch', '-q', 'origin']);
      writeOverlays(f.cloneDir, [{ ref: 'lane/b', pr: 2 }, { ref: 'edge/lane/b', pr: 3 }], { env: f.env });
      const result = await rebuildClone({
        root: f.cloneDir, env: f.env, run: vi.fn(gitRun), runSmoke: passSmoke(), prState: () => null, lockOpts: LOCK_OPTS,
      });
      expect(result.plan.decisions.find((d) => d.ref === 'edge/lane/b')?.reason).not.toBe('ref-gone');
    });

    it('does not reuse a cached edge whose remote branch is gone', async () => {
      const f = conflictFixture();
      seeded(f);
      gitOk(f.cloneDir, ['push', '-q', 'origin', '--delete', 'edge/lane/b']);
      const result = await rebuildClone({
        root: f.cloneDir, env: f.env, run: vi.fn(gitRun), runSmoke: passSmoke(), prState: () => null, lockOpts: LOCK_OPTS,
      });
      expect(result.plan.decisions[1]).toMatchObject({ action: 'drop', reason: 'conflict' });
      expect(cachedEdge(f)).toBe(false);
    });

    it('does not reuse a cached edge in a dry-run preview when ls-remote fails', async () => {
      const f = conflictFixture();
      seeded(f);
      const preview = await dryRunRebuild({
        root: f.cloneDir, env: f.env, run: failing((args) => args[0] === 'ls-remote'), prState: () => null,
      });
      expect(preview.plan.decisions[1]).toMatchObject({ action: 'drop', reason: 'conflict' });
    });
  });

  it('preserves the old conflict behavior when resolution is disabled', async () => {
    const f = conflictFixture({ replay: true });
    const result = await plan(f, { edgeResolve: false });
    expect(result.decisions[1]).toEqual({ ref: 'lane/b', pr: 2, action: 'drop', reason: 'conflict', sha: f.b });
    expect(result.alerts).toEqual([]);
  });

  it('falls through git exceptions and reports failures without throwing', () => {
    const f = conflictFixture({ replay: true });
    const cur = f.a;
    const brokenEdge = (args, opts) => {
      if (args.some((arg) => arg.includes('origin/edge/'))) throw new Error('edge unavailable');
      return f.runGit(args, opts);
    };
    const approvedEdgeSha = f.a; // a recorded resolution, so the edge path is actually attempted
    expect(resolveOverlayConflict({ git: brokenEdge, cur, ovSha: f.b, ref: 'lane/b', approvedEdgeSha })).toMatchObject({ ok: true, via: 'replay' });
    const brokenCommit = (args, opts) => args[0] === 'commit-tree' ? { status: 128 } : brokenEdge(args, opts);
    expect(resolveOverlayConflict({ git: brokenCommit, cur, ovSha: f.b, ref: 'lane/b', approvedEdgeSha })).toEqual({ ok: false, files: ['README.md'], tried: ['replay'] });
    expect(resolveOverlayConflict({ git: () => { throw new Error('git failed'); }, cur, ovSha: f.b, ref: 'lane/b', approvedEdgeSha }))
      .toEqual({ ok: false, files: [], tried: ['replay'] });
  });

  it('fetches edges once, removes stale edges and wakes then clears the conflicting PR', async () => {
    const f = conflictFixture();
    for (const o of f.overlays) addOverlay(f.cloneDir, o, { env: f.env });
    gitOk(f.cloneDir, ['update-ref', 'refs/remotes/origin/edge/lane/b', f.a]);
    const run = vi.fn(gitRun);
    const runSmoke = passSmoke();
    const rebuild = () => rebuildClone({ root: f.cloneDir, env: f.env, run, runSmoke, prState: () => null, lockOpts: LOCK_OPTS });
    const first = await rebuild();
    expect(first.plan.decisions[1].reason).toBe('conflict');
    expect(git(f.cloneDir, ['rev-parse', '--verify', 'refs/remotes/origin/edge/lane/b']).status).not.toBe(0);
    // nothing recorded → no overlay is an edge candidate, so the remote is never even asked about edge branches
    expect(run.mock.calls.filter(([args]) => args[0] === 'ls-remote')).toHaveLength(0);
    expect(readOverlayConflictWakes(f.env).get(2)).toMatchObject({ pr: 2, ref: 'lane/b', files: ['README.md'], clone: f.cloneDir });
    const edgeSha = pushBranch(f.originDir, 'edge/lane/b', (dir) => {
      writeFile(dir, 'README.md', 'A\n');
      writeFile(dir, 'reviewed.txt', 'resolution\n');
    }, { base: 'origin/lane/b' });
    // pushed but not yet approved: still never adopted
    const unapproved = await rebuild();
    expect(unapproved.plan.decisions[1].reason).toBe('conflict');
    expect(git(f.cloneDir, ['rev-parse', '--verify', 'refs/remotes/origin/edge/lane/b']).status).not.toBe(0);
    recordEdgeResolution(f.cloneDir, 'lane/b', { sha: edgeSha, by: 'operator', reason: 'reviewed' }, { env: f.env });
    expect(readOverlays(f.cloneDir, { env: f.env })[1].edgeResolution).toMatchObject({ sha: edgeSha, by: 'operator', reason: 'reviewed' });
    run.mockClear();
    const second = await rebuild();
    expect(second.adopted).toBe(true);
    expect(second.plan.applied[1]).toMatchObject({ resolvedVia: 'edge-ref', edgeSha });
    expect(runSmoke).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.filter(([args]) => args[0] === 'ls-remote')).toHaveLength(1);
    expect(run.mock.calls.filter(([args]) => args[0] === 'fetch' && args.some((a) => a.startsWith('+refs/heads/edge/')))).toHaveLength(1);
    expect(readOverlayConflictWakes(f.env).has(2)).toBe(false);
    markOverlayConflictWake(f.env, { pr: 2, ref: 'lane/b', files: ['README.md'], clone: f.cloneDir,
      at: new Date(Date.now() - 7 * 3600_000).toISOString() });
    removeOverlay(f.cloneDir, 'lane/b', { env: f.env });
    await rebuild();
    expect(readOverlayConflictWakes(f.env, { maxAgeMs: Infinity }).has(2)).toBe(false);
  });

  it('honors the disable env in rebuilds and previews without fetching edges', async () => {
    const f = conflictFixture({ replay: true });
    f.env[OVERLAY_EDGE_RESOLVE_ENV] = '0';
    for (const o of f.overlays) addOverlay(f.cloneDir, o, { env: f.env });
    const run = vi.fn(gitRun);
    const preview = await dryRunRebuild({ root: f.cloneDir, env: f.env, run, prState: () => null });
    expect(preview.plan.decisions[1].reason).toBe('conflict');
    const result = await rebuildClone({ root: f.cloneDir, env: f.env, run, runSmoke: passSmoke(), prState: () => null, lockOpts: LOCK_OPTS });
    expect(result.plan.decisions[1].reason).toBe('conflict');
    expect(result.plan.alerts).toEqual([]);
    expect(run.mock.calls.some(([args]) => args[0] === 'ls-remote')).toBe(false);
    expect(readOverlayConflictWakes(f.env).size).toBe(0);
  });
});

// x5wbsbc — a smoke that fails ONLY the candidate carrying `file` (the bad change) and passes every other tree,
// in particular the last-good control the rebuild now smokes before calling a failure a code regression (a stub
// that failed EVERY tree would read, correctly, as a broken harness — `smoke-harness-broken`).
function failsWhenFile(file, result) {
  return vi.fn(async ({ root }) => (existsSync(join(root, file))
    ? result
    : { verdict: 'pass', attempts: 1, smoke: { results: [] } }));
}

// Short lock waits — no reader ever contends in this suite, so acquireWrite should always succeed immediately,
// but keep the budget small regardless per the design spec's "use short lock waits in tests".
const LOCK_OPTS = { waitMs: 2000, pollMs: 20 };

beforeEach(() => {
  tempDirs.length = 0;
});

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe('rebuildClone', () => {
  it('applies a clean overlay', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/clean-a', (dir) => writeFile(dir, 'a.txt', 'hello a\n'));
    addOverlay(cloneDir, { ref: 'lane/clean-a' }, { env });

    const runSmoke = passSmoke();
    const result = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.moved).toBe(true);
    expect(result.adopted).toBe(true);
    expect(runSmoke).toHaveBeenCalledTimes(1);
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(result.head);
    expect(existsSync(join(cloneDir, 'a.txt'))).toBe(true);
    expect(readOverlays(cloneDir, { env }).map((o) => o.ref)).toEqual(['lane/clean-a']);

    const state = readRebuildState(cloneDir, env);
    expect(state.adopted?.head).toBe(result.head);
  });

  // #4044 live: a full smoke took 209s under the write lock (lane acquire 172s on a busy pool); every daemon on
  // the clone skipped its ticks meanwhile. The rebuild now hands the smoke the files changed since the LAST
  // LIVE-VERIFIED build, so tree-code checks whose code is untouched are not re-run.
  it('passes the smoke the files changed since the adopted build — and null when the current head was never verified', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    // First rebuild: HEAD is not a recorded adopted build yet ⇒ full smoke (changedFiles null).
    advanceMain(originDir, (dir) => writeFile(dir, 'backlog/1.md', 'one\n'));
    const first = passSmoke();
    const r1 = await rebuildClone({ root: cloneDir, env, runSmoke: first, prState: async () => null, lockOpts: LOCK_OPTS });
    expect(r1.adopted).toBe(true);
    expect(first.mock.calls[0][0].changedFiles).toBeNull();
    // Second rebuild from the adopted head ⇒ exactly the diff.
    advanceMain(originDir, (dir) => writeFile(dir, 'backlog/2.md', 'two\n'));
    const second = passSmoke();
    const r2 = await rebuildClone({ root: cloneDir, env, runSmoke: second, prState: async () => null, lockOpts: LOCK_OPTS });
    expect(r2.adopted).toBe(true);
    expect(second.mock.calls[0][0].changedFiles).toEqual(['backlog/2.md']);
  });

  // Live 2026-10-03: lane-pool probes are now SKIPPED under a busy pool. A build adopted that way never ran those
  // checks live, so the NEXT smoke must not treat it as "last live-verified" (null ⇒ every check runs).
  it('a build adopted with a busy-pool skip is not the baseline for skip-unchanged: the next smoke is full', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'backlog/1.md', 'one\n'));
    const skipping = vi.fn(async () => ({
      verdict: 'pass', attempts: 1,
      smoke: { pass: true, results: [{ name: 'lane-pool-list', ok: true, skipped: true, skipReason: 'busy-pool', detail: 'skipped: busy pool' }] },
    }));
    const r1 = await rebuildClone({ root: cloneDir, env, runSmoke: skipping, prState: async () => null, lockOpts: LOCK_OPTS });
    expect(r1.adopted).toBe(true);
    expect(readRebuildState(cloneDir, env).busySkippedTrees).toHaveLength(1);
    advanceMain(originDir, (dir) => writeFile(dir, 'backlog/2.md', 'two\n'));
    const second = passSmoke();
    await rebuildClone({ root: cloneDir, env, runSmoke: second, prState: async () => null, lockOpts: LOCK_OPTS });
    expect(second.mock.calls[0][0].changedFiles).toBeNull(); // not ['backlog/2.md']
    // that one ran everything and passed without a skip: the third is a normal diff again
    advanceMain(originDir, (dir) => writeFile(dir, 'backlog/3.md', 'three\n'));
    const third = passSmoke();
    await rebuildClone({ root: cloneDir, env, runSmoke: third, prState: async () => null, lockOpts: LOCK_OPTS });
    expect(third.mock.calls[0][0].changedFiles).toEqual(['backlog/3.md']);
  });

  // #4044 live (10:28-10:40 ET): the fix daemon's rebuild waited silently ~10 min on the review daemon's long tick.
  it('a live reader holding the clone makes the rebuild wait at most 60s by default, logged, then give up', async () => {
    const { originDir, cloneDir, env, lockDir } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'y.txt', 'y\n'));
    const { acquireRead } = await import('../daemon-clone-lock.mjs');
    expect(acquireRead(cloneDir, { owner: 'review-daemon-sim', lockRoot: lockDir, pid: process.pid }).ok).toBe(true);
    let t = 1_000_000;
    const log = { error: vi.fn() };
    const runSmoke = passSmoke();
    const r = await rebuildClone({
      root: cloneDir, env, runSmoke, log, prState: async () => null, now: () => t, sleep: async (ms) => { t += ms; },
      lockOpts: { pollMs: 1000 },
    });
    expect(r).toMatchObject({ moved: false, reason: 'tick-in-progress', heldBy: 'review-daemon-sim' });
    expect(t - 1_000_000).toBeLessThanOrEqual(61_000);
    expect(runSmoke).not.toHaveBeenCalled();
    const lines = log.error.mock.calls.map(([m]) => m);
    expect(lines.some((m) => /waiting up to 60s for live reader\(s\) review-daemon-sim/.test(m))).toBe(true);
    expect(lines.some((m) => /gave up after 60s/.test(m))).toBe(true);
  });

  // live 2026-10-05 07:09-07:33 ET: two daemons' long ticks starved every 60s wait — no rebuild for 20+ min.
  it('after 2 consecutive starved attempts the next waits the longer starved wait, and a success resets it', async () => {
    const { originDir, cloneDir, env, lockDir } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'y.txt', 'y\n'));
    const { acquireRead, releaseRead } = await import('../daemon-clone-lock.mjs');
    expect(acquireRead(cloneDir, { owner: 'review-daemon-sim', lockRoot: lockDir, pid: process.pid }).ok).toBe(true);
    let t = 1_000_000;
    const attempt = async (sleep = async (ms) => { t += ms; }) => rebuildClone({
      root: cloneDir, env, runSmoke: passSmoke(), log: { error: vi.fn() }, prState: async () => null, now: () => t, sleep,
      lockOpts: { pollMs: 1000 },
    });
    for (let i = 0; i < 2; i += 1) {
      const s = t;
      expect((await attempt()).reason).toBe('tick-in-progress');
      expect(t - s).toBeLessThanOrEqual(61_000);
    }
    expect(readRebuildStarvation(cloneDir, env)).toBe(2);
    // third attempt: the reader finishes its tick after 2 min — within the (3 min default) starved wait, so it adopts
    const s = t;
    const r = await attempt(async (ms) => {
      t += ms;
      if (t - s >= 2 * 60_000) releaseRead(cloneDir, { owner: 'review-daemon-sim', lockRoot: lockDir });
    });
    expect(r.reason).not.toBe('tick-in-progress');
    expect(t - s).toBeGreaterThanOrEqual(2 * 60_000);
    expect(readRebuildStarvation(cloneDir, env)).toBe(0);
  });

  // xa4qo7n: the smoke no longer holds any lock (it runs against a disposable candidate worktree) — this only
  // checks the informational `smoke-slow` alert still fires and still carries per-check timings.
  it('a smoke that takes 60s+ raises a smoke-slow alert with per-check timings', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'x.txt', 'x\n'));
    let t = 1_000_000;
    const runSmoke = vi.fn(async () => { t += 209_000; return { verdict: 'pass', attempts: 1, smoke: { results: [{ name: 'lane-acquire-release', ok: true, ms: 171834 }] } }; });
    const r = await rebuildClone({ root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS, now: () => t });
    const slow = r.alerts.find((a) => a.kind === 'smoke-slow');
    expect(slow?.detail).toMatchObject({ ms: 209_000, checks: 'lane-acquire-release:171834ms' });
  });

  it('removes an overlay whose content already landed on main in a different (squashed) form', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/squashed', (dir) => writeFile(dir, 'squash.txt', 'same content\n'));
    // main picks up the SAME content plus an unrelated change in ONE commit — a different patch-id than the
    // overlay's own commit, so `git cherry` will NOT see it as upstream-equivalent; only the tree-equality
    // fallback (planRebuild step 5) catches this.
    advanceMain(originDir, (dir) => {
      writeFile(dir, 'squash.txt', 'same content\n');
      writeFile(dir, 'unrelated.txt', 'noise\n');
    });
    addOverlay(cloneDir, { ref: 'lane/squashed' }, { env });

    const runSmoke = passSmoke();
    const result = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.moved).toBe(true);
    expect(readOverlays(cloneDir, { env })).toEqual([]);
    expect(result.alerts.some((a) => a.kind === 'overlay-auto-dropped' && a.detail?.reason === 'in-main')).toBe(true);
    expect(existsSync(join(cloneDir, 'unrelated.txt'))).toBe(true);
    expect(existsSync(join(cloneDir, 'squash.txt'))).toBe(true);
  });

  it('drops a conflicting overlay but still applies a clean one, and the conflicting ref stays in the list', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    writeFile(cloneDir, 'shared.txt', 'original\n');
    gitOk(cloneDir, ['add', '-A']);
    gitOk(cloneDir, ['commit', '-q', '-m', 'seed shared.txt']);
    gitOk(cloneDir, ['push', '-q', 'origin', 'main']);

    pushBranch(originDir, 'lane/conflict', (dir) => writeFile(dir, 'shared.txt', 'overlay change\n'));
    advanceMain(originDir, (dir) => writeFile(dir, 'shared.txt', 'main change\n'));
    pushBranch(originDir, 'lane/clean-b', (dir) => writeFile(dir, 'b.txt', 'hello b\n'));

    addOverlay(cloneDir, { ref: 'lane/conflict' }, { env });
    addOverlay(cloneDir, { ref: 'lane/clean-b' }, { env });

    const runSmoke = passSmoke();
    const result = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.moved).toBe(true);
    const refs = readOverlays(cloneDir, { env }).map((o) => o.ref);
    expect(refs).toEqual(['lane/conflict', 'lane/clean-b']); // conflict stays in the list, unchanged position
    expect(result.alerts.some((a) => a.kind === 'overlay-conflict-dropped')).toBe(true);
    expect(existsSync(join(cloneDir, 'b.txt'))).toBe(true);
  });

  it('removes an overlay whose PR is MERGED', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/merged-pr', (dir) => writeFile(dir, 'c.txt', 'hello c\n'));
    addOverlay(cloneDir, { ref: 'lane/merged-pr', pr: 42 }, { env });

    const runSmoke = passSmoke();
    const prState = vi.fn(async (pr) => (pr === 42 ? 'MERGED' : null));
    const result = await rebuildClone({ root: cloneDir, env, runSmoke, prState, lockOpts: LOCK_OPTS });

    expect(readOverlays(cloneDir, { env })).toEqual([]);
    expect(result.alerts.some((a) => a.kind === 'overlay-auto-dropped' && a.detail?.reason === 'pr-merged')).toBe(true);
    expect(existsSync(join(cloneDir, 'c.txt'))).toBe(false);
  });

  it('removes an overlay whose ref was deleted on origin', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/gone', (dir) => writeFile(dir, 'd.txt', 'hello d\n'));
    addOverlay(cloneDir, { ref: 'lane/gone' }, { env });
    deleteBranch(originDir, 'lane/gone');

    const runSmoke = passSmoke();
    const result = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(readOverlays(cloneDir, { env })).toEqual([]);
    expect(result.alerts.some((a) => a.kind === 'overlay-auto-dropped' && a.detail?.reason === 'ref-gone')).toBe(true);
    expect(existsSync(join(cloneDir, 'd.txt'))).toBe(false);
  });

  it('refuses a dirty tree (uncommitted change to a TRACKED file) without touching anything', async () => {
    const { cloneDir, env } = makeFixture();
    writeFile(cloneDir, 'README.md', 'oops uncommitted edit\n'); // README.md is tracked (see makeFixture)
    const headBefore = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();

    const runSmoke = passSmoke();
    const result = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.moved).toBe(false);
    expect(result.reason).toBe('dirty');
    expect(runSmoke).not.toHaveBeenCalled();
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(readFileSync(join(cloneDir, 'README.md'), 'utf8')).toBe('oops uncommitted edit\n');
  });

  it('an untracked, non-ignored file never blocks the rebuild — it adopts and the file survives untouched', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/clean-stray', (dir) => writeFile(dir, 'stray-overlay.txt', 'hello\n'));
    addOverlay(cloneDir, { ref: 'lane/clean-stray' }, { env });
    writeFile(cloneDir, 'stray.txt', 'untracked and harmless\n');

    const runSmoke = passSmoke();
    const result = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.moved).toBe(true);
    expect(result.adopted).toBe(true);
    expect(result.reason).not.toBe('dirty');
    expect(result.reason).not.toBe('untracked-collision');
    expect(existsSync(join(cloneDir, 'stray.txt'))).toBe(true);
    expect(readFileSync(join(cloneDir, 'stray.txt'), 'utf8')).toBe('untracked and harmless\n');
    expect(result.alerts.some((a) => a.kind === 'untracked-kept'
      && a.detail?.paths?.includes('stray.txt'))).toBe(true);
  });

  it('an untracked file colliding with a path the new main adds refuses with untracked-collision', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    const headBefore = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();
    advanceMain(originDir, (dir) => writeFile(dir, 'newfile.txt', 'from main\n'));
    writeFile(cloneDir, 'newfile.txt', 'local untracked content\n');

    const runSmoke = passSmoke();
    const result = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.moved).toBe(false);
    expect(result.reason).toBe('untracked-collision');
    expect(result.untracked).toEqual(['newfile.txt']);
    expect(runSmoke).not.toHaveBeenCalled();
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(readFileSync(join(cloneDir, 'newfile.txt'), 'utf8')).toBe('local untracked content\n');
    expect(result.alerts.some((a) => a.kind === 'untracked-collision'
      && a.detail?.paths?.includes('newfile.txt'))).toBe(true);
  });

  it('refuses a local unpushed commit', async () => {
    const { cloneDir, env } = makeFixture();
    writeFile(cloneDir, 'local-only.txt', 'local\n');
    gitOk(cloneDir, ['add', '-A']);
    gitOk(cloneDir, ['commit', '-q', '-m', 'local commit never pushed']);
    const headBefore = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();

    const runSmoke = passSmoke();
    const result = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.moved).toBe(false);
    expect(result.reason).toBe('local-commits');
    expect(runSmoke).not.toHaveBeenCalled();
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
  });

  it('smoke "code" restores HEAD, records the rejection, and the next call short-circuits without smoking', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/broken', (dir) => writeFile(dir, 'broken.txt', 'x\n'));
    // pinned: a pinned overlay is never dropped by the plain-main fallback (x5wbsbc), so this exercises the hold.
    addOverlay(cloneDir, { ref: 'lane/broken', pinned: true }, { env });
    const prevHead = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();

    const runSmoke = failsWhenFile('broken.txt', {
      verdict: 'code', attempts: 1, smoke: { results: [{ ok: false, name: 'x', detail: 'boom' }] },
    });
    const first = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(first.reason).toBe('smoke-rejected');
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(prevHead);
    expect(readRebuildState(cloneDir, env).rejected).toBeTruthy();

    const second = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(second.reason).toBe('still-rejected');
    expect(runSmoke).toHaveBeenCalledTimes(2); // candidate + the last-good control (x5wbsbc); not called again
  });

  it('smoke "transient" restores HEAD, never records a rejection, and re-runs smoke next call', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/flaky', (dir) => writeFile(dir, 'flaky.txt', 'x\n'));
    addOverlay(cloneDir, { ref: 'lane/flaky' }, { env });
    const prevHead = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();

    const runSmoke = vi.fn(async () => ({
      verdict: 'transient', attempts: 3, smoke: { results: [{ ok: false, name: 'x', detail: 'ETIMEDOUT' }] },
    }));
    const first = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(first.reason).toBe('smoke-transient');
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(prevHead);
    expect(readRebuildState(cloneDir, env).rejected).toBeNull();

    const second = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(second.reason).toBe('smoke-transient');
    expect(runSmoke).toHaveBeenCalledTimes(2); // re-ran, not short-circuited
  });

  it('is deterministic — the same inputs twice yield up-to-date and the identical finalSha', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/det', (dir) => writeFile(dir, 'det.txt', 'x\n'));
    addOverlay(cloneDir, { ref: 'lane/det' }, { env });

    const runSmoke = passSmoke();
    const first = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(first.moved).toBe(true);

    const second = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(second.moved).toBe(false);
    expect(second.reason).toBe('up-to-date');
    expect(second.plan.finalSha).toBe(first.head);
  });

  it('recovers a stale index.lock and proceeds', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'e.txt', 'x\n'));
    const lockPath = join(cloneDir, '.git', 'index.lock');
    writeFileSync(lockPath, '');
    const oldSeconds = Date.now() / 1000 - 3600;
    utimesSync(lockPath, oldSeconds, oldSeconds);

    const runSmoke = passSmoke();
    const result = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.alerts.some((a) => a.kind === 'index-lock-recovered')).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(result.moved).toBe(true);
  });

  // Advisory 2026-09-25 (PR #2625): a corrupt overlay file read as "no overlays", so the next rebuild silently
  // built main alone and dropped every registered fix, with no alert anywhere.
  it('a corrupt overlay-state file refuses the rebuild with an alert, never builds main alone', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/kept', (dir) => writeFile(dir, 'kept.txt', 'x\n'));
    addOverlay(cloneDir, { ref: 'lane/kept' }, { env });
    const first = await rebuildClone({ root: cloneDir, env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS });
    expect(first.adopted).toBe(true);
    const headBefore = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();
    advanceMain(originDir, (dir) => writeFile(dir, 'main-next.txt', 'y\n'));
    writeFileSync(overlayFilePath(cloneDir, env), '{ not json');

    const runSmoke = passSmoke();
    const result = await rebuildClone({ root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS });

    expect(result.moved).toBe(false);
    expect(result.reason).toBe('overlay-state-corrupt');
    expect(result.alerts.some((a) => a.kind === 'overlay-state-corrupt')).toBe(true);
    expect(runSmoke).not.toHaveBeenCalled();
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(existsSync(join(cloneDir, 'kept.txt'))).toBe(true);
    expect(readFileSync(overlayFilePath(cloneDir, env), 'utf8')).toBe('{ not json'); // left for a person to inspect

    const preview = await dryRunRebuild({ root: cloneDir, env, prState: async () => null });
    expect(preview.overlayStateCorrupt).toBe(true);
    expect(preview.wouldDo).toBe('refuse');
  });

  // Advisory 2026-09-25 (PR #2625): a kept untracked file was reported only on ticks that moved the tree, so it
  // could sit in the clone through every no-op tick with no signal.
  it('a kept untracked file is re-reported on every tick, including an up-to-date one', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/tick', (dir) => writeFile(dir, 'tick.txt', 'x\n'));
    addOverlay(cloneDir, { ref: 'lane/tick' }, { env });
    writeFile(cloneDir, 'planted.txt', 'untracked\n');
    const opts = { root: cloneDir, env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS };
    expect((await rebuildClone(opts)).adopted).toBe(true);

    const second = await rebuildClone(opts);
    expect(second.reason).toBe('up-to-date');
    expect(second.alerts.some((a) => a.kind === 'untracked-kept' && a.detail?.paths?.includes('planted.txt'))).toBe(true);
    expect(existsSync(join(cloneDir, 'planted.txt'))).toBe(true);
  });

  it('mainOnly ignores every overlay', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/refused', (dir) => writeFile(dir, 'f.txt', 'x\n'));
    addOverlay(cloneDir, { ref: 'lane/refused' }, { env });

    const runSmoke = passSmoke();
    const result = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, mainOnly: true, lockOpts: LOCK_OPTS,
    });

    expect(result.alerts.some((a) => a.kind === 'overlays-refused-main-only')).toBe(true);
    expect(existsSync(join(cloneDir, 'f.txt'))).toBe(false);
    expect(readOverlays(cloneDir, { env })).toHaveLength(1); // never removed — just ignored this pass
    expect(runSmoke).not.toHaveBeenCalled(); // main alone == current HEAD already, nothing to build
  });

  // Module E follow-up (#4044) — an already-ADOPTED overlay's own commit becomes unreachable from any remote
  // ref once its PR is squash-merged (a different sha lands on main) AND its origin branch is deleted for
  // cleanup — exactly the shape a normal squash-merge-and-delete-branch PR leaves behind. Before `knownInputs`
  // fed the adopted state's own shas into `findUnsafeLocalState`, that orphaned commit (reachable from HEAD via
  // the earlier rebuild's merge commit, but from no remaining remote-tracking ref) looked exactly like a real
  // local commit and froze the rebuild with `local-commits`, forever, on a perfectly safe clone.
  it('an adopted overlay squash-merged + branch-deleted on origin is auto-dropped next rebuild — never refused as local-commits', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/squash-drop', (dir) => writeFile(dir, 'squash-drop.txt', 'overlay content\n'));
    addOverlay(cloneDir, { ref: 'lane/squash-drop' }, { env });

    const runSmoke = passSmoke();
    const first = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(first.moved).toBe(true);
    expect(first.adopted).toBe(true);
    expect(existsSync(join(cloneDir, 'squash-drop.txt'))).toBe(true);

    // Origin: the overlay's content lands on main as a squash (a NEW, different commit than the overlay's own),
    // then its own branch is deleted — the overlay's original commit is now reachable from HEAD (via the first
    // rebuild's merge commit) but from no remaining remote-tracking ref at all.
    advanceMain(originDir, (dir) => writeFile(dir, 'squash-drop.txt', 'overlay content\n'));
    deleteBranch(originDir, 'lane/squash-drop');

    const second = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(second.reason).not.toBe('local-commits');
    expect(second.moved).toBe(true);
    expect(readOverlays(cloneDir, { env })).toEqual([]);
    expect(second.alerts.some((a) => a.kind === 'overlay-auto-dropped' && a.detail?.reason === 'ref-gone')).toBe(true);
    expect(existsSync(join(cloneDir, 'squash-drop.txt'))).toBe(true);
    // Lands on PLAIN main — no overlay merge commit left in the picture.
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(gitOk(cloneDir, ['rev-parse', 'origin/main']).trim());
  });

  /** Seed `state.quarantine` exactly as a failed rollback leaves it (rebuildClone's own state file). */
  function seedQuarantine(cloneDir, env, prevHead) {
    const file = rebuildStatePath(cloneDir, env);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ quarantine: { prevHead, reason: 'smoke-code-rollback-failed' } }));
  }

  it('recovers from quarantine even when a harmless untracked file sits in the tree', async () => {
    const { cloneDir, env } = makeFixture();
    seedQuarantine(cloneDir, env, gitOk(cloneDir, ['rev-parse', 'HEAD']).trim());
    writeFile(cloneDir, 'daemon-sidecar.json', '{}\n'); // untracked, not ignored, absent from prevHead's tree

    const result = await rebuildClone({
      root: cloneDir, env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.reason).not.toBe('quarantined');
    expect(readRebuildState(cloneDir, env).quarantine).toBeNull();
    expect(readFileSync(join(cloneDir, 'daemon-sidecar.json'), 'utf8')).toBe('{}\n'); // kept, never deleted
  });

  it('stays quarantined when a tracked file is dirty', async () => {
    const { cloneDir, env } = makeFixture();
    seedQuarantine(cloneDir, env, gitOk(cloneDir, ['rev-parse', 'HEAD']).trim());
    writeFile(cloneDir, 'README.md', 'local edit\n');

    const result = await rebuildClone({
      root: cloneDir, env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.reason).toBe('quarantined');
    expect(readRebuildState(cloneDir, env).quarantine).not.toBeNull();
    expect(readFileSync(join(cloneDir, 'README.md'), 'utf8')).toBe('local edit\n');
  });

  it('stays quarantined rather than let the recovery reset overwrite an untracked file prevHead has content at', async () => {
    const { cloneDir, env } = makeFixture();
    writeFile(cloneDir, 'collide.txt', 'tracked at prevHead\n');
    gitOk(cloneDir, ['add', '-A']);
    gitOk(cloneDir, ['commit', '-q', '-m', 'add collide.txt']);
    const prevHead = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();
    gitOk(cloneDir, ['rm', '-q', 'collide.txt']);
    gitOk(cloneDir, ['commit', '-q', '-m', 'drop collide.txt']);
    gitOk(cloneDir, ['push', '-q', 'origin', 'main']);
    seedQuarantine(cloneDir, env, prevHead);
    writeFile(cloneDir, 'collide.txt', 'untracked local content\n');

    const result = await rebuildClone({
      root: cloneDir, env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.reason).toBe('quarantined');
    expect(readRebuildState(cloneDir, env).quarantine).not.toBeNull();
    expect(readFileSync(join(cloneDir, 'collide.txt'), 'utf8')).toBe('untracked local content\n');
  });

  // ── Step 0: interrupted-rebuild recovery (`state.inProgress`) ──────────────────────────────────────────────

  /** Seed `state.inProgress` exactly as Step 5 writes it just before its `reset --hard`. */
  function seedInProgress(cloneDir, env, inProgress) {
    const file = rebuildStatePath(cloneDir, env);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ inProgress }));
  }
  /** A pid on this host that has certainly exited (the child is reaped before spawnSync returns). */
  function deadPid() {
    return spawnSync(process.execPath, ['-e', '']).pid;
  }
  const OTHER_SHA = 'f'.repeat(40);
  const interruptedAlerts = (result) => result.alerts.filter((a) => a.kind.startsWith('rebuild-interrupted-'));

  // xa4qo7n: under this design a `reset --hard` NEVER runs before its candidate's live smoke has already
  // passed (the smoke runs unlocked, against a disposable worktree, before root is ever touched — see
  // daemon-rebuild.mjs's file header). So a crash with HEAD == target can only mean the smoke for that EXACT
  // build already passed; recovery promotes it straight to `adopted` from the inProgress record's own echoed
  // plan fields, with NO re-smoke (a real behavior change from the pre-fix design, where the smoke ran AFTER
  // the reset and a crash here really could mean an unverified build on disk — PR #2625's own advisory).
  it('recovers an interrupted rebuild whose owner died after its reset landed (HEAD == target) — promotes directly, no re-smoke', async () => {
    const { cloneDir, env } = makeFixture();
    const head = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();
    seedInProgress(cloneDir, env, {
      pid: deadPid(), host: hostname(), prevHead: OTHER_SHA, target: head, startedAt: new Date().toISOString(),
      inputsKey: 'seeded-inputs-key', mainSha: head, applied: [], verified: true,
    });

    const runSmoke = passSmoke();
    const result = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(interruptedAlerts(result).map((a) => a.kind)).toEqual(['rebuild-interrupted-recovered']);
    expect(result.reason).toBe('recovered-adopted');
    expect(result.adopted).toBe(true);
    expect(runSmoke).not.toHaveBeenCalled();
    expect(readRebuildState(cloneDir, env).inProgress).toBeNull();
    expect(readRebuildState(cloneDir, env).adopted?.inputsKey).toBe('seeded-inputs-key');
  });

  // xa4qo7n / PR #2625 advisory: a rebuild killed AFTER its `reset --hard <target>` but BEFORE its state write
  // landed leaves HEAD == target with `inProgress` still on disk. Replays that crash window with real git —
  // the build it crashed onto is, BY THIS DESIGN'S OWN INVARIANT, always one whose smoke already passed (see
  // the test just above), so recovery never re-smokes it.
  function crashAfterReset(cloneDir, env) {
    writeFile(cloneDir, 'new-code.txt', 'already-smoked\n');
    gitOk(cloneDir, ['add', '-A']);
    gitOk(cloneDir, ['commit', '-q', '-m', 'the build the dead rebuild reset onto (its smoke already passed)']);
    gitOk(cloneDir, ['push', '-q', 'origin', 'main']);
    const target = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();
    const prevHead = gitOk(cloneDir, ['rev-parse', 'HEAD~1']).trim();
    seedInProgress(cloneDir, env, {
      pid: deadPid(), host: hostname(), prevHead, target, startedAt: new Date().toISOString(),
      inputsKey: 'ik-crash-1', mainSha: target, applied: [], verified: true,
    });
    return { target, prevHead };
  }

  it('crash after reset landed but before the state write: the next call promotes it directly, with no re-smoke', async () => {
    const { cloneDir, env } = makeFixture();
    const { target } = crashAfterReset(cloneDir, env);
    const runSmoke = passSmoke();
    const result = await rebuildClone({ root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS });
    expect(runSmoke).not.toHaveBeenCalled();
    expect(result.adopted).toBe(true);
    expect(result.reason).toBe('recovered-adopted');
    expect(readRebuildState(cloneDir, env).adopted.head).toBe(target);
    expect(readRebuildState(cloneDir, env).adopted.inputsKey).toBe('ik-crash-1');
  });

  // PR #2731 review: a record written by the PRE-fix code (reset BEFORE smoke) carries no `verified` marker, and
  // the pre-fix recovery could leave `state.unverified` behind. Either one at HEAD means a build that was NEVER
  // smoked is on disk — it must be rolled back and re-smoked off-lock, never promoted straight to adopted.
  function crashAfterLegacyReset(cloneDir, env, { asUnverified = false } = {}) {
    const { target, prevHead } = crashAfterReset(cloneDir, env);
    const file = rebuildStatePath(cloneDir, env);
    const legacy = asUnverified
      ? { unverified: { head: target, prevHead } }
      : { inProgress: { pid: deadPid(), host: hostname(), prevHead, target, startedAt: new Date().toISOString() } };
    writeFileSync(file, JSON.stringify(legacy));
    return { target, prevHead };
  }

  it.each([
    ['a legacy inProgress record (no verified marker)', false],
    ['a legacy state.unverified record', true],
  ])('%s at HEAD is never promoted unsmoked — a failing smoke leaves the clone back on prevHead', async (_label, asUnverified) => {
    const { cloneDir, env } = makeFixture();
    const { target, prevHead } = crashAfterLegacyReset(cloneDir, env, { asUnverified });
    // The control fails the same check as the candidate, which now adopts as no worse by default; opt out so the
    // failing smoke still holds the clone on prevHead (the behavior this case pins).
    env.WE_DAEMON_HARNESS_BROKEN_ADOPT_NOT_WORSE = '0';
    const runSmoke = vi.fn(async () => ({ verdict: 'code', attempts: 1, smoke: { results: [{ ok: false, name: 'x', detail: 'broken' }] } }));
    const result = await rebuildClone({ root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS });
    // x5wbsbc: the candidate, then the last-good (prevHead) control smoke — never an unsmoked promotion.
    expect(runSmoke).toHaveBeenCalledTimes(2);
    expect(result.adopted).toBeFalsy();
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(prevHead);
    const state = readRebuildState(cloneDir, env);
    expect(state.adopted?.head).not.toBe(target);
    expect(state.inProgress).toBeNull();
    expect(state.unverified).toBeNull();
  });

  it.each([
    ['a legacy inProgress record (no verified marker)', false],
    ['a legacy state.unverified record', true],
  ])('%s at HEAD is re-smoked, then adopted once the smoke passes', async (_label, asUnverified) => {
    const { cloneDir, env } = makeFixture();
    const { target } = crashAfterLegacyReset(cloneDir, env, { asUnverified });
    const runSmoke = passSmoke();
    const result = await rebuildClone({ root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS });
    expect(runSmoke).toHaveBeenCalledTimes(1);
    expect(result.adopted).toBe(true);
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(target);
    expect(readRebuildState(cloneDir, env).adopted.head).toBe(target);
  });

  it('recovers an aged interrupted rebuild from another host when HEAD is back at a clean prevHead', async () => {
    const { cloneDir, env: baseEnv } = makeFixture();
    const env = { ...baseEnv, WE_DAEMON_REBUILD_STALE_MS: String(30 * 60_000) }; // never the host shell's value
    const head = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();
    seedInProgress(cloneDir, env, {
      pid: 1, host: 'some-other-host', prevHead: head, target: OTHER_SHA,
      startedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    });

    const result = await rebuildClone({
      root: cloneDir, env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(interruptedAlerts(result).map((a) => a.kind)).toEqual(['rebuild-interrupted-recovered']);
    expect(readRebuildState(cloneDir, env).inProgress).toBeNull();
  });

  it('refuses as unrecoverable when the owner is dead and HEAD is neither prevHead nor target', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'pending.txt', 'x\n'));
    const headBefore = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();
    const inProgress = {
      pid: deadPid(), host: hostname(), prevHead: OTHER_SHA, target: 'e'.repeat(40), startedAt: new Date().toISOString(),
    };
    seedInProgress(cloneDir, env, inProgress);

    const runSmoke = passSmoke();
    const result = await rebuildClone({ root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS });

    expect(result.moved).toBe(false);
    expect(result.reason).toBe('rebuild-interrupted-unrecoverable');
    expect(interruptedAlerts(result).map((a) => a.kind)).toEqual(['rebuild-interrupted-unrecoverable']);
    expect(runSmoke).not.toHaveBeenCalled();
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(readRebuildState(cloneDir, env).inProgress).toEqual(inProgress); // never silently cleared
  });

  it('refuses as unrecoverable when HEAD is at prevHead but a tracked file is dirty', async () => {
    const { cloneDir, env } = makeFixture();
    seedInProgress(cloneDir, env, {
      pid: deadPid(), host: hostname(), prevHead: gitOk(cloneDir, ['rev-parse', 'HEAD']).trim(), target: OTHER_SHA,
      startedAt: new Date().toISOString(),
    });
    writeFile(cloneDir, 'README.md', 'half-reset edit\n');

    const result = await rebuildClone({
      root: cloneDir, env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.reason).toBe('rebuild-interrupted-unrecoverable');
    expect(readRebuildState(cloneDir, env).inProgress).not.toBeNull();
    expect(readFileSync(join(cloneDir, 'README.md'), 'utf8')).toBe('half-reset edit\n');
  });

  it('leaves a fresh inProgress owned by a live pid alone (no recovery verdict either way)', async () => {
    const { cloneDir, env } = makeFixture();
    seedInProgress(cloneDir, env, {
      pid: process.pid, host: hostname(), prevHead: OTHER_SHA, target: 'e'.repeat(40), startedAt: new Date().toISOString(),
    });

    const result = await rebuildClone({
      root: cloneDir, env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(interruptedAlerts(result)).toEqual([]);
    expect(result.reason).toBe('up-to-date');
    expect(readRebuildState(cloneDir, env).inProgress).toMatchObject({ pid: process.pid });
  });

  // ── single-flight build lease (PR #2731 review) ────────────────────────────────────────────────────────────

  function seedBuilding(cloneDir, env, building) {
    const file = rebuildStatePath(cloneDir, env);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ building }));
  }

  it('a live sibling build lease makes a second rebuild yield rebuild-in-progress — no candidate, no smoke', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'm.txt', 'x\n'));
    const sibling = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
    try {
      const building = {
        token: 'sib', pid: sibling.pid, host: hostname(), startedAt: new Date().toISOString(), path: join(env.WE_DAEMON_STATE_DIR, 'sib-candidate'),
      };
      seedBuilding(cloneDir, env, building);
      const runSmoke = passSmoke();
      const headBefore = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();
      const result = await rebuildClone({ root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS });
      expect(result.reason).toBe('rebuild-in-progress');
      expect(runSmoke).not.toHaveBeenCalled();
      expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
      expect(result.alerts.map((a) => a.kind)).not.toContain('clone-held-stale');
      expect(readRebuildState(cloneDir, env).building).toEqual(building); // the sibling's lease is left alone
    } finally {
      sibling.kill('SIGKILL');
    }
  });

  it.each([
    ['a dead pid', () => ({ pid: deadPid(), startedAt: new Date().toISOString() }), true],
    ['this process, but no build of ours is running (an unreleased lease)', () => ({ pid: process.pid, startedAt: new Date().toISOString() }), true],
    // Aged but its owner may still be reading it: taken over, but its tree is left alone (unique paths never collide).
    ['an aged lease from another host', () => ({ pid: 1, host: 'some-other-host', startedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString() }), false],
  ])('an abandoned lease (%s) is taken over and the rebuild adopts; its leftover is torn down only if its owner is gone', async (_label, make, removed) => {
    const { originDir, cloneDir, env } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'm.txt', 'x\n'));
    const leftover = join(env.WE_DAEMON_STATE_DIR, 'abandoned-candidate');
    mkdirSync(leftover, { recursive: true });
    seedBuilding(cloneDir, env, {
      token: 'old', host: hostname(), path: leftover, ...make(),
    });
    const runSmoke = passSmoke();
    const result = await rebuildClone({ root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS });
    expect(result.adopted).toBe(true);
    expect(runSmoke).toHaveBeenCalledTimes(1);
    expect(existsSync(leftover)).toBe(!removed);
    expect(readRebuildState(cloneDir, env).building).toBeNull();
  });

  it('each attempt smokes its own unique candidate path, and a rejected build releases its lease', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'm.txt', 'x\n'));
    const roots = [];
    const runSmoke = vi.fn(async ({ root }) => {
      roots.push(root);
      return { verdict: 'transient', attempts: 1, smoke: { results: [{ ok: false, name: 'x', detail: 'flake' }] } };
    });
    await rebuildClone({ root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS });
    expect(readRebuildState(cloneDir, env).building).toBeNull();
    await rebuildClone({ root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS });
    expect(roots).toHaveLength(2);
    expect(roots[0]).not.toBe(roots[1]);
    for (const r of roots) expect(existsSync(r)).toBe(false);
  });

  // ── Step 5/6: rollback failures on the live rebuildClone path (injected failing `run`) ──────────────────────

  /** The real git runner, except `reset --hard <sha>` for any of `failShas` exits non-zero. With `applyFirst`
   *  the real reset still runs before the failure is reported, so the tree really moves (a partial reset). */
  function failingResetRun(failShas, { applyFirst = false } = {}) {
    const fail = new Set([].concat(failShas));
    return vi.fn((args, opts) => {
      if (args[0] === 'reset' && args[1] === '--hard' && fail.has(args[2])) {
        if (applyFirst) gitRun(args, opts);
        return { status: 1, stdout: '', stderr: 'injected reset failure' };
      }
      return gitRun(args, opts);
    });
  }
  const resetCalls = (run) => run.mock.calls.map((c) => c[0]).filter((a) => a[0] === 'reset').map((a) => a[2]);

  // xa4qo7n: a smoke that fails (or throws) runs against a DISPOSABLE candidate worktree, before `root` is ever
  // touched — so `root` never moves for a bad smoke, there is nothing to roll back, and no quarantine is
  // possible from this path any more (unlike the pre-fix design, where `root` had already been reset onto the
  // candidate BEFORE the smoke ran, so a bad smoke needed a real rollback that could itself fail).
  it.each([
    ['code', 'smoke-rejected'],
    ['transient', 'smoke-transient'],
    // live 2026-09-26: GitHub rejecting the env's token is an ENVIRONMENT fault — named, held, never rejected.
    ['auth-broken', 'github-auth-broken'],
  ])('a "%s" smoke verdict never touches root at all — no reset, no rollback, no quarantine', async (verdict, reason) => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, `lane/rollback-${verdict}`, (dir) => writeFile(dir, 'r.txt', 'x\n'));
    addOverlay(cloneDir, { ref: `lane/rollback-${verdict}`, pinned: true }, { env });
    const prevHead = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();

    // Even though this `run` would fail a `reset --hard` back to prevHead, it must never be CALLED for a
    // failing smoke — root was never moved off prevHead in the first place.
    const run = failingResetRun(prevHead);
    const runSmoke = failsWhenFile('r.txt', {
      verdict, attempts: 1, smoke: { results: [{ ok: false, name: 'x', detail: 'boom' }] },
    });
    const result = await rebuildClone({
      root: cloneDir, env, run, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.moved).toBe(false);
    expect(result.reason).toBe(reason);
    expect(resetCalls(run)).toEqual([]); // never even attempted
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(prevHead);
    const state = readRebuildState(cloneDir, env);
    expect(state.quarantine).toBeNull();
    expect(state.inProgress).toBeNull();
    if (verdict === 'code') expect(state.rejected).not.toBeNull();
    else expect(state.rejected).toBeNull();
    if (verdict === 'auth-broken') {
      expect(result.alerts.map((x) => x.kind)).toContain('github-auth-broken');
      expect(result.alerts.map((x) => x.kind)).not.toContain('smoke-rejected');
      expect(state.held?.reason).toBe('github-auth-broken');
    }
  });

  it('a smoke that throws is treated like a rejection — root untouched, no quarantine', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/throws', (dir) => writeFile(dir, 't.txt', 'x\n'));
    addOverlay(cloneDir, { ref: 'lane/throws' }, { env });
    const prevHead = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();

    const run = failingResetRun(prevHead);
    const result = await rebuildClone({
      root: cloneDir, env, run, runSmoke: vi.fn(async () => { throw new Error('smoke crashed'); }),
      prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.reason).toBe('smoke-threw');
    expect(resetCalls(run)).toEqual([]);
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(prevHead);
    const state = readRebuildState(cloneDir, env);
    expect(state.quarantine).toBeNull();
    expect(state.inProgress).toBeNull();
  });

  // These two still fully apply: a PASSING smoke is always followed by the ONE real `reset --hard` this module
  // performs (see finalizeRebuild), and that reset can still fail for its own (disk/permissions) reasons.
  it('a failed reset onto the target (reached only after a passing smoke) rolls back, and clears inProgress', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/reset-fails', (dir) => writeFile(dir, 'u.txt', 'x\n'));
    addOverlay(cloneDir, { ref: 'lane/reset-fails' }, { env });
    const prevHead = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();
    const plan = (await dryRunRebuild({ root: cloneDir, env, prState: async () => null })).plan;

    // The failing reset really moves the tree first, so only the rollback can bring HEAD back.
    const run = failingResetRun(plan.finalSha, { applyFirst: true });
    const runSmoke = passSmoke();
    const result = await rebuildClone({
      root: cloneDir, env, run, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(runSmoke).toHaveBeenCalledTimes(1); // the smoke ran (and passed) BEFORE the reset was ever attempted
    expect(result.reason).toBe('reset-failed');
    expect(result.rolledBack).toBe(true);
    expect(resetCalls(run)).toEqual([plan.finalSha, prevHead]);
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(prevHead);
    expect(existsSync(join(cloneDir, 'u.txt'))).toBe(false);
    expect(readRebuildState(cloneDir, env).inProgress).toBeNull();
    expect(readRebuildState(cloneDir, env).quarantine).toBeNull();
  });

  it('a failed reset onto the target whose rollback ALSO fails quarantines the clone (smoke had already passed)', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/reset-and-rollback-fail', (dir) => writeFile(dir, 'v.txt', 'x\n'));
    addOverlay(cloneDir, { ref: 'lane/reset-and-rollback-fail' }, { env });
    const prevHead = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();
    const plan = (await dryRunRebuild({ root: cloneDir, env, prState: async () => null })).plan;

    const run = failingResetRun([plan.finalSha, prevHead]);
    const runSmoke = passSmoke();
    const result = await rebuildClone({ root: cloneDir, env, run, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS });

    expect(runSmoke).toHaveBeenCalledTimes(1);
    expect(result.reason).toBe('reset-failed');
    expect(result.rolledBack).toBe(false);
    expect(result.quarantine).toBe(true);
    const state = readRebuildState(cloneDir, env);
    expect(state.quarantine).toEqual({ prevHead, reason: 'reset-rollback-failed' });
    expect(state.inProgress).toBeNull();

    // The next tick refuses to build anything on the unknown (half-reset) tree while quarantined — the
    // quarantine recovery in Step 0 refuses before ever reaching another smoke, so the call count doesn't grow.
    const next = await rebuildClone({ root: cloneDir, env, run, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS });
    expect(next.reason).toBe('quarantined');
    expect(runSmoke).toHaveBeenCalledTimes(1);
  });
});

// xa4qo7n LIVE BUG (2026-09-26 15:20 ET, proving this very fix on wev-review-daemon): a `node_modules/`
// `.gitignore` entry (trailing slash — "directories only") does NOT match a SYMLINK of the same name, so the
// node_modules symlink materializeCandidate creates made `daemon-live-smoke.mjs#checkTreeStaysClean` see the
// candidate as dirty on EVERY rebuild in a repo with that (near-universal) ignore convention — poisoning the
// reject-cache permanently (`tree-stays-clean` is `mayBeTransient:false`). Fixed by writing a bare `node_modules`
// line (no trailing slash) to the repo's SHARED `info/exclude` — confirmed empirically it is NOT per-worktree.
describe('materializeCandidate — node_modules symlink never reads as tree dirt (xa4qo7n)', () => {
  it('a real node_modules DIRECTORY, ignored only via a trailing-slash .gitignore rule, symlinks in clean', async () => {
    const { cloneDir, env } = makeFixture();
    writeFile(cloneDir, '.gitignore', 'node_modules/\n');
    gitOk(cloneDir, ['add', '-A']);
    gitOk(cloneDir, ['commit', '-q', '-m', 'add .gitignore']);
    gitOk(cloneDir, ['push', '-q', 'origin', 'main']);
    mkdirSync(join(cloneDir, 'node_modules', 'some-pkg'), { recursive: true });
    writeFile(cloneDir, 'node_modules/some-pkg/index.js', 'module.exports = 1;\n');

    const sha = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();
    const result = materializeCandidate({
      root: cloneDir, sha, run: gitRun, env,
    });
    expect(result.ok).toBe(true);
    try {
      const status = spawnSync('git', ['status', '--porcelain'], { cwd: result.path, encoding: 'utf8' });
      expect(status.stdout.trim()).toBe(''); // the whole point: no `?? node_modules` line
      expect(existsSync(join(result.path, 'node_modules', 'some-pkg', 'index.js'))).toBe(true);
      // The main clone's own worktree is unaffected by the shared info/exclude addition — still clean.
      const rootStatus = spawnSync('git', ['status', '--porcelain'], { cwd: cloneDir, encoding: 'utf8' });
      expect(rootStatus.stdout.trim()).toBe('');
    } finally {
      removeCandidate({
        root: cloneDir, path: result.path, run: gitRun, env,
      });
    }
  });

  it('is idempotent — a second candidate build never duplicates the info/exclude line', async () => {
    const { cloneDir, env } = makeFixture();
    writeFile(cloneDir, '.gitignore', 'node_modules/\n');
    gitOk(cloneDir, ['add', '-A']);
    gitOk(cloneDir, ['commit', '-q', '-m', 'add .gitignore']);
    gitOk(cloneDir, ['push', '-q', 'origin', 'main']);
    mkdirSync(join(cloneDir, 'node_modules'), { recursive: true });
    writeFile(cloneDir, 'node_modules/marker.js', '1\n');
    const sha = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();

    const first = materializeCandidate({ root: cloneDir, sha, run: gitRun, env });
    removeCandidate({ root: cloneDir, path: first.path, run: gitRun, env });
    const second = materializeCandidate({ root: cloneDir, sha, run: gitRun, env });
    removeCandidate({ root: cloneDir, path: second.path, run: gitRun, env });

    const excludeText = readFileSync(join(cloneDir, '.git', 'info', 'exclude'), 'utf8');
    const lines = excludeText.split('\n').filter((l) => l.trim() === 'node_modules');
    expect(lines.length).toBe(1);
  });
});

describe('dryRunRebuild', () => {
  it('leaves the clone byte-identical and reports the plan', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/preview', (dir) => writeFile(dir, 'g.txt', 'x\n'));
    addOverlay(cloneDir, { ref: 'lane/preview' }, { env });
    advanceMain(originDir, (dir) => writeFile(dir, 'h.txt', 'y\n'));

    const snapshot = () => {
      const gitDir = join(cloneDir, '.git');
      let objectsCount = 0;
      const walk = (d) => {
        let entries;
        try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (entry.name === 'info' || entry.name === 'pack') continue;
          const p = join(d, entry.name);
          if (entry.isDirectory()) walk(p); else objectsCount += 1;
        }
      };
      walk(join(gitDir, 'objects'));
      const indexPath = join(gitDir, 'index');
      const fetchHeadPath = join(gitDir, 'FETCH_HEAD');
      return {
        head: gitOk(cloneDir, ['rev-parse', 'HEAD']).trim(),
        forEachRef: gitOk(cloneDir, ['for-each-ref']),
        objectsCount,
        indexMtime: existsSync(indexPath) ? statSync(indexPath).mtimeMs : null,
        fetchHeadPresent: existsSync(fetchHeadPath),
        fetchHeadMtime: existsSync(fetchHeadPath) ? statSync(fetchHeadPath).mtimeMs : null,
      };
    };

    const before = snapshot();
    const result = await dryRunRebuild({ root: cloneDir, env, prState: async () => null });
    const after = snapshot();

    expect(after).toEqual(before);
    expect(result.dryRun).toBe(true);
    expect(result.onMain).toBe(true);
    expect(result.unsafe.safe).toBe(true);
    expect(result.plan.ok).toBe(true);
    expect(result.wouldDo).toBe('rebuild-and-smoke');
    expect(result.overlays.map((o) => o.ref)).toEqual(['lane/preview']);
  });

  it('reports "nothing" when there is nothing to build', async () => {
    const { cloneDir, env } = makeFixture();
    const result = await dryRunRebuild({ root: cloneDir, env, prState: async () => null });
    expect(result.wouldDo).toBe('nothing');
    expect(result.plan.finalSha).toBe(result.head);
  });

  // Module E (#4044) — daemon-load-overlay.mjs's own `--dry-run` previews "what if I registered this ref too"
  // without ever writing the overlay list.
  it('extraOverlays are appended after the stored list, fed into the plan, and NEVER written to disk', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/virtual', (dir) => writeFile(dir, 'virtual.txt', 'x\n'));
    expect(readOverlays(cloneDir, { env })).toEqual([]);

    const result = await dryRunRebuild({
      root: cloneDir, env, prState: async () => null, extraOverlays: [{ ref: 'lane/virtual', pr: null }],
    });

    expect(result.wouldDo).toBe('rebuild-and-smoke');
    expect(result.plan.applied.map((a) => a.ref)).toEqual(['lane/virtual']);
    expect(result.overlays.map((o) => o.ref)).toEqual(['lane/virtual']);
    expect(readOverlays(cloneDir, { env })).toEqual([]); // still never written
  });

  it('reports stillRejected + "nothing (still-rejected)" when the plan matches the last recorded rejection', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/rejected', (dir) => writeFile(dir, 'rejected.txt', 'x\n'));
    addOverlay(cloneDir, { ref: 'lane/rejected', pinned: true }, { env });

    const runSmoke = failsWhenFile('rejected.txt', {
      verdict: 'code', attempts: 1, smoke: { results: [{ ok: false, name: 'x', detail: 'boom' }] },
    });
    const rebuildResult = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(rebuildResult.reason).toBe('smoke-rejected');

    const preview = await dryRunRebuild({ root: cloneDir, env, prState: async () => null });
    expect(preview.stillRejected).toBe(true);
    expect(preview.wouldDo).toBe('nothing (still-rejected)');
    expect(preview.state.rejected).toBeTruthy();
  });
});

// ── previewOverlayConflict — the overlay-conflict guard (`scripts/daemon-overlay.mjs add`, epic #3383/#4075) ──
// Live incident 2026-09-27: `lane/promote-stale-green` was registered while KNOWINGLY conflicting with
// `lane/fix-procedure` in a shared file — nothing refused it, so the next rebuild silently DROPPED it and its
// own fix never went live. These tests replay that shape with real git: two overlay branches that edit the
// SAME line of the SAME file (must report `clean:false`, naming the file and the conflicting overlay), and the
// control case (different files/lines — must report `clean:true`).
describe('previewOverlayConflict — the overlay-conflict guard', () => {
  it('reports clean:false, naming the file AND the already-registered overlay, when the candidate conflicts', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    // Seed a shared file on main so both overlays' edits are to the SAME pre-existing line (a real conflict,
    // not two independent additions git could auto-merge).
    advanceMain(originDir, (dir) => writeFile(dir, 'shared.mjs', 'export const X = 1;\n'));
    pushBranch(originDir, 'lane/fix-procedure', (dir) => writeFile(dir, 'shared.mjs', 'export const X = 2;\n'));
    pushBranch(originDir, 'lane/promote-stale-green', (dir) => writeFile(dir, 'shared.mjs', 'export const X = 3;\n'));

    const check = await previewOverlayConflict({
      root: cloneDir, ref: 'lane/promote-stale-green', pr: 2826,
      existingOverlays: [{ ref: 'lane/fix-procedure', pr: 2821 }], env,
    });

    expect(check.ok).toBe(true);
    expect(check.clean).toBe(false);
    expect(check.files).toEqual(['shared.mjs']);
    expect(check.conflicting).toEqual([{ ref: 'lane/fix-procedure', pr: 2821 }]);
  });

  it('reports clean:true when the candidate merges fine against main + every registered overlay', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/fix-procedure', (dir) => writeFile(dir, 'a.mjs', 'a\n'));
    pushBranch(originDir, 'lane/other', (dir) => writeFile(dir, 'b.mjs', 'b\n'));

    const check = await previewOverlayConflict({
      root: cloneDir, ref: 'lane/other', pr: null, existingOverlays: [{ ref: 'lane/fix-procedure', pr: 2821 }], env,
    });

    expect(check).toMatchObject({ ok: true, clean: true });
  });

  it('reports clean:true against an empty existing-overlay list (candidate vs. main alone)', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/solo', (dir) => writeFile(dir, 'c.mjs', 'c\n'));

    const check = await previewOverlayConflict({ root: cloneDir, ref: 'lane/solo', existingOverlays: [], env });
    expect(check).toMatchObject({ ok: true, clean: true });
  });

  it('never mutates the clone: no ref, index, working-tree or overlay-list change', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'shared.mjs', 'export const X = 1;\n'));
    pushBranch(originDir, 'lane/fix-procedure', (dir) => writeFile(dir, 'shared.mjs', 'export const X = 2;\n'));
    pushBranch(originDir, 'lane/promote-stale-green', (dir) => writeFile(dir, 'shared.mjs', 'export const X = 3;\n'));
    const before = { head: gitOk(cloneDir, ['rev-parse', 'HEAD']).trim(), refs: gitOk(cloneDir, ['for-each-ref']) };

    await previewOverlayConflict({
      root: cloneDir, ref: 'lane/promote-stale-green', existingOverlays: [{ ref: 'lane/fix-procedure' }], env,
    });

    const after = { head: gitOk(cloneDir, ['rev-parse', 'HEAD']).trim(), refs: gitOk(cloneDir, ['for-each-ref']) };
    expect(after).toEqual(before);
    expect(readOverlays(cloneDir, { env })).toEqual([]);
  });

  it('previewOverlayConflict never mutates staged, unstaged or untracked state', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'shared.mjs', 'export const X = 1;\n'));
    pushBranch(originDir, 'lane/fix-procedure', (dir) => writeFile(dir, 'shared.mjs', 'export const X = 2;\n'));
    pushBranch(originDir, 'lane/promote-stale-green', (dir) => writeFile(dir, 'shared.mjs', 'export const X = 3;\n'));
    writeFile(cloneDir, 'staged.txt', 'staged sentinel\n');
    gitOk(cloneDir, ['add', 'staged.txt']);
    writeFile(cloneDir, 'README.md', 'unstaged edit\n');
    writeFile(cloneDir, 'untracked.txt', 'untracked sentinel\n');
    const snapshot = () => ({
      index: readFileSync(join(cloneDir, '.git', 'index')).toString('base64'),
      files: ['staged.txt', 'README.md', 'untracked.txt'].map((f) => readFileSync(join(cloneDir, f), 'utf8')),
      status: gitOk(cloneDir, ['status', '--porcelain']),
    });
    const before = snapshot();

    await previewOverlayConflict({
      root: cloneDir, ref: 'lane/promote-stale-green', existingOverlays: [{ ref: 'lane/fix-procedure' }], env,
    });

    expect(snapshot()).toEqual(before);
  });

  it('previewOverlayConflict reports exact file names for a rename/delete conflict', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    const body = Array.from({ length: 30 }, (_, i) => `export const V${i} = ${i};\n`).join('');
    advanceMain(originDir, (dir) => writeFile(dir, 'ren.mjs', body));
    const oldMain = gitOk(originDir, ['rev-parse', 'main']).trim();
    advanceMain(originDir, (dir) => rmSync(join(dir, 'ren.mjs')));
    pushBranch(originDir, 'lane/renamer', (dir) => {
      rmSync(join(dir, 'ren.mjs'));
      writeFile(dir, 'renamed.mjs', `${body}export const EXTRA = 1;\n`);
    }, { base: oldMain });

    const check = await previewOverlayConflict({ root: cloneDir, ref: 'lane/renamer', existingOverlays: [], env });

    expect(check.ok).toBe(true);
    expect(check.clean).toBe(false);
    expect(check.files).toEqual(['renamed.mjs']);
  });

  it('previewOverlayConflict conflicts with main advanced after an existing overlay branched, attributing to no overlay', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'shared.mjs', 'export const X = 1;\n'));
    const oldMain = gitOk(originDir, ['rev-parse', 'main']).trim();
    pushBranch(originDir, 'lane/existing', (dir) => writeFile(dir, 'unrelated.mjs', 'u\n'), { base: oldMain });
    advanceMain(originDir, (dir) => writeFile(dir, 'shared.mjs', 'export const X = 2;\n'));
    pushBranch(originDir, 'lane/candidate', (dir) => writeFile(dir, 'shared.mjs', 'export const X = 3;\n'), { base: oldMain });

    const check = await previewOverlayConflict({
      root: cloneDir, ref: 'lane/candidate', existingOverlays: [{ ref: 'lane/existing', pr: null }], env,
    });

    expect(check.ok).toBe(true);
    expect(check.clean).toBe(false);
    expect(check.files).toEqual(['shared.mjs']);
    expect(check.conflicting).toEqual([]);
  });

  it('refuses a ref that does not resolve (typo / deleted branch), never a false "clean"', async () => {
    const { cloneDir, env } = makeFixture();
    const check = await previewOverlayConflict({ root: cloneDir, ref: 'lane/does-not-exist', existingOverlays: [], env });
    expect(check).toEqual({ ok: false, reason: 'ref-unresolved' });
  });

  // PR #2827 review: only merge-tree's documented conflict status (1) is a CONFIRMED conflict. Any other failure
  // (here: an unrelated-history candidate, which merge-tree refuses with 128) proves nothing about mergeability,
  // so it must be `ok:false` — never `clean:false`, which `--allow-conflict` would then let register.
  it('a merge-tree execution error (unrelated histories) is ok:false, never an overridable "conflict"', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    const dir = makeAuthorClone(originDir);
    gitOk(dir, ['checkout', '-q', '--orphan', 'lane/unrelated']);
    gitOk(dir, ['rm', '-rq', '--cached', '--ignore-unmatch', '.']); // the author clone's index can be empty (CI)
    writeFile(dir, 'z.mjs', 'z\n');
    gitOk(dir, ['add', 'z.mjs']);
    gitOk(dir, ['commit', '-q', '-m', 'orphan']);
    gitOk(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/lane/unrelated']);

    const check = await previewOverlayConflict({ root: cloneDir, ref: 'lane/unrelated', existingOverlays: [], env });
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('merge-tree-failed');
  });

  // PR #2827 review: an already-registered PINNED overlay that no longer folds onto main (it conflicts, so a
  // real rebuild refuses) must not make every unrelated candidate unverifiable. The stuck overlay is set aside
  // and REPORTED; the candidate is still checked against main + every overlay that does fold.
  it('sets aside (and reports) a pinned overlay that no longer folds, and still checks the candidate', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'shared.mjs', 'export const X = 1;\n'));
    pushBranch(originDir, 'lane/pinned-thing', (dir) => writeFile(dir, 'shared.mjs', 'export const X = 2;\n'));
    advanceMain(originDir, (dir) => writeFile(dir, 'shared.mjs', 'export const X = 9;\n'));
    pushBranch(originDir, 'lane/normal', (dir) => writeFile(dir, 'n.mjs', 'n = 1\n'));
    pushBranch(originDir, 'lane/unrelated', (dir) => writeFile(dir, 'other.mjs', 'o\n'));
    pushBranch(originDir, 'lane/clashes-normal', (dir) => writeFile(dir, 'n.mjs', 'n = 2\n'));
    const existingOverlays = [{ ref: 'lane/pinned-thing', pr: null, pinned: true }, { ref: 'lane/normal', pr: null }];

    const clean = await previewOverlayConflict({ root: cloneDir, ref: 'lane/unrelated', existingOverlays, env });
    expect(clean).toMatchObject({ ok: true, clean: true });
    expect(clean.setAside).toEqual([expect.objectContaining({ ref: 'lane/pinned-thing', reason: 'pinned-overlay-conflict' })]);

    const clash = await previewOverlayConflict({ root: cloneDir, ref: 'lane/clashes-normal', existingOverlays, env });
    expect(clash).toMatchObject({ ok: true, clean: false, files: ['n.mjs'] });
    expect(clash.conflicting).toEqual([{ ref: 'lane/normal', pr: null }]);
  });
});

describe('findUnsafeLocalState / planRebuild (pure core)', () => {
  function gitFor(cwd) {
    return (args) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' });
      return { status: r.status == null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
    };
  }

  it('findUnsafeLocalState reports safe on a clean tree with nothing local', () => {
    const { cloneDir } = makeFixture();
    expect(findUnsafeLocalState({ git: gitFor(cloneDir) })).toEqual({ safe: true, untracked: [] });
  });

  it('findUnsafeLocalState reports untracked paths without them affecting safe', () => {
    const { cloneDir } = makeFixture();
    writeFile(cloneDir, 'loose.txt', 'x\n');
    expect(findUnsafeLocalState({ git: gitFor(cloneDir) })).toEqual({ safe: true, untracked: ['loose.txt'] });
  });

  it('planRebuild reports main-unresolved when mainRef does not exist', async () => {
    const { cloneDir } = makeFixture();
    const plan = await planRebuild({
      git: gitFor(cloneDir), headSha: 'deadbeef', mainRef: 'origin/does-not-exist', overlays: [],
    });
    expect(plan).toEqual({ ok: false, reason: 'main-unresolved' });
  });
});

// ── pinned overlays — the 2026-09-25 self-destruct guard ────────────────────────────────────────────────────
// Live incident: #2625 (the overlay that CARRIES daemon-rebuild.mjs) was loaded on the review/fix clone. main
// moved, the overlay conflicted, and the rebuild conflict-dropped its own mechanism — rebuilding the clone onto
// plain main, whose code had no rebuild or overlay list at all. These tests replay that shape with real git.
describe('rebuildClone — pinned overlays never conflict-drop (self-destruct guard)', () => {
  /** An overlay that ships the rebuild mechanism itself, plus a file main will later conflict on. */
  function pushMechanismOverlay(originDir, ref) {
    return pushBranch(originDir, ref, (dir) => {
      writeFile(dir, 'scripts/lib/daemon-rebuild.mjs', '// the rebuild mechanism\n');
      writeFile(dir, 'shared.txt', 'overlay change\n');
    });
  }
  function seedShared(cloneDir) {
    writeFile(cloneDir, 'shared.txt', 'original\n');
    gitOk(cloneDir, ['add', '-A']);
    gitOk(cloneDir, ['commit', '-q', '-m', 'seed shared.txt']);
    gitOk(cloneDir, ['push', '-q', 'origin', 'main']);
  }

  it('an overlay carrying the rebuild mechanism that starts to conflict REFUSES: tree, HEAD and list untouched', async () => {
    const { originDir, cloneDir, env, stateDir } = makeFixture();
    seedShared(cloneDir);
    pushMechanismOverlay(originDir, 'lane/4044-daemon-rebuild-and-clone-lock');
    addOverlay(cloneDir, { ref: 'lane/4044-daemon-rebuild-and-clone-lock', pr: 2625 }, { env });

    // Tick 1: the overlay applies cleanly and is adopted — the clone now RUNS the mechanism.
    const first = await rebuildClone({
      root: cloneDir, env, runSmoke: passSmoke(), prState: async () => 'OPEN', lockOpts: LOCK_OPTS,
    });
    expect(first.moved).toBe(true);
    expect(existsSync(join(cloneDir, 'scripts/lib/daemon-rebuild.mjs'))).toBe(true);
    const headBefore = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();

    // main moves and now conflicts with the overlay.
    advanceMain(originDir, (dir) => writeFile(dir, 'shared.txt', 'main change\n'));

    // Tick 2: must refuse, never rebuild onto plain main.
    const runSmoke = passSmoke();
    const second = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => 'OPEN', lockOpts: LOCK_OPTS,
    });
    expect(second.moved).toBe(false);
    expect(second.reason).toBe('pinned-overlay-conflict');
    expect(second.detail).toMatchObject({
      ref: 'lane/4044-daemon-rebuild-and-clone-lock', pr: 2625, dropReason: 'conflict', pinnedBy: 'mechanism',
    });
    expect(runSmoke).not.toHaveBeenCalled();
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(existsSync(join(cloneDir, 'scripts/lib/daemon-rebuild.mjs'))).toBe(true);
    expect(readOverlays(cloneDir, { env }).map((o) => o.ref)).toEqual(['lane/4044-daemon-rebuild-and-clone-lock']);
    expect(second.alerts.some((a) => a.kind === 'overlay-conflict-dropped')).toBe(false);
    const alert = second.alerts.find((a) => a.kind === 'pinned-overlay-conflict');
    expect(alert?.detail?.message).toBe('pinned overlay conflicts with main — needs a rebase');
    // …and it lands in the durable alerts log the operator reads.
    const log = readdirSync(stateDir).find((f) => f.endsWith('.alerts.jsonl'));
    expect(readFileSync(join(stateDir, log), 'utf8')).toContain('pinned overlay conflicts with main — needs a rebase');
  });

  it('an overlay registered pinned:true refuses on conflict even when it touches no mechanism file', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    seedShared(cloneDir);
    pushBranch(originDir, 'lane/pinned-plain', (dir) => writeFile(dir, 'shared.txt', 'overlay change\n'));
    advanceMain(originDir, (dir) => writeFile(dir, 'shared.txt', 'main change\n'));
    addOverlay(cloneDir, { ref: 'lane/pinned-plain', pinned: true }, { env });
    const headBefore = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();

    const result = await rebuildClone({
      root: cloneDir, env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(result.moved).toBe(false);
    expect(result.reason).toBe('pinned-overlay-conflict');
    expect(result.detail?.pinnedBy).toBe('flag');
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(readOverlays(cloneDir, { env })[0]).toMatchObject({ ref: 'lane/pinned-plain', pinned: true });
  });

  it('a pinned overlay whose ref vanished (PR not merged) refuses instead of auto-dropping', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushBranch(originDir, 'lane/pinned-gone', (dir) => writeFile(dir, 'g.txt', 'g\n'));
    addOverlay(cloneDir, { ref: 'lane/pinned-gone', pinned: true }, { env });
    deleteBranch(originDir, 'lane/pinned-gone');

    const result = await rebuildClone({
      root: cloneDir, env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(result.moved).toBe(false);
    expect(result.reason).toBe('pinned-overlay-unavailable');
    expect(readOverlays(cloneDir, { env }).map((o) => o.ref)).toEqual(['lane/pinned-gone']);
  });

  it('a pinned overlay whose PR MERGED still leaves the list normally (main has it now)', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    pushMechanismOverlay(originDir, 'lane/pinned-merged');
    addOverlay(cloneDir, { ref: 'lane/pinned-merged', pr: 7, pinned: true }, { env });
    const result = await rebuildClone({
      root: cloneDir, env, runSmoke: passSmoke(), prState: async () => 'MERGED', lockOpts: LOCK_OPTS,
    });
    expect(result.reason).not.toBe('pinned-overlay-conflict');
    expect(readOverlays(cloneDir, { env })).toEqual([]);
  });

  it('a NON-pinned, non-mechanism overlay still conflict-drops as before', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    seedShared(cloneDir);
    pushBranch(originDir, 'lane/plain', (dir) => writeFile(dir, 'shared.txt', 'overlay change\n'));
    advanceMain(originDir, (dir) => writeFile(dir, 'shared.txt', 'main change\n'));
    addOverlay(cloneDir, { ref: 'lane/plain' }, { env });
    const result = await rebuildClone({
      root: cloneDir, env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(result.moved).toBe(true);
    expect(result.alerts.some((a) => a.kind === 'overlay-conflict-dropped')).toBe(true);
  });

  it('dryRunRebuild reports refuse for a conflicting pinned overlay', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    seedShared(cloneDir);
    pushMechanismOverlay(originDir, 'lane/mech');
    advanceMain(originDir, (dir) => writeFile(dir, 'shared.txt', 'main change\n'));
    addOverlay(cloneDir, { ref: 'lane/mech' }, { env });
    const dry = await dryRunRebuild({ root: cloneDir, env, prState: async () => null });
    expect(dry.wouldDo).toBe('refuse');
    expect(dry.plan.reason).toBe('pinned-overlay-conflict');
  });
});

// ── xpinskip — one conflicting pinned overlay must never freeze the fleet ─────────────────────────────────
// Live 2026-09-26 23:39 ET on wev-review-daemon: #2768 (lane/fix-rebuild-finalize) only CHANGES
// scripts/lib/daemon-rebuild.mjs, which main already carries — so it is auto-pinned ('mechanism'). main moved,
// #2768 conflicted, the rebuild refused (`pinned-overlay-conflict`) every tick, the clone fell 2 commits behind,
// and the fix daemon refused ALL dispatch in all three repos as stale. These replay that shape with real git.
describe('rebuildClone — a conflicting pinned overlay is skipped (not dropped) when main has the mechanism', () => {
  function seedMechanismOnMain(cloneDir) {
    writeFile(cloneDir, 'scripts/lib/daemon-rebuild.mjs', '// main rebuild v1\n');
    writeFile(cloneDir, 'scripts/lib/daemon-overlays.mjs', '// main overlays v1\n');
    writeFile(cloneDir, 'shared.txt', 'original\n');
    gitOk(cloneDir, ['add', '-A']);
    gitOk(cloneDir, ['commit', '-q', '-m', 'seed mechanism + shared.txt']);
    gitOk(cloneDir, ['push', '-q', 'origin', 'main']);
  }
  /** A fix to a mechanism file main already has, plus an edit main will later conflict on (the #2768 shape). */
  function pushMechanismFix(originDir, ref, sharedText = 'overlay change\n') {
    return pushBranch(originDir, ref, (dir) => {
      writeFile(dir, 'scripts/lib/daemon-rebuild.mjs', '// main rebuild v1 + finalize fix\n');
      writeFile(dir, 'shared.txt', sharedText);
    });
  }
  const readAt = (cloneDir, path) => readFileSync(join(cloneDir, path), 'utf8');

  it('moves the clone to main + the OTHER overlays, keeps the pinned one registered, alerts once, re-applies after a rebase', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    seedMechanismOnMain(cloneDir);
    pushMechanismFix(originDir, 'lane/fix-rebuild-finalize');
    pushBranch(originDir, 'lane/other', (dir) => writeFile(dir, 'other.txt', 'other\n'));
    addOverlay(cloneDir, { ref: 'lane/fix-rebuild-finalize', pr: 2768 }, { env });
    addOverlay(cloneDir, { ref: 'lane/other', pr: 2771 }, { env });

    const first = await rebuildClone({ root: cloneDir, env, runSmoke: passSmoke(), prState: async () => 'OPEN', lockOpts: LOCK_OPTS });
    expect(first.moved).toBe(true);
    expect(readAt(cloneDir, 'scripts/lib/daemon-rebuild.mjs')).toContain('finalize fix');

    const mainSha = advanceMain(originDir, (dir) => writeFile(dir, 'shared.txt', 'main change\n'));

    // Before the fix this tick refused `pinned-overlay-conflict` and never moved the clone.
    const runSmoke = passSmoke();
    const second = await rebuildClone({ root: cloneDir, env, runSmoke, prState: async () => 'OPEN', lockOpts: LOCK_OPTS });
    expect(second.moved).toBe(true);
    expect(runSmoke).toHaveBeenCalled(); // smoked as usual
    expect(gitOk(cloneDir, ['merge-base', '--is-ancestor', mainSha, 'HEAD']) === '').toBe(true);
    expect(readAt(cloneDir, 'shared.txt')).toBe('main change\n');
    expect(existsSync(join(cloneDir, 'other.txt'))).toBe(true); // the non-conflicting overlay is still built in
    expect(readAt(cloneDir, 'scripts/lib/daemon-rebuild.mjs')).toBe('// main rebuild v1\n'); // main's own mechanism
    expect(readOverlays(cloneDir, { env }).map((o) => o.ref)).toEqual(['lane/fix-rebuild-finalize', 'lane/other']);
    const kinds = second.alerts.map((a) => a.kind);
    expect(kinds.filter((k) => k === 'pinned-overlay-conflict-skipped')).toHaveLength(1);
    expect(kinds).not.toContain('pinned-overlay-conflict');
    expect(kinds).not.toContain('overlay-conflict-dropped');
    expect(second.alerts.find((a) => a.kind === 'pinned-overlay-conflict-skipped').detail).toMatchObject({
      ref: 'lane/fix-rebuild-finalize', pr: 2768, pinnedBy: 'mechanism', mechanismPaths: ['scripts/lib/daemon-rebuild.mjs'],
    });
    expect(readRebuildState(cloneDir, env).held).toBeNull();

    // The branch is rebased onto the new main — the SAME registration re-applies with no operator step.
    const dir = makeAuthorClone(originDir);
    gitOk(dir, ['checkout', '-q', '-B', 'lane/fix-rebuild-finalize', 'origin/main']);
    writeFile(dir, 'scripts/lib/daemon-rebuild.mjs', '// main rebuild v1 + finalize fix\n');
    gitOk(dir, ['add', '-A']);
    gitOk(dir, ['commit', '-q', '-m', 'rebased']);
    gitOk(dir, ['push', '-q', '-f', 'origin', 'HEAD:refs/heads/lane/fix-rebuild-finalize']);

    const third = await rebuildClone({ root: cloneDir, env, runSmoke: passSmoke(), prState: async () => 'OPEN', lockOpts: LOCK_OPTS });
    expect(third.moved).toBe(true);
    expect(readAt(cloneDir, 'scripts/lib/daemon-rebuild.mjs')).toContain('finalize fix');
    expect(existsSync(join(cloneDir, 'other.txt'))).toBe(true);
    expect(third.alerts.map((a) => a.kind)).not.toContain('pinned-overlay-conflict-skipped');
  });

  it('dryRunRebuild previews the skip: rebuild-and-smoke onto main + the other overlays', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    seedMechanismOnMain(cloneDir);
    pushMechanismFix(originDir, 'lane/mech-fix');
    advanceMain(originDir, (dir) => writeFile(dir, 'shared.txt', 'main change\n'));
    addOverlay(cloneDir, { ref: 'lane/mech-fix', pr: 1 }, { env });
    const dry = await dryRunRebuild({ root: cloneDir, env, prState: async () => null });
    expect(dry.wouldDo).toBe('rebuild-and-smoke');
    expect(dry.plan.ok).toBe(true);
    expect(dry.plan.finalSha).toBe(dry.plan.mainSha);
    expect(dry.plan.decisions).toEqual([expect.objectContaining({ ref: 'lane/mech-fix', action: 'skip' })]);
  });

  it('still REFUSES when the overlay ADDS a mechanism file main lacks — and holds the clone on its last-good build', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    writeFile(cloneDir, 'shared.txt', 'original\n');
    gitOk(cloneDir, ['add', '-A']);
    gitOk(cloneDir, ['commit', '-q', '-m', 'seed shared.txt']);
    gitOk(cloneDir, ['push', '-q', 'origin', 'main']);
    pushBranch(originDir, 'lane/brings-mechanism', (dir) => {
      writeFile(dir, 'scripts/lib/daemon-rebuild.mjs', '// the whole mechanism\n');
      writeFile(dir, 'shared.txt', 'overlay change\n');
    });
    addOverlay(cloneDir, { ref: 'lane/brings-mechanism', pr: 2625 }, { env });
    const first = await rebuildClone({ root: cloneDir, env, runSmoke: passSmoke(), prState: async () => 'OPEN', lockOpts: LOCK_OPTS });
    expect(first.moved).toBe(true);
    const lastGood = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();
    advanceMain(originDir, (dir) => writeFile(dir, 'shared.txt', 'main change\n'));

    const second = await rebuildClone({ root: cloneDir, env, runSmoke: passSmoke(), prState: async () => 'OPEN', lockOpts: LOCK_OPTS });
    expect(second.moved).toBe(false);
    expect(second.reason).toBe('pinned-overlay-conflict');
    expect(second.detail.skipRefusedBecause).toMatch(/^main-lacks-mechanism: /);
    // Held on last-good ⇒ the staleness guard dispatches from it instead of refusing every tick (x5wbsbc).
    const { held } = readRebuildState(cloneDir, env);
    expect(held).toMatchObject({ reason: 'pinned-overlay-conflict', lastGood });
    expect(held.failed).toContain('lane/brings-mechanism (PR #2625)');
    const { decideLastGood } = await import('../daemon-last-good.mjs');
    expect(decideLastGood({
      headSha: lastGood, state: readRebuildState(cloneDir, env), nowMs: Date.now(), maxAgeMs: 86_400_000,
    }).onLastGood).toBe(true);
  });
});

// ── overlay-list race (live 2026-09-24/25: #2640, #2641, #2643 each needed repeated adds) ────────────────────
// Two REAL processes on a throwaway clone: process A is a real `rebuildClone` auto-removing a merged overlay;
// while A sits inside its read→write window (widened by the test-only RMW delay; A drops a marker file when it
// gets there), process B runs the real CLI `daemon-overlay.mjs add --no-lock` — the unlocked add path
// `daemon-load-overlay.mjs` also takes. Before the list mutex, A wrote back its stale read and B's add vanished.
describe('overlay list — concurrent add vs. a rebuild auto-remove (two real processes)', () => {
  // vitest's import.meta.url is not a file: URL — resolve from the repo root like daemon-live-smoke.test.mjs does.
  const REBUILD_URL = pathToFileURL(join(process.cwd(), 'scripts/lib/daemon-rebuild.mjs')).href;
  const CLI = join(process.cwd(), 'scripts/daemon-overlay.mjs');

  function runNode(args, env) {
    return new Promise((resolveP) => {
      const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', (code) => resolveP({ code, out }));
    });
  }

  it('an add that lands while a rebuild is removing a merged overlay is never lost', async () => {
    const { originDir, cloneDir, env, base } = makeFixture();
    pushBranch(originDir, 'lane/merged', (dir) => writeFile(dir, 'm.txt', 'm\n'));
    addOverlay(cloneDir, { ref: 'lane/merged', pr: 42 }, { env });
    // The overlay-conflict guard (epic #3383/#4075) now resolves `--ref` for real before registering it — a
    // real branch, even an empty-diff one, so `add` has something to verify against.
    pushBranch(originDir, 'lane/new', (dir) => writeFile(dir, 'n.txt', 'n\n'));
    const marker = join(base, 'rmw-window-open');

    const script = `
      const { rebuildClone } = await import(${JSON.stringify(REBUILD_URL)});
      const r = await rebuildClone({
        root: ${JSON.stringify(cloneDir)}, prState: async () => 'MERGED',
        runSmoke: async () => ({ verdict: 'pass', attempts: 1, smoke: { results: [] } }),
        lockOpts: { waitMs: 2000, pollMs: 20 }, log: { error() {} },
      });
      console.log(JSON.stringify({ reason: r.reason }));
    `;
    let rebuildDone = false;
    const rebuildP = runNode(['--input-type=module', '-e', script], {
      ...env, WE_DAEMON_OVERLAYS_TEST_RMW_DELAY_MS: '1500', WE_DAEMON_OVERLAYS_TEST_RMW_MARKER: marker,
    }).then((r) => { rebuildDone = true; return r; });

    // Wait until A is inside its read→write window, then fire B.
    const deadline = Date.now() + 60_000;
    while (!existsSync(marker) && !rebuildDone && Date.now() < deadline) await new Promise((r) => { setTimeout(r, 20); });
    if (!existsSync(marker)) {
      const early = await rebuildP;
      throw new Error(`the rebuild process never reached its read→write window: ${early.out}`);
    }
    const addP = runNode([CLI, 'add', `--clone=${cloneDir}`, '--ref=lane/new', '--pr=7', '--no-lock', '--json'], env);

    const [a, b] = await Promise.all([rebuildP, addP]);
    expect(b.code, b.out).toBe(0);
    expect(a.code, a.out).toBe(0);
    expect(readOverlays(cloneDir, { env }).map((o) => o.ref)).toEqual(['lane/new']);
  }, 90_000);
});

// ── live 2026-09-25 08:14 ET: a gh-only smoke failure froze the clone as still-rejected until main moved ────────
// Both gh checks failed together (GitHub/network), the verdict came back `code`, and the rejection stuck: the clone
// sat 3 commits behind origin/main and the fix-dispatch daemon refused every repo as stale, silently.
describe('rebuildClone — an external-only (gh) smoke rejection retries with backoff and alerts while held', () => {
  const ghOnlyFailure = () => failsWhenFile('next.txt', {
    verdict: 'code', attempts: 1,
    smoke: {
      results: [
        { name: 'lane-pool-list', ok: true, mayBeTransient: false },
        { name: 'gh-api-repo', ok: false, mayBeTransient: true, detail: 'gh api --method GET repos/o/r failed: exited 1: weird gh output' },
        { name: 'gh-pr-list', ok: false, mayBeTransient: true, detail: 'gh pr list failed: exited 1: weird gh output' },
      ],
    },
  });

  it('rejects with a retryAt, holds (alerting clone-held-stale) until it is due, then re-smokes and adopts', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'next.txt', 'next\n'));
    const t0 = Date.now();
    const env2 = { ...env, WE_DAEMON_REJECT_RETRY_BASE_MS: '60000' };
    const headBefore = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();

    const first = await rebuildClone({ root: cloneDir, env: env2, runSmoke: ghOnlyFailure(), prState: async () => null, lockOpts: LOCK_OPTS, now: () => t0 });
    expect(first.reason).toBe('smoke-rejected');
    const rej = readRebuildState(cloneDir, env2).rejected;
    expect(rej).toMatchObject({ externalOnly: true, attempts: 1 });
    expect(Date.parse(rej.retryAt)).toBe(t0 + 60_000);
    expect(first.alerts.find((a) => a.kind === 'smoke-rejected').detail.details[0].detail).toContain('weird gh output');
    expect(first.alerts.some((a) => a.kind === 'clone-held-stale')).toBe(true);

    const runSmoke2 = passSmoke();
    const held = await rebuildClone({ root: cloneDir, env: env2, runSmoke: runSmoke2, prState: async () => null, lockOpts: LOCK_OPTS, now: () => t0 + 30_000 });
    expect(held.reason).toBe('still-rejected');
    expect(runSmoke2).not.toHaveBeenCalled();
    expect(held.alerts.find((a) => a.kind === 'clone-held-stale')?.detail).toMatchObject({ reason: 'still-rejected', retryAt: rej.retryAt });
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);

    const runSmoke3 = passSmoke();
    const retried = await rebuildClone({ root: cloneDir, env: env2, runSmoke: runSmoke3, prState: async () => null, lockOpts: LOCK_OPTS, now: () => t0 + 61_000 });
    expect(runSmoke3).toHaveBeenCalledTimes(1);
    expect(retried.moved).toBe(true);
    expect(retried.adopted).toBe(true);
  });

  it('a second external-only rejection of the SAME inputs doubles the backoff', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'next.txt', 'next\n'));
    const t0 = Date.now();
    const env2 = { ...env, WE_DAEMON_REJECT_RETRY_BASE_MS: '60000' };
    await rebuildClone({ root: cloneDir, env: env2, runSmoke: ghOnlyFailure(), prState: async () => null, lockOpts: LOCK_OPTS, now: () => t0 });
    await rebuildClone({ root: cloneDir, env: env2, runSmoke: ghOnlyFailure(), prState: async () => null, lockOpts: LOCK_OPTS, now: () => t0 + 61_000 });
    const rej = readRebuildState(cloneDir, env2).rejected;
    expect(rej.attempts).toBe(2);
    expect(Date.parse(rej.retryAt)).toBe(t0 + 61_000 + 120_000);
  });

  it('a failure in a check that runs tree code still sticks until the inputs change (no retryAt)', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'next.txt', 'next\n'));
    const t0 = Date.now();
    const treeFailure = failsWhenFile('next.txt', {
      verdict: 'code', attempts: 1,
      smoke: { results: [{ name: 'reconcile-dry-run', ok: false, mayBeTransient: false, detail: 'boom' }] },
    });
    await rebuildClone({ root: cloneDir, env, runSmoke: treeFailure, prState: async () => null, lockOpts: LOCK_OPTS, now: () => t0 });
    expect(readRebuildState(cloneDir, env).rejected.retryAt).toBeUndefined();
    const runSmoke = passSmoke();
    const later = await rebuildClone({ root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS, now: () => t0 + 24 * 3600_000 });
    expect(later.reason).toBe('still-rejected');
    expect(runSmoke).not.toHaveBeenCalled();
  });
});

describe('rebuildClone — a stray backlog claim stamp is restored, never a freeze (#4561)', () => {
  const card = 'backlog/9001-stray-claim.md';
  const original = '---\nstatus: open\nscope: []\n---\nBody stays byte-identical.\n';
  const stamp = (text, status = 'active') => text.replace('status: open', `status: ${status}\ndateStarted: "2026-09-29"`);
  const scorecard = 'scripts/conveyor/run-scorecards.json';

  it.each(['\n', '\r\n'])('recognizes claim stamps with line ending %j', (eol) => {
    const head = original.replaceAll('\n', eol);
    const work = stamp(original).replaceAll('\n', eol);
    expect(isClaimStampOnlyEdit(head, work)).toBe(true);
    expect(isClaimStampOnlyEdit(head, work + 'body edit')).toBe(false);
    expect(isClaimStampOnlyEdit(head, work.replace('scope: []', 'scope: [x]'))).toBe(false);
    expect(isClaimStampOnlyEdit(head, work.replace('status: active', 'status: resolved'))).toBe(false);
    expect(isClaimStampOnlyEdit(head, work.replace('status: active', 'status: active' + eol + 'status: open'))).toBe(false);
    expect(isClaimStampOnlyEdit('no frontmatter', work)).toBe(false);
    expect(isClaimStampOnlyEdit(head, 'no frontmatter')).toBe(false);
  });

  it.each([
    ['unreadable HEAD', 'head-unreadable'],
    ['unreadable file', 'file-busy'],
    ['concurrent write', 'file-busy'],
    ['failed diff', 'restore-failed'],
    ['failed checkout', 'restore-failed'],
  ])('retains the claim on %s', (fault, reason) => {
    const run = vi.fn((args) => {
      if (args[0] === 'show') return { status: fault === 'unreadable HEAD' ? 1 : 0, stdout: original };
      if (args[0] === 'diff') return { status: fault === 'failed diff' ? 1 : 0, stdout: 'diff' };
      return { status: 1 };
    });
    let reads = 0;
    const fs = { read: () => {
      if (fault === 'unreadable file') throw new Error('read failed');
      reads += 1;
      return stamp(original) + (fault === 'concurrent write' && reads > 1 ? 'new body' : '');
    } };
    expect(restoreStrayClaimStamps({ git: run, root: '/fixture', dirty: [`M ${card}`], fs }))
      .toEqual({ ok: false, reason, restored: [] });
    expect(run.mock.calls.some(([args]) => args[0] === 'checkout')).toBe(fault === 'failed checkout');
  });

  it.each([[], ['R backlog/old.md -> backlog/new.md'], [`D ${card}`], [`UU ${card}`]].map((dirty) => ({ dirty })))
    ('rejects non-modification porcelain without reading or restoring: $dirty', ({ dirty }) => {
      const run = vi.fn();
      expect(restoreStrayClaimStamps({ git: run, root: '/fixture', dirty }))
        .toEqual({ ok: false, reason: 'not-claim-stamps', restored: [] });
      expect(run).not.toHaveBeenCalled();
    });

  it('validates every backlog card before restoring any of them', () => {
    const run = vi.fn(() => ({ status: 0, stdout: original }));
    const fs = { read: (path) => stamp(original) + (path.endsWith('9002.md') ? 'body edit' : '') };
    expect(restoreStrayClaimStamps({
      git: run, root: '/fixture', dirty: [`M ${card}`, 'M backlog/9002.md'], fs,
    })).toEqual({ ok: false, reason: 'not-claim-stamps', restored: [] });
    expect(run.mock.calls.every(([args]) => args[0] === 'show')).toBe(true);
  });

  function fixture(head = original) {
    const fx = makeFixture();
    delete fx.env.CONVEYOR_STATE_ROOT;
    writeFile(fx.cloneDir, card, head);
    writeFile(fx.cloneDir, scorecard, '{"version":1,"records":[]}\n');
    gitOk(fx.cloneDir, ['add', '-A']);
    gitOk(fx.cloneDir, ['commit', '-qm', 'seed card']);
    gitOk(fx.cloneDir, ['push', '-q', 'origin', 'main']);
    gitOk(fx.cloneDir, ['fetch', '-q', 'origin']);
    advanceMain(fx.originDir, (dir) => writeFile(dir, 'new-on-main.txt', 'new\n'));
    return fx;
  }
  const rebuild = (fx, log) => rebuildClone({
    root: fx.cloneDir, env: fx.env, runSmoke: passSmoke(), prState: async () => null,
    lockOpts: LOCK_OPTS, log,
  });

  it.each(['active', 'preparing'])('restores a status: %s claim stamp, alerts with the diff, and moves the clone', async (status) => {
    const fx = fixture();
    writeFile(fx.cloneDir, card, stamp(original, status));
    expect(findUnsafeLocalState({ git: (args) => git(fx.cloneDir, args) }).reason).toBe('dirty');
    const log = { error: vi.fn() };
    const result = await rebuild(fx, log);
    expect(result.moved).toBe(true);
    expect(gitOk(fx.cloneDir, ['status', '--porcelain'])).toBe('');
    expect(gitOk(fx.cloneDir, ['rev-parse', 'HEAD'])).toBe(gitOk(fx.cloneDir, ['rev-parse', 'origin/main']));
    expect(result.alerts).toContainEqual(expect.objectContaining({
      kind: 'backlog-claim-stamp-restored',
      detail: { path: card, diff: expect.stringContaining(`+status: ${status}`) },
    }));
    expect(JSON.stringify(log.error.mock.calls)).toContain('backlog-claim-stamp-restored');
    const alerts = readdirSync(fx.stateDir).filter((name) => name.endsWith('.alerts.jsonl'));
    expect(alerts.some((name) => readFileSync(join(fx.stateDir, name), 'utf8').includes('backlog-claim-stamp-restored'))).toBe(true);
    // Repeated ticks after recovery neither restore again nor move an already current clone.
    for (let tick = 0; tick < 3; tick += 1) {
      const again = await rebuild(fx);
      expect(again.reason).toBe('up-to-date');
      expect(again.alerts.some((a) => a.kind === 'backlog-claim-stamp-restored')).toBe(false);
      expect(gitOk(fx.cloneDir, ['status', '--porcelain'])).toBe('');
    }
  });

  it.each([
    ['body change', original, stamp(original).replace('Body stays', 'Edited body stays')],
    ['other frontmatter key', original, stamp(original).replace('scope: []', 'scope: ["we:other"]')],
    ['non-claim status move', original.replace('open', 'active'), original.replace('open', 'resolved')],
  ])('refuses a %s as dirty without restoring', async (_label, head, work) => {
    const fx = fixture(head);
    writeFile(fx.cloneDir, card, work);
    const result = await rebuild(fx);
    expect(result.reason).toBe('dirty');
    expect(readFileSync(join(fx.cloneDir, card), 'utf8')).toBe(work);
    expect(result.alerts.some((a) => a.kind === 'backlog-claim-stamp-restored')).toBe(false);
  });

  it('refuses when a non-backlog file is also dirty, restoring nothing', async () => {
    const fx = fixture();
    writeFile(fx.cloneDir, card, stamp(original));
    writeFile(fx.cloneDir, 'README.md', 'unrelated change\n');
    const result = await rebuild(fx);
    expect(result.reason).toBe('dirty');
    expect(readFileSync(join(fx.cloneDir, card), 'utf8')).toBe(stamp(original));
    expect(readFileSync(join(fx.cloneDir, 'README.md'), 'utf8')).toBe('unrelated change\n');
    expect(result.alerts.some((a) => a.kind === 'backlog-claim-stamp-restored')).toBe(false);
  });

  it('recovers mixed dirt: a claim stamp plus a scorecard row', async () => {
    const fx = fixture();
    writeFile(fx.cloneDir, card, stamp(original));
    writeFile(fx.cloneDir, scorecard, '{"version":1,"records":[{"id":"row"}]}\n');
    const result = await rebuild(fx);
    expect(result.moved).toBe(true);
    expect(gitOk(fx.cloneDir, ['status', '--porcelain'])).toBe('');
    expect(result.alerts.map((a) => a.kind)).toContain('backlog-claim-stamp-restored');
    expect(result.alerts.map((a) => a.kind)).toContain('state-file-migrated');
    expect(JSON.parse(readFileSync(join(daemonConveyorStateRoot(fx.env), '.conveyor/run-scorecards.json'), 'utf8')).records).toEqual([{ id: 'row' }]);
  });
});

// Live 2026-09-25 13:36 ET: a review session appended a scorecard row to the TRACKED
// `scripts/conveyor/run-scorecards.json` in the review-daemon clone. The rebuild refused it as `dirty` every
// tick, the clone fell 10 commits behind origin/main, and every review and fix dispatch refused as STALE.
describe('rebuildClone — daemon runtime state in a tracked file is carried out, never a freeze', () => {
  const SC = 'scripts/conveyor/run-scorecards.json';
  const store = (records) => `${JSON.stringify({ version: 1, records }, null, 2)}\n`;

  function stateFixture() {
    const fx = makeFixture();
    delete fx.env.CONVEYOR_STATE_ROOT;
    writeFile(fx.cloneDir, SC, store([{ id: 'committed' }]));
    gitOk(fx.cloneDir, ['add', '-A']);
    gitOk(fx.cloneDir, ['commit', '-q', '-m', 'seed scorecards']);
    gitOk(fx.cloneDir, ['push', '-q', 'origin', 'main']);
    gitOk(fx.cloneDir, ['fetch', '-q', 'origin']);
    advanceMain(fx.originDir, (dir) => writeFile(dir, 'new-on-main.txt', 'x\n'));
    fx.pinned = join(fx.stateDir, 'conveyor-state', '.conveyor', 'run-scorecards.json');
    return fx;
  }

  it('carries the uncommitted rows to the pinned root, restores the file, and moves the clone to main', async () => {
    const fx = stateFixture();
    writeFile(fx.cloneDir, SC, store([{ id: 'committed' }, { id: 'row-1' }, { id: 'row-2' }]));

    const result = await rebuildClone({
      root: fx.cloneDir, env: fx.env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.reason).not.toBe('dirty');
    expect(result.moved).toBe(true);
    expect(gitOk(fx.cloneDir, ['status', '--porcelain']).trim()).toBe('');
    expect(gitOk(fx.cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(gitOk(fx.cloneDir, ['rev-parse', 'origin/main']).trim());
    expect(JSON.parse(readFileSync(fx.pinned, 'utf8')).records.map((r) => r.id)).toEqual(['committed', 'row-1', 'row-2']);
    expect(result.alerts.some((a) => a.kind === 'state-file-migrated' && a.detail?.path === SC && a.detail?.added === 3)).toBe(true);
  });

  // #4155 — the file is untracked on main (git rm + .gitignore) while an OLD-code process in the daemon clone has
  // just modified its tracked copy. The rebuild must still move the clone onto the untracking commit, carrying
  // the rows, and leave it clean — the self-heal the review daemon depends on the first tick after #4155 lands.
  it('self-heals onto the commit that UNTRACKS the store while the clone\'s tracked copy is modified', async () => {
    const fx = stateFixture();
    advanceMain(fx.originDir, (dir) => {
      rmSync(join(dir, SC));
      writeFile(dir, '.gitignore', `${SC}\n`);
    });
    writeFile(fx.cloneDir, SC, store([{ id: 'committed' }, { id: 'late-row' }]));

    const result = await rebuildClone({
      root: fx.cloneDir, env: fx.env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.reason).not.toBe('dirty');
    expect(result.moved).toBe(true);
    expect(gitOk(fx.cloneDir, ['status', '--porcelain']).trim()).toBe('');
    expect(gitOk(fx.cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(gitOk(fx.cloneDir, ['rev-parse', 'origin/main']).trim());
    expect(gitOk(fx.cloneDir, ['ls-files', '--', SC]).trim()).toBe('');
    expect(JSON.parse(readFileSync(fx.pinned, 'utf8')).records.map((r) => r.id)).toEqual(['committed', 'late-row']);
  });

  it('keeps the store\'s migration stamp when it carries rows into it (#4155)', async () => {
    const fx = stateFixture();
    writeFile(fx.stateDir, 'conveyor-state/.conveyor/run-scorecards.json',
      `${JSON.stringify({ version: 1, records: [{ id: 'committed' }], migrations: ['legacy-in-tree-store-4155'] })}\n`);
    writeFile(fx.cloneDir, SC, store([{ id: 'committed' }, { id: 'row-1' }]));

    const result = await rebuildClone({
      root: fx.cloneDir, env: fx.env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.moved).toBe(true);
    const pinned = JSON.parse(readFileSync(fx.pinned, 'utf8'));
    expect(pinned.records.map((r) => r.id)).toEqual(['committed', 'row-1']);
    expect(pinned.migrations).toEqual(['legacy-in-tree-store-4155']);
  });

  it('unions into an existing pinned store — no row lost, none duplicated', async () => {
    const fx = stateFixture();
    writeFile(fx.stateDir, 'conveyor-state/.conveyor/run-scorecards.json', store([{ id: 'committed' }, { id: 'already-pinned' }]));
    writeFile(fx.cloneDir, SC, store([{ id: 'committed' }, { id: 'row-1' }]));

    const result = await rebuildClone({
      root: fx.cloneDir, env: fx.env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.moved).toBe(true);
    expect(JSON.parse(readFileSync(fx.pinned, 'utf8')).records.map((r) => r.id)).toEqual(['committed', 'already-pinned', 'row-1']);
  });

  it('CONVEYOR_STATE_ROOT, when set, is where the rows go', async () => {
    const fx = stateFixture();
    const opRoot = mktemp('we-daemon-rebuild-oproot-');
    fx.env.CONVEYOR_STATE_ROOT = opRoot;
    writeFile(fx.cloneDir, SC, store([{ id: 'committed' }, { id: 'row-1' }]));

    const result = await rebuildClone({
      root: fx.cloneDir, env: fx.env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.moved).toBe(true);
    expect(JSON.parse(readFileSync(join(opRoot, '.conveyor', 'run-scorecards.json'), 'utf8')).records).toHaveLength(2);
  });

  it('state file dirty ALONGSIDE other tracked dirt still refuses, and migrates nothing', async () => {
    const fx = stateFixture();
    writeFile(fx.cloneDir, SC, store([{ id: 'committed' }, { id: 'row-1' }]));
    writeFile(fx.cloneDir, 'README.md', 'a real local edit\n');

    const result = await rebuildClone({
      root: fx.cloneDir, env: fx.env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.reason).toBe('dirty');
    expect(existsSync(fx.pinned)).toBe(false);
    expect(JSON.parse(readFileSync(join(fx.cloneDir, SC), 'utf8')).records).toHaveLength(2);
  });

  it('an unparsable state file is never discarded — refuses as dirty with a migrate-failed alert', async () => {
    const fx = stateFixture();
    writeFile(fx.cloneDir, SC, '{ not json');

    const result = await rebuildClone({
      root: fx.cloneDir, env: fx.env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.reason).toBe('dirty');
    expect(readFileSync(join(fx.cloneDir, SC), 'utf8')).toBe('{ not json');
    expect(result.alerts.some((a) => a.kind === 'state-file-migrate-failed' && a.detail?.reason === 'state-file-unparsable')).toBe(true);
  });

  it('an unreadable pinned store is never overwritten — refuses instead', async () => {
    const fx = stateFixture();
    writeFile(fx.stateDir, 'conveyor-state/.conveyor/run-scorecards.json', 'corrupt');
    writeFile(fx.cloneDir, SC, store([{ id: 'committed' }, { id: 'row-1' }]));

    const result = await rebuildClone({
      root: fx.cloneDir, env: fx.env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS,
    });

    expect(result.reason).toBe('dirty');
    expect(readFileSync(fx.pinned, 'utf8')).toBe('corrupt');
  });
});

describe('isDaemonManagedClone / daemonConveyorStateRoot', () => {
  it('a clone with a registered overlay list or rebuild state is daemon-managed; a plain one is not', () => {
    const fx = makeFixture();
    expect(isDaemonManagedClone(fx.cloneDir, fx.env)).toBe(false);
    addOverlay(fx.cloneDir, { ref: 'lane/x' }, { env: fx.env });
    expect(isDaemonManagedClone(fx.cloneDir, fx.env)).toBe(true);
  });

  it('defaults under the rebuild state dir; CONVEYOR_STATE_ROOT wins', () => {
    expect(daemonConveyorStateRoot({ WE_DAEMON_STATE_DIR: '/s' })).toBe(join('/s', 'conveyor-state'));
    expect(daemonConveyorStateRoot({ WE_DAEMON_STATE_DIR: '/s', CONVEYOR_STATE_ROOT: '/op' })).toBe('/op');
  });
});


describe('landed backlog sidecar cleanup (#4458)', () => {
  it('prunes landed sidecars on a current HEAD and repeated ticks are idempotent', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    const mainSha = advanceMain(originDir, (dir) => writeFile(dir, 'backlog/123-landed.md', '---\nbornAs: xabc123\n---\nNumbered content\n'));
    gitOk(cloneDir, ['fetch', '-q', 'origin']);
    gitOk(cloneDir, ['reset', '--hard', mainSha]);
    writeFile(cloneDir, 'backlog/xabc123-original.md', 'different provisional bytes\n');
    writeFile(cloneDir, 'backlog/xdef456-unlanded.md', 'survivor\n');
    const opts = { root: cloneDir, env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS };
    const first = await rebuildClone(opts);
    expect(first.reason).toBe('up-to-date');
    expect(existsSync(join(cloneDir, 'backlog/xabc123-original.md'))).toBe(false);
    expect(first.alerts.filter((a) => a.kind === 'backlog-sidecar-pruned')).toEqual([{
      kind: 'backlog-sidecar-pruned', detail: { path: 'backlog/xabc123-original.md', hash: 'xabc123', landedPath: 'backlog/123-landed.md', mainSha },
    }]);
    expect(first.alerts.find((a) => a.kind === 'untracked-kept').detail.paths).toEqual(['backlog/xdef456-unlanded.md']);
    for (let tick = 0; tick < 3; tick++) {
      const again = await rebuildClone(opts);
      expect(again.reason).toBe('up-to-date');
      expect(again.alerts.map((a) => a.kind)).toEqual(['untracked-kept']);
      expect(readFileSync(join(cloneDir, 'backlog/xdef456-unlanded.md'), 'utf8')).toBe('survivor\n');
    }
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(mainSha);
  });

  it('uses freshly fetched main only, accepts quoted scalars, and preserves unsafe evidence and paths', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    const evidence = {
      '101-single.md': "---\nbornAs: 'xabc123'\n---\n",
      '102-double.md': '---\nbornAs: "xdef456"\n---\n',
      '103-prefix.md': '---\nbornAs: xghi789extra\n---\n',
      '104-body.md': '---\nstatus: open\n---\nbornAs: xjkl012\n',
      '105-duplicate.md': '---\nbornAs: xmno345\nbornAs: xmno345\n---\n',
      '106-malformed.md': '---\nbornAs: xpqr678\nbroken: [\n---\n',
      '107-quote.md': '---\nbornAs: "xstu901\n---\n',
      '108-delimiter.md': '---\nbornAs: xvwx234\n---oops\n',
      'xyza567-proof.md': '---\nbornAs: xyza567\n---\n',
      '109-nested.md': '---\nexample:\n  bornAs: xbcd890\n---\n',
    };
    const mainSha = advanceMain(originDir, (dir) => {
      for (const [name, text] of Object.entries(evidence)) writeFile(dir, `backlog/${name}`, text);
      writeFile(dir, 'backlog/xabc123-tracked.md', 'tracked\n');
      writeFile(dir, '.gitignore', 'backlog/xabc123-ignored.md\n');
    });
    // Get ignore/tracked sentinels without adopting the newly fetched landing evidence.
    gitOk(cloneDir, ['fetch', '-q', 'origin']);
    gitOk(cloneDir, ['reset', '--hard', mainSha]);
    advanceMain(originDir, (dir) => writeFile(dir, 'backlog/110-fresh.md', '---\nbornAs: xcde123\n---\n'));
    pushBranch(originDir, 'lane/evidence', (dir) => writeFile(dir, 'backlog/111-overlay.md', '---\nbornAs: xefg456\n---\n'));
    addOverlay(cloneDir, { ref: 'lane/evidence' }, { env });
    const survivors = [
      'backlog/xghi789-copy.md', 'backlog/xjkl012-copy.md', 'backlog/xmno345-copy.md',
      'backlog/xpqr678-copy.md', 'backlog/xstu901-copy.md', 'backlog/xvwx234-copy.md',
      'backlog/xyza567-copy.md', 'backlog/xbcd890-copy.md', 'backlog/xefg456-copy.md',
      'backlog/xfgh789-copy.md', 'backlog/xabc123-ignored.md', 'backlog/xabc123-nested/file.md',
      'backlog/xabc123-copy.txt', 'backlog/xabc1234-copy.md', 'other/xabc123-copy.md',
      'backlog/999-local.md',
    ];
    for (const path of survivors) writeFile(cloneDir, path, 'sentinel\n');
    writeFile(cloneDir, 'backlog/998-local-evidence.md', '---\nbornAs: xfgh789\n---\n');
    mkdirSync(join(cloneDir, 'backlog/xabc123-directory.md'));
    symlinkSync('../README.md', join(cloneDir, 'backlog/xabc123-symlink.md'));
    const removed = ['backlog/xabc123-copy.md', 'backlog/xdef456-copy.md', 'backlog/xcde123-copy.md'];
    for (const path of removed) writeFile(cloneDir, path, 'old content\n');
    const result = await rebuildClone({ root: cloneDir, env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS });
    expect(result.adopted).toBe(true);
    expect(result.alerts.filter((a) => a.kind === 'backlog-sidecar-pruned').map((a) => a.detail.path).sort()).toEqual(removed.sort());
    for (const path of removed) expect(existsSync(join(cloneDir, path))).toBe(false);
    for (const path of survivors) expect(readFileSync(join(cloneDir, path), 'utf8')).toBe('sentinel\n');
    expect(lstatSync(join(cloneDir, 'backlog/xabc123-directory.md')).isDirectory()).toBe(true);
    expect(lstatSync(join(cloneDir, 'backlog/xabc123-symlink.md')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(cloneDir, 'backlog/xabc123-tracked.md'), 'utf8')).toBe('tracked\n');
  });

  it.each(['fetch', 'search', 'blob', 'main-sha', 'recheck', 'unlink', 'tracked', 'refresh', 'absent', 'parent-symlink'])(
    'fails closed for %s without inventing successful deletions', async (failure) => {
      const { originDir, cloneDir, env } = makeFixture();
      advanceMain(originDir, (dir) => writeFile(dir, 'backlog/123-landed.md', '---\nbornAs: xabc123\n---\n'));
      const path = 'backlog/xabc123-copy.md';
      writeFile(cloneDir, path, 'sentinel\n');
      let inventories = 0;
      let changed = false;
      const run = (args, opts) => {
        if ((failure === 'main-sha' && args[0] === 'rev-parse' && args.includes('origin/main^{commit}'))
          || (failure === 'fetch' && args[0] === 'fetch') || (failure === 'search' && args[0] === 'grep')
          || (failure === 'blob' && args[0] === 'show' && args[1].endsWith(':backlog/123-landed.md')))
          return { status: 2, stdout: '', stderr: 'injected failure' };
        if (args[0] === 'ls-files' && args.includes('--others')) {
          inventories++;
          if (failure === 'recheck' && inventories === 2) return { status: 1, stdout: '', stderr: 'inventory unavailable' };
          if (inventories === 2) {
            if (failure === 'tracked') { gitOk(cloneDir, ['add', path]); changed = true; }
            if (failure === 'unlink') { chmodSync(join(cloneDir, 'backlog'), 0o555); changed = true; }
            if (failure === 'absent') rmSync(join(cloneDir, path));
            if (failure === 'parent-symlink') {
              const external = mktemp('we-sidecar-external-');
              writeFile(external, 'xabc123-copy.md', 'sentinel\n');
              rmSync(join(cloneDir, 'backlog'), { recursive: true });
              symlinkSync(external, join(cloneDir, 'backlog'));
              // A stale inventory must still fail the filesystem type check.
              return { status: 0, stdout: `${path}\0`, stderr: '' };
            }
          }
          if (failure === 'refresh' && inventories === 3) return { status: 1, stdout: '', stderr: 'inventory unavailable' };
        }
        return gitRun(args, opts);
      };
      let result;
      try {
        result = await rebuildClone({ root: cloneDir, env, run, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS });
      } finally {
        if (failure === 'unlink' && changed) chmodSync(join(cloneDir, 'backlog'), 0o755);
      }
      if (failure === 'refresh') {
        expect(result.reason).toBe('status-failed');
        expect(existsSync(join(cloneDir, path))).toBe(false);
      } else {
        expect(result.alerts.filter((a) => a.kind === 'backlog-sidecar-pruned')).toEqual([]);
        if (failure !== 'absent') expect(readFileSync(join(cloneDir, path), 'utf8')).toBe('sentinel\n');
      }
      if (['search', 'blob', 'main-sha', 'recheck', 'unlink'].includes(failure)) expect(result.alerts.some((a) => a.kind === 'backlog-sidecar-prune-failed')).toBe(true);
      if (failure === 'fetch') {
        expect(result.reason).toBe('fetch-failed');
        expect(result.alerts.find((a) => a.kind === 'untracked-kept').detail.paths).toContain(path);
      }
      if (failure === 'tracked') { expect(changed).toBe(true); expect(result.reason).toBe('dirty'); }
    },
  );

  it('keeps a collision sentinel and dry run preserves sidecar bytes, index and refs', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    advanceMain(originDir, (dir) => {
      writeFile(dir, 'backlog/123-landed.md', '---\nbornAs: xabc123\n---\n');
      writeFile(dir, 'collision.txt', 'incoming\n');
    });
    writeFile(cloneDir, 'backlog/xabc123-copy.md', 'provisional\n');
    writeFile(cloneDir, 'collision.txt', 'sentinel\n');
    const before = { index: readFileSync(join(cloneDir, '.git/index')), refs: gitOk(cloneDir, ['show-ref']) };
    await dryRunRebuild({ root: cloneDir, env, prState: async () => null });
    expect(readFileSync(join(cloneDir, 'backlog/xabc123-copy.md'), 'utf8')).toBe('provisional\n');
    expect(readFileSync(join(cloneDir, '.git/index'))).toEqual(before.index);
    expect(gitOk(cloneDir, ['show-ref'])).toBe(before.refs);
    const result = await rebuildClone({ root: cloneDir, env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS });
    expect(result.reason).toBe('untracked-collision');
    expect(readFileSync(join(cloneDir, 'collision.txt'), 'utf8')).toBe('sentinel\n');
    expect(existsSync(join(cloneDir, 'backlog/xabc123-copy.md'))).toBe(false);
    expect(result.alerts.find((a) => a.kind === 'untracked-kept').detail.paths).toEqual(['collision.txt']);
  });

  it('refreshes the inventory before cached-ready collision checks', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    const path = 'backlog/xabc123-copy.md';
    const target = advanceMain(originDir, (dir) => {
      writeFile(dir, 'backlog/123-landed.md', '---\nbornAs: xabc123\n---\n');
      writeFile(dir, path, 'tracked incoming\n');
    });
    const readOpts = { lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT, owner: 'sidecar-test-reader' };
    const opts = { root: cloneDir, env, prState: async () => null, lockOpts: { waitMs: 30, pollMs: 5 } };
    const first = await rebuildClone({ ...opts, runSmoke: async () => {
      expect(acquireRead(cloneDir, readOpts).ok).toBe(true);
      return { verdict: 'pass', attempts: 1, smoke: { results: [] } };
    } });
    expect(first.reason).toBe('tick-in-progress');
    releaseRead(cloneDir, readOpts);
    writeFile(cloneDir, path, 'provisional\n');
    const runSmoke = passSmoke();
    const second = await rebuildClone({ ...opts, runSmoke });
    expect(second.reason).toBe('ready-adopted');
    expect(runSmoke).not.toHaveBeenCalled();
    expect(second.alerts.some((a) => a.kind === 'backlog-sidecar-pruned')).toBe(true);
    expect(second.alerts.some((a) => a.kind === 'untracked-kept')).toBe(false);
    expect(gitOk(cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(target);
    expect(readFileSync(join(cloneDir, path), 'utf8')).toBe('tracked incoming\n');
  });


  it('pins landing reads even if origin/main changes after the evidence search', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    const oldHead = gitOk(cloneDir, ['rev-parse', 'HEAD']).trim();
    const mainSha = advanceMain(originDir, (dir) => writeFile(dir, 'backlog/123-landed.md', '---\nbornAs: xabc123\n---\n'));
    writeFile(cloneDir, 'backlog/xabc123-copy.md', 'provisional\n');
    const proofReads = [];
    const run = (args, opts) => {
      const result = gitRun(args, opts);
      if (args[0] === 'grep') gitOk(cloneDir, ['update-ref', 'refs/remotes/origin/main', oldHead]);
      if (args[0] === 'show' && args[1].includes(':backlog/')) proofReads.push(args[1]);
      return result;
    };
    const result = await rebuildClone({ root: cloneDir, env, run, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS });
    expect(proofReads).toEqual([`${mainSha}:backlog/123-landed.md`]);
    expect(result.alerts.find((a) => a.kind === 'backlog-sidecar-pruned').detail.mainSha).toBe(mainSha);
    expect(existsSync(join(cloneDir, 'backlog/xabc123-copy.md'))).toBe(false);
  });

});

describe('starved rebuild wait is bounded (live 2026-10-07: 900s waits starved the sibling daemon)', () => {
  it('defaults the starved wait to at most 3 minutes', async () => {
    const { starvationLockWaitMs, DEFAULT_STARVED_LOCK_WAIT_MS } = await import('../daemon-rebuild/lease.mjs');
    expect(DEFAULT_STARVED_LOCK_WAIT_MS).toBeLessThanOrEqual(180_000);
    expect(starvationLockWaitMs(60_000, 5, {})).toBeLessThanOrEqual(180_000);
  });
});
