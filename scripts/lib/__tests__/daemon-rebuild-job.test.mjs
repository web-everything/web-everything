/**
 * @file scripts/lib/__tests__/daemon-rebuild-job.test.mjs
 * @description #4126 — the clone rebuild's build + live smoke run as a detached job, so an opted-in daemon's tick
 *   never waits on a smoke (live 2026-10-09: the drain merged nothing while inline smokes took 421 s and 1,002 s).
 *   Real temp git fixtures, injected `runSmoke` stubs (same conventions as daemon-rebuild-ready.test.mjs; helpers
 *   copied, never imported).
 */
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  rebuildClone, readRebuildState, readReadyCandidate,
} from '../daemon-rebuild.mjs';
import {
  resolveRebuildAsJob, rebuildCloneAsJob, rebuildChildArgs, parseRebuildChildOutput, REBUILD_JOB_KIND, RESULT_SUFFIX,
} from '../daemon-rebuild/rebuild-job.mjs';
import { createJobStore, enqueueJob } from '../daemon-jobs-runtime.mjs';
import { markSucceeded } from '../daemon-jobs.mjs';

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
function advanceMain(originDir, mutate) {
  const dir = join(mktemp('we-rebuild-job-author-'), 'w');
  const r = spawnSync('git', ['clone', '-q', originDir, dir], { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' });
  if (r.status !== 0) throw new Error(`clone failed: ${r.stderr}`);
  gitOk(dir, ['checkout', '-q', '-B', 'main', 'origin/main']);
  mutate(dir);
  gitOk(dir, ['add', '-A']);
  gitOk(dir, ['commit', '-q', '-m', 'change']);
  gitOk(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  return gitOk(dir, ['rev-parse', 'HEAD']).trim();
}
function makeFixture() {
  const base = mktemp('we-rebuild-job-fixture-');
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
    WE_DAEMON_STATE_DIR: mktemp('we-rebuild-job-state-'),
    WE_DAEMON_CLONE_LOCK_ROOT: mktemp('we-rebuild-job-lock-'),
    WE_DAEMON_OVERLAY_DIR: mktemp('we-rebuild-job-overlay-'),
    WE_DAEMON_JOBS_ROOT: mktemp('we-rebuild-job-jobs-'),
  };
  delete env.WE_DAEMON_REBUILD_AS_JOB;
  return { originDir, cloneDir, env };
}
const head = (dir) => gitOk(dir, ['rev-parse', 'HEAD']).trim();
const LOCK_OPTS = { waitMs: 1500, pollMs: 20 };
const PASS = { verdict: 'pass', attempts: 1, smoke: { results: [] } };
const quietLog = { error: () => {}, warn: () => {}, log: () => {} };

beforeEach(() => { tempDirs.length = 0; });
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe('the opted-in daemon tick never runs the smoke inline (the live harm)', () => {
  it('a drain-entry rebuild queues a job and returns at once, the clone untouched', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    const before = head(cloneDir);
    advanceMain(originDir, (dir) => writeFile(dir, 'a.txt', 'a\n'));
    const runSmoke = vi.fn(async () => PASS);
    const r = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS, entries: ['scripts/merge-ai-prs.mjs'], log: quietLog,
    });
    expect(runSmoke).not.toHaveBeenCalled();
    expect(r.moved).toBe(false);
    expect(r.reason).toBe('rebuild-job-started');
    expect(r.job?.id).toMatch(/^job-daemon-rebuild/);
    expect(head(cloneDir)).toBe(before);
  });

  it('a caller that is not opted in keeps the inline gated rebuild', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    const target = advanceMain(originDir, (dir) => writeFile(dir, 'b.txt', 'b\n'));
    const runSmoke = vi.fn(async () => PASS);
    const r = await rebuildClone({ root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS, log: quietLog });
    expect(runSmoke).toHaveBeenCalled();
    expect(r.adopted).toBe(true);
    expect(head(cloneDir)).toBe(target);
  });
});

