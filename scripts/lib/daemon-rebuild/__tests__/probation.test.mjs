import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  PROBATION_MS_DEFAULT, PROBATION_MAX_BOOTS, probationMsOf,
  readProvenGood, writeProvenGood, readProbation, openProbation, continueProbation,
  evaluateProbation, registerOutcomeCheck, clearOutcomeChecks,
  requestRollback, applyPendingRollback, runProbationTick, armProbationWatch,
} from '../probation.mjs';
import { acquireRead, releaseRead, inspectCloneLock, withWriteLock } from '../../daemon-clone-lock.mjs';
import { prepareRebuild } from '../prepare.mjs';
import { planRebuild } from '../plan.mjs';
import { makeTickProgressStore } from '../../daemon-background-build.mjs';
import { withSelfSync } from '../../daemon-self-sync.mjs';

vi.mock('../../daemon-clone-lock.mjs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, inspectCloneLock: vi.fn(actual.inspectCloneLock), withWriteLock: vi.fn(actual.withWriteLock) };
});

import { cloneKeyOf } from '../../daemon-last-good.mjs';
import {
  alertsFilePath, readRebuildState, writeRebuildState,
  readReadyCandidate, writeReadyCandidate,
} from '../state.mjs';

const ADOPTED_AT = Date.parse('2026-11-15T12:00:00.000Z');
const WINDOW = 1000;
const GOOD = 'a'.repeat(40);
const FAILED = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const iso = ms => new Date(ms).toISOString();
const dirs = [];

beforeEach(() => { clearOutcomeChecks(); withWriteLock.mockClear(); });
afterEach(() => {
  clearOutcomeChecks();
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
    sha: FAILED, inputsKey: 'failed-inputs', mainSha: GOOD,
    applied: [{ ref: 'overlay/example', sha: FAILED }], prevHead: GOOD,
    adoptedAt: iso(ADOPTED_AT), bootedAt: iso(ADOPTED_AT), bootPid: process.pid, probationMs: WINDOW,
    baseline: { [basename(tickFile)]: iso(ADOPTED_AT - 100) }, boots: 0, version: 1,
  };
  const run = vi.fn(() => { throw new Error('Unexpected Git IO in injected fixture'); });
  const rollback = vi.fn(async () => ({ ok: true }));
  const emit = vi.fn();
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() };
  const opts = {
    root, env, stateOpts: { env }, log, run, rollback, emit,
    now: () => ADOPTED_AT + WINDOW + 1, readHead: () => FAILED, processStartMs: ADOPTED_AT,
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
  f.seed();
  return { run, git, good, failed };
}

