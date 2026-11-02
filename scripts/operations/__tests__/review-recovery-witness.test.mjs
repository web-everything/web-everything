// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, utimesSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pidNamespace, pidStartTime } from '../../lib/pid-alive.mjs';
import { withFileLock } from '../../lib/atomic-json-file.mjs';
import * as evidence from '../../lib/drain-red-team-evidence.mjs';
import * as recovery from '../../lib/review-red-team-on-skip.mjs';
import { createReviewJobIo, dispatchReviewJob, runReviewJob, runReviewJobCli } from '../review-job.mjs';
import { newRunRecord, resolveRunsDir } from '../run-store.mjs';
import { redTeamMarker } from '../../lib/red-team-gate.mjs';
import { runRedTeam, runExtraSeatsCli } from '../review-extra-seats.mjs';
import { resumeRedTeamCarry } from '../../lib/red-team-carry-machine.mjs';

const interruption = vi.hoisted(() => ({ boundary: null }));
// Keep process metadata deterministic even where the OS sandbox prohibits ps.
// Numeric PID liveness and all claim/status filesystem operations remain real.
vi.mock('../../lib/pid-alive.mjs', async importOriginal => {
  const pid = await importOriginal();
  return { ...pid, pidStartTime: owner => owner === process.pid ? 'fixture-current-start' : pid.pidStartTime(owner) };
});
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal();
  return { ...fs, openSync: (...args) => {
    const fd = fs.openSync(...args);
    if (String(args[0]).endsWith('.stale-redispatch-1') && interruption.boundary === 'after marker') {
      fs.closeSync(fd);
      throw Error('interrupted after marker creation');
    }
    return fd;
  } };
});
vi.mock('../../lib/atomic-json-file.mjs', async importOriginal => {
  const atomic = await importOriginal();
  return { ...atomic, writeJsonAtomic: (path, data, options) => {
    const kind = path.endsWith('.stale-redispatch-1') ? 'marker' : data?.staleAbandoned ? 'writer' : null;
    atomic.writeJsonAtomic(path, data, { ...options, renameSyncFn: (temporary, target) => {
      if (kind && interruption.boundary === `before ${kind}`) throw Error(`interrupted before ${kind} rename`);
      renameSync(temporary, target);
    } });
    if (kind && interruption.boundary === `after ${kind}`) throw Error(`interrupted after ${kind}`);
  } };
});

vi.mock('../../lib/red-team-status-labels.mjs', () => ({ syncRedTeamStatusLabels: vi.fn() }));
const dirs = [];
afterEach(() => { interruption.boundary = null; dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
const repo = 'web-everything/web-everything', pr = 7537, head = 'a'.repeat(40);
const payload = () => ({ verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head }, diffText: '+code', netChangedFiles: ['scripts/example.mjs'] } } });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture({ status = 'running', foreign = false, seats = [], ageMs } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'we-7537-')); dirs.push(dir);
  const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs'), WE_RED_TEAM_STALE_RUN_MS: '1000' };
  const key = { repo, pr, head, env }, path = join(evidence.redTeamStatusDir(env), `${encodeURIComponent(repo)}-${pr}-${head}.json`);
  mkdirSync(env.WE_SHARED_RUNS_DIR, { recursive: true }); mkdirSync(evidence.redTeamStatusDir(env), { recursive: true });
  writeFileSync(path, JSON.stringify({ repo, pr, head, status, result: null, pid: 99999999,
    host: foreign ? 'foreign' : hostname(), pidNamespace: pidNamespace(), pidStart: ageMs ? new Date(Date.now() - ageMs).toISOString() : '2020-01-01T00:00:00Z', loopPayload: { findings: {} } }));
  const run = join(env.WE_SHARED_RUNS_DIR, 'review-pr-7537.json');
  writeFileSync(run, JSON.stringify({ ...newRunRecord({ id: 'review-pr-7537', op: 'review-pr', input: { repo, pr } }), ...payload() }));
  const probe = { host: hostname(), namespace: pidNamespace(), isAlive: () => false, readPidStart: () => '2020-01-01T00:00:00Z' };
  const readWitness = () => evidence.readRecoveryWitness({ ...key, runsDir: env.WE_SHARED_RUNS_DIR, readScorecards: () => seats });
  const decide = () => recovery.planRedTeamRecovery(readWitness(), { now: Date.now(), probe, deadlineMs: 1000 });
  const abandon = () => recovery.abandonStaleRedTeamRun(key, { readWitness, probe, deadlineMs: 1000 });
  const io = createReviewJobIo({ env, root: dir, readWitness, recoveryProbe: probe });
  const admit = () => io.redTeamStatus({ repo, pr, loopPayload: readWitness().newest, status: 'queued', redTeamMode: seats.some(seat => seat.status === 'ok') ? 'resume' : 'fresh' });
  return { dir, env, key, path, run, seats, probe, readWitness, decide, abandon, io, admit };
}

it.each([null, undefined].flatMap(result => [undefined, 0].map(retryCount => ({ result, retryCount }))))(
  'dead queued writer with one failed seat cannot infer a retry (result=$result, retryCount=$retryCount)', ({ result, retryCount }) => {
    const f = fixture({ status: 'queued', seats: [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'unparseable' }] });
    writeFileSync(f.path, JSON.stringify({ ...f.readWitness().rawWriter.parsed, result, retryCount }));
    const before = readFileSync(f.path, 'utf8');
    expect(f.decide()).toMatchObject({ mode: 'skip', why: 'prior pass cannot restart' });
    expect(f.abandon().ok).toBe(false);
    expect(() => f.admit()).toThrow('prior pass cannot restart');
    expect(readFileSync(f.path, 'utf8')).toBe(before);
    expect(f.readWitness().markers).toEqual({ redispatch: null, retry: false });
  },
);

