/**
 * @file scripts/lib/__tests__/daemon-rebuild-adopt-lease-plumbing.test.mjs
 * @description R830 plumbing: the daemon tick's adopt-only pass (rebuildClone → prepareRebuild → claimBuildLease) must
 *   record `adoptOnly` on the transient lease it takes. If its release write fails, that lease stays on disk with the
 *   daemon's own live pid; another process (the rebuild job) must still be able to claim it at once. The unit tests
 *   call claimBuildLease directly, so only this test reddens when a pass-through in rebuild.mjs or prepare.mjs is lost.
 *   Real temp git fixtures (helpers copied from daemon-rebuild-job.test.mjs, never imported).
 */
import {
  describe, it, expect, afterAll, afterEach, vi,
} from 'vitest';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

import { spawnKeepAlive } from '../test-keepalive.mjs';
import { rebuildClone, readRebuildState } from '../daemon-rebuild.mjs';
import { ACTIVE_BUILD_TOKENS, buildLeaseIsLive, claimBuildLease } from '../daemon-rebuild/lease.mjs';

// The adopt-only pass releases its lease through releaseBuildLease; make that one write fail, like a full disk would.
const releaseControl = vi.hoisted(() => ({ fail: false }));
vi.mock('../daemon-rebuild/lease.mjs', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    releaseBuildLease: (...args) => {
      if (releaseControl.fail) throw new Error('release write failed (simulated)');
      return real.releaseBuildLease(...args);
    },
  };
});

const tempDirs = [];
function mktemp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
function gitOk(cwd, args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}
function writeFile(dir, name, content) {
  const full = join(dir, name);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}
function makeFixtureWithPendingMain() {
  const base = mktemp('we-adopt-lease-fixture-');
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
  const author = join(mktemp('we-adopt-lease-author-'), 'w');
  gitOk(base, ['clone', '-q', originDir, author]);
  gitOk(author, ['checkout', '-q', '-B', 'main', 'origin/main']);
  writeFile(author, 'd.txt', 'd\n');
  gitOk(author, ['add', '-A']);
  gitOk(author, ['commit', '-q', '-m', 'change']);
  gitOk(author, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  const env = {
    ...process.env,
    WE_DAEMON_STATE_DIR: mktemp('we-adopt-lease-state-'),
    WE_DAEMON_CLONE_LOCK_ROOT: mktemp('we-adopt-lease-lock-'),
    WE_DAEMON_OVERLAY_DIR: mktemp('we-adopt-lease-overlay-'),
    WE_DAEMON_JOBS_ROOT: mktemp('we-adopt-lease-jobs-'),
  };
  delete env.WE_DAEMON_REBUILD_AS_JOB;
  return { cloneDir, env };
}

const LOCK_OPTS = { waitMs: 1500, pollMs: 20 };
const quietLog = { error: () => {}, warn: () => {}, log: () => {} };
const child = spawnKeepAlive({ maxLifetimeMs: 120_000 });

afterEach(() => {
  releaseControl.fail = false;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});
afterAll(() => child.kill());

describe('R830 adoptOnly plumbing: rebuildClone → prepareRebuild → claimBuildLease', () => {
  it('records adoptOnly on the lease; when the release write fails, another live process still reclaims it at once', async () => {
    const { cloneDir, env } = makeFixtureWithPendingMain();
    releaseControl.fail = true;
    const r = await rebuildClone({
      root: cloneDir, env, runSmoke: vi.fn(), prState: async () => null, lockOpts: LOCK_OPTS, adoptOnly: true, log: quietLog,
    });
    expect(r).toMatchObject({ moved: false, reason: 'needs-build' });

    // The failed release left the transient lease on disk, naming this (the daemon's) pid.
    const left = readRebuildState(cloneDir, env).building;
    expect(left).toBeTruthy();
    expect(left.pid).toBe(process.pid);
    expect(left.adoptOnly).toBe(true);

    // Re-read it as a DIFFERENT process (the rebuild job) sees it: the owner pid is a live, long-running other process.
    const nowMs = Date.now();
    const asSeenByJob = { ...left, pid: child.pid };
    const startTimeOf = () => nowMs - 3_600_000;
    expect(buildLeaseIsLive(asSeenByJob, { nowMs, startTimeOf })).toBe(false);
    const state = { building: asSeenByJob };
    const got = claimBuildLease({
      state, plan: { finalSha: 'a'.repeat(40), inputsKey: 'k' }, root: cloneDir, run: () => ({ status: 0, stdout: '', stderr: '' }), env, nowMs, startTimeOf,
    });
    if (got) ACTIVE_BUILD_TOKENS.delete(got.token);
    expect(got).not.toBeNull();

    // Control: the same lease without the flag (a real build) blocks that other process.
    const { adoptOnly: _drop, ...plain } = asSeenByJob;
    expect(buildLeaseIsLive(plain, { nowMs, startTimeOf })).toBe(true);
  });

  it('an adopt-only pass whose release succeeds leaves no lease behind', async () => {
    const { cloneDir, env } = makeFixtureWithPendingMain();
    const r = await rebuildClone({
      root: cloneDir, env, runSmoke: vi.fn(), prState: async () => null, lockOpts: LOCK_OPTS, adoptOnly: true, log: quietLog,
    });
    expect(r.reason).toBe('needs-build');
    expect(readRebuildState(cloneDir, env).building ?? null).toBeNull();
  });
});