describe('the job records a passed build; the tick adopts it without re-smoking', () => {
  it('readyOnly never moves the clone; adoptOnly then adopts the ready candidate with no smoke', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    const before = head(cloneDir);
    const target = advanceMain(originDir, (dir) => writeFile(dir, 'c.txt', 'c\n'));
    const runSmoke = vi.fn(async () => PASS);
    const job = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS, readyOnly: true, log: quietLog,
    });
    expect(runSmoke).toHaveBeenCalledTimes(1);
    expect(job.reason).toBe('ready-recorded');
    expect(job.readyRecorded).toBe(true);
    expect(head(cloneDir)).toBe(before);
    expect(readReadyCandidate(cloneDir, env)?.adopt.finalSha).toBe(target);
    expect(readRebuildState(cloneDir, env).building ?? null).toBeNull();

    const noSmoke = vi.fn(async () => PASS);
    const tick = await rebuildClone({
      root: cloneDir, env, runSmoke: noSmoke, prState: async () => null, lockOpts: LOCK_OPTS, adoptOnly: true, log: quietLog,
    });
    expect(noSmoke).not.toHaveBeenCalled();
    expect(tick.adopted).toBe(true);
    expect(tick.reason).toBe('ready-adopted');
    expect(head(cloneDir)).toBe(target);
  });

  it('adoptOnly with nothing ready says a build is due, smokes nothing and leaves no lease', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    const before = head(cloneDir);
    advanceMain(originDir, (dir) => writeFile(dir, 'd.txt', 'd\n'));
    const runSmoke = vi.fn(async () => PASS);
    const r = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS, adoptOnly: true, log: quietLog,
    });
    expect(runSmoke).not.toHaveBeenCalled();
    expect(r.reason).toBe('needs-build');
    expect(head(cloneDir)).toBe(before);
    expect(readRebuildState(cloneDir, env).building ?? null).toBeNull();
  });

  it('a candidate failing its smoke (last-good passing) records no ready candidate and never moves the clone', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    const before = head(cloneDir);
    advanceMain(originDir, (dir) => writeFile(dir, 'e.txt', 'e\n'));
    const FAIL = { verdict: 'code', attempts: 1, smoke: { results: [{ ok: false, name: 'x', detail: 'boom' }] } };
    const r = await rebuildClone({
      root: cloneDir, env, runSmoke: async ({ root }) => (existsSync(join(root, 'e.txt')) ? FAIL : PASS), prState: async () => null, lockOpts: LOCK_OPTS, readyOnly: true, log: quietLog,
    });
    expect(r.readyRecorded).not.toBe(true);
    expect(readReadyCandidate(cloneDir, env)).toBeNull();
    expect(head(cloneDir)).toBe(before);
  });
});