it.each([null, undefined].flatMap(result => [undefined, 0].map(retryCount => ({ result, retryCount }))))(
  'dead running writer with one failed seat recovers its one retry (result=$result, retryCount=$retryCount)', ({ result, retryCount }) => {
    const f = fixture({ seats: [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'unparseable' }] });
    const raw = { ...f.readWitness().rawWriter.parsed, result, retryCount };
    writeFileSync(f.path, JSON.stringify(raw));
    expect(f.decide()).toMatchObject({ mode: 'fresh', retry: true, abandon: true,
      executionPrior: { status: 'finished', result: 'failed' } });
    expect(f.readWitness().rawWriter.parsed.status).toBe('running');
    expect(f.abandon().ok).toBe(true);
    expect(f.admit().redTeamAdmission).toMatchObject({ prior: { status: 'finished', result: 'failed' },
      queued: { status: 'queued', retryCount: 1 } });
    expect(f.decide().mode).toBe('skip');
  },
);

it.each([
  { name: 'retry spent', retryCount: 1, failedSeatCount: 1, result: null },
  { name: 'two failed seats', failedSeatCount: 2, result: null },
  { name: 'comment posted', failedSeatCount: 1, result: { status: 'failed', comment: { status: 'posted' } } },
])('dead running writer still refuses with $name', ({ retryCount, failedSeatCount, result }) => {
  const f = fixture({ seats: Array.from({ length: failedSeatCount }, () =>
    ({ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'unparseable' })) });
  writeFileSync(f.path, JSON.stringify({ ...f.readWitness().rawWriter.parsed, retryCount, result }));
  expect(f.decide()).toMatchObject({ mode: 'skip', why: 'prior pass cannot restart' });
  expect(f.abandon().ok).toBe(false);
});

it('dead running writer with no seat keeps fresh recovery without a retry', () => {
  const f = fixture();
  expect(f.decide()).toMatchObject({ mode: 'fresh', retry: false, executionPrior: null, abandon: true });
});

it('default recovery witness reads the writer run store when OPERATION_RUNS_DIR overrides the shared store', () => {
  const f = fixture({ status: 'queued' });
  const canonical = join(f.dir, 'canonical', 'runs');
  mkdirSync(canonical, { recursive: true });
  f.env.OPERATION_RUNS_DIR = canonical;
  vi.stubEnv('OPERATION_RUNS_DIR', canonical);
  vi.stubEnv('WE_SHARED_RUNS_DIR', f.env.WE_SHARED_RUNS_DIR);
  try {
    const id = 'review-pr-7537-canonical';
    writeFileSync(join(resolveRunsDir(), `${id}.json`), JSON.stringify({
      ...newRunRecord({ id, op: 'review-pr', input: { repo, pr } }), ...payload(),
    }));
    rmSync(f.run);
    const readWitness = () => evidence.readRecoveryWitness({ ...f.key, readScorecards: () => [] });
    expect(readWitness().newest).toMatchObject({ id, verdict: { verdict: 'accept' } });
    expect(evidence.readRecoveryWitness({ repo, pr, head, readScorecards: () => [] }).newest).toMatchObject({ id });
    expect(recovery.planRedTeamRecovery(readWitness(), { probe: f.probe, deadlineMs: 1000 }))
      .toMatchObject({ mode: 'fresh', abandon: true });
    expect(recovery.abandonStaleRedTeamRun(f.key, { readWitness, probe: f.probe, deadlineMs: 1000 }).ok).toBe(true);
    const io = createReviewJobIo({ env: f.env, root: f.dir, readWitness, recoveryProbe: f.probe });
    expect(io.redTeamStatus({ repo, pr, loopPayload: readWitness().newest, status: 'queued', redTeamMode: 'fresh' }))
      .toHaveProperty('redTeamAdmission.queued.status', 'queued');
    expect(evidence.readRecoveryWitness({ ...f.key, runsDir: f.env.WE_SHARED_RUNS_DIR, readScorecards: () => [] }).newest).toBeNull();
  } finally { vi.unstubAllEnvs(); }
});

it.each([undefined, '', ' \t '])('recovery falls back to the shared store for an inactive OPERATION_RUNS_DIR (%j)', override => {
  const f = fixture();
  const env = { ...f.env, OPERATION_RUNS_DIR: override };
  expect(evidence.readRecoveryWitness({ ...f.key, env, readScorecards: () => [] }).newest)
    .toMatchObject({ id: 'review-pr-7537' });
});

it('recovery trims the operation run directory override', () => {
  const f = fixture();
  const env = { ...f.env, OPERATION_RUNS_DIR: ` \t${f.env.WE_SHARED_RUNS_DIR} \t`, WE_SHARED_RUNS_DIR: join(f.dir, 'empty') };
  expect(evidence.readRecoveryWitness({ ...f.key, env, readScorecards: () => [] }).newest)
    .toMatchObject({ id: 'review-pr-7537' });
});

