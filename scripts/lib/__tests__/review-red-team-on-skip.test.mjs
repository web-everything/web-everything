import { describe, it, expect, vi } from 'vitest';
import { planRedTeamOnSkip, runRedTeamOnSkip, resolveReviewRedTeamOnSkip, redTeamRecoveryRows } from '../review-red-team-on-skip.mjs';
import { renderRedTeamComment, RED_TEAM_DISCARD_DISPATCH_KIND } from '../../operations/review-extra-seats.mjs';
import { resetCascadeLogForTest } from '../policy-cascade.mjs';
import { readDrainRedTeamEvidence, readFreshRedTeamAttempts, reserveFreshRedTeamAttempt, redTeamStatusDir } from '../drain-red-team-evidence.mjs';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { provenanceRun } from './fixtures/saved-red-team-provenance.mjs';
import { reviewPrStepNames } from '../../operations/review-pr-completion.mjs';
import { writeRun } from '../../operations/run-store.mjs';
import { resolveScorecardStorePath } from '../../conveyor/run-scorecard-store.mjs';
import { readSavedRedTeamGateResult } from '../drain-saved-red-team.mjs';
import { tmpdir } from 'node:os';
import { cliReviewTickOpts, runReviewTick, runReviewTickAllRepos } from '../../../skills-src/conveyor/review-daemon.mjs';

const repo = 'web-everything/web-everything', head = 'a'.repeat(40), pr = 5762;
const payload = () => ({ verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head } } } });
function fixture(over = {}) {
  return { repo, refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }],
    rawPrs: [{ number: pr, headRefOid: head, comments: [] }],
    readEvidence: () => ({ loopPayload: payload(), recorded: false }), readStatus: () => null, readRecoveryRows: () => ({ verifiedRow: null, freshAttempts: 0 }),
    now: 2_000_000, setting: { enabled: true, retryCooldownMin: 30, maxFreshPerHead: 2 }, lastDispatch: new Map(), ...over };
}
const decide = over => planRedTeamOnSkip(fixture(over))[0];

