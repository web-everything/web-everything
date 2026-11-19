import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newJobBlock } from '../../operations/job-record.mjs';
import { newRunRecord, writeRun, runPath } from '../../operations/run-store.mjs';
import { abandonedPath, hasRejectingReviewVerdict, isRunAbandoned, markRunAbandoned } from '../run-abandoned.mjs';
import { reapDeadReviewRuns } from '../reap-dead-review-runs.mjs';
import { readDrainRedTeamEvidence, readRecoveryWitness } from '../drain-red-team-evidence.mjs';
import { readAbandonedReviewSignal } from '../abandoned-review-signal.mjs';
import { runRedTeamOnSkip } from '../review-red-team-on-skip.mjs';
import { renderReviewNotice } from '../review-core.mjs';

const now = Date.parse('2026-11-08T12:00:00Z'), minute = 60000;
const repo = 'fixture/repo', pr = 7120, head = 'a'.repeat(40), id = 'review-pr-833c6183';
let root, dir, env, probes;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'review-abandon-round3-'));
  dir = join(root, 'runs'); mkdirSync(dir);
  env = { OPERATION_RUNS_DIR: dir, WE_SHARED_RUNS_DIR: dir, WE_PLATFORM_PREFERENCES_FILE: join(dir, 'preferences.json') };
  probes = { reviewJobs: () => [], pidIdentity: () => ({ alive: false }), leases: () => '[]', sessions: () => '[]' };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function record(more = {}, age = 31 * minute) {
  const run = { ...newRunRecord({ id, op: 'review-pr', input: { repo, pr } }),
    pending: { kind: 'judge', step: 'judge', stepIndex: 2 },
    findings: { read: { netBasis: { rev: head } } },
    stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(now - age - minute).toISOString() }], ...more };
  writeRun(run, dir);
  utimesSync(runPath(run.id, dir), (now - age) / 1000, (now - age) / 1000);
  return run;
}
const sweep = over => reapDeadReviewRuns({ env, dir, now, probes, log: () => {}, apply: true, ...over });
const gate = reader => reader({ repo, pr, head, runsDir: dir, env, now, readScorecards: () => [] });
const signal = over => readAbandonedReviewSignal({ repo, pr, head, env, now, log: () => {}, ...over });
const effect = (payload, status = 'pending', type = 'review.label-swap') => ({
  key: 'send-back', type, step: 'record', stepIndex: 9, index: 0, status, payload,
});

it.each([
  ['operator confirm changes', { verdict: { verdict: 'accept' }, findings: { confirm: 'changes', read: { netBasis: { rev: head } } } }],
  ['operator rejection after its cursor cleared', { pending: null, verdict: { verdict: 'accept' }, findings: { confirm: 'changes', read: { netBasis: { rev: head } } } }],
  ['pending send-back payload', { verdict: { verdict: 'accept' }, effects: [effect({ to: 'changes', addLabel: 'review:changes' })] }],
  ['declared send-back verdict', { effects: [effect({ verdict: 'send-back' }, 'declared')] }],
  ['in-flight send-back notice', { effects: [effect({ notice: renderReviewNotice({ event: 'cleared', repo, pr, outcome: 'changes' }) }, 'in-flight', 'review.notice')] }],
  ['unknown confirm shape', { findings: { confirm: { answer: 'changes' }, read: { netBasis: { rev: head } } } }],
  ['unreadable label payload', { effects: [effect(null)] }],
  ...['declared', 'pending', 'in-flight'].flatMap(status => [
    ...['review.label-swap', 'review.notice', 'verdict-ledger.append', 'unknown-effect'].map(type =>
      [`${status} ${type} missing payload`, { effects: [effect(undefined, status, type)] }]),
    [`${status} unknown sink with accepting payload`, { effects: [effect({ verdict: 'accept' }, status, 'unknown-effect')] }],
    [`${status} nested array rejection`, { effects: [effect({ to: 'accepted', nested: [[{ verdict: 'changes' }]] }, status)] }],
  ]),
])('%s is never abandoned and both gate readers retain review-unfinished even with a prior tombstone', (_name, more) => {
  const run = record(more);
  expect(sweep().kept['rejecting-verdict']).toEqual([id]);
  expect(isRunAbandoned(id, dir)).toBe(false);
  // Historical/operator-created tombstones must not hide these rejections either.
  markRunAbandoned({ id, dir, now, reason: 'historical tombstone', probes: {}, by: 'fixture' });
  for (const reader of [readDrainRedTeamEvidence, readRecoveryWitness]) {
    const held = gate(reader);
    expect(held).toMatchObject({ ok: false, reason: 'review-unfinished' });
    const complete = held.settleBounds.completeHeadRead({ pr, head, at: now + minute });
    expect(complete).toEqual({ complete: true, blocked: true });
  }
  expect(JSON.parse(readFileSync(runPath(id, dir), 'utf8'))).toEqual(run);
});

