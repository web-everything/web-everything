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
  mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync,
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
import { readRebuildStarvation, writeRebuildStarvation } from '../daemon-rebuild/lease.mjs';
import * as rebuildLease from '../daemon-rebuild/lease.mjs';
import { createJobStore, enqueueJob } from '../daemon-jobs-runtime.mjs';
import { acquireRead, releaseRead } from '../daemon-clone-lock.mjs';
import { markSucceeded } from '../daemon-jobs.mjs';
import * as rebuildJobs from '../daemon-rebuild/rebuild-job.mjs';
import * as snapshots from '../daemon-job-snapshots.mjs';
import * as prepare from '../daemon-rebuild/prepare.mjs';
import { writeReadyCandidate } from '../daemon-rebuild/state.mjs';

// R787 proposed IO seam: rebuildClone({ adoptChild: { run } }). `run` has
// spawnSync's (executable, argv, options) -> {status, stdout, error} contract.
// Only the child runner is injected; snapshot selection and result validation
// must remain production behavior. No production seam is implemented here.


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
  vi.restoreAllMocks();
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

    writeRebuildStarvation(cloneDir, 3, env);
    const noSmoke = vi.fn(async () => PASS);
    const tick = await rebuildClone({
      root: cloneDir, env, runSmoke: noSmoke, prState: async () => null, lockOpts: LOCK_OPTS, adoptOnly: true, log: quietLog,
    });
    expect(noSmoke).not.toHaveBeenCalled();
    expect(tick.adopted).toBe(true);
    expect(readRebuildStarvation(cloneDir, env)).toBe(0);
    expect(tick.reason).toBe('ready-adopted');
    expect(head(cloneDir)).toBe(target);
  });

  it('adoptOnly with nothing ready says a build is due, smokes nothing and leaves no lease', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    const before = head(cloneDir);
    advanceMain(originDir, (dir) => writeFile(dir, 'd.txt', 'd\n'));
    const stateOpts = { env: { WE_DAEMON_STATE_DIR: mktemp('we-rebuild-job-starve-') } };
    writeRebuildStarvation(cloneDir, 3, stateOpts.env);
    expect(readRebuildStarvation(cloneDir, stateOpts.env)).toBe(3);
    const runSmoke = vi.fn(async () => PASS);
    const r = await rebuildClone({
      root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS, adoptOnly: true, stateOpts, log: quietLog,
    });
    expect(readRebuildStarvation(cloneDir, stateOpts.env)).toBe(3);
    expect(runSmoke).not.toHaveBeenCalled();
    expect(r.reason).toBe('needs-build');
    expect(head(cloneDir)).toBe(before);
    expect(readRebuildState(cloneDir, { ...env, ...stateOpts.env }).building ?? null).toBeNull();
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

// live 2026-10-11 rebuild-job livelock.
describe('detached rebuild lock wait', () => {
  it.each([undefined, 42])('uses the job wait at prepare and finalize, with caller override %s', async (waitMs) => {
    const { originDir, cloneDir, env } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'wait.txt', 'wait\n'));
    const before = head(cloneDir);
    let clock = Date.now();
    const reader = { owner: 'sibling', lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT };
    const startTick = () => expect(acquireRead(cloneDir, { ...reader, nowMs: clock }).ok).toBe(true);
    startTick();
    const waits = [];
    const r = await rebuildClone({
      root: cloneDir, env, readyOnly: true, log: quietLog,
      now: () => clock,
      sleep: async (ms) => { clock += ms; releaseRead(cloneDir, reader); },
      lockOpts: {
        pollMs: 1, ...(waitMs === undefined ? {} : { waitMs }),
        onBlocked: ({ waitMs: actual }) => waits.push(actual),
      },
      runSmoke: async () => { startTick(); return PASS; },
      prState: async () => null,
    });
    expect(waits).toEqual([waitMs ?? 900_000, waitMs ?? 900_000]);
    expect(r.reason).toBe('ready-recorded');
    expect(head(cloneDir)).toBe(before);
  });

  it('allows fifteen minutes for the job without changing foreground waits', () => {
    expect(rebuildLease.REBUILD_JOB_LOCK_WAIT_ENV).toBe('WE_DAEMON_REBUILD_JOB_LOCK_WAIT_MS');
    expect(rebuildLease.DEFAULT_REBUILD_JOB_LOCK_WAIT_MS).toBe(15 * 60_000);
    expect(rebuildLease.rebuildLockWaitMs({ env: {}, readyOnly: true })).toBe(900_000);
    expect(rebuildLease.rebuildLockWaitMs({ env: {} })).toBe(60_000);
    expect(rebuildLease.rebuildLockWaitMs({ env: {}, starvedCount: 3 })).toBe(180_000);
  });

  it('honours positive overrides and never shortens the normal computed wait', () => {
    const wait = (env) => rebuildLease.rebuildLockWaitMs({ env, readyOnly: true, starvedCount: 3 });
    expect(wait({ WE_DAEMON_REBUILD_JOB_LOCK_WAIT_MS: '1200000' })).toBe(1_200_000);
    expect(wait({ WE_DAEMON_REBUILD_JOB_LOCK_WAIT_MS: '1' })).toBe(180_000);
    expect(wait({ WE_DAEMON_REBUILD_LOCK_WAIT_MS: '1500000' })).toBe(1_500_000);
    for (const value of ['0', '-1', 'invalid']) {
      expect(wait({ WE_DAEMON_REBUILD_JOB_LOCK_WAIT_MS: value })).toBe(900_000);
    }
  });
});