it.each([[1, true], [2, true], [4, false], [5, false], [8, false], [9, false]])('matrix %s: raw dead writer is abandoned then admitted (foreign=%s)', (row, foreign) => {
  const f = fixture({ foreign, ageMs: foreign ? 2000 : undefined, status: row === 9 ? 'queued' : 'running' });
  const w = f.readWitness();
  expect(w.rawWriter.sha256).toBe(hash(readFileSync(f.path)));
  expect(f.decide()).toMatchObject({ mode: 'fresh', abandon: true, executionPrior: null });
  expect(f.decide()).not.toHaveProperty('status');
  expect(f.abandon().ok).toBe(true);
  if (row === 5) { const sameSecond = new Date(Math.floor(Date.now() / 1000) * 1000); utimesSync(f.path, sameSecond, sameSecond); utimesSync(`${f.path}.stale-redispatch-1`, sameSecond, sameSecond); }
  const admission = f.admit().redTeamAdmission;
  expect(admission).toMatchObject({ schema: 1, prior: null });
  expect(evidence.decodeRecoveryAdmission(JSON.stringify(admission))).toEqual(admission);
  expect(f.abandon().ok).toBe(false); // one re-dispatch, including a same-second replacement
});
it.each([10, 12, 'status rewritten', 'marker removed', 'seat appended'])('B / matrix %s: choke-point mutation refuses without a write or provider', mutation => {
  const f = fixture(); expect(f.abandon().ok).toBe(true);
  if (mutation === 10) {
    const original = readFileSync(f.run, 'utf8'), at = statSync(f.run).mtimeMs;
    const older = join(f.env.WE_SHARED_RUNS_DIR, 'review-pr-7537-older-accept.json');
    const newer = join(f.env.WE_SHARED_RUNS_DIR, 'review-pr-7537-newer-reject.json');
    writeFileSync(older, JSON.stringify({ ...newRunRecord({ id: 'review-pr-7537-older-accept', op: 'review-pr', input: { repo, pr } }), ...payload() }));
    utimesSync(older, new Date(at - 2000), new Date(at - 2000));
    writeFileSync(newer, JSON.stringify({ ...newRunRecord({ id: 'review-pr-7537-newer-reject', op: 'review-pr', input: { repo, pr } }), ...payload(), verdict: { verdict: 'reject' } }));
    utimesSync(newer, new Date(at + 2000), new Date(at + 2000));
    expect(readFileSync(f.run, 'utf8')).toBe(original);
    expect(f.readWitness().newest).toMatchObject({ id: 'review-pr-7537-newer-reject', verdict: { verdict: 'reject' } });
  }
  if (mutation === 12) f.probe.isAlive = () => true;
  if (mutation === 'status rewritten') writeFileSync(f.path, readFileSync(f.path, 'utf8') + ' ');
  if (mutation === 'marker removed') rmSync(`${f.path}.stale-redispatch-1`);
  if (mutation === 'seat appended') f.seats.push({ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head });
  const before = readFileSync(f.path, 'utf8'), provider = vi.fn();
  expect(() => { const admission = f.admit(); provider(admission); }).toThrow();
  expect(readFileSync(f.path, 'utf8')).toBe(before); expect(provider).not.toHaveBeenCalled();
  expect(f.decide().mode).toBe('skip');
  expect(recovery.planRedTeamOnSkip({ repo, refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }],
    rawPrs: [{ number: pr, headRefOid: head, comments: [] }], readWitness: f.readWitness, readEvidence: () => { throw Error('unexpected legacy reader'); },
    setting: { enabled: true, retryCooldownMin: 0 }, lastDispatch: new Map(),
    recoveryOptions: { now: Date.now(), probe: f.probe, deadlineMs: 1000 } })[0].action).toBe('skip');
});
it('matrix 14: live local owner is in flight even past deadline', () => {
  const f = fixture(); f.probe.isAlive = () => true; f.probe.readPidStart = () => '2020-01-01T00:00:00Z';
  expect(f.decide().mode).toBe('skip');
});
it('CAS refuses a changed raw digest without changing either file', () => {
  const f = fixture(), w = f.readWitness(); writeFileSync(f.path, readFileSync(f.path, 'utf8') + ' ');
  const before = readFileSync(f.path, 'utf8');
  expect(() => evidence.recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'queued' }, { env: f.env, expectedSha256: w.rawWriter.sha256 })).toThrow();
  expect(readFileSync(f.path, 'utf8')).toBe(before);
});
it('A1 / matrix 11: --pr --repo --prefer-lane --red-team-only round-trip; removed --red-team-plan refuses', () => {
  const f = fixture(), spawnJob = vi.fn(() => 123);
  dispatchReviewJob({ pr, repo, root: f.dir, dir: join(f.dir, 'jobs'), redTeamOnly: true, redTeamMode: 'fresh', preferLane: 7,
    spawnJob, checkStaleness: () => ({ stale: false }), readCompletion: () => null, resolveSettingsEnv: () => ({}), checkoutExists: () => true });
  const argv = spawnJob.mock.calls[0][0].argv.slice(1), runJob = vi.fn(() => ({}));
  expect(argv.some(a => a.startsWith('--red-team-plan'))).toBe(false);
  runReviewJobCli(argv, { runJob });
  expect(runJob).toHaveBeenCalledWith({ pr: String(pr), repo, preferLane: 7, redTeamOnly: true, redTeamMode: 'fresh' });
  runJob.mockClear(); runReviewJobCli([...argv, '--red-team-plan={}'], { runJob });
  expect(runJob).not.toHaveBeenCalled(); process.exitCode = 0;
});
// Drive daemon -> job -> queued CAS -> runner -> finished status across two ticks.
it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('A3 / matrix %s: persisted dead job settles by tick two', row => {
  const seats = [6, 7].includes(row) ? [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'ok', findings: [] }] : [];
  const f = fixture({ status: row === 9 ? 'queued' : 'running', foreign: [1, 2, 3].includes(row), ageMs: [1, 2, 3].includes(row) ? 2000 : undefined, seats });
  if (row === 6) expect(f.decide()).toMatchObject({ mode: 'resume', executionPrior: { status: 'finished', result: 'ran' } });
  const comments = [], paid = vi.fn(); let attempt = 0;
  const runner = vi.fn(input => {
    attempt++;
    if (row === 3 && attempt === 1) return { status: 'skipped', deferredByCap: true };
    if (row === 7) return { status: 'not-owed', deferredByGuard: true };
    if (input.redTeamMode === 'fresh') paid();
    comments.push({ body: redTeamMarker(pr, head), author: { login: 'web-everything' } });
    return { status: input.redTeamMode === 'resume' ? 'resumed' : 'ran', findings: [], comment: { status: 'posted' } };
  });
  const io = { root: f.dir, now: Date.now, newActorId: () => 'fixture', readPrevCompletion: () => null,
    claim: () => ({ ok: true }), updateRecord: vi.fn(), unclaim: vi.fn(), acquireLane: () => ({ lanePath: f.dir }),
    releaseLane: vi.fn(), report: vi.fn(), log: vi.fn(), prepareLane: () => ({ head }), fetchRedTeamHead: () => ({ head }),
    readRedTeamOnlyPayload: f.io.readRedTeamOnlyPayload, redTeamStatus: f.io.redTeamStatus,
    clearRedTeamQueued: f.io.clearRedTeamQueued, runRedTeam: runner };
  const tick = () => recovery.runRedTeamOnSkip({ repo, env: f.env,
    plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
    rawPrs: [{ number: pr, headRefOid: head, comments, labels: [] }], readWitness: f.readWitness,
    readEvidence: () => ({ loopPayload: f.readWitness().newest, recorded: comments.length > 0, inFlight: false, completedRecorded: seats.length > 0 }),
    readStatus: () => evidence.readRedTeamStatus(f.key), abandon: f.abandon,
    setting: { enabled: true, retryCooldownMin: 0 }, lastDispatch: new Map(), capacity: { lanes: 1 },
    dispatch: options => { runReviewJob(options, io); return { jobPid: 123 }; } });
  expect(tick().dispatched).toHaveLength(1);
  if (row === 3) {
    expect(f.readWitness().rawWriter.parsed.staleAbandoned).toBeTruthy();
    expect(tick().dispatched).toHaveLength(1);
  } else if (row !== 7) expect(tick().dispatched).toHaveLength(0);
  const stored = f.readWitness().rawWriter.parsed;
  expect(stored.status).toBe('finished');
  expect(stored.result).toBe([6, 7].includes(row) ? row === 6 ? 'resumed' : 'ran' : 'ran');
  expect(paid).toHaveBeenCalledTimes([6, 7].includes(row) ? 0 : 1);
  if (row === 7) expect(stored.result).toBe('ran');
  if (row !== 7) expect(comments).toHaveLength(1);
});
it('A4: every job CLI flag is named', () => {
  const source = readFileSync(new URL('../review-job.mjs', import.meta.url), 'utf8');
  const tests = readFileSync(new URL('./review-recovery-witness.test.mjs', import.meta.url), 'utf8');
  for (const [, flag] of source.matchAll(/flag\('([^']+)'\)/g)) expect(tests).toContain(`--${flag}`);
});

it.each([false, true])('C: production payload preserves carry conflict unless an exact-head panel exists (exact=%s)', exact => {
  const f = fixture();
  expect(() => resumeRedTeamCarry({ repo, pr, head, loopPayload: { ...payload(), carriedFrom: 'b'.repeat(40) } }, {
    env: f.env, eligible: () => true, intentRecorded: () => false,
    recordIntent: () => { throw Error('stop after durable intent'); },
  })).toThrow('stop after durable intent');
  if (!exact) {
    const run = JSON.parse(readFileSync(f.run, 'utf8'));
    run.findings.read.netBasis.rev = 'c'.repeat(40);
    writeFileSync(f.run, JSON.stringify(run));
  }
  const io = createReviewJobIo({ env: f.env, root: f.dir, readSeatRecords: () => [] });
  const stored = io.readRedTeamOnlyPayload({ repo, pr, head });
  if (exact) {
    expect(stored.carryConflict).toBeUndefined();
    expect(stored.loopPayload).toMatchObject({ id: 'review-pr-7537', findings: { read: { netBasis: { rev: head } } } });
  } else expect(stored).toMatchObject({ carryConflict: true, head });
});

it.each(['queued', 'running'].flatMap(status => [false, true].flatMap(completed =>
  ['before marker', 'after marker', 'before writer', 'after writer'].map(boundary => ({ status, completed, boundary })))))(
  'abandonment recovers after interruption at $boundary persistence boundary ($status, completed=$completed)', ({ status, completed, boundary }) => {
    const f = fixture({ status, seats: completed ? [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'ok' }] : [] });
    interruption.boundary = boundary;
    expect(f.abandon().ok).toBe(false);
    interruption.boundary = null;
    expect(f.abandon().ok).toBe(true);
    const provider = vi.fn();
    provider(f.admit());
    expect(f.abandon().ok).toBe(false);
    expect(() => f.admit()).toThrow();
    expect(provider).toHaveBeenCalledTimes(1);
  });