it.each(['judge', 'compute'])('abandons a dead %s step after its own default 30 minutes, and the gate requires a fresh review', kind => {
  record({ pending: { kind, step: kind, stepIndex: 2 } });
  expect(sweep().reaped).toEqual([id]);
  const tombstone = JSON.parse(readFileSync(abandonedPath(id, dir), 'utf8'));
  expect(tombstone.reason).toContain(`pending step "${kind}"`);
  expect(tombstone.probes.thresholdMs).toBe(30 * minute);
  for (const reader of [readDrainRedTeamEvidence, readRecoveryWitness]) {
    expect(gate(reader)).toMatchObject({ ok: false, reason: 'review-abandoned' });
  }
});
it('keeps a young judge without probing liveness', () => {
  record({}, 29 * minute); probes.sessions = vi.fn();
  expect(sweep().kept.young).toEqual([id]); expect(probes.sessions).not.toHaveBeenCalled();
});
it('keeps a stuck judge with a live pid', () => {
  record(); probes.reviewJobs = () => [{ repo, pr, pid: 1234 }]; probes.pidIdentity = () => ({ alive: true });
  expect(sweep().kept['live-review-job']).toEqual([id]);
});
it('uses the independent judge cascade, logs provenance, and lets thresholdMs win', () => {
  record();
  writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, JSON.stringify({ reviewRunReaper: { abandonStuckJudgeAfterMinutes: 40 } }));
  expect(sweep({ tool: {} }).stuckJudgeThresholdSource).toBe('platform');
  expect(sweep({ tool: {} }).kept.young).toEqual([id]);
  const tool = { abandonStuckJudgeAfterMinutes: 45, abandonStuckAfterMinutes: 1 };
  expect(sweep({ tool }).stuckJudgeThresholdSource).toBe('tool');
  env.WE_REAP_DEAD_REVIEW_RUNS_STUCK_JUDGE_AFTER_MINUTES = '50';
  const log = vi.fn();
  expect(sweep({ tool, log }).kept.young).toEqual([id]);
  expect(log.mock.calls.flat().join('\n')).toContain('abandonStuckJudgeAfterMinutes=50 (env)');
  expect(sweep({ tool, thresholdMs: minute }).reaped).toEqual([id]);
});
it.each(['0', '-1', 'NaN', 'Infinity'])('invalid judge setting %s falls back to the standard', value => {
  env.WE_REAP_DEAD_REVIEW_RUNS_STUCK_JUDGE_AFTER_MINUTES = value;
  record(); expect(sweep({ tool: {} }).stuckJudgeThresholdMs).toBe(30 * minute);
});

function recovery(over = {}) {
  const dispatch = vi.fn(), escalate = vi.fn();
  const out = runRedTeamOnSkip({ repo, env,
    plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
    rawPrs: [{ number: pr, headRefOid: head, comments: [], reviews: [] }],
    setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: new Map(), now: () => now,
    readEvidence: () => gate(readDrainRedTeamEvidence), readStatus: () => null,
    readAbandonedSignal: key => signal(key), capacity: { lanes: 1, budget: { left: 1 } }, dispatch, escalate, ...over });
  expect(dispatch).not.toHaveBeenCalled();
  return { row: out.rows[0], escalate };
}
it('an abandoned judge retains a visible fresh-review signal without paging during its replacement deadline', () => {
  record(); sweep();
  const { row, escalate } = recovery();
  expect(row).toMatchObject({ action: 'skip', why: 'review-abandoned', awaitingFreshReview: true, escalate: false });
  expect(escalate).not.toHaveBeenCalled();
});
it('an abandoned judge escalates exactly through the existing unfinished path if replacement never starts', () => {
  record(); sweep();
  const { row, escalate } = recovery({ now: () => now + 30 * minute });
  expect(row).toMatchObject({ action: 'skip', why: 'review-abandoned', awaitingFreshReview: true, escalate: true });
  expect(escalate).toHaveBeenCalledOnce();
  expect(escalate).toHaveBeenCalledWith({ repo, pr, head, why: 'review-abandoned' });
});
it('a newer same-head read after the tombstone prevents missing-dispatch escalation', () => {
  record(); sweep();
  record({ id: 'review-pr-replacement', stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(now + minute).toISOString() }] });
  expect(signal({ now: now + 31 * minute })).toMatchObject({ awaitingFreshReview: true, escalate: false });
});
it.each(['older', 'other-head'])('%s review cannot hide an overdue replacement', kind => {
  record(); sweep();
  record({ id: 'review-pr-unrelated', findings: { read: { netBasis: { rev: kind === 'older' ? head : 'b'.repeat(40) } } },
    stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(now + (kind === 'older' ? -minute : minute)).toISOString() }] });
  expect(signal({ now: now + 31 * minute }).escalate).toBe(true);
});
it('replacement deadline follows the judge setting instead of the effect setting', () => {
  record(); sweep();
  expect(signal({ now: now + 31 * minute, tool: { abandonStuckAfterMinutes: 1, abandonStuckJudgeAfterMinutes: 40 } }).escalate).toBe(false);
  expect(signal({ now: now + 40 * minute, tool: { abandonStuckAfterMinutes: 1, abandonStuckJudgeAfterMinutes: 40 } }).escalate).toBe(true);
});
it.each(['unreadable', 'oversized'])('replacement evidence %s fails closed with an operator-visible escalation', kind => {
  record(); sweep();
  const over = kind === 'unreadable' ? { read: () => { throw Error('unreadable run'); } }
    : { list: () => Array.from({ length: 401 }, (_, i) => `review-pr-${i}`) };
  expect(signal(over)).toMatchObject({ awaitingFreshReview: true, escalate: true, escalationContext: expect.stringContaining('inspect') });
});
it('unreadable nested payload and unknown verdict fields fail closed', () => {
  for (const payload of [false, { verdict: {} }, { target: 'unknown' }, { nested: { verdict: 'changes' } }]) {
    expect(hasRejectingReviewVerdict({ effects: [effect(payload)] })).toBe(true);
  }
});

