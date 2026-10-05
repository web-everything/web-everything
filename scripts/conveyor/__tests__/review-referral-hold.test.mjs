import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newRunRecord, writeRun } from '../../operations/run-store.mjs';
import { mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } from '../../lib/jury-core.mjs';
import { REARM_COMMENT_MARKER } from '../rearm-review.mjs';
import { runReconcilePass } from '../reconcile-pass.mjs';
import { countFindings } from '../reconcile-core.mjs';
import {
  reviewRunEvidence, readReviewRunEvidence, decideReferralHold, enrichPrsWithReferralHolds,
  notifyReferralHold, REFERRAL_RETRY_MS, decideSameHeadHold, resolveSameHeadMaxReviews, PENDING_REASON_TOKENS,
} from '../review-referral-hold.mjs';

const repo = 'web-everything/web-everything';
const head = 'a'.repeat(40);
const at = Date.parse('2026-10-03T08:00:00Z');
const iso = n => new Date(n).toISOString();
const dirs = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'referral-hold-')); dirs.push(dir); return dir; };
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const comment = (body, time = at + 1, login = 'web-everything') => ({ body, createdAt: iso(time), author: { login } });
const original = { summary: 'broken case', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
const key = referralFindingKey('judge', original);
function record() {
  return { version: 1, repo, pr: 3481, head, runId: 'review-pr-initial',
    reviewer: mandatoryReferralReviewer('review-pr-initial'), authorBody: '<!-- authored-by-actor: author -->',
    attempted: true, referrals: [{ key, seat: 'judge', original, finding: normalizeFinding(original) }], rulings: [] };
}
function run({ id = 'review-pr-parked', time = at, failure = false, attempted = true } = {}) {
  const r = newRunRecord({ id, op: 'review-pr', input: { repo, pr: 3481 } });
  const rec = { ...record(), attempted };
  r.findings = {
    read: { repo, pr: 3481, netBasis: { rev: head } },
    mandatoryReferrals: { applied: true, effects: [{ type: 'review.mandatory-referrals', status: 'applied',
      result: { records: failure ? [] : [rec], pending: [failure ? 'referral-persistence-failed' : key] } }] },
    referralVerdict: { verdict: 'needs-human', pendingReferrals: [failure ? 'referral-persistence-failed' : key], referrals: rec.referrals },
    advise: { applied: true, effects: [] },
  };
  r.verdict = r.findings.referralVerdict;
  r.stepTimings = [
    { step: 'read', stepIndex: 0, startedAt: iso(time - 60_000), finishedAt: iso(time - 59_000), durationMs: 1000 },
    { step: 'advise', stepIndex: 8, startedAt: iso(time - 1), finishedAt: iso(time), durationMs: 1 },
  ];
  r.pending = { kind: 'confirm', step: 'confirm', stepIndex: 9, of: 'human', asks: 'Ruling?', options: ['abstain'] };
  return r;
}
const pr = (overrides = {}) => ({ number: 3481, headRefOid: head, headRefName: 'lane/referrals',
  labels: [{ name: 'review:human' }], comments: [], mergeStateStatus: 'CLEAN',
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], ...overrides });
const evidence = opts => reviewRunEvidence(run(opts));
const hold = (p = pr(), runs = [evidence()], now = at + 1) => decideReferralHold(p, runs, { repo, now });

function reconcile(p) {
  return runReconcilePass({ repo, now: at + 1, readPrs: () => [p], readAgents: () => [], enrich: x => x,
    enrichMainRed: prs => ({ prs }), enrichAlreadyLanded: x => x, enrichBaseRef: x => x,
    enrichSystemFix: x => x, enrichFixClaims: x => x, enrichTimeouts: x => x,
    resolveMainSha: () => null, readRequiredChecks: () => ({ checks: ['test'] }),
  });
}