it('completed legacy abandonment bindings remain admissible', () => {
  const f = fixture();
  expect(f.abandon().ok).toBe(true);
  const { writer, evidence: boundEvidence } = f.readWitness().markers.redispatch;
  writeFileSync(`${f.path}.stale-redispatch-1`, JSON.stringify({ writer, evidence: boundEvidence }));
  expect(f.admit().redTeamAdmission.queued.status).toBe('queued');
});

it.each(['writer', 'evidence', 'marker writer', 'marker prior', 'marker abandonedAt', 'marker abandonedAt non-string'])('interrupted abandonment refuses changed %s', change => {
  const f = fixture();
  interruption.boundary = 'after marker';
  expect(f.abandon().ok).toBe(false);
  interruption.boundary = null;
  if (change === 'writer') writeFileSync(f.path, readFileSync(f.path, 'utf8') + ' ');
  if (change === 'evidence') f.seats.push({ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'ok' });
  if (change.startsWith('marker')) {
    const markerPath = `${f.path}.stale-redispatch-1`, marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (change === 'marker writer') marker.writer = 'changed';
    if (change === 'marker prior') marker.priorWriter = 'changed';
    if (change === 'marker abandonedAt') marker.abandonedAt = '2001-01-01T00:00:00.000Z';
    if (change === 'marker abandonedAt non-string') {
      marker.abandonedAt = 42;
      // Keep the digest consistent so only the timestamp type guard can refuse this intent.
      const next = { ...f.readWitness().rawWriter.parsed, staleAbandoned: { at: marker.abandonedAt } };
      marker.writer = hash(`${JSON.stringify(next, null, 2)}\n`);
    }
    writeFileSync(markerPath, JSON.stringify(marker));
  }
  const before = readFileSync(f.path, 'utf8');
  expect(f.abandon().ok).toBe(false);
  expect(() => f.admit()).toThrow();
  expect(readFileSync(f.path, 'utf8')).toBe(before);
});