describe('planRedTeamOnSkip', () => {
  it('ignores every other refusal kind', () => {
    expect(planRedTeamOnSkip(fixture({ refusals: [{ kind: 'live-job', prNumber: pr }] }))).toEqual([]);
  });
  it('a: disabled refuses before reading evidence', () => {
    const readEvidence = vi.fn();
    expect(decide({ setting: { enabled: false }, readEvidence }).why).toBe('reviewRedTeamOnSkip.enabled=false');
    expect(readEvidence).not.toHaveBeenCalled();
  });
  it.each([null, 'abc', 'b'.repeat(40)])('b: refuses missing, malformed or changed live head %s', h => {
    expect(decide({ rawPrs: [{ number: pr, headRefOid: h, comments: [] }] }).action).toBe('skip');
  });
  it('b: accepts a live head when the refusal did not supply headSha', () => {
    expect(decide({ refusals: [{ kind: 'already-reviewed-head', prNumber: pr }] }).action).toBe('dispatch');
  });
  it('c: never dispatches when a trusted result already covers this head', () => {
    const body = renderRedTeamComment({ pr, rev: head, provider: 'codex', model: 'm', findings: [], foldedVerdict: 'accept' });
    const readEvidence = vi.fn();
    expect(decide({ rawPrs: [{ number: pr, headRefOid: head, comments: [{ body, author: { login: 'web-everything' } }] }], readEvidence }).why)
      .toBe('red-team result already on head');
    expect(readEvidence).not.toHaveBeenCalled();
  });
  it('refuses unreadable comments or evidence instead of assuming no pass', () => {
    expect(decide({ rawPrs: [{ number: pr, headRefOid: head }] }).action).toBe('skip');
    expect(decide({ readEvidence: () => { throw Error('unreadable'); } }).action).toBe('skip');
    expect(decide({ readStatus: () => { throw Error('unreadable'); } }).action).toBe('skip');
  });
  it('d: a non-accept or missing review never dispatches', () => {
    for (const loopPayload of [null, { verdict: { verdict: 'changes' } }]) {
      expect(decide({ readEvidence: () => ({ loopPayload }) }).action).toBe('skip');
    }
  });
  it('refuses an accepting payload pinned to another head', () => {
    const loopPayload = payload(); loopPayload.findings.read.netBasis.rev = 'b'.repeat(40);
    expect(decide({ readEvidence: () => ({ loopPayload }) }).action).toBe('skip');
  });
  it.each(['inFlight', 'queued'])('e: does not dispatch while %s', key => {
    expect(decide({ readEvidence: () => ({ loopPayload: payload(), [key]: true }) }).why).toBe('red-team pass in flight');
  });
  it('f: resumes the #5762 shape: recorded pass with a failed comment', () => {
    expect(decide({ readEvidence: () => ({ loopPayload: payload(), recorded: true }),
      readRecoveryRows: () => ({ verifiedRow: {}, freshAttempts: 0 }),
      readStatus: () => ({ status: 'finished', result: { status: 'ran', comment: 'error' } }) }))
      .toMatchObject({ action: 'dispatch', mode: 'resume' });
  });
  it.each(['ran', 'resumed'])('f: a posted %s result awaits visibility', status => {
    for (const comment of ['posted', { status: 'posted' }]) {
      expect(decide({ readEvidence: () => ({ loopPayload: payload(), recorded: true }),
        readStatus: () => ({ result: { status, comment } }) }).why).toBe('result posted; comment not visible yet');
    }
  });
  it('f: a recorded advisory accept resumes with a finished clean status', () => {
    const loopPayload = payload();
    loopPayload.verdict = { verdict: 'needs-human', humanRequired: true,
      lensVerdicts: { correctness: 'accept' }, findings: [], admittedFindings: [] };
    expect(decide({ readEvidence: () => ({ loopPayload, recorded: true }),
      readRecoveryRows: () => ({ verifiedRow: {}, freshAttempts: 0 }),
      readStatus: () => ({ status: 'finished', result: { status: 'ran' } }) })).toMatchObject({ action: 'dispatch', mode: 'resume' });
  });
  it('f: a recorded row with no status skips with an unknown prior result', () => {
    expect(decide({ readEvidence: () => ({ loopPayload: payload(), recorded: true }) }))
      .toMatchObject({ action: 'skip', why: 'prior result unknown (status missing); not re-run' });
  });
  it.each(['error', 'skipped', 'disabled', 'not-owed', null])('f: a recorded non-recoverable result %s never resumes', prior => {
    expect(decide({ readEvidence: () => ({ loopPayload: payload(), recorded: true }),
      readStatus: () => ({ status: 'finished', result: { status: prior } }) }))
      .toMatchObject({ action: 'skip', why: `prior result ${prior ?? 'unknown'} (status finished); not re-run` });
  });
  it.each(['resumed', { status: 'resumed', comment: 'error' }, { status: 'resumed', comment: { status: 'error' } }])('f: a failed recovery result %j remains eligible with recorded evidence', result => {
    expect(decide({ readEvidence: () => ({ loopPayload: payload(), recorded: true }),
      readRecoveryRows: () => ({ verifiedRow: {}, freshAttempts: 0 }),
      readStatus: () => ({ status: 'finished', result }) })).toMatchObject({ action: 'dispatch', mode: 'resume' });
  });
  it('f: a string error result never resumes', () => {
    expect(decide({ readEvidence: () => ({ loopPayload: payload(), recorded: true }),
      readStatus: () => ({ status: 'finished', result: 'error' }) })).toMatchObject({ action: 'skip' });
  });
  it.each(['ran', 'resumed'])('f: unfinished statuses cannot authorize %s resume', prior => {
    for (const status of ['queued', 'running', undefined]) {
      expect(decide({ readEvidence: () => ({ loopPayload: payload(), recorded: true }),
        readStatus: () => ({ status, result: { status: prior } }) }).action).toBe('skip');
    }
  });
  it('f: a legacy string ran result authorizes resume', () => {
    expect(decide({ readEvidence: () => ({ loopPayload: payload(), recorded: true }),
      readRecoveryRows: () => ({ verifiedRow: {}, freshAttempts: 0 }),
      readStatus: () => ({ status: 'finished', result: 'ran' }) })).toMatchObject({ action: 'dispatch', mode: 'resume' });
  });
  it('f: missing recorded evidence cannot authorize a fresh pass', () => {
    expect(decide({ readEvidence: () => ({ loopPayload: payload() }) }).action).toBe('skip');
  });
  it('f: fresh dispatch only when neither status nor row exists', () => {
    expect(decide()).toMatchObject({ action: 'dispatch', mode: 'fresh' });
  });
  it.each(['error', 'skipped', 'disabled', 'not-owed', 'ran', 'resumed', null])('f: never re-runs an unrecorded prior result %s', prior => {
    expect(decide({ readStatus: () => ({ status: 'finished', result: prior }) }).action).toBe('skip');
    expect(decide({ readStatus: () => ({ status: 'finished', result: { status: prior } }) }).action).toBe('skip');
  });
  it('refuses verified evidence without a finished status (main guard)', () => {
    expect(decide({ readEvidence: () => ({ loopPayload: payload(), recorded: true }),
      readRecoveryRows: () => ({ verifiedRow: {}, freshAttempts: 2 }) }))
      .toMatchObject({ action: 'skip', why: 'prior result unknown (status missing); not re-run' });
  });
  it.each(['error', 'skipped', 'disabled', 'not-owed', 'ran', 'resumed', null])('unverified prior result %s cannot bypass main fresh guards', prior => {
    for (const result of [prior, { status: prior }]) {
      expect(decide({ readStatus: () => ({ status: 'finished', result }) })).toMatchObject({ action: 'skip' });
    }
  });
  it('fails closed on unreadable or malformed recovery evidence', () => {
    for (const readRecoveryRows of [() => { throw Error('unreadable'); }, () => null, () => ({})]) {
      expect(decide({ readRecoveryRows }).action).toBe('skip');
    }
  });
  it.each([2, 3, 1000])('refuses fresh attempts at or above cap: %s (operator inspection required)', freshAttempts => {
    expect(decide({ readRecoveryRows: () => ({ verifiedRow: null, freshAttempts }) }).why).toBe('fresh attempts exhausted for head');
  });
  it('retains advisory accepting evidence with a verified row', () => {
    const loopPayload = payload();
    loopPayload.verdict = { verdict: 'needs-human', humanRequired: true,
      lensVerdicts: { correctness: 'accept' }, findings: [], admittedFindings: [] };
    expect(decide({ readEvidence: () => ({ loopPayload, recorded: true }),
      readStatus: () => ({ status: 'finished', result: 'ran' }), readRecoveryRows: () => ({ verifiedRow: {}, freshAttempts: 0 }) }))
      .toMatchObject({ action: 'dispatch', mode: 'resume' });
  });
  it('honors the persisted status cooldown across dispatcher restarts', () => {
    expect(decide({ readEvidence: () => ({ loopPayload: payload(), recorded: true }),
      readRecoveryRows: () => ({ verifiedRow: {}, freshAttempts: 0 }),
      readStatus: () => ({ status: 'finished', result: 'ran', updatedAtMs: 200_001 }) }).why).toBe('retry cooldown active');
  });
  it('refuses a finished recorded pass without verified provenance', () => {
    expect(decide({ readEvidence: () => ({ loopPayload: payload(), recorded: true }),
      readStatus: () => ({ status: 'finished', result: 'ran' }) }))
      .toMatchObject({ action: 'skip', why: 'recorded pass lacks verified provenance; inspect stored evidence before retrying' });
  });
  it('resumes verified finished evidence even at the fresh-attempt cap', () => {
    expect(decide({ readEvidence: () => ({ loopPayload: payload(), recorded: true }),
      readStatus: () => ({ status: 'finished', result: 'resumed' }),
      readRecoveryRows: () => ({ verifiedRow: {}, freshAttempts: 2 }) }))
      .toMatchObject({ action: 'dispatch', mode: 'resume' });
  });
  it('g: observes cooldown then allows retry at the boundary', () => {
    const lastDispatch = new Map([[`${repo}#${pr}@${head}`, 200_001]]);
    expect(decide({ lastDispatch }).why).toBe('retry cooldown active');
    lastDispatch.set(`${repo}#${pr}@${head}`, 200_000);
    expect(decide({ lastDispatch }).action).toBe('dispatch');
  });
});

