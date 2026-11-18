// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { MissingStoreError, resolveScorecardStorePath, writeStore, appendScorecard, appendScorecardUnlessJudged } from '../../conveyor/run-scorecard-store.mjs';
import { createRedTeamIo, createExtraSeatsIo, runExtraSeats, readSeatCapUsage, completeRedTeam, finishSpeculativeRedTeam, redTeamReadFingerprint, runRedTeam, speculateRedTeam } from '../../operations/review-extra-seats.mjs';
import { defaultProviderQuotaHold } from '../../operations/cli-adapter.mjs';
import { defaultReadScorecards } from '../../operations/dispatch-lane-io.mjs';
import { dispatchProviderAvailable } from '../dispatch-provider-availability.mjs';
import { runJudge } from '../model-probation.mjs';
import { createReviewJobIo } from '../../operations/review-job.mjs';
import { newRunRecord, writeRun } from '../../operations/run-store.mjs';
import { readDrainRedTeamEvidence, readRecoveryWitness, redTeamStatusDir } from '../drain-red-team-evidence.mjs';
import { abandonStaleRedTeamRun, planRedTeamOnSkip, planRedTeamRecovery } from '../review-red-team-on-skip.mjs';
import { failedRedTeamRetry, redTeamStatusWithoutRun } from '../red-team-run-result.mjs';
import { publishStoredRedTeamResult } from '../red-team-withheld-publish.mjs';