it.each(['review.label-swap', 'review.notice'])('historical %s effects without payloads retain the hold, as do present unreadable payloads', type => {
  const historical = effect(undefined, 'pending', type);
  delete historical.payload;
  record({ effects: [historical] });
  expect(hasRejectingReviewVerdict({ effects: [historical] })).toBe(true);
  for (const payload of [null, false, {}, { verdict: 'changes' }]) {
    expect(hasRejectingReviewVerdict({ effects: [{ ...historical, payload }] })).toBe(true);
  }
  expect(sweep().kept['rejecting-verdict']).toEqual([id]);
  for (const reader of [readDrainRedTeamEvidence, readRecoveryWitness]) {
    expect(gate(reader)).toMatchObject({ ok: false, reason: 'review-unfinished' });
  }
});

it('accepting label and notice payloads, including removal of review:changes, remain abandonable', () => {
  const run = record({ pending: { kind: 'effect', step: 'record', stepIndex: 9 }, verdict: { verdict: 'accept' },
    findings: { confirm: 'accept', read: { netBasis: { rev: head } } },
    effects: [effect({ to: 'accepted', addLabel: 'review:accepted', removeLabels: ['review:changes'] }),
      { ...effect({ notice: renderReviewNotice({ event: 'cleared', repo, pr, outcome: 'accepted' }) }, 'pending', 'review.notice'), key: 'notice' }] });
  expect(hasRejectingReviewVerdict(run)).toBe(false);
  expect(sweep().reaped).toEqual([id]);
  expect(signal().escalate).toBe(false);
  expect(signal({ now: now + 30 * minute }).escalate).toBe(true);
});

it('oversized replacement record fails closed with operator escalation', () => {
  record(); sweep();
  writeFileSync(runPath('review-pr-oversized', dir), ' '.repeat(4 * 1024 * 1024 + 1));
  expect(signal()).toMatchObject({ awaitingFreshReview: true, escalate: true,
    escalationContext: expect.stringContaining('bounded read exceeded') });
});
it('payload nesting beyond the inspection bound retains rejection and unfinished holds', () => {
  const payload = Array.from({ length: 18 }).reduce(value => ({ nested: value }), { to: 'accepted' });
  record({ verdict: { verdict: 'accept' }, effects: [effect(payload)] });
  expect(sweep().kept['rejecting-verdict']).toEqual([id]);
  expect(gate(readDrainRedTeamEvidence)).toMatchObject({ ok: false, reason: 'review-unfinished' });
});
it.each([
  ['nested arrays', () => ({ to: 'accepted', nested: Array.from({ length: 18 }).reduce(value => [value], { verdict: 'accept' }) })],
  ['wide array', () => ({ to: 'accepted', nested: Array(4097).fill('accept') })],
  ['wide object', () => ({ to: 'accepted', nested: Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [`k${i}`, 'accept'])) })],
  ['large string', () => ({ to: 'accepted', note: 'x'.repeat(256 * 1024 + 1) })],
])('oversized %s retains the hold and directs the operator to inspect the full payload', (_name, payload) => {
  record({ verdict: { verdict: 'accept' }, effects: [effect(payload())] });
  const log = vi.fn();
  expect(sweep({ log }).kept['rejecting-verdict']).toEqual([id]);
  expect(log.mock.calls.flat().join('\n')).toContain('inspect the full verdict/effect payload');
  expect(isRunAbandoned(id, dir)).toBe(false);
  for (const reader of [readDrainRedTeamEvidence, readRecoveryWitness]) {
    expect(gate(reader)).toMatchObject({ ok: false, reason: 'review-unfinished' });
  }
});

it('keeps a judge whose own job pid is live even before a handle is recorded', () => {
  record({ job: { ...newJobBlock({ kind: 'review' }), pid: 1234 } });
  probes.pidIdentity = () => ({ alive: true });
  expect(sweep().kept['live-pid']).toEqual([id]);
});

it('a replacement that is later abandoned gets its own deadline instead of inheriting the old missing-dispatch page', () => {
  record(); sweep();
  const replacement = 'review-pr-replacement';
  record({ id: replacement, stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(now + minute).toISOString() }] });
  markRunAbandoned({ id: replacement, dir, now: now + 20 * minute, reason: 'judge stuck', probes: {}, by: 'fixture' });
  expect(signal({ now: now + 31 * minute }).escalate).toBe(false);
  expect(signal({ now: now + 50 * minute }).escalate).toBe(true);
});