describe('settings cascade', () => {
  it('loads the default tool settings from the filesystem under Vite', () => {
    const resolved = resolveReviewRedTeamOnSkip({ env: { WE_PLATFORM_PREFERENCES_FILE: '/missing-test-policy' } });
    expect(resolved.value).toEqual({ enabled: true, retryCooldownMin: 30, maxFreshPerHead: 2 });
    expect(resolved.sources).toMatchObject({ enabled: 'tool', retryCooldownMin: 'tool', maxFreshPerHead: 'tool' });
  });
  it('environment disables recovery and logs its source', () => {
    resetCascadeLogForTest(); const log = vi.fn();
    const resolved = resolveReviewRedTeamOnSkip({ env: { WE_REVIEW_RED_TEAM_ON_SKIP: '0', WE_REVIEW_RED_TEAM_ON_SKIP_MAX_FRESH_PER_HEAD: '3', WE_POLICY_CASCADE_LOG: '1' },
      readFile: () => '{"enabled":true}', log });
    expect(resolved.value.enabled).toBe(false);
    expect(resolved.sources.enabled).toBe('env');
    expect(resolved.value.maxFreshPerHead).toBe(3);
    expect(resolved.sources.maxFreshPerHead).toBe('env');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('maxFreshPerHead=3 (env)'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('enabled=false (env)'));
  });
  it('malformed tool and environment values retain lower layers', () => {
    const resolved = resolveReviewRedTeamOnSkip({ env: { WE_REVIEW_RED_TEAM_ON_SKIP: 'garbage', WE_REVIEW_RED_TEAM_ON_SKIP_RETRY_COOLDOWN_MIN: '-1', WE_REVIEW_RED_TEAM_ON_SKIP_MAX_FRESH_PER_HEAD: 'garbage', WE_PLATFORM_PREFERENCES_FILE: '/missing-test-policy' },
      readFile: () => '{"enabled":"bad","retryCooldownMin":-1,"maxFreshPerHead":-1}' });
    expect(resolved.value).toEqual({ enabled: true, retryCooldownMin: 30, maxFreshPerHead: 2 });
  });
});

