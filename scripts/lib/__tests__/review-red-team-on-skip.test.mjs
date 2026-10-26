import { proveCardOnlyHeadMove } from '../card-only-head-move.mjs';
import * as numbering from '../numbering-carry.mjs';
import { describe, it, expect, vi } from 'vitest';
import { cardOnlyHeadMoveCandidate, normalizeRedTeamResult, planRedTeamOnSkip, runRedTeamOnSkip, resolveReviewRedTeamOnSkip } from '../review-red-team-on-skip.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { resetCascadeLogForTest } from '../policy-cascade.mjs';
import { readDrainRedTeamEvidence } from '../drain-red-team-evidence.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const repo = 'web-everything/web-everything', head = 'a'.repeat(40), pr = 5762;
const payload = () => ({ verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head } } } });
function fixture(over = {}) {
  return { repo, refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }],
    rawPrs: [{ number: pr, headRefOid: head, comments: [] }],
    readEvidence: () => ({ loopPayload: payload(), recorded: false }), readStatus: () => null,
    now: 2_000_000, setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: new Map(), ...over };
}
const decide = over => planRedTeamOnSkip(fixture(over))[0];

describe('planRedTeamOnSkip — heal a previously skipped card-only head', () => {
  const cardPayload = () => {
    const loopPayload = payload();
    Object.assign(loopPayload.findings.read, { diffText: 'diff --git a/backlog/5872-card.md b/backlog/5872-card.md\n+update', netChangedFiles: ['backlog/5872-card.md'], netRenameSources: [] });
    return loopPayload;
  };
  const heal = (over = {}) => ({
    readEvidence: () => ({ loopPayload: cardPayload(), recorded: false }),
    readStatus: () => ({ status: 'finished', head, result: 'skipped', skipCardOnly: true, loopPayload: cardPayload() }),
    ...over,
  });

  it.each(['skipped', { status: 'skipped', policy: 'card-only' }])(
    'legacy string or explicit card-only object %j dispatches fresh', result => {
      expect(decide(heal({ readStatus: () => ({ status: 'finished', head, result, skipCardOnly: true, loopPayload: cardPayload() }) })))
        .toMatchObject({ action: 'dispatch', mode: 'fresh' });
    });

  it.each([{ status: 'skipped' }, { status: 'skipped', reason: 'quota exhausted' },
    { status: 'skipped', reason: 'red team skipped: card-only' }])(
    'policy-absent object %j never heals even with a complete card-only read', result => {
      expect(decide(heal({ readStatus: () => ({ status: 'finished', head, result, skipCardOnly: true, loopPayload: cardPayload() }) })))
        .toMatchObject({ action: 'skip', why: 'prior result skipped (status finished); not re-run' });
    });

  it.each(['other', null, false, ''])('does not heal an explicit non-card-only policy %j', policy => {
    const result = { status: 'skipped', policy, reason: 'quota exhausted' };
    expect(decide(heal({ readStatus: () => ({ status: 'finished', head, result, skipCardOnly: true, loopPayload: cardPayload() }) })))
      .toMatchObject({ action: 'skip', why: 'prior result skipped (status finished); not re-run' });
  });

  it.each([
    { diffText: '' }, { diffText: '  \n ' }, { diffText: undefined },
    { netBasis: { rev: 'b'.repeat(40) } }, { netBasis: {} },
  ])('does not heal incomplete or mismatched stored read %j', read => {
    const loopPayload = cardPayload(); Object.assign(loopPayload.findings.read, read);
    expect(decide(heal({ readStatus: () => ({ status: 'finished', head, result: 'skipped', skipCardOnly: true, loopPayload }) })))
      .toMatchObject({ action: 'skip', why: 'prior result skipped (status finished); not re-run' });
  });

  it('non-card-only skipped status still skips with its existing not-re-run reason', () => {
    const loopPayload = cardPayload();
    loopPayload.findings.read.netChangedFiles = ['scripts/example.mjs'];
    expect(decide(heal({ readEvidence: () => ({ loopPayload, recorded: false }),
      readStatus: () => ({ status: 'finished', head, result: 'skipped', skipCardOnly: true, loopPayload }) })))
      .toMatchObject({ action: 'skip', why: 'prior result skipped (status finished); not re-run' });
  });

  it('a trusted comment already on the head skips healing before reading evidence', () => {
    const body = renderRedTeamComment({ pr, rev: head, provider: 'codex', model: 'm', findings: [], foldedVerdict: 'accept' });
    const readEvidence = vi.fn();
    expect(decide(heal({ rawPrs: [{ number: pr, headRefOid: head, comments: [{ body, author: { login: 'web-everything' } }] }], readEvidence })))
      .toMatchObject({ action: 'skip', why: 'red-team result already on head' });
    expect(readEvidence).not.toHaveBeenCalled();
  });

  it.each([false, undefined, 'true'])('fails closed when stored skipCardOnly is %j instead of true', skipCardOnly => {
    expect(decide(heal({ readStatus: () => ({ status: 'finished', head, result: 'skipped', skipCardOnly, loopPayload: cardPayload() }) })).action).toBe('skip');
  });

  it.each(['queued', 'running'])('does not heal an unfinished %s skip', status => {
    expect(decide(heal({ readStatus: () => ({ status, head, result: 'skipped', skipCardOnly: true, loopPayload: cardPayload() }) })).action).toBe('skip');
  });

  it.each([
    { netChangedFiles: [] },
    { netChangedFiles: null },
    { netChangedFiles: ['backlog/5872-card.md'], netRenameSources: ['scripts/moved-code.mjs'] },
    { netChangedFiles: ['backlog/5872-card.md'], netRenameSources: 'unreadable' },
  ])('does not heal unknown or non-card-only net paths %j', paths => {
    const loopPayload = cardPayload(); Object.assign(loopPayload.findings.read, paths);
    expect(decide(heal({ readEvidence: () => ({ loopPayload, recorded: false }),
      readStatus: () => ({ status: 'finished', head, result: 'skipped', skipCardOnly: true, loopPayload }) })).action).toBe('skip');
  });

  it('card-only healing still observes the recovery cooldown', () => {
    const lastDispatch = new Map([[`${repo}#${pr}@${head}`, 200_001]]);
    expect(decide(heal({ lastDispatch })).why).toBe('retry cooldown active');
  });
});

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
    expect(decide({ readEvidence: () => ({ loopPayload: payload(), recorded: true, completedRecorded: true }),
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
    expect(decide({ readEvidence: () => ({ loopPayload: payload(), recorded: true, completedRecorded: true }),
      readStatus: () => ({ status: 'finished', result: 'ran' }) })).toMatchObject({ action: 'dispatch', mode: 'resume' });
  });
  it('f: missing recorded evidence cannot authorize a fresh pass', () => {
    expect(decide({ readEvidence: () => ({ loopPayload: payload() }) }).action).toBe('skip');
  });
  it('f: fresh dispatch only when neither status nor row exists', () => {
    expect(decide()).toMatchObject({ action: 'dispatch', mode: 'fresh' });
  });
  it.each(['error', 'skipped', 'disabled', 'not-owed', 'ran', 'resumed', null])('f: handles an unrecorded prior result %s according to its run evidence', prior => {
    expect(decide({ readStatus: () => ({ status: 'finished', result: prior }) }).action)
      .toBe(['ran', 'resumed'].includes(prior) ? 'dispatch' : 'skip');
    expect(decide({ readStatus: () => ({ status: 'finished', result: { status: prior } }) }).action)
      .toBe(prior === 'resumed' ? 'dispatch' : 'skip');
  });
  it.each(['ran', 'resumed', { status: 'resumed' }])('f: %j without a seat result dispatches fresh', result => {
    expect(decide({ readStatus: () => ({ status: 'finished', result }) }))
      .toMatchObject({ action: 'dispatch', mode: 'fresh' });
  });
  it.each([undefined, 'finished', 'running'])('f: a null completion without queued provenance skips (stored status %s)', storedStatus => {
    const status = { status: 'finished', result: null };
    expect(decide({ readStatus: () => status,
      readEvidence: () => ({ loopPayload: payload(), recorded: false, seatRecorded: false,
        ...(storedStatus ? { status: { ...status, status: storedStatus } } : {}) }) }))
      .toMatchObject({ action: 'skip', why: 'prior result unknown (status finished); not re-run' });
  });
  it('f: a normalized null completion with original queued evidence dispatches fresh', () => {
    expect(decide({ readStatus: () => ({ status: 'finished', result: null }),
      readEvidence: () => ({ loopPayload: payload(), recorded: false, seatRecorded: false,
        status: { status: 'queued', result: null } }) }))
      .toMatchObject({ action: 'dispatch', mode: 'fresh' });
  });
  it('f: a real ran payload without a scorecard never launches another model call', () => {
    expect(decide({ readStatus: () => ({ status: 'finished', result: { status: 'ran' } }) }).action).toBe('skip');
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
    expect(resolved.value).toEqual({ enabled: true, retryCooldownMin: 30 });
    expect(resolved.sources).toMatchObject({ enabled: 'tool', retryCooldownMin: 'tool' });
  });
  it('environment disables recovery and logs its source', () => {
    resetCascadeLogForTest(); const log = vi.fn();
    const resolved = resolveReviewRedTeamOnSkip({ env: { WE_REVIEW_RED_TEAM_ON_SKIP: '0', WE_POLICY_CASCADE_LOG: '1' },
      readFile: () => '{"enabled":true}', log });
    expect(resolved.value.enabled).toBe(false);
    expect(resolved.sources.enabled).toBe('env');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('enabled=false (env)'));
  });
  it('malformed tool and environment values retain lower layers', () => {
    const resolved = resolveReviewRedTeamOnSkip({ env: { WE_REVIEW_RED_TEAM_ON_SKIP: 'garbage', WE_REVIEW_RED_TEAM_ON_SKIP_RETRY_COOLDOWN_MIN: '-1', WE_PLATFORM_PREFERENCES_FILE: '/missing-test-policy' },
      readFile: () => '{"enabled":"bad","retryCooldownMin":-1}' });
    expect(resolved.value).toEqual({ enabled: true, retryCooldownMin: 30 });
  });
});