it.each([
  ['pid mismatch', a => { a.queued.pid++; }],
  ['zero pid', a => { a.pid = a.queued.pid = 0; }],
  ['fractional pid', a => { a.pid = a.queued.pid = 1.5; }],
  ['string pid', a => { a.pid = a.queued.pid = '42'; }],
  ['zero pr', a => { a.queued.pr = 0; }],
  ['fractional pr', a => { a.queued.pr = 1.5; }],
  ['unsafe pr', a => { a.queued.pr = Number.MAX_SAFE_INTEGER + 1; }],
  ['short head', a => { a.queued.head = 'a'.repeat(39); }],
  ['nonhex head', a => { a.queued.head = 'g'.repeat(40); }],
  ['missing head', a => { delete a.queued.head; }],
  ['invalid repo', a => { a.queued.repo = 1; }],
  ['nonqueued writer', a => { a.queued.status = 'running'; }],
  ['missing prior', a => { delete a.prior; }],
])('admission codec isolates %s', (_name, invalidate) => {
  const admission = { schema: 1, pid: 42, prior: null, queued: { repo, pr, head, pid: 42, status: 'queued' } };
  expect(evidence.decodeRecoveryAdmission(JSON.stringify(admission))).toEqual(admission);
  invalidate(admission);
  expect(() => evidence.decodeRecoveryAdmission(JSON.stringify(admission))).toThrow('invalid recovery admission schema');
});

it.each([undefined, null, '', 42])('rollback refuses missing or invalid admission identity (%j) without writes', admissionId => {
  const f = fixture(), witness = f.readWitness(), before = readFileSync(f.path, 'utf8');
  expect(() => evidence.restoreRecoveryWriter(f.key, witness, admissionId)).toThrow('missing rollback admission identity');
  expect(readFileSync(f.path, 'utf8')).toBe(before);
});

it.each(['missing', 'corrupt', 'schema', 'mismatch', 'legacy', 'incomplete', 'null'])('A2: %s admission file refuses without write or provider call', async kind => {
  const f = fixture(), path = join(f.dir, 'admission.json');
  const queued = { repo, pr, head, status: 'queued', pid: 42, result: null };
  if (kind !== 'missing') writeFileSync(path, kind === 'corrupt' ? '{' : kind === 'null' ? 'null' : JSON.stringify({ schema: kind === 'legacy' ? undefined : kind === 'schema' ? 2 : 1, pid: 42, prior: null, queued: kind === 'incomplete' ? undefined : queued }));
  const provider = vi.fn(), write = vi.fn(), output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const before = readFileSync(f.path, 'utf8');
  try {
    await runExtraSeatsCli(['red-team', `--pr=${pr}`, `--repo=${repo}`, `--lane=${f.dir}`, `--loop-json=${f.run}`,
      '--red-team-mode=fresh', `--red-team-admission=${path}`], { redTeamIo: {
      readRecords: () => [], readRedTeamStatus: () => kind === 'mismatch' ? { ...queued, pid: 43 } : queued, cliAvailable: provider, redTeamStatus: write,
    } });
    const result = JSON.parse(output.mock.calls.at(-1)[0]);
    expect(result).toMatchObject({ status: 'not-owed', invalidAdmission: true });
    expect(readFileSync(f.path, 'utf8')).toBe(before); expect(provider).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  } finally { output.mockRestore(); }
});