function runFixture(over = {}) {
  const f = fixture();
  return { repo, plan: { refusals: f.refusals }, rawPrs: f.rawPrs, setting: f.setting,
    readEvidence: f.readEvidence, readStatus: f.readStatus, readRecoveryRows: f.readRecoveryRows, now: () => f.now, lastDispatch: f.lastDispatch,
    capacity: { lanes: 1, budget: { left: 1 } }, dispatch: vi.fn(() => ({ jobPid: 42 })), ...over };
}
describe('runRedTeamOnSkip', () => {
  it.each(['finished-error', 'missing'])('an error seat row with %s status skips without dispatch', kind => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-skip-'));
    try {
      const evidence = readDrainRedTeamEvidence({ repo, pr, head,
        env: { WE_SHARED_RUNS_DIR: join(dir, 'runs') }, runsDir: join(dir, 'runs'), list: () => [],
        readScorecards: () => [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'error' }] });
      expect(evidence.recorded).toBe(true);
      const o = runFixture({ readEvidence: () => ({ ...evidence, loopPayload: payload() }),
        readStatus: () => kind === 'missing' ? null : { status: 'finished', result: { status: 'error' } } });
      const out = runRedTeamOnSkip(o);
      expect(out.rows[0]).toMatchObject({ action: 'skip',
        why: kind === 'missing' ? 'prior result unknown (status missing); not re-run' : 'prior result error (status finished); not re-run' });
      expect(out.dispatched).toEqual([]); expect(o.dispatch).not.toHaveBeenCalled();
      expect(o.capacity).toEqual({ lanes: 1, budget: { left: 1 } }); expect(o.lastDispatch.size).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['finished-error', 'missing'])('an error seat row with %s status still refuses a bounded fresh recovery (main guard)', kind => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-skip-'));
    try {
      const evidence = readDrainRedTeamEvidence({ repo, pr, head,
        env: { CONVEYOR_STATE_ROOT: dir, WE_SHARED_RUNS_DIR: join(dir, 'runs'), OPERATION_RUNS_DIR: join(dir, 'runs') },
        runsDir: join(dir, 'runs'), list: () => [],
        readScorecards: () => [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'error' }] });
      expect(evidence.recorded).toBe(true);
      const o = runFixture({ readEvidence: () => ({ ...evidence, loopPayload: payload() }),
        readStatus: () => kind === 'missing' ? null : { status: 'finished', result: { status: 'error' } },
        readRecoveryRows: () => ({ verifiedRow: null, freshAttempts: 1 }) });
      const out = runRedTeamOnSkip(o);
      expect(out.rows[0]).toMatchObject({ action: 'skip',
        why: kind === 'missing' ? 'prior result unknown (status missing); not re-run' : 'prior result error (status finished); not re-run' });
      expect(out.dispatched).toEqual([]); expect(o.dispatch).not.toHaveBeenCalled();
      expect(o.capacity).toEqual({ lanes: 1, budget: { left: 1 } }); expect(o.lastDispatch.size).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('dry run calls no dispatch and spends no capacity or cooldown', () => {
    const o = runFixture({ dryRun: true }); const out = runRedTeamOnSkip(o);
    expect(o.dispatch).not.toHaveBeenCalled(); expect(out.dispatched).toEqual([]);
    expect(o.capacity.budget.left).toBe(1); expect(o.lastDispatch.size).toBe(0);
  });
  it.each([{ lanes: 0 }, { lanes: 1, budget: { left: 0 } }])('does not dispatch with exhausted capacity %j', capacity => {
    const o = runFixture({ capacity }); runRedTeamOnSkip(o); expect(o.dispatch).not.toHaveBeenCalled();
  });
  it('host-denied capacity blocks recovery without consuming lanes, budget or host starts', () => {
    const take = vi.fn(), capacity = { lanes: 3, budget: { left: 3 }, remainingStarts: 0, take };
    const o = runFixture({ capacity });
    const out = runRedTeamOnSkip(o);
    expect(o.dispatch).not.toHaveBeenCalled();
    expect(out.dispatched).toEqual([]);
    expect(out.rows[0].why).toBe('no review capacity left');
    expect(capacity).toEqual({ lanes: 3, budget: { left: 3 }, remainingStarts: 0, take });
    expect(take).not.toHaveBeenCalled();
    expect(o.lastDispatch.size).toBe(0);
  });
  it('bounds recovery by the remaining shared host cap despite spare lanes and live-review budget', () => {
    const take = vi.fn();
    const o = runFixture({ capacity: { lanes: 5, budget: { left: 5 }, remainingStarts: 1, take } });
    for (const prNumber of [5530, 5531, 5532]) {
      o.plan.refusals.push({ kind: 'already-reviewed-head', prNumber, headSha: head });
      o.rawPrs.push({ number: prNumber, headRefOid: head, comments: [] });
    }
    const out = runRedTeamOnSkip(o);
    expect(out.dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode: 'fresh' }]);
    expect(o.dispatch).toHaveBeenCalledTimes(1);
    expect(o.capacity).toEqual({ lanes: 4, budget: { left: 4 }, remainingStarts: 0, take });
    expect(take).toHaveBeenCalledTimes(1);
    expect(out.notStarted).toHaveLength(3);
  });
  it.each(['dry-run', 'skipped', 'no-job'])('%s consumes no host start', kind => {
    const take = vi.fn();
    const o = runFixture({ capacity: { lanes: 2, budget: { left: 2 }, remainingStarts: 1, take },
      dryRun: kind === 'dry-run',
      dispatch: vi.fn(() => kind === 'skipped' ? { skipped: 'lane-cooloff' } : {}) });
    expect(runRedTeamOnSkip(o).dispatched).toEqual([]);
    expect(o.capacity.remainingStarts).toBe(1);
    expect(take).not.toHaveBeenCalled();
  });
  it('a throwing recovery dispatch consumes host capacity because a spawn may have occurred', () => {
    const take = vi.fn();
    const o = runFixture({ capacity: { lanes: 2, budget: { left: 2 }, remainingStarts: 1, take },
      dispatch: vi.fn(() => { throw Error('unknown start'); }) });
    o.plan.refusals.push({ kind: 'already-reviewed-head', prNumber: 5530, headSha: head });
    o.rawPrs.push({ number: 5530, headRefOid: head, comments: [] });
    const out = runRedTeamOnSkip(o);
    expect(out.rows[0].why).toBe('dispatch failed; start unknown');
    expect(o.dispatch).toHaveBeenCalledTimes(1);
    expect(o.capacity).toEqual({ lanes: 1, budget: { left: 1 }, remainingStarts: 0, take });
    expect(take).toHaveBeenCalledTimes(1);
  });
  it('dispatches the existing job, spends capacity and records cooldown only for starts', () => {
    const log = vi.fn(), o = runFixture({ log, preferLane: 7 }); const out = runRedTeamOnSkip(o);
    expect(o.dispatch).toHaveBeenCalledWith({ pr, repo, redTeamOnly: true, redTeamMode: 'fresh', preferLane: 7 });
    expect(out.dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode: 'fresh' }]);
    expect(o.capacity).toEqual({ lanes: 0, budget: { left: 0 } }); expect(o.lastDispatch.size).toBe(1);
    expect(log).toHaveBeenCalledTimes(1); expect(log.mock.calls[0][0]).toContain('dispatched (fresh)');
  });
  it('a skipped dispatch retains no cooldown and refunds capacity', () => {
    const o = runFixture({ dispatch: () => ({ skipped: 'lane-cooloff' }) });
    expect(runRedTeamOnSkip(o).notStarted).toEqual([{ prNumber: pr, reason: 'lane-cooloff' }]);
    expect(o.lastDispatch.size).toBe(0); expect(o.capacity.budget.left).toBe(1);
  });
  it.each([false, true])('a live-job refusal refunds only an already-counted pid (counted: %s)', counted => {
    const o = runFixture({ dispatch: () => ({ skipped: 'live-job', jobPid: 99 }),
      capacity: { lanes: 1, budget: { left: 1, countedJobPids: new Set(counted ? [99] : []) } } });
    runRedTeamOnSkip(o);
    expect(o.capacity.budget.left).toBe(counted ? 1 : 0); expect(o.lastDispatch.size).toBe(0);
  });
  it('a throw retains the reservation and becomes a row, never an exception', () => {
    const o = runFixture({ dispatch: () => { throw Error('failed'); } });
    const out = runRedTeamOnSkip(o);
    expect(out.rows[0].why).toBe('dispatch failed; start unknown');
    expect(out.uncertain).toEqual([{ prNumber: pr, reason: 'dispatch failed; start unknown' }]);
    expect(out.dispatched).toEqual([]);
    expect(o.capacity.lanes).toBe(0);
    expect(o.capacity.budget.left).toBe(0); expect(o.lastDispatch.size).toBe(0);
  });
  it('bounds starts across multiple refusals', () => {
    const o = runFixture();
    o.plan.refusals.push({ kind: 'already-reviewed-head', prNumber: 5530, headSha: head });
    o.rawPrs.push({ number: 5530, headRefOid: head, comments: [] });
    expect(runRedTeamOnSkip(o).dispatched).toHaveLength(1); expect(o.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('fresh attempt accounting', () => {
  it('counts only persisted admissions, ignoring historical error, discard and unattested ok rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'fresh-attempts-'));
    const env = { CONVEYOR_STATE_ROOT: root, WE_SHARED_RUNS_DIR: join(root, 'runs'), OPERATION_RUNS_DIR: join(root, 'runs') };
    try {
      const row = { repo, pr, rev: head, dispatchKind: 'review-seat', seat: 'red-team', status: 'error' };
      const records = [row, { ...row, status: 'skipped' }, { ...row, status: 'ok' },
        { ...row, dispatchKind: RED_TEAM_DISCARD_DISPATCH_KIND }];
      // Recovery now reports the strict row classification too: mixed historical
      // statuses neither establish provenance nor authorize a bounded retry.
      const classification = { recordedRow: true, onlyOkRows: false, onlyRetryableRows: false };
      expect(redTeamRecoveryRows(records, { repo, pr, head, env })).toEqual({ verifiedRow: null, freshAttempts: 0, ...classification });
      reserveFreshRedTeamAttempt({ repo, pr, head, at: 1, pid: 42, maxFreshPerHead: 2 }, { env });
      reserveFreshRedTeamAttempt({ repo: repo.toUpperCase(), pr, head: head.toUpperCase(), at: 2, pid: 43, maxFreshPerHead: 2 }, { env });
      expect(readFreshRedTeamAttempts({ repo, pr, head, env })).toHaveLength(2);
      expect(redTeamRecoveryRows(records, { repo, pr, head, env })).toEqual({ verifiedRow: null, freshAttempts: 2, ...classification });
      for (const identity of [{ repo: 'other/repo', pr, head }, { repo, pr: pr + 1, head }, { repo, pr, head: 'b'.repeat(40) }]) {
        expect(readFreshRedTeamAttempts({ ...identity, env })).toEqual([]);
      }
      expect(() => redTeamRecoveryRows(null, { repo, pr, head, env })).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('two admissions racing for the last slot reserve exactly one attempt', () => {
    const root = mkdtempSync(join(tmpdir(), 'fresh-attempts-'));
    const env = { CONVEYOR_STATE_ROOT: root, WE_SHARED_RUNS_DIR: join(root, 'runs'), OPERATION_RUNS_DIR: join(root, 'runs') };
    try {
      const input = { repo, pr, head, at: 1, pid: 42, maxFreshPerHead: 2 };
      const prefix = join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${pr}-${head}.fresh-attempt-`);
      mkdirSync(redTeamStatusDir(env), { recursive: true });
      writeFileSync(`${prefix}0.json`, JSON.stringify({ at: 0, pid: 41 }));
      // Both callers saw the same planner snapshot with one slot left.
      expect(redTeamRecoveryRows([], { repo, pr, head, env }).freshAttempts).toBe(1);
      expect(redTeamRecoveryRows([], { repo, pr, head, env }).freshAttempts).toBe(1);
      const outcomes = [reserveFreshRedTeamAttempt(input, { env }),
        reserveFreshRedTeamAttempt({ ...input, at: 2, pid: 43 }, { env })];
      expect(outcomes).toEqual([1, null]);
      expect(readFreshRedTeamAttempts({ repo, pr, head, env })).toHaveLength(2);
      expect(readFreshRedTeamAttempts({ repo, pr, head: 'b'.repeat(40), env })).toEqual([]);
      expect(reserveFreshRedTeamAttempt({ ...input, maxFreshPerHead: 0 }, { env })).toBeNull();
      // The replaced append ledger is no longer admission evidence.
      writeFileSync(join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${pr}-${head}.fresh-attempts.json`), '{');
      expect(redTeamRecoveryRows([], { repo, pr, head, env }).freshAttempts).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('retains the exclusively created slot after a partial write fails and never reuses it', () => {
    const root = mkdtempSync(join(tmpdir(), 'fresh-attempts-'));
    const env = { CONVEYOR_STATE_ROOT: root, WE_SHARED_RUNS_DIR: join(root, 'runs'), OPERATION_RUNS_DIR: join(root, 'runs') };
    try {
      const input = { repo, pr, head, at: 1, pid: 42, maxFreshPerHead: 2 };
      const prefix = join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${pr}-${head}.fresh-attempt-`);
      const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      const writeFile = vi.fn(fd => {
        // Exercise a real exclusive create and partial write before injecting failure.
        expect(readFileSync(`${prefix}0.json`, 'utf8')).toBe('');
        writeFileSync(fd, '{');
        throw failure;
      });
      expect(() => reserveFreshRedTeamAttempt(input, { env, writeFile })).toThrow(failure);
      expect(writeFile).toHaveBeenCalledOnce();
      expect(readFileSync(`${prefix}0.json`, 'utf8')).toBe('{');
      expect(readFreshRedTeamAttempts({ repo, pr, head, env })).toHaveLength(1);
      expect(reserveFreshRedTeamAttempt({ ...input, at: 2, pid: 43 }, { env })).toBe(1);
      expect(reserveFreshRedTeamAttempt({ ...input, at: 3, pid: 44 }, { env })).toBeNull();
      expect(readFileSync(`${prefix}0.json`, 'utf8')).toBe('{');
      expect(JSON.parse(readFileSync(`${prefix}1.json`, 'utf8'))).toEqual({ at: 2, pid: 43 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('reservation throws on non-EEXIST filesystem errors', () => {
    const root = mkdtempSync(join(tmpdir(), 'fresh-attempts-'));
    const env = { CONVEYOR_STATE_ROOT: root, WE_SHARED_RUNS_DIR: join(root, 'runs'), OPERATION_RUNS_DIR: join(root, 'runs') };
    try {
      mkdirSync(join(redTeamStatusDir(env), '..'), { recursive: true });
      writeFileSync(redTeamStatusDir(env), 'not a directory');
      expect(() => reserveFreshRedTeamAttempt({ repo, pr, head, at: 1, pid: 42, maxFreshPerHead: 2 }, { env })).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each(['corrupt', 'malformed-attempt', 'unreadable'])('counts a %s attempt slot as used in the reader and planner', kind => {
    const root = mkdtempSync(join(tmpdir(), 'fresh-attempts-'));
    const env = { CONVEYOR_STATE_ROOT: root, WE_SHARED_RUNS_DIR: join(root, 'runs'), OPERATION_RUNS_DIR: join(root, 'runs') };
    try {
      const path = join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${pr}-${head}.fresh-attempt-0.json`);
      mkdirSync(redTeamStatusDir(env), { recursive: true });
      if (kind === 'unreadable') mkdirSync(path);
      else writeFileSync(path, kind === 'corrupt' ? '{' : JSON.stringify({ at: -1, pid: 42 }));
      expect(readFreshRedTeamAttempts({ repo, pr, head, env })).toHaveLength(1);
      expect(redTeamRecoveryRows([], { repo, pr, head, env }).freshAttempts).toBe(1);
      expect(decide({ readRecoveryRows: input => redTeamRecoveryRows([], { ...input, env }) }))
        .toMatchObject({ action: 'dispatch' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});


describe('withheld saved red-team result (live #5759 shape)', () => {
  const withheld = { status: 'finished', result: { status: 'ran', foldedVerdict: 'changes', comment: { status: 'withheld' } }, updatedAtMs: 1 };
  const live = { readStatus: () => withheld, readRecoveryRows: () => ({ verifiedRow: null, freshAttempts: 2 }),
    readSavedResult: () => ({ pr, rev: head, findings: [] }) };
  it('applies the gate from the saved result instead of reporting attempts exhausted', () => {
    expect(decide(live)).toMatchObject({ action: 'apply-gate' });
  });
  it('applies the gate for a withheld finished result with valid parked-at-confirm provenance', () => {
    const root = mkdtempSync(join(tmpdir(), 'withheld-parked-red-team-'));
    try {
      const runsDir = join(root, 'runs'); mkdirSync(runsDir);
      const env = { CONVEYOR_STATE_ROOT: root, OPERATION_RUNS_DIR: runsDir,
        WE_RED_TEAM_DRAIN_READS_SAVED_RESULT: 'true' };
      const rows = [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head,
        status: 'ok', recheckStatus: 'ok', confirmedMissCount: 0, findings: [] }];
      const path = resolveScorecardStorePath(env); mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ version: 1, records: rows }));
      const run = provenanceRun({ env, rows });
      run.cursor = reviewPrStepNames().indexOf('confirm');
      run.pending = { kind: 'confirm', step: 'confirm', stepIndex: run.cursor };
      run.verdict = { verdict: 'needs-human', humanRequired: true };
      writeRun(run, runsDir);
      expect(decide({ ...live,
        readSavedResult: input => readSavedRedTeamGateResult({ ...input, env }),
      })).toMatchObject({ action: 'apply-gate' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('fails closed when the saved result is missing or for another head', () => {
    expect(decide({ ...live, readSavedResult: () => null }).action).toBe('skip');
    expect(decide({ ...live, readSavedResult: () => ({ pr, rev: 'b'.repeat(40), findings: [] }) }).action).toBe('skip');
  });
  it('never dispatches a fresh pass for it, and respects the retry cooldown between gate applications', () => {
    const applyGate = vi.fn(() => ({ status: 'applied' })), dispatch = vi.fn(), history = new Map();
    const run = at => runRedTeamOnSkip({ repo, plan: { refusals: fixture().refusals }, rawPrs: fixture().rawPrs, capacity: { lanes: 1 }, dispatch, applyGate,
      readEvidence: () => ({ loopPayload: payload() }), readStatus: live.readStatus, readRecoveryRows: live.readRecoveryRows, readSavedResult: live.readSavedResult,
      now: () => at, setting: fixture().setting, history, lastDispatch: new Map() });
    run(2_000_000); run(2_000_000 + 60_000);
    expect(applyGate).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('daemon recovery shares host admission', () => {
  function tickFixture(over = {}) {
    const f = runFixture();
    return { repo, reconcile: () => ({ dispatch: [], ...f.plan }),
      readPrs: () => f.rawPrs, readAgents: () => [], holdReconcile: () => [],
      tagRound: vi.fn(), tagStatus: vi.fn(), statusCandidates: () => [], acquirableLanes: () => 5,
      liveReviewBudget: { left: 5 },
      redTeamOnSkip: input => runRedTeamOnSkip({ ...f, ...input }), ...over };
  }
  it.each(['denied', 'unreadable'])('a recovery-only tick checks host admission and refuses %s capacity', kind => {
    const dispatch = vi.fn(() => ({ jobPid: 42 }));
    const hostAdmission = vi.fn(() => {
      if (kind === 'unreadable') throw Error('host reading failed');
      return { admitted: false, reason: 'host memory low' };
    });
    const f = runFixture({ dispatch });
    const options = tickFixture({ hostAdmission, redTeamOnSkip: input => runRedTeamOnSkip({ ...f, ...input }) });
    const out = runReviewTick(options);
    expect(hostAdmission).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
    expect(out.redTeamOnSkip.rows[0]).toMatchObject({ action: 'skip', why: 'no review capacity left' });
    expect(options.liveReviewBudget.left).toBe(5);
    expect(f.lastDispatch.size).toBe(0);
  });
  it.each(['started', 'unknown', 'skipped'])('a %s recovery shares the host cap with ordinary reviews in later repos', kind => {
    const recoveryDispatch = vi.fn(() => {
      if (kind === 'unknown') throw Error('spawn may have occurred');
      return kind === 'skipped' ? { skipped: 'lane-cooloff' } : { jobPid: 42 };
    });
    const f = runFixture({ dispatch: recoveryDispatch });
    const dispatch = vi.fn(() => ({ jobPid: 43 }));
    const hostAdmission = vi.fn(() => ({ admitted: true, maxPerTick: 1 }));
    const options = tickFixture({ dispatch, hostAdmission,
      reconcile: ({ repo: target }) => target === repo ? { dispatch: [], ...f.plan }
        : { dispatch: [{ kind: 'review', prNumber: 99 }], refusals: [] },
      redTeamOnSkip: input => runRedTeamOnSkip({ ...f, ...input }),
    });
    runReviewTickAllRepos({ ...options, repos: [repo, 'other/repo'],
      authGateOverride: () => ({ paused: false, reason: null }) });
    expect(hostAdmission).toHaveBeenCalledOnce();
    expect(recoveryDispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledTimes(kind === 'skipped' ? 1 : 0);
    expect(options.liveReviewBudget.left).toBe(4);
  });
  it('ordinary reviews spend the per-tick host allowance before recovery', () => {
    const f = runFixture();
    const dispatch = vi.fn(() => ({ jobPid: 43 }));
    const out = runReviewTick(tickFixture({ dispatch,
      reconcile: () => ({ ...f.plan, dispatch: [{ kind: 'review', prNumber: 99 }] }),
      hostAdmission: () => ({ admitted: true, maxPerTick: 1 }),
      redTeamOnSkip: input => runRedTeamOnSkip({ ...f, ...input }),
    }));
    expect(dispatch).toHaveBeenCalledOnce();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(out.redTeamOnSkip.rows[0]).toMatchObject({ action: 'skip', why: 'no review capacity left' });
  });
  it('the current CLI effects factory wires recovery through runRedTeamOnSkip', () => {
    const log = { error: vi.fn() };
    const effects = cliReviewTickOpts({ log });
    const f = runFixture({ dryRun: true });
    const out = effects.redTeamOnSkip(f);
    expect(out.rows[0]).toMatchObject({ action: 'skip', why: 'dry run (fresh)' });
    expect(out.dispatched).toEqual([]);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('red team not dispatched'));
  });
});