function runFixture(over = {}) {
  const f = fixture();
  return { repo, plan: { refusals: f.refusals }, rawPrs: f.rawPrs, setting: f.setting,
    readEvidence: f.readEvidence, readStatus: f.readStatus, now: () => f.now, lastDispatch: f.lastDispatch,
    capacity: { lanes: 1, budget: { left: 1 } }, dispatch: vi.fn(() => ({ jobPid: 42 })), ...over };
}
describe('runRedTeamOnSkip', () => {
  it.each(['finished-error', 'missing'])('an error seat row with %s status skips without dispatch', kind => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-skip-'));
    try {
      const evidence = readDrainRedTeamEvidence({ repo, pr, head,
        env: { WE_SHARED_RUNS_DIR: join(dir, 'runs') }, list: () => [],
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
    expect(runRedTeamOnSkip(o).rows[0].why).toBe('dispatch failed; start unknown');
    expect(o.capacity.budget.left).toBe(0); expect(o.lastDispatch.size).toBe(0);
  });
  it('bounds starts across multiple refusals', () => {
    const o = runFixture();
    o.plan.refusals.push({ kind: 'already-reviewed-head', prNumber: 5530, headSha: head });
    o.rawPrs.push({ number: 5530, headRefOid: head, comments: [] });
    expect(runRedTeamOnSkip(o).dispatched).toHaveLength(1); expect(o.dispatch).toHaveBeenCalledTimes(1);
  });
});


describe('PR 5890 review-pr status payloads', () => {
  it('a finished string resumed result survives normalization and resumes with completed seat evidence', () => {
    const status = { status: 'finished', result: 'resumed' };
    expect(normalizeRedTeamResult(status.result)).toEqual({ priorResult: 'resumed', priorComment: undefined });
    expect(decide({ readStatus: () => status,
      readEvidence: () => ({ loopPayload: payload(), recorded: true, completedRecorded: true }) }))
      .toMatchObject({ action: 'dispatch', mode: 'resume' });
  });
  it.each(['resumed', 'ran', { status: 'resumed' }])('review-pr row %j with no seat dispatches fresh', result => {
    const loopPayload = { ...payload(), op: 'review-pr' };
    const row = { repo, pr: 5762, head, status: 'finished', result, loopPayload };
    expect(decide({ readStatus: () => row })).toMatchObject({ action: 'dispatch', mode: 'fresh' });
  });
  it('bare resumed with a clean seat dispatches from that seat', () => {
    const row = { repo, pr: 5762, head, status: 'finished', result: 'resumed', loopPayload: { ...payload(), op: 'review-pr' } };
    expect(decide({ readStatus: () => row,
      readEvidence: () => ({ loopPayload: payload(), recorded: true, cleanRecorded: true }) }))
      .toMatchObject({ action: 'dispatch', mode: 'resume' });
  });
  it('an incomplete seat cannot authorize legacy string ran recovery', () => {
    expect(decide({ readStatus: () => ({ repo, pr, head, status: 'finished', result: 'ran', loopPayload: { ...payload(), op: 'review-pr' } }),
      readEvidence: () => ({ loopPayload: payload(), recorded: true, seatRecorded: true, completedRecorded: false }) }).action).toBe('skip');
  });
  it('a completed seat with confirmed breaks resumes effects without authorizing another model call', () => {
    expect(decide({ readStatus: () => ({ repo, pr, head, status: 'finished', result: 'ran', loopPayload: { ...payload(), op: 'review-pr' } }),
      readEvidence: () => ({ loopPayload: payload(), recorded: true, seatRecorded: true, completedRecorded: true }) }))
      .toMatchObject({ action: 'dispatch', mode: 'resume' });
  });
});


describe('card-only head move recovery', () => {
  const fromSha = 'b'.repeat(40);
  const oldPayload = () => ({ verdict: { verdict: 'changes' }, findings: { read: {
    netBasis: { rev: fromSha }, diffText: '+card', netChangedFiles: ['backlog/123-card.md'],
  } } });
  const oldEvidence = () => {
    const loopPayload = oldPayload();
    return { loopPayload, recorded: false, seatRecorded: false, completedRecorded: false, inFlight: false,
      status: { head: fromSha, status: 'finished', result: 'skipped', skipCardOnly: true, loopPayload: structuredClone(loopPayload) } };
  };
  // One row per top-level conjunct of cardOnlyHeadMoveCandidate. Keep this list
  // aligned with the predicate so overlapping planner guards cannot hide a missing check.
  it.each([
    // Real-head validity is also implied by the matching-head and settleable-status guards.
    ['real read head', e => { e.loopPayload.findings.read.netBasis.rev = 'unknown'; }],
    ['moved read head', e => { e.loopPayload.findings.read.netBasis.rev = head; e.status.head = head; e.status.loopPayload.findings.read.netBasis.rev = head; }],
    ['card-only read', e => { e.loopPayload.findings.read.netChangedFiles = ['scripts/code.mjs']; }],
    ['settleable skip', e => { e.status.result = 'ran'; }],
    ['matching status head', e => { e.status.head = 'c'.repeat(40); e.status.loopPayload.findings.read.netBasis.rev = e.status.head; }],
    ['no recorded result', e => { e.recorded = true; }],
    ['no recorded seat', e => { e.seatRecorded = true; }],
    ['not in flight', e => { e.inFlight = true; }],
    ['not queued', e => { e.queued = true; }],
  ])('moved candidate requires %s', (_clause, mutate) => {
    const evidence = oldEvidence();
    expect(cardOnlyHeadMoveCandidate(evidence, head)).toBe(true);
    mutate(evidence);
    expect(cardOnlyHeadMoveCandidate(evidence, head)).toBe(false);
  });
  it.each(['numbering-only', 'card-only'])('%s move dispatches fresh despite a not-owed old review', kind => {
    const proveMove = vi.fn(() => ({ ok: true, kind }));
    expect(decide({ readEvidence: oldEvidence, proveMove })).toMatchObject({ action: 'dispatch', mode: 'fresh' });
    expect(proveMove).toHaveBeenCalledWith({ fromSha, toSha: head });
  });
  it.each(['code change', 'unprovable move'])('keeps the skip for %s', reason => {
    expect(decide({ readEvidence: oldEvidence, proveMove: () => ({ ok: false, reason }) }).action).toBe('skip');
  });
  it.each([
    { recorded: true }, { seatRecorded: true }, { inFlight: true }, { queued: true },
    { status: null }, { completedRecorded: true },
  ])('does not dispatch with existing or unknown evidence %j', over => {
    expect(decide({ readEvidence: () => ({ ...oldEvidence(), ...over }), proveMove: () => ({ ok: true }) }).action).toBe('skip');
  });
  it.each(['missing head', 'status head mismatch', 'code read', 'not skipped', 'skip disabled'])('refuses %s provenance', kind => {
    const evidence = oldEvidence();
    if (kind === 'missing head') delete evidence.loopPayload.findings.read.netBasis.rev;
    if (kind === 'status head mismatch') {
      evidence.status.head = 'c'.repeat(40);
      evidence.status.loopPayload.findings.read.netBasis.rev = evidence.status.head;
    }
    if (kind === 'code read') evidence.loopPayload.findings.read.netChangedFiles = ['scripts/code.mjs'];
    if (kind === 'not skipped') evidence.status.result = 'ran';
    if (kind === 'skip disabled') evidence.status.skipCardOnly = false;
    expect(decide({ readEvidence: () => evidence, proveMove: () => ({ ok: true }) }).action).toBe('skip');
  });
  it('observes cooldown and existing live-head state after the proof', () => {
    const base = { readEvidence: oldEvidence, proveMove: () => ({ ok: true }) };
    expect(decide({ ...base, lastDispatch: new Map([[`${repo}#${pr}@${head}`, 200_001]]) }).why).toBe('retry cooldown active');
    expect(decide({ ...base, readStatus: () => ({ status: 'finished' }) }).action).toBe('skip');
  });
  it('runner uses the injected move proof and dispatches the normal red-team-only job', () => {
    const dispatch = vi.fn(() => ({ jobPid: 42 }));
    const out = runRedTeamOnSkip({ ...fixture(), plan: { refusals: fixture().refusals },
      now: () => 2_000_000, readEvidence: oldEvidence, proveMove: () => ({ ok: true }),
      capacity: { lanes: 1 }, dispatch });
    expect(out.dispatched).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledWith({ repo, pr, redTeamOnly: true, redTeamMode: 'fresh' });
  });
  it('runner default move proof forwards exec, cwd and mainRef to the numbering proof', () => {
    const exec = vi.fn(), cwd = '/fixture/checkout', mainRef = 'fixture/main';
    const detector = vi.spyOn(numbering, 'proveNumberingOnlyMove').mockReturnValue({ ok: true, kind: 'numbering-only' });
    try {
      const dispatch = vi.fn(() => ({ jobPid: 42 }));
      const out = runRedTeamOnSkip({ ...fixture(), plan: { refusals: fixture().refusals },
        now: () => 2_000_000, readEvidence: oldEvidence, exec, cwd, mainRef,
        capacity: { lanes: 1 }, dispatch, lastDispatch: new Map() });
      expect(out.dispatched).toHaveLength(1);
      expect(detector).toHaveBeenCalledWith({ exec, cwd, mainRef, fromSha, toSha: head });
      expect(dispatch).toHaveBeenCalledWith({ repo, pr, redTeamOnly: true, redTeamMode: 'fresh' });
    } finally { detector.mockRestore(); }
  });
  it('runner default move proof executes the card-path proof with its supplied cwd', () => {
    const cwd = '/fixture/checkout';
    const exec = vi.fn((file, args, options) => {
      expect(file).toBe('git');
      expect(options.cwd).toBe(cwd);
      if (args[0] === 'merge-base') return '';
      if (args[0] === 'rev-list') return `${head} ${fromSha}`;
      if (args[0] === 'diff-tree') return 'backlog/123-card.md\0';
      throw Error('not numbering');
    });
    const out = runRedTeamOnSkip({ ...fixture(), plan: { refusals: fixture().refusals },
      now: () => 2_000_000, readEvidence: oldEvidence, exec, cwd, lastDispatch: new Map(),
      capacity: { lanes: 1 }, dispatch: () => ({ jobPid: 42 }) });
    expect(out.dispatched).toHaveLength(1);
    expect(exec).toHaveBeenCalledWith('git', expect.arrayContaining(['diff-tree', head]), expect.objectContaining({ cwd }));
  });
});

describe('proveCardOnlyHeadMove', () => {
  const fromSha = 'b'.repeat(40), toSha = head;
  it('reuses the numbering detector before checking card paths', () => {
    const proof = { ok: true, kind: 'numbering-only' };
    const detector = vi.spyOn(numbering, 'proveNumberingOnlyMove').mockReturnValue(proof);
    const exec = vi.fn();
    try {
      expect(proveCardOnlyHeadMove({ exec, fromSha, toSha, cwd: 'checkout', mainRef: 'main' })).toBe(proof);
      expect(detector).toHaveBeenCalledWith({ exec, fromSha, toSha, cwd: 'checkout', mainRef: 'main' });
      expect(exec).not.toHaveBeenCalled();
    } finally { detector.mockRestore(); }
  });
  it('carries a renumber plus docs id rewrite through the real numbering detector', () => {
    const zero = '0'.repeat(40), beforeOid = '1'.repeat(40), afterOid = '2'.repeat(40);
    const docBeforeOid = '3'.repeat(40), docAfterOid = '4'.repeat(40);
    const blobs = new Map([[beforeOid, '---\ntitle: card\n---\n'], [afterOid, '---\nbornAs: xabcdef\ntitle: card\n---\n'],
      [docBeforeOid, 'See xabcdef.\n'], [docAfterOid, 'See 123.\n']]);
    const exec = vi.fn((file, args, options) => {
      expect(file).toBe('git');
      expect(options.cwd).toBe('checkout');
      let output;
      if (args[0] === 'cat-file') {
        if (args[1] === '-e') output = '';
        else {
          const blob = blobs.get(args[2]);
          if (blob === undefined) throw Error('unknown blob');
          output = args[1] === '-t' ? 'blob\n' : args[1] === '-s' ? `${Buffer.byteLength(blob)}\n` : blob;
        }
      } else if (args[0] === 'rev-parse') output = fromSha;
      else if (args[0] === 'rev-list') output = `${toSha} ${fromSha}\n`;
      else if (args[0] === 'log') output = 'drain: JIT-number xabcdef→#123 at land (#2288)\n';
      else if (['ls-tree', 'grep'].includes(args[0])) output = '';
      else if (args[0] === 'diff-tree') output = [
        `:100644 000000 ${beforeOid} ${zero} D\0backlog/xabcdef-card.md\0`,
        `:000000 100644 ${zero} ${afterOid} A\0backlog/123-card.md\0`,
        `:100644 100644 ${docBeforeOid} ${docAfterOid} M\0docs/agent/testing.md\0`,
      ].join('');
      else throw Error(`unexpected Git read: ${args[0]}`);
      return options.encoding === null ? Buffer.from(output) : output;
    });
    expect(proveCardOnlyHeadMove({ exec, fromSha, toSha, cwd: 'checkout', mainRef: 'fixture/main' }))
      .toMatchObject({ ok: true, commits: [toSha], pairs: [['xabcdef', '123']] });
    expect(exec).toHaveBeenCalledWith('git', expect.arrayContaining(['ls-tree', 'fixture/main']), expect.anything());
    expect(exec.mock.calls.some(([, args]) => args[0] === 'merge-base')).toBe(false);
  });
  const c1 = 'c'.repeat(40);
  const fake = ({ ancestor = true, revList = `${c1} ${fromSha}`, tree }) => vi.fn((file, args) => {
    if (args[0] === 'merge-base') { if (!ancestor) throw Error('not ancestor'); return ''; }
    if (args[0] === 'rev-list') return revList;
    if (args[0] === 'diff-tree') return tree;
    throw Error('not numbering');
  });
  const history = count => Array.from({ length: count }, (_, i) => (i + 1).toString(16).padStart(40, '0'));
  const revListFor = commits => commits.map((sha, i) => `${sha} ${commits[i + 1] ?? fromSha}`).join('\n');
  it('accepts exactly 20 card-only commits and inspects every commit within bounded Git calls', () => {
    const commits = history(20), exec = fake({ revList: revListFor(commits), tree: 'backlog/123-card.md\0' });
    expect(proveCardOnlyHeadMove({ exec, fromSha, toSha: commits[0], cwd: 'checkout' })).toMatchObject({ ok: true, kind: 'card-only' });
    expect(exec.mock.calls.filter(([, args]) => args[0] === 'diff-tree').map(([, args]) => args.at(-1))).toEqual(commits);
    expect(exec).toHaveBeenCalledWith('git', ['rev-list', '--max-count=21', '--parents', `${fromSha}..${commits[0]}`],
      expect.objectContaining({ cwd: 'checkout', timeout: 10_000, maxBuffer: 1024 * 1024 }));
  });
  it('rejects a history over MAX_COMMITS', () => {
    for (const count of [20, 21]) {
      const commits = history(count), exec = fake({ revList: revListFor(commits), tree: 'backlog/123-card.md\0' });
      expect(proveCardOnlyHeadMove({ exec, fromSha, toSha: commits[0] }).ok, `${count} card-only commits`).toBe(count === 20);
      expect(exec.mock.calls.filter(([, args]) => args[0] === 'diff-tree')).toHaveLength(count === 20 ? 20 : 0);
    }
  });
  it.each(['', c1])('rejects empty or zero-parent history %j', revList => {
    expect(proveCardOnlyHeadMove({ exec: fake({ revList, tree: 'backlog/123-card.md\0' }), fromSha, toSha }).ok).toBe(false);
  });
  it('rejects an intermediate non-card commit', () => {
    // Both two-commit orders reject first-only/last-only inspection; the middle of three rejects endpoints-only inspection.
    for (const [count, badIndex] of [[2, 0], [2, 1], [3, 0], [3, 1], [3, 2]]) {
      const commits = history(count);
      const exec = fake({ revList: revListFor(commits), tree: 'backlog/123-card.md\0' });
      const read = exec.getMockImplementation();
      exec.mockImplementation((file, args, options) => args[0] === 'diff-tree' && args.at(-1) === commits[badIndex]
        ? 'scripts/code.mjs\0' : read(file, args, options));
      expect(proveCardOnlyHeadMove({ exec, fromSha, toSha: commits[0] }).ok,
        `non-card commit at index ${badIndex} of ${count}`).toBe(false);
    }
  });
  it('requires --no-renames and sees a code-to-card rename', () => {
    const exec = fake({ revList: `${toSha} ${fromSha}`, tree: 'backlog/123-card.md\0' }), read = exec.getMockImplementation();
    exec.mockImplementation((file, args, options) => args[0] === 'diff-tree' && args.includes('--no-renames')
      ? 'scripts/code.mjs\0backlog/123-card.md\0' : read(file, args, options));
    expect(proveCardOnlyHeadMove({ exec, fromSha, toSha }).ok).toBe(false);
    expect(exec).toHaveBeenCalledWith('git', expect.arrayContaining(['diff-tree', '--no-renames', toSha]), expect.anything());
  });
  it.each([
    ['backlog/123-card.md\0', true],
    ['backlog/123-card.md\0scripts/code.mjs\0', false],
    ['scripts/code.mjs\0backlog/123-moved.md\0', false],
    ['', false], ['backlog/123-card.md', false], ['x'.repeat(1024 * 1024 + 1) + '\0', false],
  ])('fails closed unless every commit contains only card paths (case %#)', (tree, ok) => {
    const exec = fake({ tree });
    expect(proveCardOnlyHeadMove({ exec, fromSha, toSha, cwd: 'checkout' }).ok).toBe(ok);
  });
  it('refuses a non-descendant head, a merge commit, and submodule-blind diffs', () => {
    expect(proveCardOnlyHeadMove({ exec: fake({ ancestor: false, tree: 'backlog/1-a.md\0' }), fromSha, toSha }).ok).toBe(false);
    expect(proveCardOnlyHeadMove({ exec: fake({ revList: `${c1} ${fromSha} ${'d'.repeat(40)}`, tree: 'backlog/1-a.md\0' }), fromSha, toSha }).ok).toBe(false);
    const exec = fake({ tree: 'backlog/1-a.md\0' });
    proveCardOnlyHeadMove({ exec, fromSha, toSha });
    expect(exec).toHaveBeenCalledWith('git', expect.arrayContaining(['diff-tree', '--ignore-submodules=none', '--no-ext-diff']), expect.anything());
  });
  it('refuses missing heads and unreadable Git evidence', () => {
    const exec = () => { throw Error('missing commit'); };
    expect(proveCardOnlyHeadMove({ exec, toSha }).ok).toBe(false);
    expect(proveCardOnlyHeadMove({ exec, fromSha, toSha }).ok).toBe(false);
  });
});
