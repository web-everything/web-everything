import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { acquireLockDir, lockDirFor, makeLockEntry, readLockEntry, releaseLockDir } from '../../../readiness/file-locks.mjs';
import {
  PROBATION_MS_DEFAULT, PROBATION_MAX_BOOTS, probationMsOf,
  readProvenGood, writeProvenGood, readProbation, openProbation,
  evaluateProbation, withProbationLock, bootProbation, checkProbationAtTick,
  requestRollback, applyPendingRollback,
} from '../probation.mjs';
import { acquireRead, acquireWrite, releaseRead, inspectCloneLock, withWriteLock } from '../../daemon-clone-lock.mjs';
import { prepareRebuild } from '../prepare.mjs';
import { planRebuild } from '../plan.mjs';
import { finalizeRebuild } from '../adopt.mjs';
import { makeTickProgressStore } from '../../daemon-background-build.mjs';
import { withSelfSync } from '../../daemon-self-sync.mjs';
import siblingStartupBreak from '../../../conveyor/soak/breaks/probation-sibling-startups.mjs';

// No remote, fetch, push, hooks, or user Git configuration. commit-tree creates
// local fixture objects; the real rollback must move HEAD and the tracked bytes.
function realRepo(f) {
  const run = vi.fn((args, opts = {}) => {
    if (['fetch', 'push', 'pull', 'clone'].includes(args[0])) throw new Error('Network Git forbidden');
    return spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: opts.cwd || f.root, env: {
        ...f.env, GIT_AUTHOR_NAME: 'Probation test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Probation test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
        GIT_AUTHOR_DATE: iso(ADOPTED_AT), GIT_COMMITTER_DATE: iso(ADOPTED_AT),
      }, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
    });
  });
  const git = args => {
    const r = run(args);
    if (r.status !== 0) throw new Error(`Fixture git ${args[0]} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(['init', '-q', '-b', 'main']);
  writeFileSync(join(f.root, 'build.txt'), 'proven build\n');
  git(['add', 'build.txt']);
  const good = git(['commit-tree', git(['write-tree']), '-m', 'proven fixture']);
  git(['reset', '--hard', good]);
  writeFileSync(join(f.root, 'build.txt'), 'failed build\n');
  git(['add', 'build.txt']);
  const failed = git(['commit-tree', git(['write-tree']), '-p', good, '-m', 'failed fixture']);
  git(['reset', '--hard', failed]);
  f.good.head = good;
  f.good.mainSha = good;
  Object.assign(f.probation, { sha: failed, prevHead: good, mainSha: good, applied: [] });
  f.opts.bootSha = failed;
  f.seed();
  return { run, git, good, failed };
}


describe('real repository rollback and CLI contracts', () => {

  it('failure requests rollback without touching HEAD or taking a clone lock; boot apply resets under the normal lock', async () => {
    const f = fixture();
    const repo = realRepo(f);
    writeReadyCandidate(f.root, { prevHead: repo.failed, adopt: { finalSha: repo.failed } }, f.env);
    const result = checkProbationAtTick({ ...f.opts, run: repo.run });
    expect(result).toMatchObject({ action: 'fail', reason: 'no-tick-progress' });
    expect(repo.git(['rev-parse', 'HEAD'])).toBe(repo.failed);
    expect(readFileSync(join(f.root, 'build.txt'), 'utf8')).toBe('failed build\n');
    expect(withWriteLock).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(f.markerFile, 'utf8'))).toEqual({
      adoptionId: f.probation.adoptionId, from: repo.failed, to: repo.good, inputsKey: f.good.inputsKey, mainSha: f.good.mainSha, applied: f.good.applied,
      rejectInputsKey: 'failed-inputs', reason: 'no-tick-progress', at: iso(f.opts.now()),
    });
    expect(existsSync(f.probationFile)).toBe(true);
    expect(f.opts.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'probation-rollback-requested' }), { env: expect.anything() });
    repo.run.mockClear();
    const resetLocks = [];
    expect(await applyPendingRollback({ ...f.opts, run: (args, opts) => {
      if (args[0] === 'reset') resetLocks.push(inspectCloneLock(f.root, { lockRoot: f.env.WE_DAEMON_CLONE_LOCK_ROOT, nowMs: f.opts.now() }));
      return repo.run(args, opts);
    } })).toMatchObject({ ok: true });
    expect(resetLocks).toHaveLength(1);
    expect(resetLocks[0].writerLive).toBe(true);
    expect(withWriteLock).toHaveBeenCalledTimes(1);
    expect(withWriteLock.mock.calls[0][2]).toEqual({ now: f.opts.now, waitMs: 60000, lockRoot: f.env.WE_DAEMON_CLONE_LOCK_ROOT,
      owner: expect.stringContaining('-probation-rollback-'), leaseMinutes: Infinity, probe: expect.any(Function) });
    expect(withWriteLock.mock.calls[0][2].probe({ owner: 'unknown:1' })).toBe('alive');
    expect(repo.run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(true);
    expect(existsSync(f.markerFile)).toBe(false);
    expect(repo.git(['rev-parse', 'HEAD'])).toBe(repo.good);
    expect(readFileSync(join(f.root, 'build.txt'), 'utf8')).toBe('proven build\n');
    expect(readRebuildState(f.root, f.env)).toMatchObject({
      adopted: { head: repo.good, inputsKey: f.good.inputsKey },
      rejected: { inputsKey: f.probation.inputsKey, reason: 'no-tick-progress', probation: true },
    });
    expect(readReadyCandidate(f.root, f.env)).toBeNull();
    expect(existsSync(f.probationFile)).toBe(false);
    expect(f.opts.emit.mock.calls.some(([event]) => event.kind === 'probation-rolled-back')).toBe(true);
  });


  it.each(['missing', 'invalid'])('rollback marker with %s failed SHA refuses recovery and alerts once', async kind => {
    const f = fixture(); const repo = realRepo(f);
    await requestRollback({ ...f.opts, run: repo.run });
    const marker = JSON.parse(readFileSync(f.markerFile, 'utf8'));
    if (kind === 'missing') delete marker.from;
    else marker.from = 'not-a-sha';
    json(f.markerFile, marker);
    const before = readRebuildState(f.root, f.env);
    withWriteLock.mockClear();
    expect(await applyPendingRollback({ ...f.opts, run: repo.run }))
      .toEqual({ ok: false, reason: 'rollback-request-unreadable' });
    expect(await applyPendingRollback({ ...f.opts, run: repo.run }))
      .toEqual({ ok: false, reason: 'rollback-request-unreadable' });
    expect(repo.git(['rev-parse', 'HEAD'])).toBe(repo.failed);
    expect(readRebuildState(f.root, f.env)).toEqual(before);
    expect(JSON.parse(readFileSync(f.markerFile, 'utf8'))).toEqual(marker);
    expect(withWriteLock).not.toHaveBeenCalled();
    expect(readFileSync(alertsFilePath(f.root, f.env), 'utf8').trim().split('\n')).toHaveLength(1);
  });


  it.each(['corrupt', 'incomplete', 'directory'])('unreadable %s rollback marker stays and alerts once', async kind => {
    const f = fixture(); f.seed();
    if (kind === 'directory') mkdirSync(f.markerFile);
    else writeFileSync(f.markerFile, kind === 'corrupt' ? '{broken' : '{}');
    expect(await applyPendingRollback(f.opts)).toMatchObject({ ok: false });
    expect(await applyPendingRollback(f.opts)).toMatchObject({ ok: false });
    expect(existsSync(f.markerFile)).toBe(true);
    expect(readFileSync(alertsFilePath(f.root, f.env), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(withWriteLock).not.toHaveBeenCalled();
  });


  it('a live reader makes normal boot lock acquisition time out without reclaiming its slot', async () => {
    const f = fixture(); const repo = realRepo(f);
    await requestRollback({ ...f.opts, run: repo.run });
    const lockOpts = { owner: 'busy-reader:1', lockRoot: f.env.WE_DAEMON_CLONE_LOCK_ROOT, nowMs: f.opts.now() };
    expect(acquireRead(f.root, lockOpts).ok).toBe(true);
    try {
      expect(await applyPendingRollback({ ...f.opts, run: repo.run, lockWaitMs: 0 }))
        .toEqual({ ok: false, reason: 'rollback-lock-timeout' });
      expect(repo.git(['rev-parse', 'HEAD'])).toBe(repo.failed);
      expect(existsSync(f.markerFile)).toBe(true);
      expect(inspectCloneLock(f.root, { lockRoot: lockOpts.lockRoot }).readers).toHaveLength(1);
      expect(JSON.parse(readFileSync(alertsFilePath(f.root, f.env), 'utf8').trim()))
        .toMatchObject({ kind: 'probation-needs-you', detail: { reason: 'rollback-lock-timeout' } });
    } finally { releaseRead(f.root, lockOpts); }
  });


  it.each(['listed', 'unresolved', 'malformed'])('boot rollback refuses a newly unverified %s target inside the lock', async kind => {
    const f = fixture(); const repo = realRepo(f);
    await requestRollback({ ...f.opts, run: repo.run });
    const marker = readFileSync(f.markerFile, 'utf8');
    const actual = await vi.importActual('../../daemon-clone-lock.mjs');
    withWriteLock.mockImplementationOnce((root, fn, opts) => actual.withWriteLock(root, async () => {
      writeRebuildState(f.root, { ...readRebuildState(f.root, f.env),
        forceUnverifiedTrees: kind === 'malformed' ? {} : [repo.git(['rev-parse', `${repo.good}^{tree}`])],
      }, f.env);
      return fn();
    }, opts));
    const run = (args, opts) => kind === 'unresolved' && args.includes(`${repo.good}^{tree}`)
      ? { status: 1 } : repo.run(args, opts);
    repo.run.mockClear();
    expect(await applyPendingRollback({ ...f.opts, run }))
      .toEqual({ ok: false, reason: 'proven-good-unverified' });
    expect(repo.run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
    expect(repo.git(['rev-parse', 'HEAD'])).toBe(repo.failed);
    expect(readFileSync(join(f.root, 'build.txt'), 'utf8')).toBe('failed build\n');
    expect(readFileSync(f.markerFile, 'utf8')).toBe(marker);
    expect(readRebuildState(f.root, f.env).rejected).toBeNull();
    expect(JSON.parse(readFileSync(alertsFilePath(f.root, f.env), 'utf8').trim()))
      .toMatchObject({ kind: 'probation-needs-you', detail: { reason: 'proven-good-unverified' } });
    expect(f.opts.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'probation-needs-you',
      detail: { reason: 'proven-good-unverified' } }), { env: expect.anything() });
  });


  it.each([true, undefined])('boot recovery preserves only probation rejection (probation=%s)', async probation => {
    const f = fixture(); const repo = realRepo(f);
    repo.git(['reset', '--hard', repo.good]);
    const rejected = { inputsKey: 'failed-inputs', reason: 'no-tick-progress', at: iso(f.opts.now()),
      ...(probation ? { probation } : {}) };
    writeRebuildState(f.root, { ...readRebuildState(f.root, f.env), rejected,
      inProgress: { target: repo.good, prevHead: repo.failed, verified: true,
        inputsKey: 'good-inputs', mainSha: repo.good, applied: [], startedAt: iso(ADOPTED_AT - 3_600_000) },
    }, f.env);
    expect(await prepareRebuild({ ...f.opts, run: repo.run }))
      .toMatchObject({ terminal: true, result: { reason: 'recovered-adopted', head: repo.good } });
    expect(readRebuildState(f.root, f.env).rejected).toEqual(probation ? rejected : null);
    expect(readRebuildState(f.root, f.env).inProgress).toBeNull();
  });


  it('crash after rollback reset persists rejection before reset and boot recovery keeps failed inputs rejected', async () => {
    const f = fixture(); const repo = realRepo(f);
    repo.git(['update-ref', 'refs/remotes/origin/main', repo.failed]);
    const plan = await planRebuild({ git: args => repo.run(args), headSha: repo.good, mainRef: 'origin/main' });
    expect(plan.ok).toBe(true);
    writeRebuildState(f.root, { ...readRebuildState(f.root, f.env), adopted: {
      head: repo.failed, inputsKey: plan.inputsKey, mainSha: repo.failed, applied: [],
    } }, f.env);
    json(f.probationFile, { ...f.probation, inputsKey: plan.inputsKey });
    await requestRollback({ ...f.opts, run: repo.run, reason: 'no-tick-progress' });
    // Exit the child immediately after the real reset, before finalize can save or clear the marker.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { applyPendingRollback } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../probation.mjs')).href)};
      import { gitRun } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../../main-staleness.mjs')).href)};
      await applyPendingRollback({ root: process.env.TEST_ROOT, env: process.env,
        now: () => ${ADOPTED_AT + WINDOW + 1}, log: {},
        run: (args, opts) => {
          const result = gitRun(args, opts);
          if (args[0] === 'reset' && result.status === 0) process.exit(73);
          return result;
        } });
    `], { env: { ...f.env, TEST_ROOT: f.root }, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
    expect(child.status, child.stderr).toBe(73);
    expect(repo.git(['rev-parse', 'HEAD'])).toBe(repo.good);
    expect(existsSync(f.markerFile)).toBe(true);
    const rejection = { inputsKey: plan.inputsKey, reason: 'no-tick-progress', at: iso(f.opts.now()), probation: true };
    expect(readRebuildState(f.root, f.env)).toMatchObject({
      rejected: rejection, inProgress: { target: repo.good, prevHead: repo.failed, verified: true },
    });
    const prepare = () => prepareRebuild({ ...f.opts, env: { ...f.env, WE_DAEMON_REBUILD_SKIP_UNRELATED: '0' },
      // All objects are local; emulate a successful fetch without any remote IO.
      run: (args, opts) => args[0] === 'fetch' ? { status: 0, stdout: '' } : repo.run(args, opts),
      prState: async () => null });
    expect(await prepare()).toMatchObject({ terminal: true, result: { reason: 'recovered-adopted', head: repo.good } });
    expect(readRebuildState(f.root, f.env)).toMatchObject({ rejected: rejection, inProgress: null });
    expect(await prepare()).toMatchObject({ terminal: true, result: { reason: 'still-rejected', plan: { inputsKey: plan.inputsKey } } });
    expect(repo.git(['rev-parse', 'HEAD'])).toBe(repo.good);
    expect(readRebuildState(f.root, f.env).rejected).toEqual(rejection);
  });


  it('no pending rollback does nothing', async () => {
    const f = fixture();
    expect(await applyPendingRollback(f.opts)).toEqual({ action: 'none' });
    expect(withWriteLock).not.toHaveBeenCalled();
  });


  it('failed finalization keeps the rollback marker for next boot', async () => {
    const f = fixture(); const repo = realRepo(f);
    await requestRollback({ ...f.opts, run: repo.run });
    const run = (args, opts) => args[0] === 'reset' ? { status: 1, stderr: 'reset refused' } : repo.run(args, opts);
    expect(await applyPendingRollback({ ...f.opts, run })).toMatchObject({ ok: false });
    expect(existsSync(f.markerFile)).toBe(true);
    expect(repo.git(['rev-parse', 'HEAD'])).toBe(repo.failed);
  });


  it('rejected inputsKey is not re-adopted: rollback persists the failed key without retryAt', async () => {
    const f = fixture(); const repo = realRepo(f);
    expect(await requestRollback({ ...f.opts, run: repo.run, expectSha: repo.failed })).toMatchObject({ ok: true });
    expect(await applyPendingRollback({ ...f.opts, run: repo.run })).toMatchObject({ ok: true });
    const rejected = readRebuildState(f.root, f.env).rejected;
    expect(rejected).toMatchObject({ inputsKey: 'failed-inputs', probation: true, reason: 'probation-failed' });
    expect(rejected).not.toHaveProperty('retryAt');
    expect(Number.isFinite(Date.parse(rejected.at))).toBe(true);
    expect(await checkProbationAtTick(f.opts)).toMatchObject({ action: 'none' });
    expect(readRebuildState(f.root, f.env).rejected).toEqual(rejected);
  });


  it('CLI provenGood only requests rollback and leaves HEAD and adopted state untouched', () => {
    const f = fixture(); const repo = realRepo(f);
    const before = readRebuildState(f.root, f.env);
    const cli = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), '../probation.mjs'),
      'rollback', `--clone=${f.root}`, '--to=provenGood'], {
      cwd: f.base, env: f.env, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
    });
    expect(cli.error).toBeUndefined();
    expect(cli.status).toBe(0);
    expect(JSON.parse(cli.stdout)).toEqual({ ok: true, requested: true });
    expect(repo.git(['rev-parse', 'HEAD'])).toBe(repo.failed);
    expect(readRebuildState(f.root, f.env)).toEqual(before);
    expect(JSON.parse(readFileSync(f.markerFile, 'utf8'))).toMatchObject({ to: repo.good, rejectInputsKey: 'failed-inputs' });
    expect(existsSync(f.probationFile)).toBe(true);
  });


  it('CLI refuses unknown --to without changing HEAD or adopted state', () => {
    const f = fixture(); const repo = realRepo(f);
    const before = readRebuildState(f.root, f.env);
    // Resolve on disk: Vite rewrites new URL(..., import.meta.url) as an asset URL.
    const cli = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), '../probation.mjs'),
      'rollback', `--clone=${f.root}`, '--to=unknown'], {
      cwd: f.base, env: f.env, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
    });
    expect(cli.error).toBeUndefined();
    expect(cli.status).toBe(1);
    expect(`${cli.stdout}\n${cli.stderr}`).toMatch(/unknown|invalid|unsupported|provenGood/i);
    expect(repo.git(['rev-parse', 'HEAD'])).toBe(repo.failed);
    expect(readRebuildState(f.root, f.env)).toEqual(before);
  });

});