describe('rebuildCloneAsJob — the tick side', () => {
  const setup = () => {
    const dir = mktemp('we-rebuild-job-store-');
    return { store: createJobStore(dir), reattach: vi.fn(async () => ({ slept: false, actions: [] })) };
  };

  it('queues one job when a build is due, then reports it running without calling adopt again', async () => {
    const { store, reattach } = setup();
    const adopt = vi.fn(async () => ({ moved: false, reason: 'needs-build', plan: { finalSha: 'abc123' } }));
    const first = await rebuildCloneAsJob({
      root: '/tmp/x', adopt, store, reattach, codeSha: 'a'.repeat(40), log: quietLog, evict: () => ({ evicted: [] }),
    });
    expect(first.reason).toBe('rebuild-job-started');
    expect(store.list().records).toHaveLength(1);
    const second = await rebuildCloneAsJob({
      root: '/tmp/x', adopt, store, reattach, codeSha: 'a'.repeat(40), log: quietLog, evict: () => ({ evicted: [] }),
    });
    expect(second.reason).toBe('rebuild-job-running');
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(store.list().records).toHaveLength(1);
  });

  it('consumes a finished job that recorded a ready build and lets the adopt-only pass swap', async () => {
    const { store, reattach } = setup();
    const rec = enqueueJob({ store, kindDef: REBUILD_JOB_KIND, codeSha: 'b'.repeat(40), input: { root: '/tmp/x' } });
    store.update(rec.id, (r) => markSucceeded(r, { at: new Date().toISOString() }));
    writeFileSync(join(store.dir, `${rec.id}${RESULT_SUFFIX}`), JSON.stringify({ reason: 'ready-recorded', readyRecorded: true, target: 'f00' }));
    const adopt = vi.fn(async () => ({ moved: true, adopted: true, reason: 'ready-adopted', head: 'f00' }));
    const r = await rebuildCloneAsJob({
      root: '/tmp/x', adopt, store, reattach, codeSha: 'b'.repeat(40), log: quietLog, evict: () => ({ evicted: [] }),
    });
    expect(r.adopted).toBe(true);
    expect(r.finishedJobs).toEqual([expect.objectContaining({ id: rec.id, readyRecorded: true })]);
    const again = await rebuildCloneAsJob({
      root: '/tmp/x', adopt: async () => ({ moved: false, reason: 'up-to-date' }), store, reattach, codeSha: 'b'.repeat(40), log: quietLog, evict: () => ({ evicted: [] }),
    });
    expect(again.finishedJobs).toEqual([]);
  });

  it('spaces a new build after one that recorded nothing', async () => {
    const { store, reattach } = setup();
    const rec = enqueueJob({ store, kindDef: REBUILD_JOB_KIND, codeSha: 'c'.repeat(40), input: { root: '/tmp/x' } });
    store.update(rec.id, (r) => markSucceeded(r, { at: new Date().toISOString() }));
    writeFileSync(join(store.dir, `${rec.id}${RESULT_SUFFIX}`), JSON.stringify({ reason: 'smoke-transient', readyRecorded: false }));
    const adopt = vi.fn(async () => ({ moved: false, reason: 'needs-build', plan: { finalSha: 'abc' } }));
    const r = await rebuildCloneAsJob({
      root: '/tmp/x', adopt, store, reattach, codeSha: 'c'.repeat(40), log: quietLog, evict: () => ({ evicted: [] }),
      settings: { entries: [], minIntervalMs: 60_000 },
    });
    expect(r.reason).toBe('rebuild-job-spaced');
    expect(store.list().records).toHaveLength(1);
  });
});

describe('opt-in and child plumbing', () => {
  it('resolves job mode by entry basename, with an env override both ways', () => {
    const settings = { entries: ['merge-ai-prs.mjs'], minIntervalMs: 0 };
    expect(resolveRebuildAsJob({ entries: ['scripts/merge-ai-prs.mjs'], env: {}, settings })).toBe(true);
    expect(resolveRebuildAsJob({ entries: ['scripts/review-daemon.mjs'], env: {}, settings })).toBe(false);
    expect(resolveRebuildAsJob({ entries: undefined, env: {}, settings })).toBe(false);
    expect(resolveRebuildAsJob({ entries: ['scripts/merge-ai-prs.mjs'], env: { WE_DAEMON_REBUILD_AS_JOB: '0' }, settings })).toBe(false);
    expect(resolveRebuildAsJob({ entries: [], env: { WE_DAEMON_REBUILD_AS_JOB: '1' }, settings })).toBe(true);
  });

  it('builds the ready-only CLI argv and parses its last JSON line', () => {
    expect(rebuildChildArgs({ root: '/c', entries: ['scripts/merge-ai-prs.mjs'], mainOnly: true }, '/s/cli.mjs'))
      .toEqual(['/s/cli.mjs', '--clone=/c', '--ready-only', '--json', '--entry=scripts/merge-ai-prs.mjs', '--main-only']);
    expect(parseRebuildChildOutput('noise\n{"reason":"x"}\n{"reason":"ready-recorded","readyRecorded":true}\n'))
      .toEqual({ reason: 'ready-recorded', readyRecorded: true });
    expect(parseRebuildChildOutput('no json')).toBeNull();
  });
});