it('matrix 13: newer review forbids restarting a completed adversarial pass', () => {
  const f = fixture({ seats: [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'ok' }] });
  evidence.recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'finished', result: { status: 'ran', comment: 'posted' } }, { env: f.env });
  writeFileSync(f.run, JSON.stringify({ ...newRunRecord({ id: 'review-pr-7537', op: 'review-pr', input: { repo, pr } }), ...payload() }));
  const before = readFileSync(f.path, 'utf8'), provider = vi.fn();
  expect(f.decide().mode).toBe('skip');
  expect(() => { provider(f.admit()); }).toThrow();
  expect(provider).not.toHaveBeenCalled(); expect(readFileSync(f.path, 'utf8')).toBe(before);
});
it.each(['null', '{'])('corrupt raw writer %s refuses, without repair writes', raw => {
  const f = fixture(); writeFileSync(f.path, raw);
  expect(() => f.admit()).toThrow(); expect(readFileSync(f.path, 'utf8')).toBe(raw);
});

it('an exclusive claim loser cannot trigger ordinary-job rollback over the winner', () => {
  const f = fixture(), before = readFileSync(f.path, 'utf8');
  writeFileSync(`${f.path}.retry-claim`, 'winner');
  expect(() => evidence.recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'queued' }, { env: f.env }))
    .toThrow(expect.objectContaining({ code: 'RED_TEAM_RETRY_ADMITTED' }));
  expect(readFileSync(f.path, 'utf8')).toBe(before);
  expect(readFileSync(`${f.path}.retry-claim`, 'utf8')).toBe('winner');
});

it.each(['99999999\n', '', 'legacy-claim'])('recovers a dead or incomplete stale status-write claim (%j)', owner => {
  const f = fixture(), claim = `${f.path}.retry-claim`;
  writeFileSync(claim, owner);
  const old = new Date(Date.now() - 60_000); utimesSync(claim, old, old);
  expect(f.abandon().ok).toBe(true);
  expect(f.admit().redTeamAdmission.queued.status).toBe('queued');
});

it.each(['recovery', 'queued', 'running', 'finished'])('reclaims a stale %s claim after its pid is reused', status => {
  const f = fixture(), claim = `${f.path}.retry-claim`;
  // The pid really exists; its birth time proves this claim belongs to an earlier process.
  writeFileSync(claim, `${process.pid}\n${JSON.stringify({ pid: process.pid, pidStart: 'an-earlier-process',
    host: hostname(), pidNamespace: pidNamespace() })}\n`);
  const old = new Date(Date.now() - 86_400_000); utimesSync(claim, old, old);
  if (status === 'recovery') {
    expect(f.abandon().ok).toBe(true);
    expect(f.admit().redTeamAdmission.queued.status).toBe('queued');
  } else {
    evidence.recordRedTeamStatus({ repo, pr, loopPayload: payload(), status }, { env: f.env });
    expect(evidence.readRedTeamStatus(f.key).status).toBe(status);
  }
});

it('a status claim persists the actual holder process identity before entering the write', () => {
  const f = fixture(), claim = `${f.path}.retry-claim`;
  evidence.withRedTeamStatusClaim(f.path, () => {
    const [pid, identity] = readFileSync(claim, 'utf8').trim().split('\n');
    expect(Number(pid)).toBe(process.pid);
    expect(JSON.parse(identity)).toEqual({ pid: process.pid, pidStart: pidStartTime(process.pid),
      host: hostname(), pidNamespace: pidNamespace() });
    expect(JSON.parse(identity).pidStart).toEqual(expect.any(String));
  });
  expect(() => statSync(claim)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
});

it.each(['matching', 'normalized', 'unreadable', 'throws', 'foreign-host', 'foreign-namespace', 'missing-start', 'mismatched-pid', 'partial'])
('preserves an aged status claim when its owner identity is %s', kind => {
  const f = fixture(), claim = `${f.path}.retry-claim`;
  const identity = { pid: process.pid, pidStart: 'original start', host: hostname(), pidNamespace: pidNamespace() };
  if (kind === 'foreign-host') identity.host = 'another-host';
  if (kind === 'foreign-namespace') identity.pidNamespace = 'another-namespace';
  if (kind === 'missing-start') delete identity.pidStart;
  if (kind === 'mismatched-pid') identity.pid++;
  const bytes = `${process.pid}\n${kind === 'partial' ? '{' : JSON.stringify(identity)}\n`;
  writeFileSync(claim, bytes);
  const old = new Date(Date.now() - 86_400_000); utimesSync(claim, old, old);
  const write = vi.fn(), before = readFileSync(f.path, 'utf8');
  const readPidStart = () => {
    if (kind === 'throws') throw Error('identity unavailable');
    return kind === 'unreadable' ? null : kind === 'matching' ? 'original start'
      : kind === 'normalized' ? ' original   start ' : 'replacement start';
  };
  // Let our own stamp be read normally; the injected failures apply only to the holder probe.
  let reads = 0;
  expect(() => evidence.withRedTeamStatusClaim(f.path, write, {
    readPidStart: () => ++reads === 1 ? pidStartTime(process.pid) : readPidStart(),
  })).toThrow(expect.objectContaining({ code: 'RED_TEAM_RETRY_ADMITTED' }));
  expect(write).not.toHaveBeenCalled();
  expect(readFileSync(claim, 'utf8')).toBe(bytes);
  expect(readFileSync(f.path, 'utf8')).toBe(before);
});

it('a fresh status claim with a reused pid retains the initialization grace', () => {
  const f = fixture(), claim = `${f.path}.retry-claim`, write = vi.fn();
  const bytes = `${process.pid}\n${JSON.stringify({ pid: process.pid, pidStart: 'an-earlier-process',
    host: hostname(), pidNamespace: pidNamespace() })}\n`;
  writeFileSync(claim, bytes);
  expect(() => evidence.withRedTeamStatusClaim(f.path, write))
    .toThrow(expect.objectContaining({ code: 'RED_TEAM_RETRY_ADMITTED' }));
  expect(write).not.toHaveBeenCalled(); expect(readFileSync(claim, 'utf8')).toBe(bytes);
});

it('rollback reclaims a status claim whose owner pid was reused', () => {
  const f = fixture({ status: 'finished' }), witness = f.readWitness();
  evidence.recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'queued', admissionId: 'ours' }, { env: f.env });
  const claim = `${f.path}.retry-claim`;
  writeFileSync(claim, `${process.pid}\n${JSON.stringify({ pid: process.pid, pidStart: 'an-earlier-process',
    host: hostname(), pidNamespace: pidNamespace() })}\n`);
  const old = new Date(Date.now() - 86_400_000); utimesSync(claim, old, old);
  evidence.restoreRecoveryWriter(f.key, witness, 'ours');
  expect(f.readWitness().rawWriter.parsed).toEqual(witness.rawWriter.parsed);
});

