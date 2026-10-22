/**
 * stale-hold-resume (live 2026-10-21) — daemon coverage for #5773, #5775 and #5800.
 * Fixtures are the live threads and review-run projections captured at 2026-10-21T17:30Z.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { buildOperatorRulingComment, readReferralRecords } from '../../lib/jury-core.mjs';
import {
  decideReferralHoldAutoResolve, enrichPrsWithReferralHoldAutoResolve, enrichPrsWithReferralHolds,
  REFERRAL_HOLD_AUTO_RESOLVED,
} from '../review-referral-hold.mjs';
import { planReconcile as planReconcileWithTiming } from '../reconcile-core.mjs';
import { defaultSendBackReferralHold, handleReferralHoldAutoResolve, operatorHoldsFromPlan, runReviewTick } from '../../../skills-src/conveyor/review-daemon.mjs';

const planReconcile = options => planReconcileWithTiming({ reviewTiming: { startAfter: 'ci-green' }, fixTiming: { joinCiAndReview: false }, ...options });
const here = dirname(fileURLToPath(import.meta.url));
// The live per-role bot logins (plateau-*) come from the host's delivery settings, which a hermetic test run does not
// read; the legacy bot login stands in for them (both are the automation's own trusted identity).
const BOTS = new Set(['plateau-merger', 'plateau-reviewer', 'plateau-worker']);
const load = n => {
  const fx = JSON.parse(readFileSync(join(here, 'fixtures', `pr-${n}-stale-referral-hold.json`), 'utf8'));
  return { ...fx, comments: fx.comments.map(c => (BOTS.has(c.author?.login) ? { ...c, author: { login: 'web-everything' } } : c)) };
};
const FX = { 5773: load(5773), 5775: load(5775), 5800: load(5800) };
const repo = 'web-everything/web-everything';
const noCards = () => false;
const asPr = (fx, comments = fx.comments) => ({
  number: fx.number, headRefOid: fx.headRefOid, body: fx.body, createdAt: fx.createdAt, isDraft: false, baseRefName: 'main',
  labels: fx.labels.map(name => ({ name })), comments,
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'ci' }],
});
const decide = (pr, hold, o = {}) => decideReferralHoldAutoResolve(pr, hold, { repo, cardReadable: noCards, env: {}, ...o });
/** The daemon's enrichment chain for one PR: today's hold, then the auto-resolve step. */
const enrich = (fx, { comments, env = {} } = {}) => {
  const [held] = enrichPrsWithReferralHolds([asPr(fx, comments)], { repo, readRuns: () => fx.runs, now: Date.parse(fx.capturedAt), env });
  return enrichPrsWithReferralHoldAutoResolve([held], { repo, env, decide: (p, h) => decide(p, h, { env }) })[0];
};
const plan = pr => planReconcile({ repo: 'we', prs: [pr], agents: [], requiredChecks: ['test'], now: Date.parse('2026-10-21T17:30:00Z') });

/** An operator ruling comment on the live head (posted before the head's last review started, so it is no wake). */
function operatorRuling(fx, { key, runId, result, at, reason = 'operator: this must be fixed' }) {
  const body = buildOperatorRulingComment({ version: 1, repo, pr: fx.number, head: fx.headRefOid,
    rulings: [{ runId, key, result }], actor: 'chalbert', channel: 'test', reason, at, clearerId: '' });
  return { author: { login: 'chalbert' }, authorAssociation: 'OWNER', body, createdAt: at };
}
const liveRecord = fx => readReferralRecords(fx.comments, { head: fx.headRefOid }).records.find(r => r.head === fx.headRefOid);