describe('attempted mandatory referrals', () => {
  it('releases stale run evidence only when the live gate has cleared', () => {
    const r = record();
    const p = pr({ comments: [comment(renderReferralRecord(r), at - 120_000)] });
    expect(hold(p)).not.toBeNull();
    r.rulings = [{ id: 'r1', key, reviewerId: r.reviewer.id, lens: r.reviewer.lens,
      result: 'block', rationale: 'confirmed', evidence: ['diff'] }];
    p.comments = [comment(renderReferralRecord(r), at - 120_000)];
    expect(hold(p)).toBeNull();
    expect(decideReferralHold(p, [evidence()], { repo, now: at + 1,
      env: { WE_REFERRAL_HOLD_LIVE_RELEASE: '0' } })).not.toBeNull();
  });
  // The live release must judge a `card` ruling the way the real gate does: only an existing readable card clears it.
  it.each([
    ['an unreadable card', 'we:backlog/9999999-not-yet-filed.md', undefined, false],
    ['a card the gate can read', 'we:backlog/9999999-not-yet-filed.md', () => true, true],
  ])('a card ruling naming %s %s the hold', (_, card, cardReadable, releases) => {
    const r = record();
    r.rulings = [{ id: 'r1', key, reviewerId: r.reviewer.id, lens: r.reviewer.lens,
      result: 'card', card, rationale: 'tracked', evidence: ['diff'] }];
    const p = pr({ comments: [comment(renderReferralRecord(r), at - 120_000)] });
    const decided = decideReferralHold(p, [evidence()], { repo, now: at + 1, ...(cardReadable ? { cardReadable } : {}) });
    expect(decided === null).toBe(releases);
  });
  it('a not-real or block ruling releases the hold (neither needs a card)', () => {
    for (const result of ['not-real', 'block']) {
      const r = record();
      r.rulings = [{ id: 'r1', key, reviewerId: r.reviewer.id, lens: r.reviewer.lens, result, rationale: 'x', evidence: ['diff'] }];
      expect(hold(pr({ comments: [comment(renderReferralRecord(r), at - 120_000)] }))).toBeNull();
    }
  });
  it('reads real run-store shape and withholds an unchanged head in the shared planner, across repeated passes', () => {
    const dir = temp(); vi.stubEnv('OPERATION_RUNS_DIR', dir); writeRun(run(), dir);
    for (let tick = 0; tick < 3; tick++) {
      const plan = reconcile(pr());
      expect(plan.dispatch.filter(d => d.kind === 'review')).toEqual([]);
      expect(plan.refusals).toContainEqual(expect.objectContaining({ kind: 'review-referrals-pending', prNumber: 3481 }));
    }
    expect(readReviewRunEvidence({ dir })).toHaveLength(1);
  });
  it.each(['push', 'ruling', 'operator reply', 'send-back', 'rearm'])('%s re-enables review through the planner', action => {
    const dir = temp(); vi.stubEnv('OPERATION_RUNS_DIR', dir); writeRun(run(), dir);
    const r = record();
    r.rulings.push({ id: 'r1', key, reviewerId: r.reviewer.id, lens: 'correctness', result: 'not-real', rationale: 'checked', evidence: ['diff'] });
    const changes = {
      push: { headRefOid: 'b'.repeat(40) },
      ruling: { comments: [comment(renderReferralRecord(r))] },
      'operator reply': { comments: [comment('Please try again; I answered the referral.', at + 1, 'chalbert')] },
      'send-back': { comments: [comment('🔁 review — changes requested\nFix this.')] },
      rearm: { comments: [comment(REARM_COMMENT_MARKER)] },
    };
    expect(reconcile(pr(changes[action])).dispatch).toContainEqual(expect.objectContaining({ kind: 'review', prNumber: 3481 }));
  });
  it('does not hold an unattempted referral, a different subject, or an incomplete review', () => {
    expect(hold(pr(), [evidence({ attempted: false })])).toBeNull();
    expect(hold(pr({ number: 3507 }))).toBeNull();
    expect(hold(pr(), [{ ...evidence(), repo: 'frontier-ui/frontierui' }])).toBeNull();
    const unfinished = run(); unfinished.stepTimings.pop();
    expect(reviewRunEvidence(unfinished)).toBeNull();
  });
  it('the latest completed review supersedes an earlier park, including cache invalidation', () => {
    const dir = temp(); writeRun(run(), dir);
    expect(readReviewRunEvidence({ dir })[0].parked).toBe(true);
    const done = run(); done.findings.referralVerdict = { verdict: 'accept', pendingReferrals: [] };
    writeRun(done, dir);
    expect(hold(pr(), readReviewRunEvidence({ dir }))).toBeNull();
    expect(hold(pr(), [evidence(), { ...evidence(), completedAt: at + 1, parked: false }])).toBeNull();
  });
  it('ignores bot bookkeeping, own notices, repeated snapshots, old replies, and untrusted answers', () => {
    for (const c of [comment('review paused: 1 referrals need a ruling'), comment('status tag changed'),
      comment(renderReferralRecord(record())), comment('try again', at - 120_000, 'chalbert'),
      comment('🔁 review — changes requested', at + 1, 'stranger')]) {
      expect(hold(pr({ comments: [c] }))).not.toBeNull();
    }
    expect(countFindings([comment(hold().why)])).toBe(0);
  });
  it('an edited operator answer and an answer during the panel both wake it', () => {
    expect(hold(pr({ comments: [{ ...comment('answer', at - 120_000, 'chalbert'), updatedAt: iso(at + 1) }] }))).toBeNull();
    expect(hold(pr({ comments: [comment('answer', at - 30_000, 'chalbert')] }))).toBeNull();
  });
});

