import { expect, it, vi } from 'vitest';
import { REARM_COMMENT_MARKER } from '../../../scripts/conveyor/rearm-review.mjs';
import { AUTOMATION_LOGINS } from '../../../scripts/lib/marker-authorship.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReviewTick } from '../review-daemon.mjs';
import { diagnoseEndedJob, writeEndedJobDiagnosis } from '../../../scripts/operations/review-job-end-diagnosis.mjs';
import { reviewRunEvidence, notifyReferralHold, findResumableParkedRun } from '../../../scripts/conveyor/review-referral-hold.mjs';

it('holds a second timeout over three ticks including restart; a moved head starts fresh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timeout-hold-'));
  try {
  const head = 'b'.repeat(40), repo = 'web-everything/web-everything';
  const request = { lens: 'correctness', model: 'sonnet', seatProvider: { fallbackModel: 'claude-opus-5-5-high' } };
  const run = { id: 'r', op: 'review-pr', input: { pr: 10, repo }, findings: { read: { repo, pr: 10, netBasis: { rev: head } } },
    stepTimings: [{ step: 'read', startedAt: '2026-11-25T00:00:00Z' }], pending: { kind: 'judge', step: 'judge', request },
    seatTimeouts: ['sonnet', 'claude-opus-5-5-high'].map((model, i) => ({ step: 'judge', lens: 'correctness', head, provider: 'claude', model, timeoutMs: i ? 1800000 : 1200000 })) };
  const dispatch = vi.fn(() => ({})), post = vi.fn();
  const notifyReferral = vi.fn(args => notifyReferralHold({ ...args, dir, post, log() {} }));
  const tick = (liveHead = head, providerCapacity = () => null, comments = []) => runReviewTick({ repo, now: () => 1000,
    dispatchState: { firstOwedAt: new Map(), lastDispatched: new Map() },
    readRuns: () => [reviewRunEvidence(JSON.parse(JSON.stringify(run)))], providerCapacity,
    holdReconcile: () => [], reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: 10, headRefOid: liveHead }], refusals: [] }),
    readPrs: () => [{ number: 10, headRefOid: liveHead, labels: ['review:pending'], comments }], readAgents: () => [],
    dispatch, notifyReferral, tagRound() {}, tagStatus() {}, statusCandidates: () => [], log() {} });
  tick(); tick(); tick();
  expect(dispatch).not.toHaveBeenCalled();
  expect(notifyReferral.mock.calls[0][0].hold.why).toContain('review-blocked-on-infra: juror timeout x2 (correctness: claude/sonnet 20m, claude/opus 30m; head bbbbbbbbbbbb)');
  expect(notifyReferral.mock.calls[0][0].hold.why).toContain('Orchestrator:');
  expect(post).toHaveBeenCalledTimes(1);
  tick('c'.repeat(40));
  expect(dispatch).toHaveBeenCalledTimes(1);
  run.seatTimeouts.pop();
  tick(head, () => 'provider capacity held');
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(notifyReferral.mock.calls.at(-1)[0].hold.why).toContain('provider capacity held');
  tick(head, () => null, [{ author: { login: 'chalbert' }, body: 'run a fresh review', createdAt: '2026-11-25T01:00:00Z' }]);
  expect(dispatch).toHaveBeenCalledTimes(2);
  delete run.pending.request.seatProvider;
  tick();
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(notifyReferral.mock.calls.at(-1)[0].hold.why).toContain('no allowed route remains');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('bounds and redacts hostile timeout metadata and ignores an oversized ended record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'juror-timeout-'));
  try {
    const job = { slug: 'review-11', pid: 7, dir };
    const model = `sk-ant-api03-${'A'.repeat(40)} ${'x'.repeat(10000)}`;
    writeEndedJobDiagnosis(job, { reason: 'juror-timeout', lens: 'l', provider: 'p', model, head: 'h', wallMs: 1, timeoutMs: 1, runId: 'r' });
    const out = diagnoseEndedJob({ ...job });
    expect(out.model.length).toBeLessThanOrEqual(80);
    expect(out.model).not.toContain('A'.repeat(40));
    writeEndedJobDiagnosis(job, { reason: 'juror-timeout', lens: 'l', provider: 'p', model: 'm', pad: 'z'.repeat(70000) });
    expect(diagnoseEndedJob({ ...job }).reason).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('logs a persisted juror-timeout without no-verdict wording and keeps retry priority', () => {
  const dir = mkdtempSync(join(tmpdir(), 'juror-timeout-'));
  try {
    const head = 'a'.repeat(40);
    const job = { slug: 'review-10', pid: 42, dir };
    writeEndedJobDiagnosis(job, { reason: 'juror-timeout', lens: 'correctness', provider: 'claude', model: 'sonnet', head, wallMs: 6, timeoutMs: 5, runId: 'timeout-run' });
    const log = vi.fn();
    const dispatch = vi.fn(() => ({}));
    const dispatchState = { firstOwedAt: new Map(), lastDispatched: new Map([['web-everything/web-everything#10', { pid: 42, head, slug: job.slug }]]) };
    runReviewTick({ repo: 'web-everything/web-everything', dispatchState, isPidAlive: () => false, holdReconcile: () => [],
      reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: 10, headRefOid: head }], refusals: [] }),
      readPrs: () => [{ number: 10, headRefOid: head, labels: ['review:pending'] }], readAgents: () => [],
      diagnoseJob: j => diagnoseEndedJob({ ...j, dir }), writeJobDiagnosis: (j, d) => writeEndedJobDiagnosis({ ...j, dir }, d),
      dispatch, tagRound() {}, tagStatus() {}, statusCandidates: () => [], acquirableLanes: () => 1, log });
    expect(log).toHaveBeenCalledWith('review-daemon: web-everything/web-everything#10 review-job-ended juror-timeout (correctness claude/sonnet 6ms; run timeout-run; head aaaaaaaaaaaa)');
    expect(log.mock.calls.flat().join(' ')).not.toContain('no-verdict');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(diagnoseEndedJob({ ...job, pid: 999 }).reason).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each(['run a fresh review', '🔁 review — changes requested'])('timeout resume honors operator fresh request: %s', body => {
  const repo = 'web-everything/web-everything', head = 'a'.repeat(40);
  const run = { id: 'parked', repo, pr: 10, head, incomplete: true, startedAt: Date.parse('2026-11-25T00:00:00Z'), rulings: [], jurorTimeout: { attempts: 0 } };
  const pr = { number: 10, headRefOid: head, comments: [{ author: { login: 'chalbert' }, body, createdAt: '2026-11-25T01:00:00Z' }] };
  expect(findResumableParkedRun(pr, [run], { repo })).toBeNull();
  expect(findResumableParkedRun({ ...pr, comments: [] }, [run], { repo })).toEqual({ id: run.id, head });
});


it.each(['🔁 review — changes requested', REARM_COMMENT_MARKER])('automation wake keeps exhausted timeout run resumable: %s', body => {
  const repo = 'web-everything/web-everything', head = 'a'.repeat(40);
  const run = { id: 'parked', repo, pr: 10, head, incomplete: true,
    startedAt: Date.parse('2026-11-25T00:00:00Z'), rulings: [], jurorTimeout: { attempts: 3 } };
  const pr = { number: 10, headRefOid: head,
    comments: [{ author: { login: AUTOMATION_LOGINS[0] }, body, createdAt: '2026-11-25T01:00:00Z' }] };
  expect(findResumableParkedRun(pr, [run], { repo })).toEqual({ id: run.id, head });
});
