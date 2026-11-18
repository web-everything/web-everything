// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveScorecardStorePath } from '../../conveyor/run-scorecard-store.mjs';
import { createRedTeamIo, runRedTeam } from '../../operations/review-extra-seats.mjs';
import { createReviewJobIo } from '../../operations/review-job.mjs';
import { newRunRecord, writeRun } from '../../operations/run-store.mjs';
import { readDrainRedTeamEvidence, readRecoveryWitness, readRedTeamStatus, redTeamStatusDir } from '../drain-red-team-evidence.mjs';
import { skippedRedTeamRetry } from '../red-team-run-result.mjs';
import { planRedTeamOnSkip, planRedTeamRecovery } from '../review-red-team-on-skip.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const unknown = ['missing', 'malformed', 'unreadable'];
function loseHistory(f, state) {
  rmSync(f.storePath);
  if (state === 'malformed') writeFileSync(f.storePath, '{broken');
  if (state === 'unreadable') mkdirSync(f.storePath);
}
function fixture(state) {
  const root = mkdtempSync(join(tmpdir(), 'strict-scorecard-callers-')); roots.push(root);
  const env = { CONVEYOR_STATE_ROOT: join(root, 'state'), WE_SHARED_RUNS_DIR: join(root, 'runs'),
    OPERATION_RUNS_DIR: join(root, 'runs'), WE_RED_TEAM_STATUS_LABELS: '0', WE_RED_TEAM_SKIP_CARD_ONLY: '0',
    WE_REVIEW_RED_TEAM: '1', WE_REVIEW_EXTRA_SEATS: '1' };
  const key = { repo: 'example/project', pr: 6999, head: 'a'.repeat(40) };
  const read = { netBasis: { rev: key.head }, netChangedFiles: ['scripts/example.mjs'], diffText: '+changed' };
  const loopPayload = { verdict: { verdict: 'accept' }, findings: { read } };
  writeRun({ ...newRunRecord({ id: 'review-pr-strict-store', op: 'review-pr', input: key }),
    ...loopPayload }, env.WE_SHARED_RUNS_DIR);
  const storePath = resolveScorecardStorePath(env);
  mkdirSync(dirname(storePath), { recursive: true });
  // Damage real existing execution history while its finished skipped writer survives.
  const rows = state === 'empty' ? [] : [{ dispatchKind: 'review-seat', seat: 'red-team',
    repo: key.repo, pr: key.pr, rev: key.head, status: 'ok' }];
  writeFileSync(storePath, JSON.stringify({ version: 1, records: rows }));
  const statusPath = join(redTeamStatusDir(env), `${encodeURIComponent(key.repo)}-${key.pr}-${key.head}.json`);
  mkdirSync(dirname(statusPath), { recursive: true });
  const status = { ...key, status: 'finished', result: { status: 'skipped' }, loopPayload };
  writeFileSync(statusPath, JSON.stringify(status));
  const f = { root, env, key, loopPayload, status, statusPath, storePath };
  if (state !== 'empty') loseHistory(f, state);
  f.evidence = () => readDrainRedTeamEvidence({ ...key, env });
  f.witness = () => readRecoveryWitness({ ...key, env });
  f.forbidden = vi.fn(() => { throw Error('unexpected provider or external IO'); });
  f.seatIo = { ...createRedTeamIo({ root, env, storePath, readCompleteComments: () => [] }),
    log: () => {}, cliAvailable: f.forbidden, reserveCalls: f.forbidden, runSeat: f.forbidden };
  f.jobIo = createReviewJobIo({ root, env, exec: f.forbidden });
  return f;
}
function plan(f) {
  return planRedTeamOnSkip({ repo: f.key.repo, env: f.env,
    refusals: [{ kind: 'already-reviewed-head', prNumber: f.key.pr, headSha: f.key.head }],
    rawPrs: [{ number: f.key.pr, headRefOid: f.key.head, comments: [], reviews: [] }],
    readEvidence: f.evidence, readStatus: key => readRedTeamStatus({ ...key, env: f.env }),
    now: Date.now(), setting: { enabled: true, retryCooldownMin: 0 }, lastDispatch: new Map() })[0];
}
const readers = [
  ['seat admission records', f => f.seatIo.readRecords({ strict: true }), value => expect(value).toEqual([])],
  ['drain retry evidence', f => f.evidence(), (value, f) => {
    expect(value).toMatchObject({ completedRecorded: false, failedSeatCount: 0 });
    expect(skippedRedTeamRetry(f.status, value)).toBe(true);
  }],
  ['recovery witness', f => f.witness(), (value, f) => {
    expect(value.seats).toEqual([]);
    expect(planRedTeamRecovery(value, { now: Date.now(), env: f.env,
      setting: { enabled: true, retryCooldownMin: 0 }, probe: { isAlive: f.forbidden } }))
      .toMatchObject({ mode: 'fresh', retry: true });
  }],
  ['review-job payload admission', f => f.jobIo.readRedTeamOnlyPayload(f.key),
    (value, f) => expect(value).toMatchObject({ head: f.key.head, loopPayload: f.loopPayload })],
  ['review-job queued admission', f => f.jobIo.redTeamStatus({ ...f.key, loopPayload: f.loopPayload,
    status: 'queued', redTeamMode: 'fresh' }), value => expect(value.redTeamAdmission.retrySpent).toBe(true)],
];
describe('admission reader matrix: unknown history never authorizes a skipped retry', () => {
  it.each(readers.flatMap(([name, read, check]) => ['empty', ...unknown].map(state => ({ name, read, check, state }))))
  ('$name with $state history', ({ read, check, state }) => {
    const f = fixture(state), before = readFileSync(f.statusPath, 'utf8');
    if (state === 'empty') check(read(f), f);
    else {
      expect(() => read(f)).toThrow();
      expect(readFileSync(f.statusPath, 'utf8')).toBe(before);
      expect(existsSync(`${f.statusPath}.retry-1`)).toBe(false);
    }
    expect(f.forbidden).not.toHaveBeenCalled();
  });
  it.each(unknown)('planner cannot dispatch a skipped retry with %s history', state => {
    const f = fixture(state);
    expect(plan(f)).toMatchObject({ action: 'skip', why: 'red-team evidence unreadable; inspect stored evidence before retrying' });
    expect(plan(f)).not.toHaveProperty('mode');
    expect(plan(f)).not.toHaveProperty('settle');
  });
  it('present empty history still permits planning the bounded skipped retry', () => {
    expect(plan(fixture('empty'))).toMatchObject({ action: 'dispatch', mode: 'fresh' });
  });
  it.each(unknown)('runner refuses %s history without provider work or retry spend', async state => {
    const f = fixture(state), before = readFileSync(f.statusPath, 'utf8');
    expect(await runRedTeam({ ...f.key, loopPayload: f.loopPayload, env: f.env,
      redTeamMode: 'fresh', lanePath: f.root, post: false, record: false }, f.seatIo))
      .toMatchObject({ status: 'not-owed', deferredByGuard: true,
        reason: expect.stringContaining('scorecard store unreadable; inspect stored evidence') });
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(readFileSync(f.statusPath, 'utf8')).toBe(before);
    expect(existsSync(`${f.statusPath}.retry-1`)).toBe(false);
  });
  it.each(unknown)('queued admission rechecks %s history lost after a valid plan', state => {
    const f = fixture('empty'), before = readFileSync(f.statusPath, 'utf8');
    expect(plan(f)).toMatchObject({ action: 'dispatch', mode: 'fresh' });
    loseHistory(f, state);
    expect(() => f.jobIo.redTeamStatus({ ...f.key, loopPayload: f.loopPayload,
      status: 'queued', redTeamMode: 'fresh' })).toThrow();
    expect(readFileSync(f.statusPath, 'utf8')).toBe(before);
    expect(existsSync(`${f.statusPath}.retry-1`)).toBe(false);
    expect(f.forbidden).not.toHaveBeenCalled();
  });
});
