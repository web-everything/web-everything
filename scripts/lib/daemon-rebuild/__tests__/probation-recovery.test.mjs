// Recovery regressions retained from earlier PR rounds; only fixture identity follows S2a.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  requestRollback, applyPendingRollback, readProvenGood, writeProvenGood,
} from '../probation.mjs';
import { acquireRead, releaseRead, inspectCloneLock, withWriteLock } from '../../daemon-clone-lock.mjs';
import { finalizeRebuild } from '../adopt.mjs';
import { withSelfSync } from '../../daemon-self-sync.mjs';

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

describe('boot rollback send-back regressions (injected Git)', () => {
  function pending(f) {
    f.seed();
    rmSync(f.probationFile);
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
    expect(await fresh.wrapped.tickOnce()).toBe('failed-build-ticked');
    expect(fresh.onRestart).not.toHaveBeenCalled();
    expect(fresh.tick).toHaveBeenCalledTimes(1);
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
      // The lock-time marker check has passed and reset has completed. An external
      // edit can still corrupt recovery evidence while finalization awaits IO.
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