describe('live replays: each PR is paused today, and every live-head finding is ruled', () => {
  it('#5775 (all not-real on the live head) resumes: the pause becomes the human gate, no panel, no accept (daemon)', () => {
    const p = plan(enrich(FX[5775]));
    // Not an operator referral hold any more.
    expect(operatorHoldsFromPlan(p)).toEqual([]);
  });

  it('#5775: the review tick logs `referral-hold auto-resolved` once, posts no pause notice, dispatches nothing', () => {
    const [row] = plan(enrich(FX[5775])).refusals;
    const notifyReferral = vi.fn(), log = vi.fn(), dispatch = vi.fn(), seen = new Set();
    const subject = { number: 5775, labels: FX[5775].labels.map(name => ({ name })), comments: [] };
    for (let t = 0; t < 3; t++) {
      runReviewTick({ repo, reconcile: () => ({ dispatch: [], refusals: [row] }), dispatch, readPrs: () => [subject], readAgents: () => [],
        holdReconcile: () => [], tagRound: vi.fn(), tagStatus: vi.fn(), notifyReferral, autoResolveSeen: seen, log });
    }
    expect(notifyReferral).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    const lines = log.mock.calls.map(c => c[0]).filter(l => l.includes(REFERRAL_HOLD_AUTO_RESOLVED));
    expect(lines).toEqual([`review-daemon: referral-hold auto-resolved {"repo":"${repo}","pr":5775,"head":"${FX[5775].headRefOid}","outcome":"resume","counts":{"not-real":1},"next":"human-review"}`]);
  });

  it('#5773: its one finished review left NO advisory on the PR (write-up to a local file, label swap refused), so the review resumes once (daemon)', () => {
    const p = plan(enrich(FX[5773]));
    // The tick logs it once.
    const log = vi.fn(), seen = new Set();
    for (let t = 0; t < 2; t++) {
      runReviewTick({ repo, reconcile: () => ({ dispatch: [], refusals: [], notes: p.notes }), dispatch: vi.fn(), readPrs: () => [], readAgents: () => [],
        holdReconcile: () => [], tagRound: vi.fn(), tagStatus: vi.fn(), autoResolveSeen: seen, log });
    }
    expect(log.mock.calls.map(c => c[0]).filter(l => l.includes(REFERRAL_HOLD_AUTO_RESOLVED)))
      .toEqual([`review-daemon: referral-hold auto-resolved {"repo":"${repo}","pr":5773,"head":"${FX[5773].headRefOid}","outcome":"resume","counts":{"not-real":3},"next":"advisory-review"}`]);
  });

  it('#5773: a SECOND finished review that still leaves no advisory keeps the pause (no panel per tick) (daemon)', () => {
    const fx = FX[5773];
    const last = fx.runs.filter(r => r.head === fx.headRefOid).sort((x, y) => x.completedAt - y.completedAt).at(-1);
    const again = { ...last, id: `${last.id}-2`, startedAt: last.completedAt + 60_000, completedAt: last.completedAt + 600_000 };
    const [held] = enrichPrsWithReferralHolds([asPr(fx)], { repo, readRuns: () => [...fx.runs, again], now: Date.parse(fx.capturedAt), env: {} });
    const [pr] = enrichPrsWithReferralHoldAutoResolve([held], { repo, env: {}, decide: (q, h) => decide(q, h) });
    const p = plan(pr);
    expect(operatorHoldsFromPlan(p)).toEqual([{ prNumber: 5773, kind: 'review-referrals-pending' }]);
  });
});