describe('no-restart adoptions', () => {
  it.each(['skipped-unrelated', 'adopted', 'sibling'])('%s adoption can prove continued ticking without a fresh boot', async reason => {
    const f = fixture();
    let at = ADOPTED_AT;
    let head = GOOD;
    const onRestart = vi.fn();
    const wrapped = withSelfSync({ tickOnce: () => {
      json(f.tickFile, { pid: process.pid, head, lastTickDoneAt: iso(++at) });
      return 'ticked';
    } }, {
      root: f.root, env: f.env, now: () => at, log: f.opts.log, onRestart,
      versions: null, background: false, applyPendingRollback: async () => ({ action: 'none' }),
      readHead: () => head, readState: () => ({ adopted: null }),
      acquireRead: () => ({ ok: true }), releaseRead: () => {},
      importClosure: () => ({ files: new Set(['scripts/daemon.mjs']), complete: true, bareDeps: false, jsonNames: new Set() }),
      diffFiles: () => ['docs/example.md'],
      rebuild: async () => {
        if (head !== FAILED) {
          json(f.provenFile, f.good);
          openProbation({ ...f.opts, ...f.probation, now: () => at });
          head = FAILED;
        }
        return { moved: reason !== 'sibling', adopted: true, head, reason };
      },
    });
    expect(await wrapped.tickOnce()).toBe('ticked');
    expect(onRestart).not.toHaveBeenCalled();
    expect(await runProbationTick({ ...f.opts, now: () => ++at })).toEqual({ action: 'passed' });
    expect(readProvenGood(f.root, f.env)?.head).toBe(FAILED);
    expect(await runProbationTick({ ...f.opts, now: () => ADOPTED_AT + 2 * WINDOW + 1 })).toEqual({ action: 'none' });
    expect(f.opts.rollback).not.toHaveBeenCalled();
    expect(existsSync(f.markerFile)).toBe(false);
  });

  it.each([{ changedFiles: null }, { changedFiles: ['scripts/daemon.mjs'] }])('unknown or deferred imported changes (%j) still require a fresh boot', async ({ changedFiles }) => {
    const f = fixture();
    openProbation({ ...f.opts, ...f.probation, now: () => ADOPTED_AT });
    const wrapped = withSelfSync({ tickOnce: () => 'ticked' }, {
      root: f.root, env: f.env, now: () => ADOPTED_AT, log: f.opts.log, onRestart: () => 'restarted',
      versions: null, background: false, applyPendingRollback: async () => ({ action: 'none' }),
      readHead: () => GOOD, readState: () => ({ adopted: null }),
      acquireRead: () => ({ ok: true }), releaseRead: () => {},
      importClosure: () => ({ files: new Set(['scripts/daemon.mjs']), complete: true, bareDeps: false, jsonNames: new Set() }),
      diffFiles: () => changedFiles, minRestartIntervalMs: 600_000,
      rebuild: async () => ({ moved: true, adopted: true, head: FAILED }),
    });
    await wrapped.tickOnce();
    expect(readProbation(f.root, f.env)).not.toHaveProperty('continuedPid');
    expect(await runProbationTick({ ...f.opts, now: () => ADOPTED_AT + 2 * WINDOW + 1 }))
      .toEqual({ action: 'rolled-back', reason: 'never-booted' });
  });

  it('the adopting observer can run outcome checks after no-restart authorization', async () => {
    vi.useFakeTimers();
    const f = fixture();
    openProbation({ ...f.opts, ...f.probation, now: () => ADOPTED_AT });
    const check = vi.fn(() => ({ status: 'fail', reason: 'outcome-failed' }));
    registerOutcomeCheck('continuation', check);
    armProbationWatch({ ...f.opts, now: () => ADOPTED_AT + 10, observeOnly: true, onRolledBack: vi.fn() });
    expect(continueProbation({ ...f.opts, sha: FAILED, now: () => ADOPTED_AT + 10 })).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalled();
    expect(f.opts.rollback).toHaveBeenCalledWith('outcome-failed', {});
    expect(readProbation(f.root, f.env)).not.toHaveProperty('bootPid');
  });

  it('continuation retains the first authorization time and cannot renew either deadline', async () => {
    const f = fixture();
    openProbation({ ...f.opts, ...f.probation, now: () => ADOPTED_AT });
    continueProbation({ ...f.opts, sha: FAILED, now: () => ADOPTED_AT + 10 });
    continueProbation({ ...f.opts, sha: FAILED, now: () => ADOPTED_AT + WINDOW });
    expect(readProbation(f.root, f.env).continuedAt).toBe(iso(ADOPTED_AT + 10));
    expect(await runProbationTick({ ...f.opts, now: () => ADOPTED_AT + WINDOW + 11 }))
      .toEqual({ action: 'rolled-back', reason: 'no-tick-progress' });
    continueProbation({ ...f.opts, sha: FAILED, now: () => ADOPTED_AT + 2 * WINDOW });
    expect(await runProbationTick({ ...f.opts, now: () => ADOPTED_AT + 2 * WINDOW + 1 }))
      .toEqual({ action: 'rolled-back', reason: 'no-tick-progress' });
  });

  it.each(['pid', 'head', 'before-proof', 'future'])('continuation rejects a tick with invalid %s evidence', async kind => {
    const f = fixture();
    openProbation({ ...f.opts, ...f.probation, now: () => ADOPTED_AT });
    continueProbation({ ...f.opts, sha: FAILED, now: () => ADOPTED_AT + 10 });
    json(f.tickFile, { pid: kind === 'pid' ? process.pid + 1 : process.pid, head: kind === 'head' ? OTHER : FAILED,
      lastTickDoneAt: iso(ADOPTED_AT + (kind === 'before-proof' ? 5 : kind === 'future' ? 60_021 : 11)) });
    expect(await runProbationTick({ ...f.opts, now: () => ADOPTED_AT + 20 })).toEqual({ action: 'pending' });
    expect(continueProbation({ ...f.opts, sha: OTHER })).toBe(false);
  });

  it('continuation cannot promote a force-unverified tree', async () => {
    const f = fixture();
    openProbation({ ...f.opts, ...f.probation, now: () => ADOPTED_AT });
    continueProbation({ ...f.opts, sha: FAILED, now: () => ADOPTED_AT + 1 });
    writeRebuildState(f.root, { forceUnverifiedTrees: [OTHER] }, f.env);
    json(f.tickFile, { pid: process.pid, head: FAILED, lastTickDoneAt: iso(ADOPTED_AT + 2) });
    const run = vi.fn(() => ({ status: 0, stdout: OTHER }));
    expect(await runProbationTick({ ...f.opts, run, now: () => ADOPTED_AT + 3 })).toEqual({ action: 'passed-unverified' });
    expect(readProvenGood(f.root, f.env)).toBeNull();
  });

  it('a continuation write cannot replace a concurrently opened adoption', () => {
    const f = fixture();
    openProbation({ ...f.opts, ...f.probation, now: () => ADOPTED_AT });
    continueProbation({ ...f.opts, sha: FAILED, now: () => {
      openProbation({ ...f.opts, ...f.probation, sha: OTHER, now: () => ADOPTED_AT + 50 });
      return ADOPTED_AT + 10;
    } });
    expect(readProbation(f.root, f.env)).toMatchObject({ sha: OTHER, adoptedAt: iso(ADOPTED_AT + 50) });
    expect(readProbation(f.root, f.env)).not.toHaveProperty('continuedPid');
  });

  it.each(['corrupt', 'stale', 'inline', 'unwritable'])('%s continuation proof cannot authorize the old process', async kind => {
    const f = fixture();
    openProbation({ ...f.opts, ...f.probation, now: () => ADOPTED_AT });
    const proofFile = join(f.env.WE_DAEMON_STATE_DIR, `${cloneKeyOf(f.root)}.probation-continuation.json`);
    if (kind === 'corrupt') writeFileSync(proofFile, '{broken');
    if (kind === 'stale') json(proofFile, { sha: FAILED, adoptedAt: iso(ADOPTED_AT - 1), continuedPid: process.pid, continuedAt: iso(ADOPTED_AT) });
    if (kind === 'inline') json(f.probationFile, { ...readProbation(f.root, f.env), continuedPid: process.pid, continuedAt: iso(ADOPTED_AT) });
    if (kind === 'unwritable') {
      mkdirSync(proofFile);
      expect(continueProbation({ ...f.opts, sha: FAILED, now: () => ADOPTED_AT + 1 })).toBe(false);
    }
    json(f.tickFile, { pid: process.pid, head: FAILED, lastTickDoneAt: iso(ADOPTED_AT + 1) });
    expect(await runProbationTick({ ...f.opts, now: () => ADOPTED_AT + 2 })).toEqual({ action: 'pending' });
    expect(await runProbationTick({ ...f.opts, now: () => ADOPTED_AT + 2 * WINDOW + 1 }))
      .toEqual({ action: 'rolled-back', reason: 'never-booted' });
  });
});