describe('R787 — reviewed origin/main owns rebuild job code', () => {
  it('pins the queued job to origin/main, distinct from both loaded HEAD and candidate', async () => {
    const { cloneDir, env } = makeFixture();
    const mainSha = head(cloneDir);
    writeFile(cloneDir, 'candidate.txt', 'candidate only\n');
    gitOk(cloneDir, ['add', '-A']);
    gitOk(cloneDir, ['commit', '-q', '-m', 'candidate']);
    const candidateSha = head(cloneDir);
    writeFile(cloneDir, 'loaded.txt', 'loaded tree only\n');
    gitOk(cloneDir, ['add', '-A']);
    gitOk(cloneDir, ['commit', '-q', '-m', 'loaded daemon']);
    const loadedSha = head(cloneDir);
    const store = createJobStore(mktemp('r787-jobs-'));
    const reattach = vi.fn(async () => ({ actions: [] }));
    const result = await rebuildCloneAsJob({
      root: cloneDir, env, store, reattach, log: quietLog,
      adopt: async () => ({ moved: false, reason: 'needs-build', plan: { finalSha: candidateSha } }),
      evict: () => ({ evicted: [] }),
    });
    expect(result.reason).toBe('rebuild-job-started');
    const [record] = store.list().records;
    expect(record.job.codeSha).toBe(mainSha);
    expect(record.job.codeSha).not.toBe(loadedSha);
    expect(record.job.codeSha).not.toBe(candidateSha);
  });
});

