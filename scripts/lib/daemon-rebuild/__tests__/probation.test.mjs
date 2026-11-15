import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  PROBATION_MS_DEFAULT, PROBATION_MAX_BOOTS, probationMsOf,
  readProvenGood, writeProvenGood, readProbation, openProbation,
  evaluateProbation, registerOutcomeCheck, clearOutcomeChecks,
  rollbackToProvenGood, runProbationTick, armProbationWatch,
} from '../probation.mjs';
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

beforeEach(() => clearOutcomeChecks());
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
    adoptedAt: iso(ADOPTED_AT), probationMs: WINDOW,
    baseline: { [basename(tickFile)]: iso(ADOPTED_AT - 100) }, boots: 0, version: 1,
  };
  const run = vi.fn(() => { throw new Error('Unexpected Git IO in injected fixture'); });
  const rollback = vi.fn(async () => ({ ok: true }));
  const emit = vi.fn();
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() };
  const opts = {
    root, env, stateOpts: { env }, log, run, rollback, emit,
    now: () => ADOPTED_AT + WINDOW + 1, readHead: () => FAILED,
  };
  return {
    base, root, env, good, probation, probationFile, provenFile, tickFile, opts,
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

  it('tick stops advancing within probationMs after adopt: real rollbackToProvenGood resets HEAD and rejects the failed inputsKey', async () => {
    const f = fixture();
    const repo = realRepo(f);
    writeReadyCandidate(f.root, { prevHead: repo.failed, adopt: { finalSha: repo.failed } }, f.env);
    const rollback = vi.fn(reason => rollbackToProvenGood({
      ...f.opts, run: repo.run, expectSha: repo.failed, reason,
    }));
    const result = await runProbationTick({ ...f.opts, run: repo.run, readHead: () => repo.git(['rev-parse', 'HEAD']), rollback });
    expect(result).toMatchObject({ action: 'rolled-back', reason: 'no-tick-progress' });
    expect(rollback).toHaveBeenCalledTimes(1);
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

  it('healthy tick after adoptedAt writes provenGood from the probation record and removes probation', async () => {
    const f = fixture(); f.seed();
    json(f.tickFile, { lastTickDoneAt: iso(ADOPTED_AT + 1) });
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
    expect(await rollbackToProvenGood({ ...f.opts, run: repo.run, expectSha: repo.failed })).toMatchObject({ ok: true });
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
    const result = await rollbackToProvenGood({ ...f.opts, run: repo.run, expectSha: repo.failed });
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
    json(f.tickFile, { lastTickDoneAt: iso(ADOPTED_AT + 1) });
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

  it('every baseline tick must advance; a healthy sibling cannot hide a stalled worker', async () => {
    const f = fixture(); f.seed();
    const sibling = join(f.env.WE_DAEMON_STATE_DIR, `${cloneKeyOf(f.root)}.ticks.sibling.json`);
    json(f.probationFile, { ...f.probation, baseline: {
      ...f.probation.baseline, [basename(sibling)]: iso(ADOPTED_AT - 100),
    } });
    json(sibling, { lastTickDoneAt: iso(ADOPTED_AT + 1) });
    expect(await runProbationTick(f.opts)).toMatchObject({ action: 'rolled-back', reason: 'no-tick-progress' });
  });

  it('empty baseline passes only when a tick of this clone advances past adoption', async () => {
    const f = fixture(); f.seed();
    json(f.probationFile, { ...f.probation, baseline: {} });
    json(join(f.env.WE_DAEMON_STATE_DIR, 'foreign-clone.ticks.worker.json'), { lastTickDoneAt: iso(ADOPTED_AT + 1) });
    expect(await runProbationTick({ ...f.opts, now: () => ADOPTED_AT + 2 })).toEqual({ action: 'pending' });
    json(f.tickFile, { lastTickDoneAt: iso(ADOPTED_AT + 1) });
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
    json(f.tickFile, { lastTickDoneAt: iso(ADOPTED_AT + 1) });
    const check = vi.fn(() => ({ status: 'fail', reason: 'outcome-red' }));
    registerOutcomeCheck('test-outcome', check);
    expect(await runProbationTick({ ...f.opts, now: () => ADOPTED_AT + 2 })).toMatchObject({ action: 'rolled-back', reason: 'outcome-red' });
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ root: f.root, env: f.env, probation: f.probation }));
    expect(f.opts.rollback).toHaveBeenCalledTimes(1);
  });

  it('outcome-check hook: throwing check stays pending despite advancing ticks', async () => {
    const f = fixture(); f.seed();
    json(f.tickFile, { lastTickDoneAt: iso(ADOPTED_AT + 1) });
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

  it('rollback refuses when HEAD !== expectSha and treats HEAD === provenGood.head as already', async () => {
    const f = fixture(); const repo = realRepo(f);
    const before = readRebuildState(f.root, f.env);
    expect(await rollbackToProvenGood({ ...f.opts, run: repo.run, expectSha: OTHER })).toMatchObject({ superseded: true, head: repo.failed });
    expect(repo.git(['rev-parse', 'HEAD'])).toBe(repo.failed);
    expect(readRebuildState(f.root, f.env)).toEqual(before);
    repo.git(['reset', '--hard', repo.good]);
    expect(await rollbackToProvenGood({ ...f.opts, run: repo.run, expectSha: repo.good })).toMatchObject({ ok: true, already: true });
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
    // The watch must exempt its own reader from the rollback's write lock.
    expect(JSON.stringify(rollback.mock.calls)).toContain(`${hostname()}:${process.pid}`);
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
    expect(rollback).toHaveBeenLastCalledWith('no-tick-progress', {
      ignoreOwners: [`${hostname()}:${process.pid}`],
    });
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
      now: () => ADOPTED_AT + WINDOW + 2, onRolledBack, intervalMs: 10 };
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
    expect(f.opts.rollback).toHaveBeenCalledWith('no-tick-progress', {
      ignoreOwners: [`${hostname()}:${process.pid}`],
    });
    expect(onRolledBack).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.opts.rollback).toHaveBeenCalledTimes(1);
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