vi.mock('../../daemon-clone-lock.mjs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, inspectCloneLock: vi.fn(actual.inspectCloneLock), withWriteLock: vi.fn(actual.withWriteLock) };
});

vi.mock('../state.mjs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, writeRebuildState: vi.fn(actual.writeRebuildState) };
});

vi.mock('../adopt.mjs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, finalizeRebuild: vi.fn(actual.finalizeRebuild) };
});

import { cloneKeyOf } from '../../daemon-last-good.mjs';
import {
  alertsFilePath, rebuildStatePath, readRebuildState, writeRebuildState,
  readReadyCandidate, writeReadyCandidate,
} from '../state.mjs';

const ADOPTED_AT = Date.parse('2026-11-15T12:00:00.000Z');
const WINDOW = 1000;
const GOOD = 'a'.repeat(40);
const FAILED = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const iso = ms => new Date(ms).toISOString();
const dirs = [];

it('late openProbation for B after C finalize is a no-op', () => {
  const f = fixture();
  f.seed();
  const before = readFileSync(f.probationFile, 'utf8');
  expect(openProbation({ ...f.opts, ...f.probation, run: () => ({ status: 0, stdout: OTHER }) })).toBe(false);
  expect(readFileSync(f.probationFile, 'utf8')).toBe(before);
});