describe('R787 — adoption is a fail-closed main-snapshot child', () => {
  async function readyFixture() {
    const f = makeFixture();
    const before = head(f.cloneDir);
    const target = advanceMain(f.originDir, (dir) => {
      writeFile(dir, 'reviewed.txt', 'main\n');
      // A tiny reviewed CLI fixture calls the real adopter in a separate process.
      // Loaded-process Vitest mocks cannot affect its decision or lock handling.
      const source = new URL('../daemon-rebuild.mjs', import.meta.url).href;
      writeFile(dir, 'scripts/lib/daemon-rebuild.mjs', `
        import { rebuildClone } from ${JSON.stringify(source)};
        if (!process.argv.includes('--adopt-only') || !process.argv.includes('--json')) process.exit(2);
        const root = process.argv.find(a => a.startsWith('--clone=')).slice(8);
        const r = await rebuildClone({root, asJob: false, adoptOnly: true,
          skipCheck: null, log: {error() {}}, prState: async () => null});
        console.log(JSON.stringify(r));
      `);
    });
    const built = await rebuildClone({
      root: f.cloneDir, env: f.env, readyOnly: true, asJob: false,
      runSmoke: async () => PASS, prState: async () => null, lockOpts: LOCK_OPTS, log: quietLog,
    });
    expect(built.reason).toBe('ready-recorded');
    // Exercise the actual production adopt closure without launching a detached build.
    vi.spyOn(rebuildJobs, 'rebuildCloneAsJob').mockImplementation(({ adopt }) => adopt());
    return { ...f, before, target, ready: readReadyCandidate(f.cloneDir, f.env) };
  }
  const options = (f, run) => ({
    root: f.cloneDir, env: f.env, asJob: true, log: quietLog,
    prState: async () => null, lockOpts: LOCK_OPTS, skipCheck: null,
    adoptChild: { run },
  });

  it('moves when the loaded in-process adopter refuses but the main child accepts', async () => {
    const f = await readyFixture();
    const refusal = vi.spyOn(prepare, 'prepareRebuild').mockResolvedValue({
      terminal: true, result: { moved: false, reason: 'loaded-code-refused' }, alerts: [],
    });
    await expect(rebuildClone({ ...options(f), asJob: false, adoptOnly: true }))
      .resolves.toMatchObject({ moved: false, reason: 'loaded-code-refused' });
    expect(head(f.cloneDir)).toBe(f.before);
    refusal.mockClear();
    const run = vi.fn(async (executable, argv, childOptions) => spawnSync(executable, argv, {
      ...childOptions, encoding: 'utf8', timeout: 5000,
    }));
    const result = await rebuildClone(options(f, run));
    expect(result).toMatchObject({ moved: true, adopted: true, reason: 'ready-adopted' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(refusal).not.toHaveBeenCalled();
    expect(head(f.cloneDir)).toBe(f.target);
  });

  it.each([
    ['timeout', { status: null, stdout: '', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }],
    ['garbage output', { status: 0, stdout: 'not JSON' }],
    ['nonzero exit with success-looking JSON', { status: 1, stdout: '{"moved":true,"adopted":true}' }],
    ['missing snapshot', null],
  ])('%s refuses adoption, preserves ready evidence and retries next tick', async (name, output) => {
    const f = await readyFixture();
    const run = vi.fn(async () => output);
    if (name === 'missing snapshot') {
      vi.spyOn(snapshots, 'ensureCodeSnapshot').mockImplementation(() => { throw new Error('snapshot unavailable'); });
    }
    const result = await rebuildClone(options(f, run));
    expect.soft(result).toMatchObject({ moved: false, reason: 'adopt-child-failed' });
    expect.soft(head(f.cloneDir)).toBe(f.before);
    expect.soft(readReadyCandidate(f.cloneDir, f.env)).toEqual(f.ready);
    // Still failed next tick: do not consume the ready record or silently fall
    // back to the loaded adopter after the first child failure.
    const retry = await rebuildClone(options(f, run));
    expect.soft(retry).toMatchObject({ moved: false, reason: 'adopt-child-failed' });
    expect.soft(head(f.cloneDir)).toBe(f.before);
    expect.soft(readReadyCandidate(f.cloneDir, f.env)).toEqual(f.ready);
    if (name === 'missing snapshot') expect(run).not.toHaveBeenCalled();
    else expect(run).toHaveBeenCalledTimes(2);
  });

  it('runs only the origin/main snapshot CLI, with bounded IO, its cwd, and no inherited NODE_PATH', async () => {
    const f = await readyFixture();
    // Candidate/loaded HEAD has code that must never become the adopter.
    writeFile(f.cloneDir, 'candidate-code.txt', 'unreviewed\n');
    gitOk(f.cloneDir, ['add', '-A']);
    gitOk(f.cloneDir, ['commit', '-q', '-m', 'candidate code']);
    const candidateSha = head(f.cloneDir);
    writeReadyCandidate(f.cloneDir, { ...f.ready, adopt: { ...f.ready.adopt, finalSha: candidateSha } }, f.env);
    f.env.NODE_PATH = join(f.cloneDir, 'daemon-node-modules');
    const run = vi.fn(async () => ({ status: 0, stdout: '{"moved":false,"reason":"needs-build"}' }));
    await rebuildClone(options(f, run));
    expect(run).toHaveBeenCalledTimes(1);
    const [executable, argv, child] = run.mock.calls[0];
    const mainSnapshot = join(rebuildJobs.rebuildJobsDir(f.cloneDir, f.env), '.snapshots', 'code', f.target);
    expect(executable).toBe(process.execPath);
    expect(argv).toEqual(expect.arrayContaining([
      join(mainSnapshot, 'scripts/lib/daemon-rebuild.mjs'), '--adopt-only', '--json', `--clone=${f.cloneDir}`,
    ]));
    expect(argv).not.toContain('--ready-only');
    expect(argv.join(' ')).not.toContain(candidateSha);
    expect(child.cwd).toBe(mainSnapshot);
    expect(child.env).not.toHaveProperty('NODE_PATH');
    expect(child.timeout).toBe(120_000);
    expect(child.maxBuffer).toBeGreaterThan(0);
    expect(child.maxBuffer).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(readFileSync(join(mainSnapshot, 'reviewed.txt'), 'utf8')).toBe('main\n');
    expect(existsSync(join(mainSnapshot, 'candidate-code.txt'))).toBe(false);
  });
});