describe('send-back: a block ruling on the live head owes a fix, never a ruling', () => {
  const fx = FX[5775];
  const rec = liveRecord(fx);
  const key = rec.referrals[0].key;
  // Operator block on the live head at 10:58, after the operator's not-real (10:57) and before the 11:21 review.
  const block = operatorRuling(fx, { key, runId: rec.runId, result: 'block', at: '2026-10-21T10:58:00.000Z' });
  const at = fx.comments.findIndex(c => c.createdAt > '2026-10-21T10:58:00Z');
  const comments = [...fx.comments.slice(0, at), block, ...fx.comments.slice(at)];

  it('the plan sends it to a fixer and dispatches no review; the daemon sends it back exactly once (daemon)', () => {
    const pr = enrich(fx, { comments });
    // Where the plan instead refuses the review on the pause (say the fix path is capped), the row carries the
    // send-back, and the daemon performs it exactly as a block ruling's follow-up does.
    const row = { prNumber: 5775, kind: 'review-referrals-pending', referralHold: pr.referralHold, referralHoldAutoResolve: pr.referralHoldAutoResolve };
    const send = vi.fn(() => ({ sentBack: true }));
    const log = vi.fn();
    const seen = new Set();
    const rawPrs = [{ number: 5775, labels: fx.labels.map(name => ({ name })) }];
    const out = handleReferralHoldAutoResolve({ repo, row, auto: row.referralHoldAutoResolve, rawPrs, send, seen, log });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ repo, pr: 5775, head: fx.headRefOid, actor: 'chalbert' });
    expect(send.mock.calls[0][0].body).toContain('scripts/lib/git-identity.mjs:241');
    expect(out.resolved).toMatchObject({ pr: 5775, head: fx.headRefOid, outcome: 'send-back', sentBack: true });
    expect(log.mock.calls.map(c => c[0])).toEqual([expect.stringMatching(new RegExp(`^review-daemon: ${REFERRAL_HOLD_AUTO_RESOLVED} \\{"repo":"${repo}","pr":5775,"head":"${fx.headRefOid}","outcome":"send-back"`))]);
    // A stale listing that still lacks the label: this process already sent it, so nothing is sent again.
    handleReferralHoldAutoResolve({ repo, row, auto: row.referralHoldAutoResolve, rawPrs, send, seen, log });
    expect(send).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    // Next tick the label is review:changes: nothing is sent again.
    handleReferralHoldAutoResolve({ repo, row, auto: row.referralHoldAutoResolve,
      rawPrs: [{ number: 5775, labels: [{ name: 'review:human' }, { name: 'review:changes' }] }], send, seen, log });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('the review tick acts on the row: sends back, logs once, and posts no "waiting on your ruling" notice', () => {
    const pr = enrich(fx, { comments });
    const row = { prNumber: 5775, kind: 'review-referrals-pending', referralHold: pr.referralHold, referralHoldAutoResolve: pr.referralHoldAutoResolve };
    const notifyReferral = vi.fn(), send = vi.fn(() => ({ sentBack: true })), log = vi.fn(), dispatch = vi.fn();
    const subject = { number: 5775, labels: fx.labels.map(name => ({ name })), comments: [] };
    const seen = new Set();
    for (let t = 0; t < 2; t++) {
      const out = runReviewTick({ repo, reconcile: () => ({ dispatch: [], refusals: [row] }), dispatch,
        readPrs: () => [t ? { ...subject, labels: [...subject.labels, { name: 'review:changes' }] } : subject], readAgents: () => [],
        holdReconcile: () => [], tagRound: vi.fn(), tagStatus: vi.fn(), notifyReferral, sendBackReferralHold: send, autoResolveSeen: seen, log });
      if (!t) expect(out.referralHoldAutoResolved).toEqual([expect.objectContaining({ pr: 5775, outcome: 'send-back', sentBack: true })]);
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(notifyReferral).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(log.mock.calls.filter(c => c[0].includes(REFERRAL_HOLD_AUTO_RESOLVED))).toHaveLength(1);
  });

  it('a failed send is not remembered, so the next tick retries it', () => {
    const auto = { outcome: 'send-back', head: fx.headRefOid, blocked: [{ file: 'a', line: 1, summary: 's', actor: 'auto-policy' }] };
    const seen = new Set();
    const send = vi.fn(() => { throw new Error('gh down'); });
    const r1 = handleReferralHoldAutoResolve({ repo, row: { prNumber: 5775 }, auto, rawPrs: [], send, seen, log: () => {} });
    expect(r1.error).toMatch(/gh down/);
    handleReferralHoldAutoResolve({ repo, row: { prNumber: 5775 }, auto, rawPrs: [], send, seen, log: () => {} });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].actor).toBe('auto-policy');
  });
});

describe('fail closed: anything unproven keeps the pause, and says why', () => {
  const fx = FX[5775];

  it('a stay is logged once per reason, and the pause notice still posts', () => {
    const log = vi.fn();
    const seen = new Set();
    const auto = { outcome: 'stay', head: fx.headRefOid, why: 'x' };
    expect(handleReferralHoldAutoResolve({ repo, row: { prNumber: 5775 }, auto, seen, log })).toBeNull();
    handleReferralHoldAutoResolve({ repo, row: { prNumber: 5775 }, auto, seen, log });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/referral-hold auto-resolve kept the pause .*"why":"x"/);
  });
});

describe('the real sender runs a static helper file (no dynamic import inside a code string)', () => {
  it('spawns scripts/conveyor/referral-hold-send-back.mjs with the args in env and parses its last JSON line', () => {
    const exec = vi.fn(() => 'noise\n{"action":"send-back","sentBack":true}\n');
    const out = defaultSendBackReferralHold({ repo, pr: 1, head: 'a'.repeat(40) }, { exec });
    expect(out).toEqual({ action: 'send-back', sentBack: true });
    const [bin, argv, opts] = exec.mock.calls[0];
    expect(bin).toBe(process.execPath);
    expect(argv).toHaveLength(1);
    expect(resolvePath(argv[0])).toBe(resolvePath(here, '..', 'referral-hold-send-back.mjs'));
    expect(JSON.parse(opts.env.WE_AUTO_RESOLVE_SEND_BACK)).toMatchObject({ pr: 1 });
    expect(readFileSync(argv[0], 'utf8')).not.toMatch(/await import\(/);
  });
});
