/**
 * stale-hold-resume (live 2026-10-21) — #5773, #5775 and #5800 sat "review paused: head … was already reviewed 1
 * time(s); it resumes on a new push or an explicit re-arm" although every referral finding on the live head already
 * carried a ruling. No push or re-arm was coming. The fixtures are the three live threads (and their review-run
 * projections) as captured at 2026-10-21T17:30Z.
 */
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildOperatorRulingComment, readReferralRecords, REFERRAL_SUPERSEDE_REASON } from '../../lib/jury-core.mjs';
import { liveReferralState } from '../../lib/referral-live-context.mjs';
import { openReferralFindings } from '../../operations/record-referral-ruling.mjs';
import {
  decideReferralHoldAutoResolve, enrichPrsWithReferralHoldAutoResolve, enrichPrsWithReferralHolds, resolveReferralHoldAutoResolve,
  REFERRAL_HOLD_AUTO_RESOLVE_STANDARD,
  referralHoldSendBackBody, REFERRAL_HOLD_AUTO_RESOLVED,
} from '../review-referral-hold.mjs';
import { planReconcile as planReconcileWithTiming } from '../reconcile-core.mjs';
import { handleReferralHoldAutoResolve, operatorHoldsFromPlan, runReviewTick } from '../../../skills-src/conveyor/review-daemon.mjs';

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
  for (const n of [5773, 5775, 5800]) {
    it(`#${n}: before the fix the plan refuses review-referrals-pending (same-head) with nothing to resume it`, () => {
      const pr = enrich(FX[n], { env: { WE_REFERRAL_HOLD_AUTO_RESOLVE: '0' } });
      expect(pr.referralHold).toMatchObject({ kind: 'same-head', head: FX[n].headRefOid, count: 1 });
      expect(pr.referralHoldAutoResolve).toBeUndefined();
      const p = plan(pr);
      expect(p.dispatch).toEqual([]);
      expect(p.refusals.map(r => r.kind)).toEqual(['review-referrals-pending']);
      expect(p.refusals[0].why).toMatch(/already reviewed 1 time\(s\); it resumes on a new push or an explicit re-arm/);
      // The record-referral-ruling plan's reader agrees: nothing is open on the live head.
      const o = openReferralFindings({ comments: FX[n].comments, repo, pr: n, head: FX[n].headRefOid, body: FX[n].body, createdAt: FX[n].createdAt, cardReadable: noCards });
      expect(o.open).toEqual([]);
      expect(o.ruled.length).toBeGreaterThan(0);
    });
  }

  it('#5775 (all not-real on the live head) resumes: the pause becomes the human gate, no panel, no accept', () => {
    const pr = enrich(FX[5775]);
    expect(pr.referralHoldAutoResolve).toMatchObject({ outcome: 'resume', head: FX[5775].headRefOid, counts: { 'not-real': 1 } });
    const p = plan(pr);
    expect(p.dispatch).toEqual([]);
    expect(p.refusals).toHaveLength(1);
    const [row] = p.refusals;
    expect(row.kind).toBe('already-reviewed-head');
    expect(row.referralHold).toBeUndefined();
    expect(row.referralHoldAutoResolve).toMatchObject({ outcome: 'resume', next: 'human-review' });
    expect(row.why).toMatch(/^referral hold auto-resolved — every referral finding on head c5179f564 is ruled \(1 not-real\)/);
    expect(row.why).toMatch(/`review:human` kept/);
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

  it('#5773 resumes: its policy blocks stand only on OLDER heads (088b72962, b85dc59a6), so they never count', () => {
    const fx = FX[5773];
    const o = openReferralFindings({ comments: fx.comments, repo, pr: 5773, head: fx.headRefOid, body: fx.body, createdAt: fx.createdAt, cardReadable: noCards });
    // The standing list (any head) carries the old operator/policy blocks …
    expect(o.ruled.some(r => r.standing.some(s => s.result === 'block' && s.source === 'operator'))).toBe(true);
    // … but the live head's own rulings are all not-real, so no block is sent back.
    const pr = enrich(fx);
    expect(pr.referralHoldAutoResolve).toMatchObject({ outcome: 'resume', counts: { 'not-real': 3 } });
  });

  it('#5773: its one finished review left NO advisory on the PR (write-up to a local file, label swap refused), so the review resumes once', () => {
    const p = plan(enrich(FX[5773]));
    expect(p.refusals).toEqual([]);
    expect(p.dispatch.map(d => d.kind)).toEqual(['review']);
    expect(p.notes.filter(n => n.kind === 'referral-hold-auto-resolved')).toEqual([expect.objectContaining({
      prNumber: 5773, head: FX[5773].headRefOid, outcome: 'resume', next: 'advisory-review', counts: { 'not-real': 3 } })]);
    // The tick logs it once.
    const log = vi.fn(), seen = new Set();
    for (let t = 0; t < 2; t++) {
      runReviewTick({ repo, reconcile: () => ({ dispatch: [], refusals: [], notes: p.notes }), dispatch: vi.fn(), readPrs: () => [], readAgents: () => [],
        holdReconcile: () => [], tagRound: vi.fn(), tagStatus: vi.fn(), autoResolveSeen: seen, log });
    }
    expect(log.mock.calls.map(c => c[0]).filter(l => l.includes(REFERRAL_HOLD_AUTO_RESOLVED)))
      .toEqual([`review-daemon: referral-hold auto-resolved {"repo":"${repo}","pr":5773,"head":"${FX[5773].headRefOid}","outcome":"resume","counts":{"not-real":3},"next":"advisory-review"}`]);
  });

  it('#5773: a resumed review that DIES before advise (no finished run, no advisory) is not resumed again', () => {
    const fx = FX[5773];
    const last = fx.runs.filter(r => r.head === fx.headRefOid).sort((x, y) => x.completedAt - y.completedAt).at(-1);
    const died = { id: `${last.id}-died`, repo, pr: 5773, head: fx.headRefOid, startedAt: last.completedAt + 60_000, completedAt: null,
      incomplete: true, parked: false, attempted: false, persistenceFailed: false, count: 0, pending: ['review-incomplete'], rulings: [] };
    const [held] = enrichPrsWithReferralHolds([asPr(fx)], { repo, readRuns: () => [...fx.runs, died], now: Date.parse(fx.capturedAt), env: {} });
    expect(held.referralHold).toMatchObject({ kind: 'same-head', count: 1, attemptsSinceWake: 2 });
    const [pr] = enrichPrsWithReferralHoldAutoResolve([held], { repo, env: {}, decide: (q, h) => decide(q, h) });
    const p = plan(pr);
    expect(p.dispatch).toEqual([]);
    expect(p.refusals[0].referralHoldAutoResolve).toMatchObject({ outcome: 'stay' });
  });

  it('#5773: a SECOND finished review that still leaves no advisory keeps the pause (no panel per tick)', () => {
    const fx = FX[5773];
    const last = fx.runs.filter(r => r.head === fx.headRefOid).sort((x, y) => x.completedAt - y.completedAt).at(-1);
    const again = { ...last, id: `${last.id}-2`, startedAt: last.completedAt + 60_000, completedAt: last.completedAt + 600_000 };
    const [held] = enrichPrsWithReferralHolds([asPr(fx)], { repo, readRuns: () => [...fx.runs, again], now: Date.parse(fx.capturedAt), env: {} });
    expect(held.referralHold).toMatchObject({ kind: 'same-head', count: 2 });
    const [pr] = enrichPrsWithReferralHoldAutoResolve([held], { repo, env: {}, decide: (q, h) => decide(q, h) });
    const p = plan(pr);
    expect(p.dispatch).toEqual([]);
    expect(p.refusals.map(r => r.kind)).toEqual(['review-referrals-pending']);
    expect(p.refusals[0].referralHoldAutoResolve).toMatchObject({ outcome: 'stay', why: expect.stringMatching(/reviewed 2 time\(s\) and the PR still carries no advisory/) });
    expect(operatorHoldsFromPlan(p)).toEqual([{ prNumber: 5773, kind: 'review-referrals-pending' }]);
  });

  it('#5800 (one finding carried not-real from an earlier head, one ruled on the live head) resumes', () => {
    const pr = enrich(FX[5800]);
    expect(pr.referralHoldAutoResolve).toMatchObject({ outcome: 'resume', counts: { 'not-real': 2 } });
    expect(plan(pr).refusals.map(r => r.kind)).toEqual(['already-reviewed-head']);
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

  it('#5775 + an operator block on its live head: outcome send-back naming the blocked finding', () => {
    const pr = enrich(fx, { comments });
    expect(pr.referralHold).toMatchObject({ kind: 'same-head' });
    expect(pr.referralHoldAutoResolve).toMatchObject({ outcome: 'send-back', counts: { block: 1 } });
    expect(pr.referralHoldAutoResolve.blocked).toEqual([expect.objectContaining({ file: 'scripts/lib/git-identity.mjs', line: 241, actor: 'chalbert' })]);
    const body = referralHoldSendBackBody({ head: fx.headRefOid, blocked: pr.referralHoldAutoResolve.blocked });
    expect(body).toMatch(/^### Blocked referral findings \(operator ruling\)/);
    expect(body).toContain('`scripts/lib/git-identity.mjs:241`');
    expect(body).toContain(`on head \`${fx.headRefOid}\`. Fix each one, then push.`);
  });

  it('the plan sends it to a fixer and dispatches no review; the daemon sends it back exactly once', () => {
    const pr = enrich(fx, { comments });
    const p = plan(pr);
    // The planner's own block-ruled-referral fix already owns a live-head block whenever it can dispatch one.
    expect(p.dispatch.map(d => [d.kind, d.mode])).toEqual([['fix', 'block-ruled-referral']]);
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

  it('when the plan refuses the review on the pause, the row carries the send-back and says so', () => {
    const pr = { ...enrich(fx, { comments }), blockRuledReferrals: [] };
    const p = plan(pr);
    const row = p.refusals.find(r => r.kind === 'review-referrals-pending');
    expect(row.referralHoldAutoResolve).toMatchObject({ outcome: 'send-back' });
    expect(row.why).toMatch(/\(auto-resolve: every referral finding on head c5179f564 is ruled \(1 block\); 1 block ruling\(s\) owe a fix; sending back to the fixer\)$/);
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

  it('#5800 mixed (one block, one not-real on the live head): send-back names only the block', () => {
    const f = FX[5800];
    const r = liveRecord(f);
    const pr = asPr(f, [...f.comments, operatorRuling(f, { key: r.referrals[0].key, runId: r.runId, result: 'block', at: '2026-10-21T17:20:00.000Z' })]);
    const auto = decide(pr, { kind: 'same-head', head: f.headRefOid, count: 1 });
    expect(auto).toMatchObject({ outcome: 'send-back', counts: { block: 1, 'not-real': 1 } });
    expect(auto.blocked.map(b => b.key)).toEqual([r.referrals[0].key]);
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
  const pr = asPr(fx);
  const hold = { kind: 'same-head', head: fx.headRefOid, count: 1 };

  it('a pause on another head', () => {
    expect(decide(pr, { ...hold, head: 'a'.repeat(40) })).toMatchObject({ outcome: 'stay', why: 'the pause is not on the live head' });
  });
  it('a failed referral save (ledger-write-miss) or a no-verdict hold', () => {
    expect(decide(pr, { ...hold, persistenceFailed: true }).outcome).toBe('stay');
    expect(decide(pr, { ...hold, noVerdict: { exhausted: false } }).outcome).toBe('stay');
    expect(decide(pr, { ...hold, cause: 'ledger-unreadable' }).outcome).toBe('stay');
  });
  it('a ruling that is not readable on the thread never counts (a ledger-write-miss leaves the ledger row only)', () => {
    // The live-head record without its rulings, and no operator ruling comment: the thread proves no ruling.
    const strip = c => {
      const m = /<!-- mandatory-referrals-v1: (\S+) -->/.exec(c.body);
      if (!m) return c;
      const record = JSON.parse(decodeURIComponent(m[1]));
      if (record.head !== fx.headRefOid) return c;
      return { ...c, body: c.body.replace(m[1], encodeURIComponent(JSON.stringify({ ...record, rulings: [] }))) };
    };
    const comments = fx.comments.filter(c => !(c.author.login === 'chalbert' && c.body.startsWith('## Operator ruling'))).map(strip);
    expect(liveRecord({ ...fx, comments }).rulings).toEqual([]);
    const out = decide(asPr(fx, comments), hold);
    expect(out).toMatchObject({ outcome: 'stay', why: expect.stringMatching(/no readable ruling/) });
  });
  it('a malformed operator ruling on the live head', () => {
    const rec = liveRecord(fx);
    const good = operatorRuling(fx, { key: rec.referrals[0].key, runId: rec.runId, result: 'not-real', at: '2026-10-21T12:00:00.000Z' });
    // A truncated write: the trailer's payload no longer decodes, so the head it names is unknown.
    const bad = { ...good, body: good.body.replace(/: [A-Za-z0-9+/=]+ -->$/, ': e30tYnJva2Vu -->') };
    const out = decide(asPr(fx, [...fx.comments, bad]), hold);
    expect(out.outcome).toBe('stay');
  });
  it('an operator ruling for a different head only (the live head has no ruling of its own) does not count', () => {
    const f = FX[5800];
    const r = liveRecord(f);
    const other = '1'.repeat(40);
    const prOther = asPr({ ...f, headRefOid: other });
    // A pause on a head with no records at all: nothing proves anything.
    expect(decide(prOther, { ...hold, head: other })).toMatchObject({ outcome: 'stay', why: 'no referral record names the live head' });
    expect(r.head).toBe(f.headRefOid);
  });
  it('an operator carry the gate backs (source ruling on an older head) counts; the same ruling without the carry does not', () => {
    const f = FX[5800];
    const rec = liveRecord(f);
    const carry = rec.carried[0];
    const source = readReferralRecords(f.comments, { head: f.headRefOid }).records.find(r => r.head === carry.from.head && r.runId === carry.from.runId);
    expect(source).toBeTruthy();
    // The operator's not-real on the SOURCE head, and the carry rewritten as an operator-backed one (no rulingId).
    const opAt = '2026-10-21T15:45:00.000Z';
    const op = operatorRuling({ ...f, headRefOid: carry.from.head }, { key: carry.from.key, runId: carry.from.runId, result: 'not-real', at: opAt });
    const rewrite = (c, mutate) => {
      const m = /<!-- mandatory-referrals-v1: (\S+) -->/.exec(c.body);
      if (!m) return c;
      const record = JSON.parse(decodeURIComponent(m[1]));
      if (record.head !== f.headRefOid) return c;
      return { ...c, body: c.body.replace(m[1], encodeURIComponent(JSON.stringify(mutate(record)))) };
    };
    const at = f.comments.findIndex(c => c.createdAt > opAt);
    const base = [...f.comments.slice(0, at), op, ...f.comments.slice(at)];
    const withCarry = base.map(c => rewrite(c, r => ({ ...r, carried: r.carried.map(x => ({ ...x, from: { head: x.from.head, runId: x.from.runId, key: x.from.key } })) })));
    const hold = { kind: 'same-head', head: f.headRefOid, count: 1 };
    const gate = liveReferralState(asPr(f, withCarry), { repo, pr: 5800, cardReadable: noCards });
    expect(gate).toMatchObject({ pending: [], blocked: [], malformed: false });
    expect(decide(asPr(f, withCarry), hold)).toMatchObject({ outcome: 'resume', counts: { 'not-real': 2 } });
    // Without the carry entry, the older-head operator ruling proves nothing about the live head.
    const noCarry = base.map(c => rewrite(c, r => { const { carried, ...rest } = r; return rest; }));
    expect(decide(asPr(f, noCarry), hold).outcome).toBe('stay');
  });

  it('a carry whose live-head key differs from its source key still counts (the backing is keyed by the source)', () => {
    const f = FX[5800];
    const rec = liveRecord(f);
    const carry = rec.carried[0];
    const comments = f.comments.map(c => {
      const m = /<!-- mandatory-referrals-v1: (\S+) -->/.exec(c.body);
      if (!m) return c;
      const record = JSON.parse(decodeURIComponent(m[1]));
      if (record.head !== f.headRefOid) return c;
      const ref = record.referrals.find(x => x.key === carry.key);
      const k = JSON.parse(ref.key); k[3] = `${k[3]}!`;
      const key = JSON.stringify(k);
      const referrals = record.referrals.map(x => (x.key === carry.key ? { ...x, key,
        finding: { ...x.finding, summary: `${x.finding.summary}!` }, ...(x.original ? { original: { ...x.original, summary: `${x.original.summary}!` } } : {}) } : x));
      return { ...c, body: c.body.replace(m[1], encodeURIComponent(JSON.stringify({ ...record, referrals,
        carried: record.carried.map(x => (x.key === carry.key ? { ...x, key } : x)) }))) };
    });
    const gate = liveReferralState(asPr(f, comments), { repo, pr: 5800, cardReadable: noCards });
    expect(gate).toMatchObject({ pending: [], blocked: [], malformed: false });
    expect(decide(asPr(f, comments), { kind: 'same-head', head: f.headRefOid, count: 1 })).toMatchObject({ outcome: 'resume', counts: { 'not-real': 2 } });
  });

  it('a superseded advisory duplicate the gate backs reads as the not-real that replaced it', () => {
    const rec = liveRecord(fx);
    const orig = rec.referrals[0];
    const ruling = rec.rulings.find(r => r.key === orig.key);
    const dupKey = JSON.stringify(['judgeAdvisory', orig.finding.file, orig.finding.line, `${orig.finding.summary} (duplicate wording)`]);
    const comments = fx.comments.map(c => {
      const m = /<!-- mandatory-referrals-v1: (\S+) -->/.exec(c.body);
      if (!m) return c;
      const record = JSON.parse(decodeURIComponent(m[1]));
      if (record.head !== fx.headRefOid) return c;
      const next = { ...record, referrals: [...record.referrals, { key: dupKey, seat: 'judgeAdvisory', finding: { ...orig.finding, summary: `${orig.finding.summary} (duplicate wording)` },
          original: { ...orig.original, summary: `${orig.finding.summary} (duplicate wording)` } }],
        superseded: [{ key: dupKey, reason: REFERRAL_SUPERSEDE_REASON, by: { runId: record.runId, key: orig.key, rulingId: ruling.id } }] };
      return { ...c, body: c.body.replace(m[1], encodeURIComponent(JSON.stringify(next))) };
    });
    const gate = liveReferralState(asPr(fx, comments), { repo, pr: 5775, cardReadable: noCards });
    expect(gate).toMatchObject({ pending: [], blocked: [], malformed: false });
    expect(liveRecord({ ...fx, comments }).referrals.map(r => r.key)).toContain(dupKey);
    expect(decide(asPr(fx, comments), hold)).toMatchObject({ outcome: 'resume', counts: { 'not-real': 2 } });
  });

  it('the kill switch turns it off', () => {
    expect(decide(pr, hold, { env: { WE_REFERRAL_HOLD_AUTO_RESOLVE: '0' } })).toBeNull();
  });
  it('a stay is logged once per reason, and the pause notice still posts', () => {
    const log = vi.fn();
    const seen = new Set();
    const auto = { outcome: 'stay', head: fx.headRefOid, why: 'x' };
    expect(handleReferralHoldAutoResolve({ repo, row: { prNumber: 5775 }, auto, seen, log })).toBeNull();
    handleReferralHoldAutoResolve({ repo, row: { prNumber: 5775 }, auto, seen, log });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/referral-hold auto-resolve kept the pause .*"why":"x"/);
  });
  it('a resume on a PR that is not review:human stays paused (no second verdict on an unchanged head)', () => {
    const p0 = enrich(fx);
    const p = plan({ ...p0, labels: [{ name: 'review:pending' }] });
    expect(p.dispatch.filter(d => d.kind === 'review')).toEqual([]);
    const row = p.refusals.find(r => r.kind === 'review-referrals-pending');
    expect(row?.referralHoldAutoResolve).toMatchObject({ outcome: 'stay' });
  });
});

describe('policy: referralHoldAutoResolve is a setting (value and source logged), with a kill switch to the pause', () => {
  const fx = FX[5775];
  const hold = { kind: 'same-head', head: fx.headRefOid, count: 1 };
  it('standard: on, block → send-back, clean → resume; the tool file ships the same values', () => {
    expect(REFERRAL_HOLD_AUTO_RESOLVE_STANDARD).toEqual({ enabled: true, onBlock: 'send-back', onClean: 'resume' });
    const r = resolveReferralHoldAutoResolve({}, { log: () => {} });
    expect(r.value).toEqual({ enabled: true, onBlock: 'send-back', onClean: 'resume' });
    expect(Object.values(r.sources).every(v => ['standard', 'tool', 'platform'].includes(v))).toBe(true);
  });
  it('env beats the tool layer and is named as the source; invalid values are ignored', () => {
    const r = resolveReferralHoldAutoResolve({ WE_REFERRAL_HOLD_AUTO_RESOLVE: '0', WE_REFERRAL_HOLD_AUTO_RESOLVE_ON_BLOCK: 'pause',
      WE_REFERRAL_HOLD_AUTO_RESOLVE_ON_CLEAN: 'accept' }, { tool: { enabled: true, onBlock: 'send-back', onClean: 'resume' }, log: () => {} });
    expect(r.value).toEqual({ enabled: false, onBlock: 'pause', onClean: 'resume' });
    expect(r.sources).toMatchObject({ enabled: 'env', onBlock: 'env' });
    expect(r.sources.onClean).not.toBe('env');
  });
  it('a malformed (object) value in the tool layer never overrides a valid platform kill switch', () => {
    const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'rhar-'));
    try {
      const file = join(dir, 'platform-preferences.json');
      writeFileSync(file, JSON.stringify({ referralHoldAutoResolve: { enabled: false, onClean: 'pause' } }));
      const r = resolveReferralHoldAutoResolve({ WE_PLATFORM_PREFERENCES_FILE: file },
        { tool: { enabled: { nested: true }, onClean: { nested: 'resume' } }, log: () => {} });
      expect(r.value).toMatchObject({ enabled: false, onClean: 'pause' });
      expect(r.sources).toMatchObject({ enabled: 'platform', onClean: 'platform' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('enabled=false is today\'s pause exactly: no answer, the plan refuses review-referrals-pending as before', () => {
    const settings = { value: { enabled: false, onBlock: 'send-back', onClean: 'resume' }, sources: { enabled: 'env' } };
    expect(decide(asPr(fx), hold, { settings })).toBeNull();
    const [held] = enrichPrsWithReferralHolds([asPr(fx)], { repo, readRuns: () => fx.runs, now: Date.parse(fx.capturedAt), env: {} });
    const [pr] = enrichPrsWithReferralHoldAutoResolve([held], { repo, settings, decide: (p, h, o) => decide(p, h, o) });
    expect(pr.referralHoldAutoResolve).toBeUndefined();
    expect(plan(pr).refusals.map(r => r.kind)).toEqual(['review-referrals-pending']);
  });
  it('onClean=pause keeps an all-not-real pause and says which setting and source did it', () => {
    const settings = { value: { enabled: true, onBlock: 'send-back', onClean: 'pause' }, sources: { onClean: 'tool' } };
    expect(decide(asPr(fx), hold, { settings })).toMatchObject({ outcome: 'stay',
      why: expect.stringMatching(/referralHoldAutoResolve\.onClean=pause \(source: tool\) keeps the pause/) });
  });
  it('onBlock=pause keeps a live-head block paused', () => {
    const rec = liveRecord(fx);
    const block = operatorRuling(fx, { key: rec.referrals[0].key, runId: rec.runId, result: 'block', at: '2026-10-21T10:58:00.000Z' });
    const settings = { value: { enabled: true, onBlock: 'pause', onClean: 'resume' }, sources: { onBlock: 'env' } };
    expect(decide(asPr(fx, [...fx.comments, block]), hold, { settings })).toMatchObject({ outcome: 'stay',
      why: expect.stringMatching(/onBlock=pause \(source: env\)/) });
  });
});