beforeEach(() => { withWriteLock.mockClear(); });
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function json(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'we-probation-'));
  dirs.push(base);
  const root = join(base, 'clone');
  mkdirSync(root);
  const env = {
    PATH: process.env.PATH,
    HOME: join(base, 'home'),
    TMPDIR: base,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(base, 'no-gitconfig'),
    WE_DAEMON_STATE_DIR: join(base, 'state'),
    WE_DAEMON_CLONE_LOCK_ROOT: join(base, 'locks'),
    WE_DAEMON_OVERLAY_DIR: join(base, 'overlays'),
    WE_DAEMON_EVENTS: join(base, 'events.jsonl'),
    WE_DAEMON_PROBATION_MS: String(WINDOW),
  };
  mkdirSync(env.HOME);
  vi.stubEnv('WE_DAEMON_STATE_DIR', env.WE_DAEMON_STATE_DIR);
  vi.stubEnv('WE_DAEMON_CLONE_LOCK_ROOT', env.WE_DAEMON_CLONE_LOCK_ROOT);
  const key = cloneKeyOf(root);
  const probationFile = join(env.WE_DAEMON_STATE_DIR, `${key}.probation.json`);
  const provenFile = join(env.WE_DAEMON_STATE_DIR, `${key}.proven-good.json`);
  const tickFile = join(env.WE_DAEMON_STATE_DIR, `${key}.ticks.worker.json`);
  const good = { head: GOOD, inputsKey: 'good-inputs', mainSha: GOOD, applied: [], provenAt: iso(ADOPTED_AT - 10_000) };
  const probation = {
    adoptionId: '11111111-1111-4111-8111-111111111111', sha: FAILED, inputsKey: 'failed-inputs', mainSha: GOOD,
    applied: [{ ref: 'overlay/example', sha: FAILED }], prevHead: GOOD,
    adoptedAt: iso(ADOPTED_AT), bootedAt: iso(ADOPTED_AT), bootPid: process.pid, probationMs: WINDOW,
    baseline: { [basename(tickFile)]: iso(ADOPTED_AT - 100) }, boots: 0, version: 1,
  };
  const run = vi.fn(() => ({ status: 0, stdout: FAILED }));
  const rollback = vi.fn(async () => ({ ok: true }));
  const emit = vi.fn();
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() };
  const opts = {
    root, env, stateOpts: { env }, log, run, rollback, emit,
    now: () => ADOPTED_AT + WINDOW + 1, bootSha: FAILED, bootAt: ADOPTED_AT,
  };
  return {
    base, root, env, good, probation, probationFile, provenFile, tickFile, opts,
    markerFile: join(env.WE_DAEMON_STATE_DIR, `${key}.rollback-requested.json`),
    seed() {
      json(provenFile, good);
      json(probationFile, probation);
      json(tickFile, { lastTickDoneAt: iso(ADOPTED_AT - 100) });
      writeRebuildState(root, { adopted: {
        head: probation.sha, inputsKey: probation.inputsKey,
        mainSha: probation.mainSha, applied: probation.applied,
      } }, env);
    },
  };
}