it('the shared lock probes the actual moved claim before completing identity-based takeover', () => {
  const f = fixture(), claim = `${f.path}.retry-claim`, write = vi.fn();
  writeFileSync(claim, 'dead-identity');
  const old = new Date(Date.now() - 60_000); utimesSync(claim, old, old);
  // The competing holder is aged too: only the post-move identity check protects it.
  expect(() => withFileLock(claim, write, { timeoutMs: 20, pollMs: 1,
    holderText: 'our-identity',
    probeHolderLiveness: path => readFileSync(path, 'utf8') === 'dead-identity' ? 'dead' : 'alive',
    onBeforeStaleTakeover: () => { writeFileSync(claim, 'live-identity'); utimesSync(claim, old, old); },
  })).toThrow(/timed out/);
  expect(write).not.toHaveBeenCalled(); expect(readFileSync(claim, 'utf8')).toBe('live-identity');
});

it('a stale claim held by a live writer is preserved', () => {
  const f = fixture(), claim = `${f.path}.retry-claim`, before = readFileSync(f.path, 'utf8');
  writeFileSync(claim, `${process.pid}\n`);
  const old = new Date(Date.now() - 60_000); utimesSync(claim, old, old);
  expect(f.abandon().ok).toBe(false);
  expect(readFileSync(f.path, 'utf8')).toBe(before);
  expect(readFileSync(claim, 'utf8')).toBe(`${process.pid}\n`);
});

it.each(['queued', 'running', 'finished'])('an ordinary %s write reclaims a dead status-write claim', status => {
  const f = fixture(), claim = `${f.path}.retry-claim`;
  writeFileSync(claim, '99999999\n');
  const old = new Date(Date.now() - 60_000); utimesSync(claim, old, old);
  evidence.recordRedTeamStatus({ repo, pr, loopPayload: payload(), status }, { env: f.env });
  expect(evidence.readRedTeamStatus(f.key).status).toBe(status);
});