describe('persistence failure retry budget', () => {
  it('waits 15, 30, then 60 minutes, then stops until an external event', () => {
    const runs = [];
    let time = at;
    for (let i = 0; i < 3; i++) {
      runs.push(evidence({ id: `review-pr-${i}`, failure: true, time }));
      const due = time + REFERRAL_RETRY_MS[i];
      expect(hold(pr(), runs, due - 1)).toMatchObject({ retryAt: due });
      expect(hold(pr(), runs, due)).toBeNull();
      time = due + 60_000;
    }
    runs.push(evidence({ id: 'review-pr-exhausted', failure: true, time }));
    expect(hold(pr(), runs, time + 86400_000)).toMatchObject({ exhausted: true, retryAt: null });
    expect(hold(pr({ headRefOid: 'b'.repeat(40) }), runs, time)).toBeNull();
    const answered = pr({ comments: [comment('Try again', time + 1, 'chalbert')] });
    expect(hold(answered, runs, time + 1)).toBeNull();
    runs.push(evidence({ id: 'review-pr-reset', failure: true, time: time + 120_000 }));
    expect(hold(answered, runs, time + 120_001)).toMatchObject({ retryAt: time + 120_000 + REFERRAL_RETRY_MS[0] });
  });
});

describe('one visible pause notice', () => {
  it('posts/logs once with a persistent receipt, even with a stale comment snapshot', () => {
    const dir = temp(), post = vi.fn(), log = vi.fn();
    for (let tick = 0; tick < 3; tick++) notifyReferralHold({ repo, prNumber: 3481, hold: hold(), dir, post, log });
    expect(post).toHaveBeenCalledTimes(1); expect(log).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toContain('review paused: 1 referrals need a ruling; it resumes on a new push, a ruling, or a send-back');
    // A replacement checkout also dedupes from the PR thread.
    notifyReferralHold({ repo, prNumber: 3481, hold: hold(), dir: temp(), post, log,
      comments: [comment(post.mock.calls[0][0])] });
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('never repeats an ambiguous write, and backs off known unsent writes with a bounded budget', () => {
    const dir = temp(), post = vi.fn(() => { throw Error('connection lost'); }), log = vi.fn();
    const args = { repo, prNumber: 3481, hold: hold(), dir, post, log, now: at };
    notifyReferralHold(args); notifyReferralHold({ ...args, now: at + 86400_000 });
    expect(post).toHaveBeenCalledTimes(1);
    const retryDir = temp(); const unsent = vi.fn(() => { throw Error('shared backoff; call not sent'); });
    let now = at;
    for (let i = 0; i < 4; i++) {
      notifyReferralHold({ ...args, dir: retryDir, post: unsent, now });
      notifyReferralHold({ ...args, dir: retryDir, post: unsent, now: now + 1 });
      now += REFERRAL_RETRY_MS[i] ?? 86400_000;
    }
    notifyReferralHold({ ...args, dir: retryDir, post: unsent, now });
    expect(unsent).toHaveBeenCalledTimes(4);
  });
});


describe('same-head review loop regression (live #202)', () => {
  it('counts only finding keys and holds attempted referrals with a missing author stamp', () => {
    const r = run();
    r.findings.referralVerdict.pendingReferrals.push('author-stamp-missing');
    const row = reviewRunEvidence(r);
    expect(Object.isFrozen(PENDING_REASON_TOKENS)).toBe(true);
    expect(PENDING_REASON_TOKENS.has('author-stamp-missing')).toBe(true);
    expect(row).toMatchObject({ attempted: true, count: 1, parked: true });
    expect(hold(pr(), [row])).not.toBeNull();
  });
  it.each(['referral-persistence-failed', 'malformed-referral-record', 'unreadable-referral-result'])
    ('preserves the failure token %s', token => {
      const r = run();
      r.findings.referralVerdict.pendingReferrals = [token, 'author-stamp-missing'];
      expect(reviewRunEvidence(r)).toMatchObject({ attempted: false, count: 1, parked: true,
        persistenceFailed: token === 'referral-persistence-failed' });
    });
  it('holds a completed head, but releases for a trusted re-arm or new head', () => {
    const rows = [{ ...evidence(), parked: false }];
    const decided = decideSameHeadHold(pr(), rows, { repo, env: {} });
    expect(decided).toMatchObject({ kind: 'same-head', head, count: 1, retryAt: null,
      persistenceFailed: false, exhausted: false });
    expect(decided.why).toMatch(/^review paused:/);
    expect(decideSameHeadHold(pr({ comments: [comment(REARM_COMMENT_MARKER)] }), rows, { repo })).toBeNull();
    expect(decideSameHeadHold(pr({ headRefOid: 'b'.repeat(40) }), rows, { repo })).toBeNull();
    expect(decideSameHeadHold(pr({ number: 99 }), rows, { repo })).toBeNull();
    expect(decideSameHeadHold(pr(), rows, { repo: 'other/repo' })).toBeNull();
    expect(enrichPrsWithReferralHolds([pr()], { repo, readRuns: () => rows })[0].referralHold.kind).toBe('same-head');
  });
  it('respects the cap and leaves persistence retries to the referral hold', () => {
    expect(decideSameHeadHold(pr(), [evidence()], { repo, env: { WE_REVIEW_SAME_HEAD_MAX_REVIEWS: '0' } })).toBeNull();
    const rows = [evidence(), evidence({ time: at + 120_000 })];
    expect(decideSameHeadHold(pr(), rows, { repo, env: { WE_REVIEW_SAME_HEAD_MAX_REVIEWS: '3' } })).toBeNull();
    expect(decideSameHeadHold(pr(), [evidence({ failure: true })], { repo })).toBeNull();
    for (const value of [undefined, '', 'junk', '-1', '1.5', '3oops']) {
      expect(resolveSameHeadMaxReviews({ WE_REVIEW_SAME_HEAD_MAX_REVIEWS: value })).toBe(1);
    }
    expect(resolveSameHeadMaxReviews({ WE_REVIEW_SAME_HEAD_MAX_REVIEWS: '3' })).toBe(3);
  });
  it('posts no extra notice for a same-head hold', () => {
    const post = vi.fn(), log = vi.fn();
    notifyReferralHold({ repo, prNumber: 3481, hold: { ...hold(), kind: 'same-head' }, dir: temp(), post, log });
    expect(post).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