describe('boot rollback send-back regressions (injected Git)', () => {
  function pending(f) {
    f.seed();
    json(f.markerFile, { adoptionId: f.probation.adoptionId, from: FAILED, to: GOOD, ...f.good,
      rejectInputsKey: 'failed-inputs', reason: 'no-tick-progress', at: iso(ADOPTED_AT) });
  }

  function wrapper(f, run, readHead) {
    const tick = vi.fn(() => 'failed-build-ticked');
    const onRestart = vi.fn(() => 'restarted');
    const acquire = vi.fn(() => ({ ok: true }));
    const rebuild = vi.fn(async () => ({ moved: false, reason: 'still-rejected' }));
    const wrapped = withSelfSync({ tickOnce: tick }, {
      root: f.root, env: f.env, log: f.opts.log, now: f.opts.now, onRestart,
      readHead, readState: () => ({ adopted: null }), versions: null, background: false,
      acquireRead: acquire, releaseRead() {}, rebuild,
      importClosure: () => ({ files: new Set(['scripts/worker.mjs']), complete: true, bareDeps: false, jsonNames: new Set() }),
      diffFiles: () => ['scripts/worker.mjs'],
      applyPendingRollback: opts => applyPendingRollback({ ...f.opts, ...opts, run }),
    });
    return { wrapped, tick, onRestart, acquire, rebuild };
  }

  it.each(['rollback-lock-timeout', 'proven-good-unverified'])(
    'rollback deferred with HEAD at failed SHA never restarts, including a second tick: %s', async reason => {
      const f = fixture(); pending(f);
      const marker = readFileSync(f.markerFile, 'utf8');
      if (reason === 'rollback-lock-timeout') withWriteLock.mockResolvedValueOnce({ ok: false, heldBy: 'busy' });
      else json(f.provenFile, { ...f.good, head: OTHER });
      const readHead = vi.fn(() => FAILED);
      const c = wrapper(f, () => ({ status: 0, stdout: FAILED }), readHead);

      const ticks = [await c.wrapped.tickOnce(), await c.wrapped.tickOnce()];
      expect(c.onRestart).not.toHaveBeenCalled();
      expect(ticks).toEqual([
        expect.objectContaining({ skipped: true, reason }),
        expect.objectContaining({ skipped: true, reason }),
      ]);
      expect(readHead()).toBe(FAILED);
      expect(readFileSync(f.markerFile, 'utf8')).toBe(marker);
      expect(c.tick).not.toHaveBeenCalled();
      expect(c.acquire).not.toHaveBeenCalled();
      expect(c.rebuild).not.toHaveBeenCalled();
    },
  );

  it('concurrent boot callers both restart after the first removes the rollback marker', async () => {
    const f = fixture(); pending(f);
    // Both processes load failed code before a sibling restores disk.
    let head = FAILED;
    const run = vi.fn(() => ({ status: 0, stdout: head }));
    const callers = [wrapper(f, run, () => head), wrapper(f, run, () => head)];
    head = GOOD;
    const callbacks = [];
    withWriteLock.mockImplementationOnce((_root, fn) => new Promise(resolve => callbacks.push(async () => resolve({ ok: true, value: await fn() }))))
      .mockImplementationOnce((_root, fn) => new Promise(resolve => callbacks.push(async () => resolve({ ok: true, value: await fn() }))));
    const ticks = callers.map(c => c.wrapped.tickOnce());
    expect(callbacks).toHaveLength(2);
    await callbacks[0]();
    expect(existsSync(f.markerFile)).toBe(false);
    await callbacks[1]();
    expect(await Promise.all(ticks)).toEqual(['restarted', 'restarted']);
    for (const c of callers) {
      expect(c.onRestart).toHaveBeenCalledTimes(1);
      expect(c.tick).not.toHaveBeenCalled();
      expect(c.acquire).not.toHaveBeenCalled();
      expect(c.rebuild).not.toHaveBeenCalled();
    }
    expect(f.opts.emit.mock.calls.filter(([e]) => e.kind === 'probation-rolled-back')).toHaveLength(1);
  });

  it('a consumed marker cannot overwrite newer state or clear a newer ready candidate', async () => {
    const f = fixture(); pending(f);
    const state = { adopted: { ...f.good }, rejected: { inputsKey: 'new-rejection' } };
    const ready = { prevHead: GOOD, adopt: { finalSha: OTHER } };
    withWriteLock.mockImplementationOnce(async (_root, fn) => {
      unlinkSync(f.markerFile);
      writeRebuildState(f.root, state, f.env);
      writeReadyCandidate(f.root, ready, f.env);
      return { ok: true, value: await fn() };
    });
    const result = await applyPendingRollback({ ...f.opts, run: () => ({ status: 0, stdout: GOOD }) });
    expect(result).toMatchObject({ restartRequired: true, head: GOOD });
    expect(readRebuildState(f.root, f.env)).toMatchObject(state);
    expect(readReadyCandidate(f.root, f.env)).toEqual(ready);
    expect(f.opts.emit).not.toHaveBeenCalled();
  });

  it('a sibling completing before the boot hook still bypasses restart spacing', async () => {
    const f = fixture(); pending(f);
    let head = FAILED;
    const c = wrapper(f, () => ({ status: 0, stdout: head }), () => head);
    head = GOOD;
    unlinkSync(f.markerFile);
    expect(await c.wrapped.tickOnce()).toBe('restarted');
    expect(c.onRestart).toHaveBeenCalledWith(expect.objectContaining({ restartRequired: true, head: GOOD }));
    expect(c.tick).not.toHaveBeenCalled();
    expect(c.acquire).not.toHaveBeenCalled();
    expect(c.rebuild).not.toHaveBeenCalled();
  });

  it('recovery cleanup failure after reset still retires loaded failed code', async () => {
    const f = fixture(); pending(f);
    // Disk is already restored; state refuses the completion write.
    const state = rebuildStatePath(f.root, f.env);
    rmSync(state); mkdirSync(state);
    let head = FAILED;
    const c = wrapper(f, () => ({ status: 0, stdout: head }), () => head);
    head = GOOD;
    expect(await c.wrapped.tickOnce()).toBe('restarted');
    expect(c.tick).not.toHaveBeenCalled();
    expect(c.acquire).not.toHaveBeenCalled();
    expect(existsSync(f.markerFile)).toBe(true);
    const fresh = wrapper(f, () => ({ status: 0, stdout: head }), () => head);
    expect(await fresh.wrapped.tickOnce()).toMatchObject({ skipped: true, reason: 'proven-good-unverified' });
    expect(fresh.onRestart).not.toHaveBeenCalled();
    expect(fresh.tick).not.toHaveBeenCalled();
    expect(fresh.acquire).not.toHaveBeenCalled();
    expect(fresh.rebuild).not.toHaveBeenCalled();
  });

  it.each(['unverified', 'unreadable', 'completion-state', 'write-throw', 'cleanup-throw', 'lock-timeout', 'lock-throw', 'replaced', 'consumed', 'unresolved', 'head-throw'])
  ('two boots stop restarting after persistent rollback failure: %s', async kind => {
    const f = fixture(); pending(f);
    const original = readFileSync(f.markerFile, 'utf8');
    const run = vi.fn(() => {
      if (kind === 'head-throw') throw new Error('HEAD unavailable');
      return { status: 0, stdout: kind === 'unresolved' ? '' : GOOD };
    });
    const failure = () => {
      writeFileSync(f.markerFile, original);
      writeRebuildState(f.root, { adopted: { head: FAILED } }, f.env);
      if (kind === 'unverified') json(f.provenFile, { ...f.good, head: OTHER });
      if (kind === 'unreadable') writeFileSync(rebuildStatePath(f.root, f.env), '{');
      if (kind === 'lock-timeout') withWriteLock.mockResolvedValueOnce({ ok: false, heldBy: 'busy' });
      if (kind === 'lock-throw') withWriteLock.mockRejectedValueOnce(new Error('lock failed'));
      if (kind === 'replaced' || kind === 'consumed') withWriteLock.mockImplementationOnce(async (_root, fn) => {
        if (kind === 'consumed') unlinkSync(f.markerFile);
        else writeFileSync(f.markerFile, '{');
        return { ok: true, value: await fn() };
      });
      if (kind === 'completion-state') {
        writeRebuildState(f.root, { forceUnverifiedTrees: [OTHER] }, f.env);
        run.mockImplementation(args => {
          if (args.at(-1) === `${GOOD}^{tree}`) writeFileSync(rebuildStatePath(f.root, f.env), '{');
          return { status: 0, stdout: GOOD };
        });
      }
      if (kind === 'write-throw') writeRebuildState.mockImplementationOnce(() => { throw new Error('write failed'); });
      if (kind === 'cleanup-throw') writeRebuildState.mockImplementationOnce(() => {
        unlinkSync(f.markerFile); mkdirSync(f.markerFile);
      });
    };
    for (const bootHead of [FAILED, GOOD]) {
      if (existsSync(f.markerFile) && kind === 'cleanup-throw') rmSync(f.markerFile, { recursive: true });
      failure();
      const result = await applyPendingRollback({ ...f.opts, run, bootHead, lockWaitMs: 0 });
      expect(result.restartRequired === true).toBe(!['unresolved', 'head-throw'].includes(kind) && bootHead === FAILED);
      expect(result.ok).not.toBe(true);
    }
  });

  it('post-reset HEAD read failure retires failed code only once', async () => {
    const f = fixture(); pending(f);
    let head = FAILED, readable = true;
    const run = () => {
      if (!readable) throw new Error('HEAD unavailable after reset');
      return { status: 0, stdout: head };
    };
    finalizeRebuild.mockImplementationOnce(async () => {
      head = GOOD;
      readable = false;
      return { adopted: true };
    });
    expect(await applyPendingRollback({ ...f.opts, run, bootHead: FAILED }))
      .toMatchObject({ ok: false, restartRequired: true });
    expect(existsSync(f.markerFile)).toBe(true);
    const fresh = await applyPendingRollback({ ...f.opts, run, bootHead: GOOD });
    expect(fresh.ok).toBe(false);
    expect(fresh.restartRequired).not.toBe(true);
    expect(existsSync(f.markerFile)).toBe(true);
  });

  it('boot rollback reclaims a verifiably dead same-host reader without expiring live readers', async () => {
    const f = fixture(); pending(f);
    const deadPid = 2147483647;
    expect(() => process.kill(deadPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    const lockOpts = { owner: `${hostname()}:${deadPid}`, pid: deadPid,
      lockRoot: f.env.WE_DAEMON_CLONE_LOCK_ROOT, nowMs: ADOPTED_AT };
    expect(acquireRead(f.root, lockOpts).ok).toBe(true);
    expect(await applyPendingRollback({ ...f.opts, bootHead: GOOD, lockWaitMs: 0,
      run: () => ({ status: 0, stdout: GOOD }) })).toMatchObject({ ok: true });
    expect(inspectCloneLock(f.root, lockOpts).readers).toHaveLength(0);

    pending(f);
    const live = { ...lockOpts, owner: `${hostname()}:${process.pid}`, pid: process.pid,
      nowMs: ADOPTED_AT - 86_400_000 };
    expect(acquireRead(f.root, live).ok).toBe(true);
    try {
      expect(await applyPendingRollback({ ...f.opts, bootHead: FAILED, lockWaitMs: 0,
        run: () => ({ status: 0, stdout: FAILED }) })).toMatchObject({ reason: 'rollback-lock-timeout' });
      expect(inspectCloneLock(f.root, live).readers).toHaveLength(1);
    } finally { releaseRead(f.root, live); }
  });

  it.each(['replaced', 'corrupt'])('a %s marker under the lock is preserved and retires stale boot code', async kind => {
    const f = fixture(); pending(f);
    const replacement = kind === 'corrupt' ? '{' : JSON.stringify({ ...JSON.parse(readFileSync(f.markerFile)), from: GOOD, to: OTHER });
    withWriteLock.mockImplementationOnce(async (_root, fn) => {
      writeFileSync(f.markerFile, replacement);
      return { ok: true, value: await fn() };
    });
    const run = vi.fn(() => ({ status: 0, stdout: GOOD }));
    expect(await applyPendingRollback({ ...f.opts, run })).toMatchObject({ restartRequired: true });
    expect(readFileSync(f.markerFile, 'utf8')).toBe(replacement);
    expect(readRebuildState(f.root, f.env).rejected).toBeNull();
    expect(run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
  });

  it.each(['replaced', 'corrupt', 'consumed', 'unreadable'])
  ('a %s rollback marker during asynchronous finalization preserves recovery evidence and retires stale code', async kind => {
    const f = fixture(); pending(f);
    let head = FAILED;
    const run = vi.fn(() => ({ status: 0, stdout: head }));
    const c = wrapper(f, run, () => head);
    let enterFinalization, resumeFinalization;
    const entered = new Promise(resolve => { enterFinalization = resolve; });
    const resume = new Promise(resolve => { resumeFinalization = resolve; });
    finalizeRebuild.mockImplementationOnce(async () => {
      head = GOOD;
      enterFinalization();
      await resume;
      return { adopted: true };
    });
    const ticking = c.wrapped.tickOnce();
    try {
      await entered;
      // The lock-time marker check has passed and reset has completed. A request
      // writer can still replace recovery evidence while finalization awaits IO.
      expect(readRebuildState(f.root, f.env).rejected.inputsKey).toBe('failed-inputs');
      const replacement = kind === 'corrupt' ? '{' : JSON.stringify({
        ...JSON.parse(readFileSync(f.markerFile, 'utf8')), from: GOOD, to: OTHER,
        rejectInputsKey: 'replacement-inputs',
      });
      if (kind === 'consumed' || kind === 'unreadable') {
        unlinkSync(f.markerFile);
        if (kind === 'unreadable') {
          mkdirSync(f.markerFile);
          writeFileSync(join(f.markerFile, 'evidence'), replacement);
        }
      } else writeFileSync(f.markerFile, replacement);
      const state = { adopted: { ...f.good }, rejected: { inputsKey: 'new-rejection' } };
      const ready = { prevHead: GOOD, adopt: { finalSha: OTHER } };
      writeRebuildState(f.root, state, f.env);
      writeReadyCandidate(f.root, ready, f.env);
      const stateBytes = readFileSync(rebuildStatePath(f.root, f.env), 'utf8');
      const writesBeforeCompletion = writeRebuildState.mock.calls.length;

      resumeFinalization();
      expect(await ticking).toBe('restarted');
      expect(c.onRestart).toHaveBeenCalledWith(expect.objectContaining({
        reason: 'probation-rollback', head: GOOD, restartRequired: true,
      }));
      expect(c.tick).not.toHaveBeenCalled();
      expect(c.acquire).not.toHaveBeenCalled();
      expect(c.rebuild).not.toHaveBeenCalled();
      expect(writeRebuildState).toHaveBeenCalledTimes(writesBeforeCompletion);
      expect(readFileSync(rebuildStatePath(f.root, f.env), 'utf8')).toBe(stateBytes);
      expect(readReadyCandidate(f.root, f.env)).toEqual(ready);
      if (kind === 'consumed') expect(existsSync(f.markerFile)).toBe(false);
      else expect(readFileSync(kind === 'unreadable' ? join(f.markerFile, 'evidence') : f.markerFile, 'utf8'))
        .toBe(replacement);
      expect(f.opts.emit).not.toHaveBeenCalled();
    } finally {
      resumeFinalization();
      await ticking;
    }
  });

  it('boot rollback preserves expired reader leases of unknown liveness', async () => {
    const f = fixture(); pending(f);
    const lockOpts = { owner: 'unknown-host:123', lockRoot: f.env.WE_DAEMON_CLONE_LOCK_ROOT, nowMs: ADOPTED_AT - 86_400_000 };
    expect(acquireRead(f.root, lockOpts).ok).toBe(true);
    const before = inspectCloneLock(f.root, { ...lockOpts, nowMs: f.opts.now() }).readers;
    expect(before).toHaveLength(1);
    expect(before[0].live).toBe(false);
    try {
      expect(await applyPendingRollback({ ...f.opts, lockWaitMs: 0, run: () => ({ status: 0, stdout: FAILED }) }))
        .toEqual({ ok: false, reason: 'rollback-lock-timeout' });
      expect(inspectCloneLock(f.root, { ...lockOpts, nowMs: f.opts.now() }).readers).toEqual(before);
      expect(existsSync(f.markerFile)).toBe(true);
    } finally { releaseRead(f.root, lockOpts); }
  });

  it('boot recovery reclaims a dead rollback writer using the emitted owner shape', async () => {
    const f = fixture(); pending(f);
    const deadPid = 2147483647;
    const opts = { owner: `${hostname()}:${deadPid}-probation-rollback-fixture`, pid: deadPid,
      lockRoot: f.env.WE_DAEMON_CLONE_LOCK_ROOT, now: f.opts.now, waitMs: 0, leaseMinutes: Infinity };
    expect((await acquireWrite(f.root, opts)).ok).toBe(true);
    expect(await applyPendingRollback({ ...f.opts, bootHead: GOOD, lockWaitMs: 0,
      run: () => ({ status: 0, stdout: GOOD }) })).toMatchObject({ ok: true });
    expect(inspectCloneLock(f.root, opts).writer).toBeNull();
  });

  it.each(['corrupt', 'directory', 'missing', 'array', 'null'])('unreadable rebuild state refuses promotion and rollback: %s', async kind => {
    const f = fixture(); pending(f);
    const file = rebuildStatePath(f.root, f.env);
    rmSync(file);
    if (kind === 'directory') mkdirSync(file);
    else if (kind !== 'missing') writeFileSync(file, kind === 'corrupt' ? '{' : kind === 'array' ? '[]' : 'null');
    const run = () => ({ status: 0, stdout: FAILED });
    expect(await requestRollback({ ...f.opts, run })).toMatchObject({ ok: false });
    expect(await applyPendingRollback({ ...f.opts, run })).toMatchObject({ ok: false });
    expect(existsSync(f.markerFile)).toBe(true);
    rmSync(f.provenFile);
    json(f.tickFile, { pid: process.pid, head: FAILED, lastTickDoneAt: iso(ADOPTED_AT + 1) });
    await checkProbationAtTick({ ...f.opts, run, now: () => ADOPTED_AT + 2 });
    expect(readProvenGood(f.root, f.env)).toBeNull();
  });

  it('openProbation never seeds provenGood from an adoption still on probation', () => {
    const f = fixture(); f.seed(); rmSync(f.provenFile);
    const preAdopted = { head: FAILED, inputsKey: 'failed-inputs', mainSha: GOOD, applied: [] };
    expect(openProbation({ ...f.opts, ...f.probation, sha: OTHER, prevHead: FAILED, preAdopted, run: () => ({ status: 0, stdout: OTHER }) })).toBe(true);
    expect(readProvenGood(f.root, f.env)).toBeNull();
  });

  it('legacy seeded provenGood cannot authorize rollback without passed probation', async () => {
    const f = fixture(); f.seed();
    json(f.provenFile, { ...f.good, seeded: true });
    expect(readProvenGood(f.root, f.env)).toBeNull();
    expect(writeProvenGood(f.root, f.env, { ...f.good, seeded: true })).toBe(false);
    expect(await requestRollback({ ...f.opts, run: () => ({ status: 0, stdout: FAILED }) }))
      .toEqual({ ok: false, reason: 'no-proven-good' });
    expect(existsSync(f.markerFile)).toBe(false);
    json(f.markerFile, { adoptionId: f.probation.adoptionId, from: FAILED, to: GOOD, ...f.good,
      rejectInputsKey: 'failed-inputs', reason: 'no-tick-progress', at: iso(ADOPTED_AT) });
    expect(await applyPendingRollback({ ...f.opts, run: () => ({ status: 0, stdout: FAILED }) }))
      .toEqual({ ok: false, reason: 'proven-good-unverified' });
    expect(existsSync(f.markerFile)).toBe(true);
  });

  it('a contending boot caller restarts when the lock holder has already restored disk', async () => {
    const f = fixture(); pending(f);
    withWriteLock.mockResolvedValueOnce({ ok: false, reason: 'concurrent-mover' });
    let head = FAILED;
    const c = wrapper(f, () => ({ status: 0, stdout: head }), () => head);
    head = GOOD;
    expect(await c.wrapped.tickOnce()).toBe('restarted');
    expect(c.tick).not.toHaveBeenCalled();
    expect(c.acquire).not.toHaveBeenCalled();
    expect(c.rebuild).not.toHaveBeenCalled();
  });
});


describe('S2a adoption identity and synchronous liveness', () => {
  const OTHER_ID = '22222222-2222-4222-8222-222222222222';
  const tick = f => json(f.tickFile, { pid: process.pid, head: FAILED, lastTickDoneAt: iso(ADOPTED_AT + 1) });
  const snapshot = f => [f.probationFile, f.provenFile, f.markerFile, rebuildStatePath(f.root, f.env)]
    .map(file => existsSync(file) ? readFileSync(file, 'utf8') : null);

  it('stale rollback request cannot delete a newer adoption probation', () => {
    const f = fixture(); f.seed();
    const id = f.probation.adoptionId;
    expect(openProbation({ ...f.opts, ...f.probation, sha: OTHER, run: () => ({ status: 0, stdout: OTHER }) })).toBe(true);
    const before = snapshot(f);
    expect(requestRollback({ ...f.opts, expectId: id, expectSha: FAILED })).toMatchObject({ reason: 'adoption-changed' });
    expect(snapshot(f)).toEqual(before);
  });

  it.each(['open', 'request', 'tick-pass', 'tick-fail', 'tick-delete', 'boot', 'apply', 'proven-good', 'lock'])(
    'probation mutation with a mismatched adoptionId changes no file: %s', async mutation => {
      const f = fixture(); f.seed(); tick(f);
      if (mutation === 'apply') requestRollback(f.opts);
      const before = snapshot(f);
      const options = { ...f.opts, expectId: OTHER_ID, bootAt: ADOPTED_AT + 1 };
      if (mutation === 'open') openProbation({ ...options, ...f.probation, sha: OTHER, run: () => ({ status: 0, stdout: OTHER }) });
      if (mutation === 'request') requestRollback(options);
      if (mutation.startsWith('tick')) checkProbationAtTick({ ...options,
        bootAt: ADOPTED_AT,
        now: () => mutation === 'tick-fail' ? ADOPTED_AT + 3000 : ADOPTED_AT + 2,
        run: () => ({ status: 0, stdout: mutation === 'tick-delete' ? OTHER : FAILED }) });
      if (mutation === 'boot') await bootProbation(options);
      if (mutation === 'apply') await applyPendingRollback(options);
      if (mutation === 'proven-good') expect(writeProvenGood(f.root, f.env, { ...f.good, head: OTHER }, OTHER_ID)).toBe(false);
      if (mutation === 'lock') withProbationLock(f.root, OTHER_ID, () => { throw new Error('must not enter'); }, { env: f.env });
      expect(snapshot(f)).toEqual(before);
    });

  it('open stamps a fresh UUID; boot and marker preserve that adoption id', async () => {
    const f = fixture(); f.seed(); unlinkSync(f.probationFile);
    expect(openProbation({ ...f.opts, ...f.probation, now: () => ADOPTED_AT })).toBe(true);
    const opened = readProbation(f.root, f.env);
    expect(opened.adoptionId).toMatch(/^[a-f0-9-]{36}$/);
    await bootProbation({ ...f.opts, now: () => ADOPTED_AT + 1 });
    expect(readProbation(f.root, f.env)).toMatchObject({ adoptionId: opened.adoptionId, bootPid: process.pid, boots: 1 });
    expect(requestRollback(f.opts).ok).toBe(true);
    expect(JSON.parse(readFileSync(f.markerFile))).toMatchObject({ adoptionId: opened.adoptionId });
  });

  it('duplicate opens do not renew the adoption deadline', () => {
    const f = fixture(); f.seed();
    const before = snapshot(f);
    expect(openProbation({ ...f.opts, ...f.probation })).toBe(false);
    expect(snapshot(f)).toEqual(before);
  });

  it('healthy previous tick promotes synchronously and deletes probation', () => {
    const f = fixture(); f.seed(); tick(f);
    expect(checkProbationAtTick({ ...f.opts, now: () => ADOPTED_AT + 2 })).toEqual({ action: 'pass' });
    expect(readProvenGood(f.root, f.env)).toMatchObject({ head: FAILED, adoptionId: f.probation.adoptionId });
    expect(readProbation(f.root, f.env)).toBeNull();
  });

  it.each(['pid', 'head', 'before-adoption', 'before-boot', 'future', 'unapproved-head'])(
    'rejects invalid previous tick evidence: %s', kind => {
      const f = fixture(); f.seed(); tick(f);
      const evidence = JSON.parse(readFileSync(f.tickFile));
      if (kind === 'pid') evidence.pid++;
      if (kind === 'head') evidence.head = OTHER;
      if (kind === 'before-adoption') evidence.lastTickDoneAt = iso(ADOPTED_AT);
      if (kind === 'future') evidence.lastTickDoneAt = iso(ADOPTED_AT + 60_003);
      json(f.tickFile, evidence);
      expect(checkProbationAtTick({ ...f.opts, now: () => ADOPTED_AT + 2,
        bootAt: kind === 'before-boot' ? ADOPTED_AT + 1 : ADOPTED_AT,
        bootSha: kind === 'unapproved-head' ? GOOD : FAILED })).toEqual({ action: 'pending' });
      expect(readProvenGood(f.root, f.env).head).toBe(GOOD);
    });

  it.each(['boot', 'adoption'])('late healthy evidence cannot override the %s deadline', kind => {
    const f = fixture(); f.seed();
    const now = ADOPTED_AT + (kind === 'adoption' ? 2 : 1) * WINDOW + 1;
    json(f.tickFile, { pid: process.pid, head: FAILED, lastTickDoneAt: iso(now - 1) });
    expect(checkProbationAtTick({ ...f.opts, now: () => now,
      bootAt: kind === 'adoption' ? now - 2 : ADOPTED_AT })).toMatchObject({ action: 'fail' });
    expect(existsSync(f.markerFile)).toBe(true);
    expect(f.opts.run.mock.calls.every(([args]) => args[0] !== 'reset')).toBe(true);
    expect(readProbation(f.root, f.env).adoptionId).toBe(f.probation.adoptionId);
  });

  it('superseded tick cleanup leaves proven good unchanged', () => {
    const f = fixture(); f.seed();
    expect(checkProbationAtTick({ ...f.opts, run: () => ({ status: 0, stdout: OTHER }) }))
      .toEqual({ action: 'none', reason: 'superseded' });
    expect(readProbation(f.root, f.env)).toBeNull();
    expect(readProvenGood(f.root, f.env).head).toBe(GOOD);
  });

  it.each(['no-proven-good', 'proven-good-unverified', 'rebuild-state-unreadable', 'probation-unreadable'])(
    'persistent %s refusal alerts exactly once and preserves evidence', reason => {
      const f = fixture(); f.seed();
      if (reason === 'no-proven-good') unlinkSync(f.provenFile);
      if (reason.includes('unverified') || reason === 'rebuild-state-unreadable') writeFileSync(rebuildStatePath(f.root, f.env), '{');
      if (reason === 'probation-unreadable') writeFileSync(f.probationFile, '{');
      if (reason === 'rebuild-state-unreadable') tick(f);
      const before = snapshot(f);
      for (let i = 0; i < 4; i++) checkProbationAtTick({ ...f.opts,
        now: () => reason === 'rebuild-state-unreadable' ? ADOPTED_AT + 2 : ADOPTED_AT + 3000 });
      const alerts = readFileSync(alertsFilePath(f.root, f.env), 'utf8').trim().split('\n').map(JSON.parse);
      expect(alerts).toEqual([expect.objectContaining({ detail: { reason } })]);
      expect(f.opts.log.error).toHaveBeenCalledTimes(1);
      expect(snapshot(f)).toEqual(before);
    });

  it('unverified tree can pass liveness but cannot become proven good or a rollback target', () => {
    const f = fixture(); f.seed(); tick(f);
    writeRebuildState(f.root, { forceUnverifiedTrees: [FAILED] }, f.env);
    expect(checkProbationAtTick({ ...f.opts, now: () => ADOPTED_AT + 2 })).toEqual({ action: 'pass' });
    expect(readProvenGood(f.root, f.env).head).toBe(GOOD);
    f.seed(); writeRebuildState(f.root, { forceUnverifiedTrees: [FAILED] }, f.env);
    expect(requestRollback(f.opts)).toMatchObject({ reason: 'proven-good-unverified' });
  });

  it.each(['live', 'unknown', 'unreadable', 'dead'])('shared mutex handles a %s holder without expiry reclamation', kind => {
    const f = fixture(); f.seed();
    const lockRoot = join(f.env.WE_DAEMON_STATE_DIR, `${cloneKeyOf(f.root)}.probation-registration`);
    const entry = makeLockEntry(kind === 'unknown' ? 'remote.invalid:123' : `${hostname()}:${kind === 'dead' ? 2147483647 : process.pid}-fixture-token`,
      'probation', iso(0), kind === 'dead' ? 2147483647 : process.pid);
    expect(acquireLockDir(lockRoot, 'probation', entry)).toBe(true);
    if (kind === 'unreadable') writeFileSync(join(lockDirFor(lockRoot, 'probation'), 'lock.json'), '{');
    const callback = vi.fn(() => true);
    const result = withProbationLock(f.root, f.probation.adoptionId, callback, { env: f.env });
    expect(callback).toHaveBeenCalledTimes(kind === 'dead' ? 1 : 0);
    if (kind !== 'dead') {
      expect(result).toMatchObject({ reason: 'probation-lock-held' });
      expect(existsSync(lockDirFor(lockRoot, 'probation'))).toBe(true);
    }
  });

  it('all writers stay out while asynchronous boot recovery holds the shared mutex', async () => {
    const f = fixture(); f.seed(); requestRollback(f.opts);
    let release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const finish = new Promise(resolve => { release = resolve; });
    finalizeRebuild.mockImplementationOnce(async () => { entered(); await finish; return { adopted: false }; });
    const recovery = applyPendingRollback(f.opts);
    await waiting;
    const before = snapshot(f);
    expect(openProbation({ ...f.opts, ...f.probation, sha: OTHER, run: () => ({ status: 0, stdout: OTHER }) })).toBe(false);
    expect(requestRollback(f.opts)).toMatchObject({ reason: 'probation-lock-held' });
    expect(checkProbationAtTick(f.opts)).toMatchObject({ reason: 'probation-lock-held' });
    expect(await bootProbation(f.opts)).toMatchObject({ reason: 'probation-lock-held' });
    expect(writeProvenGood(f.root, f.env, f.good, f.probation.adoptionId)).toBe(false);
    expect(snapshot(f)).toEqual(before);
    release(); await recovery;
  });

  it.each(['alive', 'unknown', 'throws'])('sibling boot with %s predecessor is not a crash loop', async status => {
    const f = fixture(); f.probation.boots = 3; f.probation.bootPid = 123; f.seed();
    await bootProbation({ ...f.opts, now: () => ADOPTED_AT + 1,
      probeBoot: () => { if (status === 'throws') throw new Error(); return status; } });
    expect(readProbation(f.root, f.env)).toMatchObject({ boots: 1, concurrentBoots: true });
    expect(existsSync(f.markerFile)).toBe(false);
  });

  it('confirmed sequential crash loop requests and applies rollback in the boot call', async () => {
    const f = fixture(); f.probation.boots = PROBATION_MAX_BOOTS; f.probation.bootPid = 123; f.seed();
    let head = FAILED;
    finalizeRebuild.mockImplementationOnce(async () => { head = GOOD; return { adopted: true }; });
    expect(await bootProbation({ ...f.opts, now: () => ADOPTED_AT + 1,
      run: () => ({ status: 0, stdout: head }), probeBoot: () => 'dead' })).toMatchObject({ ok: true, restartRequired: true });
    expect(head).toBe(GOOD);
    expect(readRebuildState(f.root, f.env).rejected).toMatchObject({ inputsKey: 'failed-inputs', reason: 'crash-loop' });
  });

  it('startup failure after adoption rolls back at a later boot', async () => {
    const f = fixture(); f.seed();
    let head = FAILED, at = ADOPTED_AT + 1;
    const run = () => ({ status: 0, stdout: head });
    const restart = vi.fn(), rebuild = vi.fn(async () => ({ moved: false }));
    const make = () => withSelfSync({ tickOnce() { throw new Error('B startup failure'); } }, {
      root: f.root, env: f.env, log: f.opts.log, now: () => at, versions: null, background: false,
      readHead: () => head, readState: () => ({}), rebuild, onRestart: restart,
      acquireRead: () => ({ ok: true }), releaseRead() {},
      applyPendingRollback: opts => bootProbation({ ...opts, run, emit: f.opts.emit }),
      checkProbation: opts => checkProbationAtTick({ ...opts, run, emit: f.opts.emit }),
    });
    await expect(make().tickOnce()).rejects.toThrow('B startup failure');
    at = ADOPTED_AT + 2 * WINDOW + 1;
    rebuild.mockClear();
    finalizeRebuild.mockImplementationOnce(async () => {
      expect(readRebuildState(f.root, f.env).rejected.inputsKey).toBe('failed-inputs');
      head = GOOD; return { adopted: true };
    });
    await make().tickOnce();
    expect(head).toBe(GOOD);
    expect(restart).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledWith(expect.objectContaining({ reason: 'probation-rollback' }));
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('four live sibling processes promote only their own previous tick without rollback', async () => {
    expect((await siblingStartupBreak.run()).violations).toEqual([]);
  });

  it.each([null, ['scripts/worker.mjs']])('unknown or imported changes never authorize an old process tick: %j', async changedFiles => {
    const f = fixture();
    let head = GOOD;
    const check = vi.fn(opts => checkProbationAtTick({ ...f.opts, ...opts, run: () => ({ status: 0, stdout: head }) }));
    const wrapped = withSelfSync({ tickOnce: () => 'ticked' }, {
      root: f.root, env: f.env, log: f.opts.log, versions: null, background: false,
      now: () => ADOPTED_AT + 2, readHead: () => head, readState: () => ({}),
      applyPendingRollback: async () => ({ action: 'none' }), checkProbation: check,
      rebuild: async () => ({ moved: false }), acquireRead: () => ({ ok: true }), releaseRead() {},
      onRestart: vi.fn(), diffFiles: () => changedFiles,
      importClosure: () => ({ complete: true, files: new Set(['scripts/worker.mjs']), bareDeps: false, jsonNames: new Set() }),
    });
    f.seed(); head = FAILED;
    json(f.tickFile, { pid: process.pid, head: FAILED, lastTickDoneAt: iso(ADOPTED_AT + 3) });
    await wrapped.tickOnce();
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ bootSha: GOOD }));
    expect(readProvenGood(f.root, f.env).head).toBe(GOOD);
    expect(readProbation(f.root, f.env).adoptionId).toBe(f.probation.adoptionId);
  });

  it('unresolved HEAD never deletes probation or proves a tick', () => {
    const f = fixture(); f.seed();
    json(f.tickFile, { pid: process.pid, head: FAILED, lastTickDoneAt: iso(ADOPTED_AT + 1) });
    expect(checkProbationAtTick({ ...f.opts, now: () => ADOPTED_AT + 2, run: () => ({ status: 1 }) }))
      .toEqual({ action: 'pending' });
    expect(readProbation(f.root, f.env).adoptionId).toBe(f.probation.adoptionId);
    expect(readProvenGood(f.root, f.env).head).toBe(GOOD);
  });

  it.each(['missing', 'malformed', 'legacy'])('invalid %s adoption identity is unreadable', kind => {
    const f = fixture(); f.seed();
    const record = { ...f.probation };
    if (kind === 'malformed') record.adoptionId = '../other';
    else delete record.adoptionId;
    json(f.probationFile, record);
    expect(readProbation(f.root, f.env)).toBeNull();
  });

  it.each(['scripts/worker.mjs', 'scripts/worker @ nightly.mjs'])(
    'real tick writer feeds probation discovery and promotion: %s', entry => {
      const f = fixture();
      // Use this checkout only for read-only HEAD resolution. State is isolated
      // under f.env; no fixture Git writes or hand-written tick JSON are needed.
      const root = fileURLToPath(new URL('../../../../', import.meta.url));
      const resolved = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: root, env: f.env, encoding: 'utf8', timeout: 5000, maxBuffer: 4096,
      });
      expect(resolved.status).toBe(0);
      const head = resolved.stdout.trim();
      const adopted = { head, inputsKey: 'writer-reader-contract', mainSha: head, applied: [] };
      writeRebuildState(root, { adopted, forceUnverifiedTrees: [] }, f.env);
      expect(openProbation({ root, env: f.env, sha: head, prevHead: head,
        inputsKey: adopted.inputsKey, mainSha: head, applied: [], now: () => ADOPTED_AT })).toBe(true);
      const adoptionId = readProbation(root, f.env).adoptionId;
      const options = { root, env: f.env, bootSha: head, bootAt: ADOPTED_AT,
        now: () => ADOPTED_AT + 2, log: f.opts.log, emit: f.opts.emit };
      const store = makeTickProgressStore({ root, entry, env: f.env });
      store.markSeen(ADOPTED_AT);
      expect(checkProbationAtTick(options)).toEqual({ action: 'pending' });
      store.markTickDone(ADOPTED_AT + 1);
      // Do not read/rewrite the store or derive its path: this assertion must
      // fail if writer and reader clone keys or filename shapes diverge.
      expect(checkProbationAtTick(options)).toEqual({ action: 'pass' });
      expect(readProvenGood(root, f.env)).toMatchObject({ head, adoptionId });
      expect(readProbation(root, f.env)).toBeNull();
    });

  it('tick writer records HEAD and PID, with null HEAD when Git cannot resolve it', () => {
    const f = fixture(); const repo = realRepo(f);
    const store = makeTickProgressStore({ root: f.root, entry: 'writer', env: f.env });
    store.markTickDone(ADOPTED_AT);
    expect(store.read()).toMatchObject({ pid: process.pid, head: repo.failed, lastTickDoneAt: iso(ADOPTED_AT) });
    rmSync(join(f.root, '.git'), { recursive: true, force: true });
    store.markTickDone(ADOPTED_AT + 1);
    expect(store.read().head).toBeNull();
  });

  it('tick writer resolves HEAD on Node 22.1 without process.getBuiltinModule', () => {
    const f = fixture(); const repo = realRepo(f);
    const descriptor = Object.getOwnPropertyDescriptor(process, 'getBuiltinModule');
    try {
      Object.defineProperty(process, 'getBuiltinModule', { configurable: true, value: undefined });
      const store = makeTickProgressStore({ root: f.root, entry: 'node-22-1', env: f.env });
      store.markTickDone(ADOPTED_AT);
      expect(store.read()).toMatchObject({ pid: process.pid, head: repo.failed });
    } finally {
      if (descriptor) Object.defineProperty(process, 'getBuiltinModule', descriptor);
      else delete process.getBuiltinModule;
    }
  });

  it('probationMsOf accepts positive integers and defaults on invalid bounds', () => {
    expect(probationMsOf({ WE_DAEMON_PROBATION_MS: '1000' })).toBe(1000);
    for (const value of ['', '0', '-1', 'Infinity', '1.5', 'x']) expect(probationMsOf({ WE_DAEMON_PROBATION_MS: value })).toBe(PROBATION_MS_DEFAULT);
  });
});