it.each(['queued', 'running', 'finished'])('an ordinary %s writer waits for a concurrent live status writer', async status => {
  const f = fixture(), claim = `${f.path}.retry-claim`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { writeFileSync, rmSync } from 'node:fs';
    writeFileSync(process.argv[1], String(process.pid));
    process.stdout.write('ready');
    setTimeout(() => rmSync(process.argv[1]), 100);
  `, claim], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error(`holder exited ${code}`))); });
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
    evidence.recordRedTeamStatus({ repo, pr, loopPayload: payload(), status }, { env: f.env });
    expect(evidence.readRedTeamStatus(f.key).status).toBe(status);
  } finally { await exited; }
});

it('rollback refunds only a newly introduced retry spend', () => {
  const f = fixture({ status: 'finished' }), witness = f.readWitness();
  evidence.recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'queued', admissionId: 'ours', retryCount: 1 }, { env: f.env });
  evidence.restoreRecoveryWriter(f.key, witness, 'ours');
  expect(f.readWitness().markers.retry).toBe(false);
  expect(f.readWitness().rawWriter.parsed).toEqual(witness.rawWriter.parsed);
});

it.each([true, false, undefined, 'throws'].flatMap(alive => ['same', 'different', null, 'throws'].flatMap(start =>
  ['fresh', 'aged', 'unparseable'].map(stamp => ({ alive, start, stamp })))))('liveness matrix: alive=$alive start=$start stamp=$stamp', ({ alive, start, stamp }) => {
  const f = fixture(), raw = f.readWitness().rawWriter.parsed;
  raw.pidStart = stamp === 'unparseable' ? 'unknown-start' : new Date(Date.now() - (stamp === 'aged' ? 2000 : 0)).toISOString();
  writeFileSync(f.path, JSON.stringify(raw));
  f.probe.isAlive = () => { if (alive === 'throws') throw Error('probe unavailable'); return alive; };
  f.probe.readPidStart = () => { if (start === 'throws') throw Error('ps unavailable'); return start === 'same' ? raw.pidStart : start === 'different' ? 'another-start' : null; };
  const dead = alive === false || (alive === true ? start === 'different' : stamp === 'aged');
  expect(f.decide().mode).toBe(dead ? 'fresh' : 'skip');
});

it('readRecoveryWitness excludes unrelated repo, PR and head evidence', () => {
  const seat = { dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'ok' };
  const f = fixture({ seats: [seat] });
  const own = f.readWitness().newest;
  for (const [i, identity] of [{ repo: 'other/repo' }, { pr: pr + 1 }, { rev: 'b'.repeat(40) }].entries()) {
    f.seats.push({ ...seat, ...identity });
    const id = `review-pr-unrelated-${i}`, run = { ...own, id, input: { repo, pr, ...identity },
      findings: { read: { ...own.findings.read, netBasis: { rev: identity.rev ?? head } } } };
    const path = join(f.env.WE_SHARED_RUNS_DIR, `${id}.json`);
    writeFileSync(path, JSON.stringify(run));
    const future = new Date(Date.now() + 10_000 + i); utimesSync(path, future, future);
  }
  expect(f.readWitness().seats).toEqual([seat]);
  expect(f.readWitness().newest).toEqual(own);
});

it('rollback preserves a superseding admission', () => {
  const f = fixture(), witness = f.readWitness();
  evidence.recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'queued', admissionId: 'earlier' }, { env: f.env });
  evidence.recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'queued', admissionId: 'winner' }, { env: f.env });
  const winner = readFileSync(f.path, 'utf8');
  evidence.restoreRecoveryWriter(f.key, witness, 'earlier');
  expect(readFileSync(f.path, 'utf8')).toBe(winner);
});

it.each(['restoreRedTeamAdmission', 'clearRedTeamQueued'])('job %s preserves a superseding admission', cleanup => {
  const f = fixture(); expect(f.abandon().ok).toBe(true); f.admit();
  evidence.recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'queued', admissionId: 'winner' }, { env: f.env });
  const winner = readFileSync(f.path, 'utf8');
  f.io[cleanup]({ repo, pr, head });
  expect(readFileSync(f.path, 'utf8')).toBe(winner);
});

it('rollback preserves a runner that has started and its retry spend', () => {
  const f = fixture(), witness = f.readWitness();
  evidence.recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'queued', admissionId: 'ours', retryCount: 1 }, { env: f.env });
  evidence.recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'running', admissionId: 'ours' }, { env: f.env });
  const running = readFileSync(f.path, 'utf8');
  evidence.restoreRecoveryWriter(f.key, witness, 'ours');
  expect(readFileSync(f.path, 'utf8')).toBe(running);
  expect(f.readWitness().markers.retry).toBe(true);
});

it.each(['stale-recovery', 'failed-seat-retry'].flatMap(kind => [false, true].map(superseded => ({ kind, superseded }))))(
  'invalid runner admission restores queued evidence and skips finished write and gate ($kind, superseded=$superseded)', ({ kind, superseded }) => {
  const f = fixture();
  if (kind === 'stale-recovery') expect(f.abandon().ok).toBe(true);
  else {
    f.seats.push({ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'unparseable' });
    evidence.recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'finished', result: 'failed' }, { env: f.env });
  }
  const before = readFileSync(f.path, 'utf8'), gate = vi.fn(), settle = vi.fn();
  let winner;
  const status = vi.fn(f.io.redTeamStatus);
  const io = { root: f.dir, now: Date.now, newActorId: () => 'fixture', readPrevCompletion: () => null,
    claim: () => ({ ok: true }), updateRecord: vi.fn(), unclaim: vi.fn(), acquireLane: () => ({ lanePath: f.dir }),
    releaseLane: vi.fn(), report: vi.fn(), log: vi.fn(), prepareLane: () => ({ head }), fetchRedTeamHead: () => ({ head }),
    readRedTeamOnlyPayload: f.io.readRedTeamOnlyPayload, redTeamStatus: status,
    restoreRedTeamAdmission: f.io.restoreRedTeamAdmission, runRedTeamGate: gate, settleRedTeamSkip: settle,
    runRedTeam: () => {
      if (superseded) {
        evidence.recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'queued', admissionId: 'winner' }, { env: f.env });
        winner = readFileSync(f.path, 'utf8');
      }
      return { status: 'not-owed', invalidAdmission: true };
    } };
  expect(runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'fresh' }, io).redTeam.invalidAdmission).toBe(true);
  expect(gate).not.toHaveBeenCalled(); expect(settle).not.toHaveBeenCalled();
  expect(status.mock.calls.map(([input]) => input.status)).toEqual(['queued']);
  expect(readFileSync(f.path, 'utf8')).toBe(superseded ? winner : before);
  expect(f.decide().mode).toBe(superseded ? 'skip' : 'fresh');
  const next = recovery.planRedTeamOnSkip({ repo, refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }],
    rawPrs: [{ number: pr, headRefOid: head, comments: [] }], readWitness: f.readWitness,
    readStatus: () => evidence.readRedTeamStatus(f.key), readEvidence: () => ({ loopPayload: f.readWitness().newest,
      inFlight: false, queued: false, recorded: f.seats.length > 0, seatRecorded: f.seats.length > 0,
      completedRecorded: false, failedSeatCount: f.seats.length }),
    setting: { enabled: true, retryCooldownMin: 0 }, lastDispatch: new Map(),
    recoveryOptions: { now: Date.now(), probe: f.probe, deadlineMs: 1000 } });
  expect(next[0].action).toBe(superseded ? 'skip' : 'dispatch');
  if (!superseded) expect(f.admit().redTeamAdmission.queued.status).toBe('queued');
});
