// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { pidNamespace } from '../../lib/pid-alive.mjs';
import * as evidence from '../../lib/drain-red-team-evidence.mjs';
import * as recovery from '../../lib/review-red-team-on-skip.mjs';
import { createReviewJobIo, dispatchReviewJob, runReviewJob, runReviewJobCli } from '../review-job.mjs';
import { newRunRecord } from '../run-store.mjs';
import { redTeamMarker } from '../../lib/red-team-gate.mjs';
import { runRedTeam, runExtraSeatsCli } from '../review-extra-seats.mjs';

vi.mock('../../lib/red-team-status-labels.mjs', () => ({ syncRedTeamStatusLabels: vi.fn() }));
const dirs = [];
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
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
  const admit = () => io.redTeamStatus({ repo, pr, loopPayload: readWitness().newest, status: 'queued', redTeamMode: seats.length ? 'resume' : 'fresh' });
  return { dir, env, key, path, run, seats, probe, readWitness, decide, abandon, io, admit };
}

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
it('A4 / C: every job CLI flag is named; red-team payload reads only the witness', () => {
  const source = readFileSync(new URL('../review-job.mjs', import.meta.url), 'utf8');
  const tests = readFileSync(new URL('./review-recovery-witness.test.mjs', import.meta.url), 'utf8');
  for (const [, flag] of source.matchAll(/flag\('([^']+)'\)/g)) expect(tests).toContain(`--${flag}`);
  const body = source.slice(source.indexOf('readRedTeamOnlyPayload:'), source.indexOf('redTeamSkipCardOnlySetting:'));
  expect(body).toContain('readWitness('); expect(body).not.toMatch(/readStatus\(|readEvidence\(/);
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