describe('probation and provenGood contracts', () => {
  it('an unreadable probation file is kept and alerted once, never treated as none', async () => {
    const f = fixture();
    mkdirSync(dirname(f.probationFile), { recursive: true });
    writeFileSync(f.probationFile, '{not json');
    const r = await runProbationTick(f.opts);
    expect(r.action).toBe('pending');
    expect(existsSync(f.probationFile)).toBe(true);
    expect(readFileSync(alertsFilePath(f.root, f.env), 'utf8')).toContain('probation-unreadable');
  });

  it('a never-settling outcome check cannot block the deadline rollback', async () => {
    vi.useFakeTimers();
    const f = fixture(); f.seed();
    registerOutcomeCheck('hangs', () => new Promise(() => {}));
    const p = runProbationTick(f.opts);
    await vi.advanceTimersByTimeAsync(31_000);
    expect((await p).action).toBe('rolled-back');
    expect(f.opts.rollback).toHaveBeenCalledWith('no-tick-progress', expect.anything());
  });

  it('failure requests rollback without touching HEAD or taking a lock; boot apply resets under the normal lock', async () => {
    const f = fixture();
    const repo = realRepo(f);
    writeReadyCandidate(f.root, { prevHead: repo.failed, adopt: { finalSha: repo.failed } }, f.env);
    const rollback = vi.fn(reason => requestRollback({
      ...f.opts, run: repo.run, expectSha: repo.failed, reason,
    }));
    const result = await runProbationTick({ ...f.opts, run: repo.run, readHead: () => repo.git(['rev-parse', 'HEAD']), rollback });
    expect(result).toMatchObject({ action: 'rolled-back', reason: 'no-tick-progress' });
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(repo.git(['rev-parse', 'HEAD'])).toBe(repo.failed);
    expect(readFileSync(join(f.root, 'build.txt'), 'utf8')).toBe('failed build\n');
    expect(withWriteLock).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(f.markerFile, 'utf8'))).toEqual({
      from: repo.failed, to: repo.good, inputsKey: f.good.inputsKey, mainSha: f.good.mainSha, applied: f.good.applied,
      rejectInputsKey: 'failed-inputs', reason: 'no-tick-progress', at: iso(f.opts.now()),
    });
    expect(existsSync(f.probationFile)).toBe(false);
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
    expect(withWriteLock.mock.calls[0][2]).toEqual({ now: f.opts.now, waitMs: 60000, lockRoot: f.env.WE_DAEMON_CLONE_LOCK_ROOT });
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

  it.each(['tick-in-progress', 'concurrent-mover'].flatMap(reason => ['failed', 'target'].map(head => ({ reason, head }))))
  ('boot lock refusal $reason at $head keeps the marker, alerts, and never resets', async ({ reason, head }) => {
    const f = fixture(); const repo = realRepo(f);
    await requestRollback({ ...f.opts, run: repo.run });
    const marker = readFileSync(f.markerFile, 'utf8');
    if (head === 'target') repo.git(['reset', '--hard', repo.good]);
    withWriteLock.mockResolvedValueOnce({ ok: false, reason, heldBy: 'busy-owner' });
    expect(await applyPendingRollback({ ...f.opts, run: repo.run, lockWaitMs: 0 }))
      .toEqual({ ok: false, reason: 'rollback-lock-timeout' });
    expect(repo.git(['rev-parse', 'HEAD'])).toBe(head === 'target' ? repo.good : repo.failed);
    expect(readFileSync(f.markerFile, 'utf8')).toBe(marker);
    expect(readRebuildState(f.root, f.env).rejected).toBeNull();
    expect(JSON.parse(readFileSync(alertsFilePath(f.root, f.env), 'utf8').trim()))
      .toMatchObject({ kind: 'probation-needs-you', detail: { reason: 'rollback-lock-timeout', heldBy: 'busy-owner' } });
    expect(f.opts.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'probation-needs-you',
      detail: { reason: 'rollback-lock-timeout', heldBy: 'busy-owner' } }), { env: expect.anything() });
    expect(f.opts.log.error).toHaveBeenCalled();
  });

  it.each(['before boot', 'during lock acquisition'])('deferred rollback preserves a newer adoption and its state: %s', async phase => {
    const f = fixture(); const repo = realRepo(f);
    await requestRollback({ ...f.opts, run: repo.run, expectSha: repo.failed });
    withWriteLock.mockResolvedValueOnce({ ok: false, reason: 'tick-in-progress', heldBy: 'busy-owner' });
    expect(await applyPendingRollback({ ...f.opts, run: repo.run, lockWaitMs: 0 }))
      .toEqual({ ok: false, reason: 'rollback-lock-timeout' });

    writeFileSync(join(f.root, 'build.txt'), 'new healthy build\n');
    repo.git(['add', 'build.txt']);
    const newer = repo.git(['commit-tree', repo.git(['write-tree']), '-p', repo.failed, '-m', 'new healthy adoption']);
    repo.git(['reset', '--hard', repo.failed]);
    const state = { ...readRebuildState(f.root, f.env), adopted: {
      head: newer, inputsKey: 'new-healthy-inputs', mainSha: repo.good, applied: [],
    } };
    const ready = { prevHead: newer, adopt: { finalSha: newer }, passedAt: iso(f.opts.now()) };
    const probation = { ...f.probation, sha: newer, inputsKey: 'new-healthy-inputs' };
    const adoptNewer = () => {
      repo.git(['reset', '--hard', newer]);
      writeRebuildState(f.root, state, f.env);
      writeReadyCandidate(f.root, ready, f.env);
      json(f.probationFile, probation);
      repo.run.mockClear();
    };
    if (phase === 'before boot') adoptNewer();
    else {
      const actual = await vi.importActual('../../daemon-clone-lock.mjs');
      withWriteLock.mockImplementationOnce((root, fn, opts) => actual.withWriteLock(root, async () => {
        adoptNewer();
        return fn();
      }, opts));
    }
    f.opts.emit.mockClear();
    expect(await applyPendingRollback({ ...f.opts, run: repo.run }))
      .toMatchObject({ action: 'superseded', head: newer });
    expect(repo.run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
    expect(repo.git(['rev-parse', 'HEAD'])).toBe(newer);
    expect(readFileSync(join(f.root, 'build.txt'), 'utf8')).toBe('new healthy build\n');
    expect(readRebuildState(f.root, f.env)).toEqual(state);
    expect(readReadyCandidate(f.root, f.env)).toEqual(ready);
    expect(readProbation(f.root, f.env)).toEqual(probation);
    expect(readProvenGood(f.root, f.env)).toEqual(f.good);
    expect(existsSync(f.markerFile)).toBe(false);
    expect(f.opts.emit).not.toHaveBeenCalled();
  });

  it('already-at-target recovery preserves concurrent adoption', async () => {
    const f = fixture(); const repo = realRepo(f);
    await requestRollback({ ...f.opts, run: repo.run, expectSha: repo.failed });
    writeFileSync(join(f.root, 'build.txt'), 'new healthy build\n');
    repo.git(['add', 'build.txt']);
    const newer = repo.git(['commit-tree', repo.git(['write-tree']), '-p', repo.failed, '-m', 'concurrent healthy adoption']);
    repo.git(['reset', '--hard', repo.good]);
    const state = { ...readRebuildState(f.root, f.env), adopted: {
      head: newer, inputsKey: 'new-healthy-inputs', mainSha: repo.good, applied: [],
    } };
    const ready = { prevHead: newer, adopt: { finalSha: newer } };
    let adopted = false;
    const adoptNewer = () => {
      if (adopted) return;
      adopted = true;
      repo.git(['reset', '--hard', newer]);
      writeRebuildState(f.root, state, f.env);
      writeReadyCandidate(f.root, ready, f.env);
      repo.run.mockClear();
    };
    const actual = await vi.importActual('../../daemon-clone-lock.mjs');
    // A competing adoption wins before recovery's lock callback begins. The old
    // unlocked shortcut instead sees the target, then loses state to this race.
    withWriteLock.mockImplementationOnce((root, fn, opts) => actual.withWriteLock(root, async () => {
      adoptNewer();
      return fn();
    }, opts));
    const run = (args, opts) => {
      const result = repo.run(args, opts);
      if (args[0] === 'rev-parse' && args.at(-1) === 'HEAD') adoptNewer();
      return result;
    };
    try {
      const result = await applyPendingRollback({ ...f.opts, run });
      expect(adopted).toBe(true);
      expect(readRebuildState(f.root, f.env)).toEqual(state);
      expect(readReadyCandidate(f.root, f.env)).toEqual(ready);
      expect(repo.git(['rev-parse', 'HEAD'])).toBe(newer);
      expect(readFileSync(join(f.root, 'build.txt'), 'utf8')).toBe('new healthy build\n');
      expect(repo.run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
      expect(result).toMatchObject({ action: 'superseded', head: newer });
      expect(withWriteLock).toHaveBeenCalledTimes(1);
      expect(existsSync(f.markerFile)).toBe(false);
    } finally {
      // The buggy shortcut never consumes the one-shot lock injection.
      withWriteLock.mockReset();
      withWriteLock.mockImplementation(actual.withWriteLock);
    }
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

  it('slow outcome check expires the window before evaluation instead of passing', async () => {
    const f = fixture(); f.seed();
    let at = ADOPTED_AT + 2;
    json(f.tickFile, { pid: process.pid, head: FAILED, lastTickDoneAt: iso(ADOPTED_AT + 1) });
    registerOutcomeCheck('slow', async () => { at = ADOPTED_AT + WINDOW + 1; return { status: 'ok' }; });
    expect(await runProbationTick({ ...f.opts, now: () => at }))
      .toEqual({ action: 'rolled-back', reason: 'no-tick-progress' });
    expect(readProvenGood(f.root, f.env)).toEqual(f.good);
  });

  it('healthy tick after adoptedAt writes provenGood from the probation record and removes probation', async () => {
    const f = fixture(); f.seed();
    json(f.tickFile, { lastTickDoneAt: iso(ADOPTED_AT + 1), pid: process.pid, head: f.probation.sha });
    expect(await runProbationTick({ ...f.opts, now: () => ADOPTED_AT + 2 })).toMatchObject({ action: 'passed' });
    expect(readProvenGood(f.root, f.env)).toMatchObject({
      head: f.probation.sha, inputsKey: f.probation.inputsKey, mainSha: f.probation.mainSha,
      applied: f.probation.applied, provenAt: iso(ADOPTED_AT + 2),
    });
    expect(existsSync(f.probationFile)).toBe(false);
    expect(f.opts.rollback).not.toHaveBeenCalled();
    expect(f.opts.emit.mock.calls.some(([event]) => event.kind === 'probation-passed')).toBe(true);
  });

  it('rejected inputsKey is not re-adopted: rollback persists the failed key without retryAt', async () => {
    const f = fixture(); const repo = realRepo(f);
    expect(await requestRollback({ ...f.opts, run: repo.run, expectSha: repo.failed })).toMatchObject({ ok: true });
    expect(await applyPendingRollback({ ...f.opts, run: repo.run })).toMatchObject({ ok: true });
    const rejected = readRebuildState(f.root, f.env).rejected;
    expect(rejected).toMatchObject({ inputsKey: 'failed-inputs', probation: true, reason: 'probation-failed' });
    expect(rejected).not.toHaveProperty('retryAt');
    expect(Number.isFinite(Date.parse(rejected.at))).toBe(true);
    expect(await runProbationTick(f.opts)).toMatchObject({ action: 'none' });
    expect(readRebuildState(f.root, f.env).rejected).toEqual(rejected);
  });

  it('no provenGood refuses with no-proven-good, leaves HEAD untouched, and writes an operator alert', async () => {
    const f = fixture(); const repo = realRepo(f);
    rmSync(f.provenFile);
    const result = await requestRollback({ ...f.opts, run: repo.run, expectSha: repo.failed });
    expect(result).toMatchObject({ ok: false, reason: 'no-proven-good' });
    expect(repo.git(['rev-parse', 'HEAD'])).toBe(repo.failed);
    expect(readFileSync(join(f.root, 'build.txt'), 'utf8')).toBe('failed build\n');
    const alerts = readFileSync(alertsFilePath(f.root, f.env), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(alerts.some(alert => alert.kind === 'probation-needs-you')).toBe(true);
  });

  it('superseded HEAD drops probation without rollback or changing provenGood', async () => {
    const f = fixture(); f.seed();
    const before = readFileSync(f.provenFile, 'utf8');
    expect(await runProbationTick({ ...f.opts, readHead: () => OTHER })).toMatchObject({ action: 'superseded' });
    expect(f.opts.rollback).not.toHaveBeenCalled();
    expect(existsSync(f.probationFile)).toBe(false);
    expect(readFileSync(f.provenFile, 'utf8')).toBe(before);
  });

  it('crash-loop: boots greater than 3 fails even while ticks advance', async () => {
    const f = fixture(); f.seed();
    expect(PROBATION_MAX_BOOTS).toBe(3);
    json(f.probationFile, { ...f.probation, boots: 4 });
    json(f.tickFile, { lastTickDoneAt: iso(ADOPTED_AT + 1), pid: process.pid, head: f.probation.sha });
    expect(await runProbationTick({ ...f.opts, now: () => ADOPTED_AT + 2 })).toMatchObject({ action: 'rolled-back', reason: 'crash-loop' });
    expect(f.opts.rollback).toHaveBeenCalledTimes(1);
  });

  it('pending before the deadline preserves probation and provenGood', async () => {
    const f = fixture(); f.seed();
    expect(await runProbationTick({ ...f.opts, now: () => ADOPTED_AT + WINDOW - 1 })).toEqual({ action: 'pending' });
    expect(readProbation(f.root, f.env)).toEqual(f.probation);
    expect(readProvenGood(f.root, f.env)).toEqual(f.good);
    expect(f.opts.rollback).not.toHaveBeenCalled();
  });

  it('a sibling PID cannot prove the booted worker is live', async () => {
    const f = fixture(); f.seed();
    const sibling = join(f.env.WE_DAEMON_STATE_DIR, `${cloneKeyOf(f.root)}.ticks.sibling.json`);
    json(f.probationFile, { ...f.probation, baseline: {
      ...f.probation.baseline, [basename(sibling)]: iso(ADOPTED_AT - 100),
    } });
    json(sibling, { lastTickDoneAt: iso(ADOPTED_AT + 1), pid: process.pid + 1, head: FAILED });
    expect(await runProbationTick(f.opts)).toMatchObject({ action: 'rolled-back', reason: 'no-tick-progress' });
  });

  it('empty baseline passes only when a tick of this clone advances past adoption', async () => {
    const f = fixture(); f.seed();
    json(f.probationFile, { ...f.probation, baseline: {} });
    json(join(f.env.WE_DAEMON_STATE_DIR, 'foreign-clone.ticks.worker.json'), { lastTickDoneAt: iso(ADOPTED_AT + 1) });
    expect(await runProbationTick({ ...f.opts, now: () => ADOPTED_AT + 2 })).toEqual({ action: 'pending' });
    json(f.tickFile, { lastTickDoneAt: iso(ADOPTED_AT + 1), pid: process.pid, head: f.probation.sha });
    expect(await runProbationTick({ ...f.opts, now: () => ADOPTED_AT + 2 })).toMatchObject({ action: 'passed' });
  });

  it('failed rollback is reported as rollback-failed rather than a successful recovery', async () => {
    const f = fixture(); f.seed();
    f.opts.rollback.mockResolvedValue({ ok: false, reason: 'no-proven-good' });
    expect(await runProbationTick(f.opts)).toMatchObject({ action: 'rollback-failed' });
    expect(readProvenGood(f.root, f.env)).toEqual(f.good);
  });

  it('outcome-check hook: registered fail triggers rollback even though ticks advance', async () => {
    const f = fixture(); f.seed();
    json(f.tickFile, { lastTickDoneAt: iso(ADOPTED_AT + 1), pid: process.pid, head: f.probation.sha });
    const check = vi.fn(() => ({ status: 'fail', reason: 'outcome-red' }));
    registerOutcomeCheck('test-outcome', check);
    expect(await runProbationTick({ ...f.opts, now: () => ADOPTED_AT + 2 })).toMatchObject({ action: 'rolled-back', reason: 'outcome-red' });
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ root: f.root, env: f.env, probation: f.probation }));
    expect(f.opts.rollback).toHaveBeenCalledTimes(1);
  });

  it('outcome-check hook: throwing check stays pending despite advancing ticks', async () => {
    const f = fixture(); f.seed();
    json(f.tickFile, { lastTickDoneAt: iso(ADOPTED_AT + 1), pid: process.pid, head: f.probation.sha });
    registerOutcomeCheck('throws', () => { throw new Error('check unavailable'); });
    expect(await runProbationTick({ ...f.opts, now: () => ADOPTED_AT + 2 })).toEqual({ action: 'pending' });
    expect(f.opts.rollback).not.toHaveBeenCalled();
    expect(readProvenGood(f.root, f.env)).toEqual(f.good);
    expect(existsSync(f.probationFile)).toBe(true);
  });

  it.each([
    ['absent and matching', false, GOOD, true],
    ['absent and mismatching', false, OTHER, false],
    ['existing and matching', true, GOOD, false],
  ])('openProbation seeds provenGood only when absent and preAdopted.head === prevHead: %s', async (_label, existing, head, seeds) => {
    const f = fixture();
    if (existing) writeProvenGood(f.root, f.env, f.good);
    const preAdopted = { head, inputsKey: 'pre-adopted-inputs', mainSha: GOOD, applied: [] };
    await openProbation({ ...f.opts, ...f.probation, preAdopted, now: () => ADOPTED_AT });
    if (seeds) expect(readProvenGood(f.root, f.env)).toMatchObject({ ...preAdopted, seeded: true });
    else expect(readProvenGood(f.root, f.env)).toEqual(existing ? f.good : null);
    expect(readProbation(f.root, f.env)).toMatchObject({ sha: FAILED, inputsKey: 'failed-inputs', adoptedAt: iso(ADOPTED_AT) });
  });

  it('openProbation captures recent clone ticks, replaces old probation without proving it, and never seeds without preAdopted', async () => {
    const f = fixture();
    const oldTick = join(f.env.WE_DAEMON_STATE_DIR, `${cloneKeyOf(f.root)}.ticks.old.json`);
    json(f.tickFile, { lastTickDoneAt: iso(ADOPTED_AT - 100) });
    json(oldTick, { lastTickDoneAt: iso(ADOPTED_AT - 2 * WINDOW - 1) });
    json(join(f.env.WE_DAEMON_STATE_DIR, 'foreign.ticks.worker.json'), { lastTickDoneAt: iso(ADOPTED_AT - 100) });
    json(f.probationFile, { ...f.probation, sha: OTHER, inputsKey: 'superseded-inputs' });
    await openProbation({ ...f.opts, ...f.probation, now: () => ADOPTED_AT });
    expect(readProvenGood(f.root, f.env)).toBeNull();
    expect(readProbation(f.root, f.env)).toMatchObject({
      sha: FAILED, inputsKey: 'failed-inputs', probationMs: WINDOW,
      baseline: { [basename(f.tickFile)]: iso(ADOPTED_AT - 100) },
    });
    expect(Object.keys(readProbation(f.root, f.env).baseline)).toEqual([basename(f.tickFile)]);
  });

  it('request refuses superseded HEAD; apply already at target records rejection under the write lock', async () => {
    const f = fixture(); const repo = realRepo(f);
    const before = readRebuildState(f.root, f.env);
    expect(await requestRollback({ ...f.opts, run: repo.run, expectSha: OTHER })).toMatchObject({ superseded: true, head: repo.failed });
    expect(repo.git(['rev-parse', 'HEAD'])).toBe(repo.failed);
    expect(readRebuildState(f.root, f.env)).toEqual(before);
    repo.git(['reset', '--hard', repo.good]);
    expect(await requestRollback({ ...f.opts, run: repo.run, expectSha: repo.good })).toMatchObject({ ok: true, requested: true });
    expect(await applyPendingRollback({ ...f.opts, run: repo.run })).toMatchObject({ ok: true });
    expect(withWriteLock).toHaveBeenCalledTimes(1);
    expect(readRebuildState(f.root, f.env).rejected.inputsKey).toBe('failed-inputs');
    expect(existsSync(f.markerFile)).toBe(false);
    expect(repo.git(['rev-parse', 'HEAD'])).toBe(repo.good);
  });

  it('armProbationWatch returns immediately without awaiting rollback and calls onRolledBack after failed probation', async () => {
    vi.useFakeTimers();
    const f = fixture(); f.seed();
    let finish;
    const rollback = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const onRolledBack = vi.fn();
    const options = { ...f.opts, rollback, onRolledBack, intervalMs: 10 };
    const returned = armProbationWatch(options);
    expect(returned?.then).toBeUndefined();
    armProbationWatch(options); // same root must not create another boot/watch
    await vi.advanceTimersByTimeAsync(0);
    expect(readProbation(f.root, f.env).boots).toBe(1);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(onRolledBack).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledWith('no-tick-progress', {});
    finish({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(onRolledBack).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('armProbationWatch retries a transient rollback failure on the next tick and stops after success', async () => {
    vi.useFakeTimers();
    const f = fixture(); f.seed();
    const rollback = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: 'tick-in-progress' })
      .mockResolvedValue({ ok: true });
    const onRolledBack = vi.fn();
    const options = { ...f.opts, rollback, onRolledBack, intervalMs: 10 };
    armProbationWatch(options);
    await vi.advanceTimersByTimeAsync(0);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(onRolledBack).not.toHaveBeenCalled();
    expect(readProbation(f.root, f.env).boots).toBe(1);
    armProbationWatch(options); // failure must retain the existing watch
    await vi.advanceTimersByTimeAsync(9);
    expect(rollback).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(rollback).toHaveBeenCalledTimes(2);
    expect(rollback).toHaveBeenLastCalledWith('no-tick-progress', {});
    expect(onRolledBack).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(rollback).toHaveBeenCalledTimes(2);
    expect(onRolledBack).toHaveBeenCalledTimes(1);
  });

  it('armProbationWatch keeps monitoring replacement probation after an older outcome probe is superseded', async () => {
    vi.useFakeTimers();
    const f = fixture(); f.seed();
    let releaseCheck;
    let head = FAILED;
    const check = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { releaseCheck = resolve; }))
      .mockReturnValue({ status: 'ok' });
    registerOutcomeCheck('paused-probe', check);
    const onRolledBack = vi.fn();
    const options = { ...f.opts, readHead: () => head,
      now: () => ADOPTED_AT + 2 * WINDOW + 2, onRolledBack, intervalMs: 10 };
    armProbationWatch(options);
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(1);

    openProbation({ ...f.opts, ...f.probation, sha: OTHER, prevHead: FAILED,
      inputsKey: 'replacement-inputs', now: () => ADOPTED_AT + 1 });
    head = OTHER;
    armProbationWatch(options);
    releaseCheck({ status: 'fail', reason: 'stale-outcome' });
    await vi.advanceTimersByTimeAsync(0);
    expect(readProbation(f.root, f.env).sha).toBe(OTHER);
    expect(f.opts.rollback).not.toHaveBeenCalled();
    expect(onRolledBack).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10);
    expect(check).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenLastCalledWith(expect.objectContaining({
      probation: expect.objectContaining({ sha: OTHER, inputsKey: 'replacement-inputs' }),
    }));
    expect(f.opts.rollback).toHaveBeenCalledTimes(1);
    expect(f.opts.rollback).toHaveBeenCalledWith('never-booted', {});
    expect(onRolledBack).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.opts.rollback).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing pid', { head: FAILED }], ['missing head', { pid: process.pid }],
    ['old SHA', { pid: process.pid, head: GOOD }],
    ['sibling PID', { pid: process.pid + 1, head: FAILED }],
    ['adopter PID', { pid: process.pid + 2, head: FAILED }],
  ])('tick provenance refuses %s', async (_label, record) => {
    const f = fixture(); f.seed();
    json(f.probationFile, { ...f.probation, adopterPid: process.pid + 2 });
    json(f.tickFile, { lastTickDoneAt: iso(ADOPTED_AT + 1), ...record });
    expect(await runProbationTick({ ...f.opts, now: () => ADOPTED_AT + 2 })).toEqual({ action: 'pending' });
    expect(readProvenGood(f.root, f.env)).toEqual(f.good);
  });

  it('one matching boot tick proves liveness despite a stale baseline entry', async () => {
    const f = fixture(); f.seed();
    json(f.probationFile, { ...f.probation, baseline: { ...f.probation.baseline, stale: iso(ADOPTED_AT - 1) } });
    json(f.tickFile, { pid: process.pid, head: FAILED, lastTickDoneAt: iso(ADOPTED_AT + 1) });
    expect(await runProbationTick({ ...f.opts, now: () => ADOPTED_AT + 2 })).toEqual({ action: 'passed' });
  });

  it('ticks over 60 seconds in the future never prove liveness', async () => {
    const f = fixture(); f.seed();
    json(f.tickFile, { pid: process.pid, head: FAILED, lastTickDoneAt: iso(ADOPTED_AT + 60_003) });
    expect(await runProbationTick({ ...f.opts, now: () => ADOPTED_AT + 2 })).toEqual({ action: 'pending' });
  });

  it('legacy unbooted probation stays readable and gets a never-booted absolute cap', async () => {
    const f = fixture(); f.seed();
    const { bootPid, bootedAt, ...legacy } = f.probation;
    json(f.probationFile, legacy);
    expect(readProbation(f.root, f.env)).toEqual(legacy);
    json(f.tickFile, { pid: process.pid, head: FAILED, lastTickDoneAt: iso(ADOPTED_AT + 1) });
    expect(await runProbationTick(f.opts)).toEqual({ action: 'pending' });
    expect(await runProbationTick({ ...f.opts, now: () => ADOPTED_AT + 2 * WINDOW + 1 }))
      .toEqual({ action: 'rolled-back', reason: 'never-booted' });
  });

  it('boot deadline starts at bootedAt but cannot exceed twice the adoption window', () => {
    const f = fixture();
    const probation = { ...f.probation, bootedAt: iso(ADOPTED_AT + WINDOW) };
    expect(evaluateProbation({ probation, head: FAILED, now: ADOPTED_AT + WINDOW + 1 })).toEqual({ action: 'pending' });
    expect(evaluateProbation({ probation, head: FAILED, now: ADOPTED_AT + 2 * WINDOW + 1 }))
      .toEqual({ action: 'fail', reason: 'no-tick-progress' });
  });

  it('observer fails booted probation beyond the adoption cap even with a recent boot and tick', async () => {
    const f = fixture(); f.seed();
    json(f.probationFile, { ...f.probation, bootedAt: iso(ADOPTED_AT + 2 * WINDOW) });
    json(f.tickFile, { pid: process.pid, head: FAILED, lastTickDoneAt: iso(ADOPTED_AT + 2 * WINDOW + 1) });
    expect(await runProbationTick({ ...f.opts, observeOnly: true, now: () => ADOPTED_AT + 2 * WINDOW }))
      .toEqual({ action: 'pending' });
    expect(f.opts.rollback).not.toHaveBeenCalled();
    expect(await runProbationTick({ ...f.opts, observeOnly: true, now: () => ADOPTED_AT + 2 * WINDOW + 2 }))
      .toEqual({ action: 'rolled-back', reason: 'no-tick-progress' });
    expect(f.opts.rollback).toHaveBeenCalledWith('no-tick-progress', {});
  });

  it('watch records the boot PID and first boot time without replacing an existing time', async () => {
    vi.useFakeTimers();
    const f = fixture(); f.seed();
    const { bootPid, bootedAt, ...legacy } = f.probation;
    json(f.probationFile, legacy);
    armProbationWatch({ ...f.opts, now: () => ADOPTED_AT + 10 });
    expect(readProbation(f.root, f.env)).toMatchObject({ bootPid: process.pid, bootedAt: iso(ADOPTED_AT), boots: 1 });
    const g = fixture(); g.seed();
    json(g.probationFile, { ...g.probation, bootPid: process.pid + 1 });
    armProbationWatch({ ...g.opts, now: () => ADOPTED_AT + 20 });
    expect(readProbation(g.root, g.env)).toMatchObject({ bootedAt: iso(ADOPTED_AT), bootPid: process.pid });
    await vi.advanceTimersByTimeAsync(0);
  });

  it.each(['old', 'wrong-head', 'unresolved', 'unreadable', 'unknown-start'])('watch refuses boot evidence from %s process and observes only', async kind => {
    vi.useFakeTimers();
    const f = fixture(); f.seed();
    const { bootPid, bootedAt, ...legacy } = f.probation;
    json(f.probationFile, legacy);
    const check = vi.fn(() => ({ status: 'ok' })); registerOutcomeCheck('boot-proof', check);
    const readHead = () => {
      if (kind === 'unreadable') throw new Error('HEAD unavailable');
      return kind === 'wrong-head' ? OTHER : kind === 'unresolved' ? null : FAILED;
    };
    armProbationWatch({ ...f.opts, processStartMs: kind === 'old' ? ADOPTED_AT - 1001 : kind === 'unknown-start' ? NaN : ADOPTED_AT,
      readHead, now: () => ADOPTED_AT + 10, onRolledBack: vi.fn() });
    expect(readProbation(f.root, f.env)).toEqual(legacy);
    await vi.advanceTimersByTimeAsync(0);
    expect(check).not.toHaveBeenCalled();
  });

  it.each([1, 1000])('watch refuses a process started %s ms before adoption with the default Git HEAD probe', earlyMs => {
    vi.useFakeTimers();
    const f = fixture(); const repo = realRepo(f);
    const { bootPid, bootedAt, ...legacy } = f.probation;
    json(f.probationFile, legacy);
    armProbationWatch({ ...f.opts, run: repo.run, readHead: undefined, processStartMs: ADOPTED_AT - earlyMs });
    expect(readProbation(f.root, f.env)).toEqual(legacy);
  });

  it('watch records a process start at or after adoption rather than watch-arm time', () => {
    vi.useFakeTimers();
    for (const start of [ADOPTED_AT + 5, ADOPTED_AT]) {
      const f = fixture(); f.seed();
      const { bootPid, bootedAt, ...legacy } = f.probation;
      json(f.probationFile, legacy);
      armProbationWatch({ ...f.opts, processStartMs: start, now: () => ADOPTED_AT + 20 });
      expect(readProbation(f.root, f.env)).toMatchObject({
        bootPid: process.pid, bootedAt: iso(start), boots: 1,
      });
    }
  });

  it('observer never boots, probes outcomes or proves ticks, and rolls back only after the never-booted cap', async () => {
    vi.useFakeTimers();
    const f = fixture(); f.seed();
    const { bootPid, bootedAt, ...legacy } = f.probation;
    json(f.probationFile, legacy);
    json(f.tickFile, { pid: process.pid, head: FAILED, lastTickDoneAt: iso(ADOPTED_AT + 1) });
    const check = vi.fn(() => ({ status: 'fail' })); registerOutcomeCheck('observer', check);
    let at = ADOPTED_AT + WINDOW + 1;
    armProbationWatch({ ...f.opts, observeOnly: true, now: () => at, intervalMs: 10, onRolledBack: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(readProbation(f.root, f.env)).toEqual(legacy);
    expect(f.opts.rollback).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled();
    at = ADOPTED_AT + 2 * WINDOW + 1;
    await vi.advanceTimersByTimeAsync(10);
    expect(f.opts.rollback).toHaveBeenCalledWith('never-booted', {});
  });

  it.each(['listed', 'unresolved'])('unverified %s tree cannot pass, seed, or be a rollback target', async kind => {
    const f = fixture(); const repo = realRepo(f);
    const trees = [repo.git(['rev-parse', `${repo.failed}^{tree}`]), repo.git(['rev-parse', `${repo.good}^{tree}`])];
    writeRebuildState(f.root, { ...readRebuildState(f.root, f.env), forceUnverifiedTrees: trees }, f.env);
    const run = kind === 'unresolved' ? (args, opts) => args.some(a => a.endsWith('^{tree}')) ? { status: 1 } : repo.run(args, opts) : repo.run;
    const rollback = await requestRollback({ ...f.opts, run });
    expect(rollback).toEqual({ ok: false, reason: 'proven-good-unverified' });
    expect(repo.git(['rev-parse', 'HEAD'])).toBe(repo.failed);
    expect(readFileSync(alertsFilePath(f.root, f.env), 'utf8')).toContain('probation-needs-you');
    rmSync(f.provenFile);
    expect(openProbation({ ...f.opts, ...f.probation, run, preAdopted: f.good, now: () => ADOPTED_AT })).toBe(true);
    expect(readProvenGood(f.root, f.env)).toBeNull();
    json(f.probationFile, f.probation);
    json(f.tickFile, { pid: process.pid, head: repo.failed, lastTickDoneAt: iso(ADOPTED_AT + 1) });
    expect(await runProbationTick({ ...f.opts, run, readHead: () => repo.failed, now: () => ADOPTED_AT + 2 }))
      .toEqual({ action: 'passed-unverified' });
    expect(existsSync(f.probationFile)).toBe(false);
    expect(readProvenGood(f.root, f.env)).toBeNull(); expect(f.opts.emit).not.toHaveBeenCalled();
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

  it('a late matching tick cannot override either boot or adoption expiry', () => {
    const f = fixture();
    for (const bootedAt of [iso(ADOPTED_AT), iso(ADOPTED_AT + 2 * WINDOW)]) {
      expect(evaluateProbation({ probation: { ...f.probation, bootedAt }, head: FAILED,
        now: ADOPTED_AT + 2 * WINDOW + 2,
        tickNow: { worker: { pid: process.pid, head: FAILED, lastTickDoneAt: iso(ADOPTED_AT + 2 * WINDOW + 1) } },
      })).toEqual({ action: 'fail', reason: 'no-tick-progress' });
    }
  });

  it('an existing watch switches to observer mode when this process adopts a replacement', async () => {
    vi.useFakeTimers();
    const f = fixture(); f.seed();
    let at = ADOPTED_AT + 10;
    const options = { ...f.opts, now: () => at, intervalMs: 10, onRolledBack: vi.fn() };
    armProbationWatch(options);
    await vi.advanceTimersByTimeAsync(0);
    openProbation({ ...f.opts, ...f.probation, now: () => ADOPTED_AT + 20 });
    const check = vi.fn(() => ({ status: 'fail' })); registerOutcomeCheck('replacement-observer', check);
    armProbationWatch({ ...options, observeOnly: true });
    at = ADOPTED_AT + 30;
    await vi.advanceTimersByTimeAsync(10);
    expect(check).not.toHaveBeenCalled();
    expect(readProbation(f.root, f.env)).not.toHaveProperty('bootPid');
    expect(f.opts.rollback).not.toHaveBeenCalled();
    at = ADOPTED_AT + 20 + 2 * WINDOW + 1;
    await vi.advanceTimersByTimeAsync(10);
    expect(f.opts.rollback).toHaveBeenCalledWith('never-booted', {});
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
    expect(existsSync(f.probationFile)).toBe(false);
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

  it.each(['missing', 'corrupt'])('reads fail closed to null for %s persisted probation and provenGood', kind => {
    const f = fixture();
    if (kind === 'corrupt') {
      mkdirSync(f.env.WE_DAEMON_STATE_DIR, { recursive: true });
      writeFileSync(f.probationFile, '{broken');
      writeFileSync(f.provenFile, '{broken');
    }
    expect(readProbation(f.root, f.env)).toBeNull();
    expect(readProvenGood(f.root, f.env)).toBeNull();
  });

  it('unreadable HEAD stays pending before deadline and fails after it rather than superseding', () => {
    const f = fixture();
    expect(evaluateProbation({ probation: f.probation, head: null, now: ADOPTED_AT + 1, tickNow: {} })).toMatchObject({ action: 'pending' });
    expect(evaluateProbation({ probation: f.probation, head: null, now: ADOPTED_AT + WINDOW + 1, tickNow: {} })).toMatchObject({ action: 'fail' });
  });

  it('probationMsOf accepts positive integers and defaults on invalid bounds', () => {
    expect(PROBATION_MS_DEFAULT).toBe(900_000);
    expect(probationMsOf({ WE_DAEMON_PROBATION_MS: '25' })).toBe(25);
    for (const value of [undefined, '', '0', '-1', '1.5', 'NaN', 'Infinity']) {
      expect(probationMsOf({ WE_DAEMON_PROBATION_MS: value })).toBe(PROBATION_MS_DEFAULT);
    }
  });
});