const repo = 'web-everything/web-everything', pr = 5762, head = 'a'.repeat(40);
const read = { netBasis: { rev: head }, netChangedFiles: ['backlog/123-fixture.md'], diffText: '+fixture' };
const loopPayload = { verdict: { verdict: 'accept' }, findings: { read } };
const roots = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function fixture(empty) {
  const root = mkdtempSync(join(tmpdir(), 'strict-scorecard-callers-'));
  roots.push(root);
  const runsDir = join(root, 'runs');
  const env = { CONVEYOR_STATE_ROOT: root, WE_SHARED_RUNS_DIR: runsDir, WE_UNDER_TEST: '1',
    WE_RED_TEAM_SKIP_CARD_ONLY: '1', WE_RED_TEAM_GATE_SOURCE: 'drain-scan', WE_RED_TEAM_STATUS_LABELS: '0' };
  const storePath = resolveScorecardStorePath(env);
  if (empty) writeStore({ version: 1, records: [] }, { path: storePath });
  writeRun({ ...newRunRecord({ id: 'review-pr-matrix', op: 'review-pr', input: { repo, pr } }), ...loopPayload }, runsDir);
  const key = { repo, pr, head, env, runsDir };
  const statusPath = join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${pr}-${head}.json`);
  const status = (result, extra = {}) => {
    mkdirSync(dirname(statusPath), { recursive: true });
    writeFileSync(statusPath, JSON.stringify({ repo, pr, head, status: 'finished', result, loopPayload, ...extra }));
  };
  const effects = [];
  const forbid = label => () => { effects.push(label); throw Error(`unexpected ${label}`); };
  const seatIo = { ...createRedTeamIo({ env, root, storePath }), log: () => {},
    readRecoveryComments: () => [], cliAvailable: forbid('provider'), reserveCalls: forbid('reservation'),
    runSeat: forbid('model'), runRecheck: forbid('recheck'), postComment: forbid('comment'), append: forbid('append') };
  const planner = extra => planRedTeamOnSkip({ repo, env, now: Date.now(),
    refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }],
    rawPrs: [{ number: pr, headRefOid: head, comments: [], reviews: [], labels: [] }],
    setting: { enabled: true, retryCooldownMin: 0 }, lastDispatch: new Map(), readSeal: null,
    readStatus: () => null, readEvidence: key => readDrainRedTeamEvidence({ ...key, env, runsDir }), ...extra })[0];
  const publisher = extra => publishStoredRedTeamResult({ status: { repo, pr, head }, statusDir: redTeamStatusDir(env),
    listComments: () => [], postComment: forbid('publication'), publishNeedsYou: event => effects.push(event.kind), ...extra });
  return { root, env, key, storePath, statusPath, status, effects, seatIo, extraIo: createExtraSeatsIo({ env, root, storePath }), planner, publisher };
}

const missingThrows = fn => expect(fn).toThrow(MissingStoreError);
const heldPlan = row => expect(row).toMatchObject({ action: 'skip', why: expect.stringContaining('inspect stored evidence') });

const malformedThrows = fn => expect(fn).toThrow(/scorecard store malformed/);
const heldFinalization = async fn => expect(await fn()).toMatchObject({ status: 'error', reason: expect.stringContaining('inspect stored evidence') });
const trial = { rubricVersion: 'fixture.1', subjectClass: 'work-agent', provider: 'codex', model: 'fixture',
  dispatchKind: 'probation-trial', handle: 'matrix', pr, criteriaEvaluated: 0, score: null, deductions: [] };
const pass = { status: 'speculated', readFingerprint: redTeamReadFingerprint(read), rev: head,
  provider: 'codex', model: 'fixture', callId: 'matrix-call', call: { status: 'ok' },
  parsed: { 'red-team': { ok: true, verdict: 'accept', findings: [] } }, evidence: {}, findings: [], recheckStatus: 'not-needed' };
// New decision edges also pin malformed evidence, against the same real store files.
const decisionCallers = [
  ['review-extra-seats: default extra-seat records', f => f.extraIo.readRecords(), missingThrows,
    result => expect(result).toEqual([]), malformedThrows],
  ['review-extra-seats: quota usage', f => readSeatCapUsage({ env: f.env, storePath: f.storePath }), missingThrows,
    result => expect(result.codex).toMatchObject({ usedToday: 0, fraction: 0 }), malformedThrows],
  ['review-extra-seats: reservation', f => f.extraIo.reserveCalls({ provider: 'codex', want: 1, dailyCap: 2, now: Date.now() }),
    (fn, f) => { missingThrows(fn); expect(existsSync(join(dirname(f.storePath), 'review-seat-reservations.json'))).toBe(false); },
    result => expect(result).toMatchObject({ used: 0, callIds: [expect.any(String)] }),
    (fn, f) => { malformedThrows(fn); expect(existsSync(join(dirname(f.storePath), 'review-seat-reservations.json'))).toBe(false); }],
  ['review-extra-seats: extra-seat admission', f => runExtraSeats({ repo, pr, loopPayload, env: f.env }, { ...f.seatIo, cliAvailable: () => false }),
    heldFinalization, result => expect(result).toMatchObject({ status: 'skipped' }), heldFinalization],
  ['review-extra-seats: completion', f => completeRedTeam({ repo, pr, loopPayload, pass, post: false, record: false }, f.seatIo),
    heldFinalization, result => expect(result).toMatchObject({ status: 'ran', rowsWritten: 0 }), heldFinalization],
  ['review-extra-seats: speculative finalization', f => finishSpeculativeRedTeam({ repo, pr, loopPayload: { ...loopPayload, replay: true }, pass, env: f.env, post: false }, f.seatIo),
    heldFinalization, result => expect(result).toMatchObject({ status: 'ran', rowsWritten: 0 }), heldFinalization],
  ['scorecard store: append', f => appendScorecard(trial, { path: f.storePath }), missingThrows,
    (result, f) => { expect(result).toMatchObject(trial); expect(f.extraIo.readRecords()).toEqual([result]); }, malformedThrows],
  ['scorecard store: append unless judged', f => appendScorecardUnlessJudged(trial, { path: f.storePath }), missingThrows,
    (result, f) => { expect(result).toMatchObject(trial); expect(f.extraIo.readRecords()).toEqual([result]); }, malformedThrows],
  ['model-probation: judge', f => runJudge({ io: { path: f.storePath }, log: () => {}, lookupPr: () => { throw Error('unexpected lookup'); } }), missingThrows,
    result => expect(result).toEqual({ judged: 0, pending: 0, failed: 0 }), malformedThrows],
  ['cli-adapter: provider quota clearance', f => { vi.stubEnv('CONVEYOR_STATE_ROOT', f.root); return defaultProviderQuotaHold('codex', Date.now()); },
    async fn => expect(await fn()).toMatch(/scorecard evidence unreadable:.*inspect stored evidence/),
    result => expect(result).toBeNull(), async fn => expect(await fn()).toMatch(/scorecard evidence unreadable:.*inspect stored evidence/)],
  ['dispatch-provider-availability: provider admission', f => { vi.stubEnv('CONVEYOR_STATE_ROOT', f.root);
    return dispatchProviderAvailable('codex', { env: { PATH: f.root }, access: () => {} }); }, missingThrows,
    result => expect(result).toBe(true), malformedThrows],
  ['dispatch-lane-io: trial route reader', f => { vi.stubEnv('CONVEYOR_STATE_ROOT', f.root); return defaultReadScorecards(); },
    fn => expect(fn()).toEqual([]), result => expect(result).toEqual([]), fn => expect(fn()).toEqual([])],
];

// One table covers every direct strict-store reader and its admission/recovery consumers.
// Only external effects are injected; every scorecard, status and run read uses real files.
const callers = [
  ...decisionCallers,
  ['review-extra-seats: createRedTeamIo.readRecords', f => f.seatIo.readRecords(),
    missingThrows, result => expect(result).toEqual([])],
  ['review-extra-seats: sealing reader', f => {
    // A prior operator alert keeps this reader-only probe from writing the attention feed.
    f.status('ran', { legacyHoldPublished: true });
    const io = createRedTeamIo({ env: f.env, root: f.root, storePath: f.storePath,
      readCompleteComments: () => [], recordStatus: (_input, options) => options.sealFinished(f.key) });
    return io.redTeamStatus({ repo, pr, loopPayload, status: 'finished' });
  }, async fn => expect(await fn()).toEqual({ status: 'held' }), result => expect(result).toEqual({ status: 'held' })],
  ['review-extra-seats: redTeamRecoveryGuard', f => runRedTeam({ repo, pr, loopPayload, env: f.env, redTeamMode: 'fresh' }, f.seatIo),
    async fn => expect(await fn()).toMatchObject({ status: 'not-owed', deferredByGuard: true,
      reason: expect.stringContaining('inspect stored evidence') }),
    result => expect(result).toMatchObject({ status: 'skipped', policy: 'card-only' })],
  ['review-extra-seats: speculation', f => speculateRedTeam({ repo, pr, read, env: f.env, resume: false }, f.seatIo),
    async fn => expect(await fn()).toMatchObject({ status: 'skipped', deferredByGuard: true,
      reason: expect.stringContaining('inspect stored evidence') }),
    result => expect(result).toMatchObject({ status: 'skipped', policy: 'card-only' })],
  ['drain-red-team-evidence: readRecoveryWitness', f => readRecoveryWitness(f.key), missingThrows,
    result => { expect(result.seats).toEqual([]); expect(result.newest.verdict.verdict).toBe('accept'); }],
  ['drain-red-team-evidence: readDrainRedTeamEvidence', f => readDrainRedTeamEvidence(f.key), missingThrows,
    result => expect(result).toMatchObject({ recorded: false, seatRecorded: false, completedRecorded: false, failedSeatCount: 0, scheduled: true })],
  ['red-team-withheld-publish: default seat reader', f => {
    vi.stubEnv('CONVEYOR_STATE_ROOT', f.root);
    f.status('ran');
    return f.publisher();
  }, async fn => expect(await fn()).toEqual({ status: 'held' }), result => expect(result).toEqual({ status: 'held' })],
  ['review-job: strict seat reader / infra guard', f => createReviewJobIo({ env: f.env, root: f.root,
    seatAvailable: () => false, queueBaseline: () => ({ active: false, bypassed: 'off' }) }).reviewInfraBlock(),
    missingThrows, result => expect(result).toBeNull()],
  ['review-job: recovery admission', f => createReviewJobIo({ env: f.env, root: f.root, log: () => {} })
    .redTeamStatus({ repo, pr, status: 'queued', loopPayload, redTeamMode: 'fresh' }), (fn, f) => {
      expect(fn).toThrow(/queued red-team status could not be persisted: scorecard store missing:.*inspect stored evidence/);
      expect(existsSync(f.statusPath)).toBe(false);
    },
    (_result, f) => expect(JSON.parse(readFileSync(f.statusPath, 'utf8'))).toMatchObject({ status: 'queued', head })],
  ['red-team-run-result: retry predicates consume strict evidence', f => {
    const evidence = readDrainRedTeamEvidence(f.key);
    const status = { status: 'finished', result: 'ran' };
    return { retry: failedRedTeamRetry(status, evidence), noRun: redTeamStatusWithoutRun(status) };
  }, missingThrows, result => expect(result).toEqual({ retry: false, noRun: true })],
  ['review-red-team-on-skip: evidence consumer', f => f.planner(),
    async fn => heldPlan(await fn()), result => expect(result).toMatchObject({ action: 'dispatch', mode: 'fresh' })],
  ['review-red-team-on-skip: witness consumer', f => f.planner({ readWitness: key => readRecoveryWitness({ ...key, env: f.env, runsDir: f.key.runsDir }) }),
    async fn => heldPlan(await fn()), result => expect(result).toMatchObject({ action: 'dispatch', mode: 'fresh' })],
  ['review-red-team-on-skip: policy-clear consumer', f => {
    writeRun({ ...newRunRecord({ id: 'review-pr-matrix', op: 'review-pr', input: { repo, pr } }),
      ...loopPayload, verdict: { verdict: 'prevention-outstanding' } }, f.key.runsDir);
    return f.planner({ rawPrs: [{ number: pr, headRefOid: head, reviews: [],
      labels: ['ready-to-merge', 'review:accepted', 'red-team:pending'],
      comments: [{ body: `✅ review — accepted\n<!-- reviewed-sha: ${head} -->`, author: { login: 'web-everything' } }] }] });
  }, async fn => heldPlan(await fn()), result => expect(result).toMatchObject({ action: 'clear', why: 'not owed (stored review)' })],
  ['review-red-team-on-skip: recovery planner', f => planRedTeamRecovery(readRecoveryWitness(f.key),
    { now: Date.now(), probe: {}, setting: { enabled: true } }), missingThrows,
    result => expect(result).toMatchObject({ mode: 'fresh' })],
  ['review-red-team-on-skip: abandonment consumer', f => {
    f.status(null, { status: 'queued', pid: 99999999, host: 'matrix', pidNamespace: 'matrix' });
    return abandonStaleRedTeamRun(f.key, { probe: { host: 'matrix', namespace: 'matrix', isAlive: () => false } });
  }, async (fn, f) => {
    expect(await fn()).toEqual({ ok: false });
    expect(JSON.parse(readFileSync(f.statusPath, 'utf8'))).toMatchObject({ status: 'queued', result: null });
    expect(existsSync(`${f.statusPath}.stale-redispatch-1`)).toBe(false);
  }, result => expect(result).toEqual({ ok: true })],
];

describe('strict scorecard caller matrix: missing holds, present-empty preserves behavior', () => {
  it.each(callers)('%s', async (_name, run, missing, empty) => {
    const absent = fixture(false);
    await missing(() => run(absent), absent);
    expect(absent.effects.filter(effect => !effect.startsWith('red-team-legacy'))).toEqual([]);
    const present = fixture(true);
    await empty(await run(present), present);
    expect(present.effects.filter(effect => !effect.startsWith('red-team-legacy'))).toEqual([]);
  });
});

describe('strict decision caller matrix: malformed evidence stays available for inspection', () => {
  it.each(decisionCallers)('%s', async (_name, run, _missing, _empty, malformed) => {
    const f = fixture(true);
    const text = '{"records":[{"priorEvidence":"keep me"}]';
    writeFileSync(f.storePath, text);
    await malformed(() => run(f), f);
    expect(readFileSync(f.storePath, 'utf8')).toBe(text);
    expect(f.effects).toEqual([]);
  });
});
