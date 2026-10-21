import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createActionStore } from '../../operations/action-store.mjs';
import { publishAttention, runOnce as pollNeedsYou, unacknowledged, acknowledge } from '../../operations/needs-you-feed.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newRunRecord, tryReadRun, writeRun } from '../../operations/run-store.mjs';
import { buildOperatorRulingComment, mandatoryReferralReviewer, mandatoryReferralState, normalizeFinding, referralFindingKey, renderReferralRecord } from '../../lib/jury-core.mjs';
import { referralCardReadable } from '../../lib/referral-card-readable.mjs';
import { REARM_COMMENT_MARKER } from '../rearm-review.mjs';
import { runReconcilePass as runReconcilePassWithTiming } from '../reconcile-pass.mjs';
const runReconcilePass = (options = {}) => runReconcilePassWithTiming({ ...options, env: { WE_REVIEW_START_AFTER: 'ci-green', WE_FIX_JOIN_CI_AND_REVIEW: 'false', ...options.env } });
import { countFindings, planReconcile } from '../reconcile-core.mjs';
import { ADVISORY_REARM_COMMENT_MARKER } from '../advisory-fix-mark.mjs';
import {
  classifyPausedReview, reviewRunEvidence, readReviewRunEvidence, decideReferralHold, enrichPrsWithReferralHolds,
  notifyReferralHold, REFERRAL_RETRY_MS, decideSameHeadHold, resolveSameHeadMaxReviews, PENDING_REASON_TOKENS,
  GH_LIST_COMMENT_CAP, findResumableParkedRun, blockRuledReferralsFor, filterFixerReferrals, REFERRAL_REARM_COMMENT_MARKER,
  VERDICT_COOLDOWN_BASE_MS, VERDICT_COOLDOWN_CAP_MS, VERDICT_COOLDOWN_MAX_RELEASES,
  resolveNoVerdictRetry, NO_VERDICT_RETRY_STANDARD, raiseNoVerdictNeedsYou, NO_VERDICT_NEEDS_YOU_KIND, needsYouClaimRoot,
} from '../review-referral-hold.mjs';

it('keeps the cycle-free referral matcher equal to the canonical re-arm marker', () => {
  expect(REFERRAL_REARM_COMMENT_MARKER).toBe(REARM_COMMENT_MARKER);
  expect(ADVISORY_REARM_COMMENT_MARKER).toBe(REARM_COMMENT_MARKER);
});

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
// `body` / `createdAt` are what `gh pr list` returns; the live release reads them exactly as the gate does.
const pr = (overrides = {}) => ({ number: 3481, headRefOid: head, headRefName: 'lane/referrals',
  body: '<!-- authored-by-actor: author -->', createdAt: iso(at - 3_600_000),
  labels: [{ name: 'review:human' }], comments: [], mergeStateStatus: 'CLEAN',
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], ...overrides });
const evidence = opts => reviewRunEvidence(run(opts));
const hold = (p = pr(), runs = [evidence()], now = at + 1) => decideReferralHold(p, runs, { repo, now });

function reconcile(p, options = {}) {
  return runReconcilePass({ repo, now: at + 1, readPrs: () => [p], readAgents: () => [], enrich: x => x,
    enrichMainRed: prs => ({ prs }), enrichAlreadyLanded: x => x, enrichBaseRef: x => x,
    enrichSystemFix: x => x, enrichFixClaims: x => x, enrichTimeouts: x => x,
    resolveMainSha: () => null, readRequiredChecks: () => ({ checks: ['test'] }), ...options,
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
  it.each([
    ['chalbert/web-everything', 'web-everything/web-everything', true],
    ['web-everything/web-everything', 'chalbert/web-everything', true],
    ['web-everything/web-everything', 'other/repo', false],
  ])('operator block wakes the paused subject %s / %s', (subjectRepo, rulingRepo, matches) => {
    const body = buildOperatorRulingComment({ version: 1, repo: rulingRepo, pr: 3481, head,
      actor: 'chalbert', channel: 'test', reason: 'fix the defect', at: iso(at + 1), clearerId: '',
      rulings: [{ runId: record().runId, key, result: 'block' }] });
    const result = decideReferralHold(pr({ comments: [comment(body)] }), [{ ...evidence(), repo: subjectRepo }],
      { repo: subjectRepo, now: at + 2 });
    expect(result === null).toBe(matches);
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
    const partial = reviewRunEvidence(unfinished);
    expect(partial).toMatchObject({ incomplete: true, completedAt: null, parked: false, attempted: false });
    expect(partial.pending.length).toBeGreaterThan(0); // never evidence of a clean, completed review
    expect(hold(pr(), [partial])).toBeNull();
    expect(findResumableParkedRun(pr(), [partial], { repo })).toBeNull();
    expect(decideSameHeadHold(pr(), [partial], { repo })).toBeNull();
  });
  it('only newer attempts on the same PR supersede a parked review', () => {
    const parked = evidence();
    const crashed = { ...parked, id: 'crashed', incomplete: true, parked: false, attempted: false,
      completedAt: null, startedAt: at + 1 };
    for (const unrelated of [{ ...crashed, pr: 99 }, { ...crashed, repo: 'other/repo' },
      { ...crashed, startedAt: parked.startedAt - 1 }]) {
      expect(hold(pr(), [parked, unrelated])).not.toBeNull();
    }
    for (const startedAt of [parked.startedAt, at + 1]) {
      expect(hold(pr(), [parked, { ...crashed, startedAt }])).toBeNull();
    }
    // Completing the newer attempt with referrals restores its own referral hold.
    expect(hold(pr(), [parked, evidence({ id: 'crashed', time: at + 120_000 })])).not.toBeNull();
    // An older panel finishing late cannot reclaim the release consumed by the newer attempt.
    const latePark = { ...parked, completedAt: at + 120_000 };
    const ruled = record();
    ruled.rulings = [{ id: 'r1', key, reviewerId: ruled.reviewer.id, lens: ruled.reviewer.lens,
      result: 'not-real', rationale: 'checked', evidence: ['diff'] }];
    const p = pr({ comments: [comment(renderReferralRecord(ruled), at + 180_000)] });
    expect(findResumableParkedRun(p, [latePark], { repo })).toEqual({ id: parked.id, head });
    expect(findResumableParkedRun(p, [latePark, crashed], { repo })).toBeNull();
  });
  // Live 2026-10-10: 3,303 review-pr records (0.8 GB) were re-read and JSON-parsed by EVERY reconcile-pass process —
  // minutes under host load, which timed out the drain rebuild's reconcile/dispatch smoke checks. The projection
  // persists on disk now, so a fresh process parses only records that changed.
  it('a fresh process reuses the on-disk projection: unchanged records are never re-parsed', () => {
    const dir = temp(); writeRun(run(), dir); writeRun(run({ id: 'review-pr-other', attempted: false }), dir);
    const first = vi.fn(tryReadRun);
    const before = readReviewRunEvidence({ dir, readRun: first, memo: new Map() });
    expect(first).toHaveBeenCalledTimes(2);
    const second = vi.fn(tryReadRun);
    expect(readReviewRunEvidence({ dir, readRun: second, memo: new Map() })).toEqual(before);
    expect(second).not.toHaveBeenCalled();
    const done = run(); done.findings.referralVerdict = { verdict: 'accept', pendingReferrals: [] };
    writeRun(done, dir);
    const third = vi.fn(tryReadRun);
    const after = readReviewRunEvidence({ dir, readRun: third, memo: new Map() });
    expect(third).toHaveBeenCalledTimes(1);
    expect(after.find(e => e.id === 'review-pr-parked').parked).toBe(false);
    expect(readdirSync(dir).filter(n => n.endsWith('.json')).sort()).toEqual(['review-pr-other.json', 'review-pr-parked.json']);
  });
  // xwu9oxh S6 — live 2026-10-20 the warm fix daemon re-parsed the ~45 MB projection on every reconcile pass.
  it('a warm process parses a few new records directly and leaves the on-disk projection alone', () => {
    const dir = temp(); writeRun(run(), dir);
    const memo = new Map();
    readReviewRunEvidence({ dir, memo });
    const cache = join(dir, readdirSync(dir).find(n => !n.endsWith('.json')));
    const onDisk = readFileSync(cache, 'utf8');
    writeRun(run({ id: 'review-pr-other', attempted: false }), dir);
    const warm = vi.fn(tryReadRun);
    const after = readReviewRunEvidence({ dir, readRun: warm, memo });
    expect(warm).toHaveBeenCalledTimes(1);
    expect(after.map(e => e.id).sort()).toEqual(['review-pr-other', 'review-pr-parked']);
    expect(readFileSync(cache, 'utf8')).toBe(onDisk);
    // A cold process still gets the speed-up for what the file holds and parses only the rest — same evidence.
    const cold = vi.fn(tryReadRun);
    expect(readReviewRunEvidence({ dir, readRun: cold, memo: new Map() })).toEqual(after);
    expect(cold).toHaveBeenCalledTimes(1);
    expect(readFileSync(cache, 'utf8')).not.toBe(onDisk);
  });
  it('a corrupt or foreign on-disk projection is ignored, never trusted', () => {
    const dir = temp(); writeRun(run(), dir);
    readReviewRunEvidence({ dir, memo: new Map() });
    const cache = readdirSync(dir).find(n => !n.endsWith('.json'));
    expect(cache).toBeTruthy();
    for (const junk of ['{not json', JSON.stringify({ v: 1, code: 'some-older-projection', entries: { 'review-pr-parked.json': { key: 'x', evidence: null } } })]) {
      writeFileSync(join(dir, cache), junk);
      const spy = vi.fn(tryReadRun);
      expect(readReviewRunEvidence({ dir, readRun: spy, memo: new Map() })).toHaveLength(1);
      expect(spy).toHaveBeenCalledTimes(1);
    }
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

// The live release must agree with the gate that would re-park the PR: every branch of "released" has a negative twin.
describe('live release (parity with the gate)', () => {
  const card = readdirSync('backlog').find(n => /^\d+-.+\.md$/.test(n));
  const ruled = (result, extra = {}, base = record()) => ({ ...base, rulings: [{ id: 'r1', key, reviewerId: base.reviewer.id,
    lens: base.reviewer.lens, result, rationale: 'confirmed', evidence: ['diff'], ...extra }] });
  const withRecord = (r, overrides = {}) => pr({ comments: [comment(renderReferralRecord(r), at - 120_000)], ...overrides });

  it.each([
    ['a reviewer block ruling on the current head', ruled('block')],
    ['a card ruling citing a readable backlog card', ruled('card', { card: `we:backlog/${card}` })],
  ])('releases on %s', (_name, r) => {
    expect(hold(withRecord(r))).toBeNull();
  });

  it.each([
    ['no record on the current head', () => pr()],
    ['a record only on another head', () => withRecord(ruled('block', {}, { ...record(), head: 'b'.repeat(40) }))],
    ['a record for another PR', () => withRecord(ruled('block', {}, { ...record(), pr: 9999 }))],
    ['a card ruling citing an unreadable card (the gate re-parks it)', () => withRecord(ruled('card', { card: 'we:backlog/no-such-card.md' }))],
    ['a missing author stamp under the default refuse policy', () => withRecord(ruled('block'), { body: '', createdAt: iso(at) })],
  ])('keeps holding on %s', (_name, build) => {
    expect(hold(build())).not.toBeNull();
  });

  it('keeps holding on a missing author stamp under WE_REFERRAL_MISSING_STAMP=refuse', () => {
    vi.stubEnv('WE_REFERRAL_MISSING_STAMP', 'refuse');
    expect(hold(withRecord(ruled('block'), { body: '', createdAt: iso(at) }))).not.toBeNull();
  });

  it('agrees with the gate on the very same comments', () => {
    for (const r of [ruled('block'), ruled('card', { card: 'we:backlog/no-such-card.md' }), ruled('card', { card: `we:backlog/${card}` })]) {
      const p = withRecord(r);
      const gate = mandatoryReferralState(p.comments, { repo, pr: 3481, head, body: p.body, createdAt: p.createdAt,
        cardReadable: referralCardReadable });
      expect(hold(p) === null).toBe(gate.pending.length === 0);
    }
  });

  // The hold omits the gate's `seatDisabled` (the header of referral-live-context.mjs says that only ever errs toward
  // holding). Pin it: a seat-disabled retirement the gate honours never lets the hold release what the gate holds.
  it('never releases what the gate holds, even when only the gate retires a disabled seat', () => {
    const p = withRecord(record());
    const gate = seatDisabled => mandatoryReferralState(p.comments, { repo, pr: 3481, head, body: p.body,
      createdAt: p.createdAt, cardReadable: referralCardReadable, ...(seatDisabled ? { seatDisabled } : {}) });
    expect(gate().pending).toEqual([key]);
    expect(hold(p)).not.toBeNull();
    // The gate alone retires the unruled finding; the hold keeps it pending (the documented over-hold, never an under-hold).
    expect(gate(seat => seat === 'judge').pending).toEqual([]);
    expect(hold(p)).not.toBeNull();
  });

  // Each conjunct of the live-release condition has a negative twin: a cleared gate alone does not release a hold
  // that is inside its persistence-failure retry budget.
  it('keeps the 15/30/60-minute retry budget when the run failed to persist, even with a cleared live gate', () => {
    const cleared = withRecord(ruled('block'));
    expect(hold(cleared)).toBeNull();
    expect(hold(cleared, [evidence({ failure: true })])).toMatchObject({ persistenceFailed: true, retryAt: at + REFERRAL_RETRY_MS[0] });
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

describe('full comment thread enrichment', () => {
  const comments = () => Array.from({ length: 100 }, () => comment('Bookkeeping', at - 120_000));

  it.each([true, false])('releases a capped thread after an operator reply (parked: %s)', parked => {
    const p = pr({ comments: comments() });
    const readRuns = () => [{ ...evidence(), parked }];
    expect(enrichPrsWithReferralHolds([p], { repo, readRuns,
      readComments: () => p.comments })[0].referralHold).not.toBeNull();
    const full = [...p.comments, comment('Please reconsider.', at + 1, 'chalbert')];
    const readComments = vi.fn(() => full);
    const [enriched] = enrichPrsWithReferralHolds([p], { repo, readRuns, readComments });
    expect(enriched.referralHold).toBeNull();
    expect(enriched.comments).toBe(full);
    expect(readComments).toHaveBeenCalledOnce();
    expect(readComments).toHaveBeenCalledWith({ repo, number: p.number });
    expect(GH_LIST_COMMENT_CAP).toBe(100);
  });

  it('does not fetch threads below the list cap', () => {
    const readComments = vi.fn();
    enrichPrsWithReferralHolds([pr({ comments: comments().slice(1) })], {
      repo, readRuns: () => [evidence()], readComments,
    });
    expect(readComments).not.toHaveBeenCalled();
  });

  it.each(['no runs', 'different head', 'different repo', 'different PR'])
    ('does not fetch a capped thread with %s', mismatch => {
      const rows = {
        'no runs': [],
        'different head': [{ ...evidence(), head: 'b'.repeat(40) }],
        'different repo': [{ ...evidence(), repo: 'other/repo' }],
        'different PR': [{ ...evidence(), pr: 99 }],
      };
      const readComments = vi.fn();
      enrichPrsWithReferralHolds([pr({ comments: comments() })], {
        repo, readRuns: () => rows[mismatch], readComments,
      });
      expect(readComments).not.toHaveBeenCalled();
    });

  it('keeps the truncated thread and hold when the full read throws', () => {
    const p = pr({ comments: comments() });
    const readComments = vi.fn(() => { throw new Error('read failed'); });
    const [enriched] = enrichPrsWithReferralHolds([p], {
      repo, readRuns: () => [evidence()], readComments,
    });
    expect(readComments).toHaveBeenCalledOnce();
    expect(enriched.comments).toBe(p.comments);
    expect(enriched.referralHold).not.toBeNull();
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
  // Review round 1, finding 2: a pending list of reason tokens only must not read as "attempted, 0 referrals".
  it.each([
    ['token only', ['author-stamp-missing'], { attempted: false, count: 0 }],
    ['key only', [key], { attempted: true, count: 1 }],
    ['token and key', ['author-stamp-missing', key], { attempted: true, count: 1 }],
    ['empty', [], { attempted: false, count: 0, parked: false }],
  ])('classifies a %s pending list', (_, pending, expected) => {
    const r = run();
    r.findings.referralVerdict.pendingReferrals = pending;
    r.verdict = r.findings.referralVerdict;
    if (!pending.includes(key)) r.findings.mandatoryReferrals.effects[0].result.records = [];
    expect(reviewRunEvidence(r)).toMatchObject(expected);
  });
  it('a token-only parked run never produces a "0 referrals" hold', () => {
    const r = run();
    r.findings.referralVerdict.pendingReferrals = ['author-stamp-missing'];
    r.verdict = r.findings.referralVerdict;
    r.findings.mandatoryReferrals.effects[0].result.records = [];
    expect(hold(pr(), [reviewRunEvidence(r)])).toBeNull();
  });
  // Review round 1, finding 1: the referral hold's deliberate live release must not be re-held by the same-head guard.
  it('does not re-hold a PR whose referrals were ruled in the live thread before the parked run started', () => {
    const r = record();
    r.rulings = [{ id: 'r1', key, reviewerId: r.reviewer.id, lens: r.reviewer.lens,
      result: 'block', rationale: 'confirmed', evidence: ['diff'] }];
    const p = pr({ comments: [comment(renderReferralRecord(r), at - 120_000)] });
    expect(hold(p)).toBeNull();
    expect(enrichPrsWithReferralHolds([p], { repo, now: at + 1, readRuns: () => [evidence()] })[0].referralHold).toBeNull();
  });
  it.each([
    ['live gate not yet cleared', pr({ comments: [comment(renderReferralRecord(record()), at - 120_000)] }), 'referral'],
    ['no referral evidence at all', pr(), 'referral'],
  ])('still holds when %s', (_, p) => {
    expect(enrichPrsWithReferralHolds([p], { repo, now: at + 1, readRuns: () => [evidence()] })[0].referralHold)
      .not.toBeNull();
  });
  it('a wake event after the parked run releases the PR through the enricher too', () => {
    const p = pr({ comments: [comment(REARM_COMMENT_MARKER, at + 1)] });
    // The completed run started before the wake event, so neither guard holds a fresh review back.
    expect(enrichPrsWithReferralHolds([p], { repo, now: at + 2, readRuns: () => [evidence()] })[0].referralHold).toBeNull();
  });
  it('an elapsed persistence-failure retry releases the PR through the enricher too', () => {
    const rows = [evidence({ failure: true })];
    const early = enrichPrsWithReferralHolds([pr()], { repo, now: at + 1, readRuns: () => rows })[0].referralHold;
    expect(early).toMatchObject({ persistenceFailed: true });
    const late = enrichPrsWithReferralHolds([pr()], { repo, now: at + REFERRAL_RETRY_MS[0] + 1, readRuns: () => rows })[0].referralHold;
    expect(late).toBeNull();
  });
  it('still applies the same-head guard when the referral hold returns null for a non-release reason', () => {
    const rows = [{ ...evidence(), parked: false }];
    expect(enrichPrsWithReferralHolds([pr()], { repo, now: at + 1, readRuns: () => rows })[0].referralHold.kind)
      .toBe('same-head');
  });
  it('posts no extra notice for a same-head hold', () => {
    const post = vi.fn(), log = vi.fn();
    notifyReferralHold({ repo, prNumber: 3481, hold: { ...hold(), kind: 'same-head' }, dir: temp(), post, log });
    expect(post).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

// Live 2026-10-06, #4017: every referral ruled `block` on head H, H reviewed once. The same-head pause refused every
// tick, so the fix that would change H never went out. The pause stops a re-REVIEW only.
describe('block-ruled referrals route to a fix, not the same-head pause', () => {
  const ruledRecord = (result = 'block') => ({ ...record(), rulings: [{ id: 'r1', key, reviewerId: record().reviewer.id,
    lens: record().reviewer.lens, result, rationale: 'confirmed', evidence: ['diff'] }] });
  const reviewedOnce = [{ ...evidence(), parked: false }];
  const plan = p => runReconcilePass({ repo, now: at + 1, readPrs: () => [p], readAgents: () => [], enrich: x => x,
    enrichMainRed: prs => ({ prs }), enrichAlreadyLanded: x => x, enrichBaseRef: x => x,
    enrichSystemFix: x => x, enrichFixClaims: x => x, enrichTimeouts: x => x,
    enrichReferralHolds: prs => enrichPrsWithReferralHolds(prs, { repo, now: at + 1, readRuns: () => reviewedOnce }),
    resolveMainSha: () => null, readRequiredChecks: () => ({ checks: ['test'] }) });
  it('all referrals ruled block on the reviewed head: the review stays paused, a fix is dispatched with the findings', () => {
    const p = pr({ comments: [comment(renderReferralRecord(ruledRecord()), at - 120_000)] });
    const [enriched] = enrichPrsWithReferralHolds([p], { repo, now: at + 1, readRuns: () => reviewedOnce });
    expect(enriched.referralHold.kind).toBe('same-head');
    expect(enriched.blockRuledReferrals).toHaveLength(1);
    const out = plan(p);
    expect(out.dispatch).toContainEqual(expect.objectContaining({ kind: 'fix', mode: 'block-ruled-referral', prNumber: 3481,
      blockRuledReferrals: [expect.objectContaining({ key, finding: expect.objectContaining({ summary: 'broken case' }) })] }));
    expect(out.dispatch.some(d => d.kind === 'review')).toBe(false);
  });
  it('all referrals ruled block on a review:pending head: a fix is dispatched, not a review', () => {
    const p = pr({ labels: [{ name: 'review:pending' }], comments: [comment(renderReferralRecord(ruledRecord()), at - 120_000)] });
    const [enriched] = enrichPrsWithReferralHolds([p], { repo, now: at + 1, readRuns: () => reviewedOnce });
    expect(enriched.blockRuledReferrals).toHaveLength(1);
    const out = plan(p);
    expect(out.dispatch).toContainEqual(expect.objectContaining({ kind: 'fix', mode: 'block-ruled-referral', prNumber: 3481,
      blockRuledReferrals: [expect.objectContaining({ key, finding: expect.objectContaining({ summary: 'broken case' }) })] }));
    expect(out.dispatch.some(d => d.kind === 'review')).toBe(false);
  });
  it('unruled referrals on a review:pending head still dispatch no fix', () => {
    const p = pr({ labels: [{ name: 'review:pending' }], comments: [comment(renderReferralRecord(record()), at - 120_000)] });
    const [enriched] = enrichPrsWithReferralHolds([p], { repo, now: at + 1, readRuns: () => reviewedOnce });
    expect(enriched.blockRuledReferrals).toEqual([]);
    expect(plan(p).dispatch.some(d => d.kind === 'fix')).toBe(false);
  });
  it('unruled referrals are still paused (no fix)', () => {
    const p = pr({ comments: [comment(renderReferralRecord(record()), at - 120_000)] });
    const [enriched] = enrichPrsWithReferralHolds([p], { repo, now: at + 1, readRuns: () => reviewedOnce });
    expect(enriched.blockRuledReferrals).toEqual([]);
    expect(enriched.referralHold).not.toBeNull();
    expect(plan(p).dispatch.some(d => d.kind === 'fix')).toBe(false);
  });
  it('not-real rulings and no rulings leave behaviour unchanged', () => {
    for (const comments of [[], [comment(renderReferralRecord(ruledRecord('not-real')), at - 120_000)]]) {
      const [enriched] = enrichPrsWithReferralHolds([pr({ comments })], { repo, now: at + 1, readRuns: () => reviewedOnce });
      expect(enriched.blockRuledReferrals).toEqual([]);
      expect(enriched.referralHold?.kind).toBe('same-head');
      expect(plan(pr({ comments })).dispatch.some(d => d.kind === 'fix')).toBe(false);
    }
  });
});

describe('same-head hold never silences a review whose verdict never landed (live #4288, 2026-10-07)', () => {
  const lost = (over = {}) => ({ ...evidence(), parked: false, completedAt: Date.now() - 3600_000, startedAt: Date.now() - 3700_000, ...over });
  const labelled = (labels, over = {}) => pr({ labels: labels.map(name => ({ name })), ...over });
  it('releases (null) when the only completed run left the PR review:pending with no reviewed-sha marker', () => {
    expect(decideSameHeadHold(labelled(['review:pending', 'review-round:1']), [lost()], { repo, env: {} })).toBeNull();
  });
  const lostRuns = count => Array.from({ length: count }, (_, i) => lost({
    id: `lost-${i}`, completedAt: at - i * 120_000, startedAt: at - i * 120_000 - 60_000,
  }));
  const oldWhy = count => `review paused: head ${head.slice(0, 9)} was already reviewed ${count} time(s); it resumes on a new push or an explicit re-arm`
    + " (no verdict ever landed on the PR for those runs, and the 2 automatic re-runs are spent: a person must look at why the review's write-back fails)";
  it('holds three no-verdict runs under one hour with retryAt and the due-time text', () => {
    const held = decideSameHeadHold(labelled(['review:pending']), lostRuns(3), { repo, env: {}, now: at + 30 * 60_000 });
    expect(VERDICT_COOLDOWN_BASE_MS).toBe(3600_000);
    expect(held).toMatchObject({ kind: 'same-head', count: 3, retryAt: at + 3600_000,
      why: `${oldWhy(3)}; the next automatic re-run is due at ${iso(at + 3600_000)}` });
  });
  it('releases three no-verdict runs once the one-hour cool-down is due', () => {
    const p = labelled(['review:pending']), runs = lostRuns(3);
    for (const elapsed of [3600_000, 3600_001]) {
      expect(decideSameHeadHold(p, runs, { repo, env: {}, now: at + elapsed })).toBeNull();
    }
  });
  it('requires two hours after one cool-down release (four no-verdict runs)', () => {
    const p = labelled(['review:pending']), runs = lostRuns(4);
    expect(decideSameHeadHold(p, runs, { repo, env: {}, now: at + 7200_000 - 1 }))
      .toMatchObject({ retryAt: at + 7200_000 });
    expect(decideSameHeadHold(p, runs, { repo, env: {}, now: at + 7200_000 })).toBeNull();
  });
  it.each(['operator', 'rearm', 'ruling', 'live-release', 'persistence-retry'])('does not reuse a parked review %s release after pre-advise crashes', release => {
    const parked = evidence({ failure: release === 'persistence-retry' });
    const ruled = record();
    ruled.rulings = [{ id: 'r1', key, reviewerId: ruled.reviewer.id, lens: ruled.reviewer.lens,
      result: 'not-real', rationale: 'checked', evidence: ['diff'] }];
    const comments = {
      operator: [comment('Please review again.', at + 1, 'chalbert')],
      rearm: [comment(REARM_COMMENT_MARKER, at + 1)],
      ruling: [comment(renderReferralRecord(ruled), at + 1)],
      'live-release': [comment(renderReferralRecord(ruled), at - 120_000)],
      'persistence-retry': [],
    }[release];
    const p = labelled(['review:pending'], { comments });
    const rows = [parked];
    const decide = now => enrichPrsWithReferralHolds([p], { repo, now,
      env: { WE_REVIEW_NO_VERDICT_COOLDOWN_RELEASES: '6' }, readRuns: () => rows })[0];
    expect(decide(at + 30 * 60_000).referralHold).toBeNull(); // the initial release is still owed
    for (let i = 0; i < 20; i++) {
      const crashed = run({ id: `review-pr-after-release-${i}`, time: at + (31 + i) * 60_000 });
      crashed.stepTimings.pop();
      rows.push(reviewRunEvidence(crashed));
      if (i === 2) {
        expect(decide(at + 33 * 60_000).referralHold).toMatchObject({ kind: 'same-head',
          noVerdict: { exhausted: false } });
      }
    }
    const enriched = decide(at + 365 * 86400_000);
    expect(enriched.referralHold).toMatchObject({ kind: 'same-head', retryAt: null,
      noVerdict: { exhausted: true, releasesSpent: 6 } });
    expect(planReconcile({ repo: 'we', prs: [enriched], agents: [], now: at + 365 * 86400_000,
      requiredChecks: ['test'], reviewTiming: { startAfter: 'ci-green' } }).dispatch.filter(d => d.kind === 'review')).toEqual([]);
    expect(findResumableParkedRun(p, rows, { repo })).toBeNull();
    expect(decideReferralHold(p, rows, { repo })).toBeNull();
    const wokeAgain = { ...p, comments: [...comments, comment('Try once more.', at + 366 * 86400_000, 'chalbert')] };
    expect(enrichPrsWithReferralHolds([wokeAgain], { repo, now: at + 367 * 86400_000,
      readRuns: () => rows })[0].referralHold).toBeNull();
  });
  it.each([true, false])('charges pre-advise crashes to growing cooldowns and refuses a seventh release through reconciliation (initial panels completed: %s)', initialCompleted => {
    const dir = temp(); vi.stubEnv('OPERATION_RUNS_DIR', dir);
    vi.stubEnv('WE_REVIEW_NO_VERDICT_COOLDOWN_RELEASES', '6');
    for (let i = 0; i < 3; i++) {
      const r = run({ id: `review-pr-initial-${i}`, time: at - i * 120_000 + (initialCompleted ? 0 : 60_000) });
      r.findings.referralVerdict = r.verdict = { verdict: 'accept', pendingReferrals: [] };
      if (!initialCompleted) r.stepTimings.pop();
      writeRun(r, dir);
    }
    const p = labelled(['review:pending']);
    const decide = now => enrichPrsWithReferralHolds([p], { repo, now,
      readRuns: () => readReviewRunEvidence({ dir, memo: new Map() }) })[0];
    const planned = now => runReconcilePass({ repo, now, readPrs: () => [p], readAgents: () => [],
      enrich: x => x, enrichMainRed: prs => ({ prs }), enrichAlreadyLanded: x => x, enrichBaseRef: x => x,
      enrichSystemFix: x => x, enrichFixClaims: x => x, enrichTimeouts: x => x,
      resolveMainSha: () => null, readRequiredChecks: () => ({ checks: ['test'] }),
      enrichReferralHolds: () => [decide(now)],
    }).dispatch.filter(d => d.kind === 'review');
    expect(decide(at + 30 * 60_000).referralHold).toMatchObject({ count: 3, retryAt: at + VERDICT_COOLDOWN_BASE_MS });
    expect(planned(at + 30 * 60_000)).toEqual([]);
    let due = at + VERDICT_COOLDOWN_BASE_MS;
    for (let release = 1; release <= 6; release++) {
      expect(planned(due)).toHaveLength(1);
      const crashed = newRunRecord({ id: `review-pr-crash-${release}`, op: 'review-pr', input: { repo, pr: p.number } });
      crashed.findings.read = { repo, pr: p.number, netBasis: { rev: head } };
      crashed.stepTimings = [{ step: 'read', stepIndex: 0, startedAt: iso(due), finishedAt: iso(due + 1), durationMs: 1 }];
      writeRun(crashed, dir);
      const held = decide(due + 1).referralHold;
      expect(held).toMatchObject({ count: 3 + release,
        noVerdict: { releasesSpent: release, exhausted: release === 6 } });
      expect(planned(due + 1)).toEqual([]);
      if (release < 6) {
        due += Math.min(VERDICT_COOLDOWN_BASE_MS * 2 ** release, VERDICT_COOLDOWN_CAP_MS);
        expect(held.retryAt).toBe(due);
        expect(planned(due - 1)).toEqual([]);
      } else {
        expect(held.retryAt).toBeNull();
        expect(planned(due + 365 * 86400_000)).toEqual([]);
      }
    }
    const publish = vi.fn();
    for (let tick = 0; tick < 3; tick++) raiseNoVerdictNeedsYou({ repo, prNumber: p.number,
      hold: decide(due + 365 * 86400_000).referralHold, dir, now: due + tick, publish, log: () => {} });
    expect(publish).toHaveBeenCalledTimes(1);
  });
  it.each([3, 9, 20])('bounds %s attempts on a fresh head even if none reach advise', count => {
    const p = labelled(['review:pending']);
    const rows = lostRuns(count).map(r => ({ ...r, completedAt: null, incomplete: true }));
    const opts = { repo, env: {}, now: at, retry: { cooldownReleases: 6, source: 'tool' } };
    expect(decideSameHeadHold(p, rows, opts)).toMatchObject({ count,
      retryAt: count === 3 ? at - 60_000 + VERDICT_COOLDOWN_BASE_MS : null,
      noVerdict: { exhausted: count >= 9, releasesSpent: Math.min(count - 3, 6) } });
    expect(decideSameHeadHold(p, rows, { ...opts, retry: { cooldownReleases: 0 } }))
      .toMatchObject({ retryAt: null, noVerdict: { exhausted: true } });
    expect(decideSameHeadHold({ ...p, comments: [comment(REARM_COMMENT_MARKER, at + 1)] }, rows, opts)).toBeNull();
    expect(decideSameHeadHold({ ...p, headRefOid: 'b'.repeat(40) }, rows, opts)).toBeNull();
    expect(decideSameHeadHold(p, rows, { ...opts, env: { WE_REVIEW_SAME_HEAD_MAX_REVIEWS: '0' } })).toBeNull();
    for (const landed of [labelled(['review:accepted']), labelled(['review:pending', 'review:changes']),
      labelled(['review:pending'], { comments: [comment(`✅ review — accepted\n<!-- reviewed-sha: ${head} -->`)] })]) {
      expect(decideSameHeadHold(landed, rows, opts)).toBeNull();
    }
  });
  it('preserves the cooldown baseline when a pre-wake review completes after post-wake crashes', () => {
    const minute = 60_000;
    const p = labelled(['review:pending'], { comments: [comment(REARM_COMMENT_MARKER, at + 10 * minute)] });
    const completed = lost({ startedAt: at, completedAt: at + 100 * minute });
    const crashes = [20, 30, 40].map(n => ({ ...completed, id: `crash-${n}`,
      startedAt: at + n * minute, completedAt: null, incomplete: true }));
    expect(decideSameHeadHold(p, [completed, ...crashes], { repo, env: {}, now: at + 111 * minute,
      retry: { cooldownReleases: 6, source: 'tool' } }))
      .toMatchObject({ count: 3, retryAt: at + 160 * minute, noVerdict: { releasesSpent: 0 } });
  });
  it('counts incomplete immediate retries once, replaces them on completion, and scopes them to the head and wake', () => {
    const dir = temp(), p = labelled(['review:pending']);
    const retry = { cooldownReleases: 6, source: 'tool' }, opts = { repo, env: {}, now: at + 20 * 60_000, retry };
    const crashed = run({ id: 'review-pr-incomplete', time: at + 120_000 });
    crashed.stepTimings.pop();
    writeRun(crashed, dir);
    const partial = readReviewRunEvidence({ dir, memo: new Map() })[0];
    expect(partial).toMatchObject({ incomplete: true, completedAt: null });
    const rows = [lostRuns(1)[0], partial];
    expect(decideSameHeadHold(p, rows, opts)).toBeNull(); // one immediate retry remains
    const another = { ...partial, id: 'review-pr-another', startedAt: at + 180_000 };
    expect(decideSameHeadHold(p, [...rows, another], opts)).toMatchObject({ count: 3, retryAt: at + 180_000 + 3600_000 });
    for (const foreign of [{ ...another, repo: 'other/repo' }, { ...another, pr: 99 }, { ...another, head: 'b'.repeat(40) }]) {
      expect(decideSameHeadHold(p, [...rows, foreign], opts)).toBeNull();
    }
    expect(decideSameHeadHold({ ...p, comments: [comment(REARM_COMMENT_MARKER, at + 240_000)] }, [...rows, another], opts)).toBeNull();
    expect(decideSameHeadHold(labelled(['review:accepted']), [lostRuns(1)[0], partial, another], opts))
      .toMatchObject({ count: 1, retryAt: null }); // completed-review semantics remain unchanged
    const done = run({ id: crashed.id, time: at + 120_000 });
    writeRun(done, dir);
    const completed = readReviewRunEvidence({ dir, memo: new Map() });
    expect(completed).toHaveLength(1);
    expect(completed[0].incomplete).toBeUndefined();
    expect(completed[0].completedAt).toBe(at + 120_000);
    const invalid = run(); invalid.stepTimings = [];
    expect(reviewRunEvidence(invalid)).toBeNull();
    const noHead = run(); delete noHead.findings.read;
    expect(reviewRunEvidence(noHead)).toBeNull();
  });
  it('caps cool-down backoff at eight hours while releases remain', () => {
    expect(VERDICT_COOLDOWN_CAP_MS).toBe(8 * 3600_000);
    const p = labelled(['review:pending']);
    for (const count of [6, 7, 8]) {
      const runs = lostRuns(count);
      expect(decideSameHeadHold(p, runs, { repo, env: {}, now: at + 8 * 3600_000 - 1 }))
        .toMatchObject({ retryAt: at + 8 * 3600_000 });
      expect(decideSameHeadHold(p, runs, { repo, env: {}, now: at + 8 * 3600_000 })).toBeNull();
    }
  });
  it('keeps the permanent hold and old wording after six cool-down releases', () => {
    expect(VERDICT_COOLDOWN_MAX_RELEASES).toBe(6);
    expect(decideSameHeadHold(labelled(['review:pending']), lostRuns(9), { repo, env: {}, now: at + 30 * 86400_000 }))
      .toMatchObject({ kind: 'same-head', count: 9, retryAt: null, why: oldWhy(9) });
  });
  it('keeps landed-verdict holds unchanged for reviewed-sha and verdict labels', () => {
    const runs = lostRuns(3), opts = { repo, env: {}, now: at + 86400_000 };
    const landed = [labelled(['review:pending'], { comments: [comment(`✅ review — accepted\n<!-- reviewed-sha: ${head} -->`)] }),
      ...['review:accepted', 'review:changes', 'review:human'].map(label => labelled([label])),
      labelled(['review:pending', 'review:changes'])];
    for (const p of landed) {
      expect(decideSameHeadHold(p, runs, opts)).toMatchObject({ kind: 'same-head', retryAt: null,
        why: `review paused: head ${head.slice(0, 9)} was already reviewed 3 time(s); it resumes on a new push or an explicit re-arm` });
    }
  });
  it('preserves the off-switch, persistence-failure exclusion, operator wake and head reset', () => {
    const p = labelled(['review:pending']), runs = lostRuns(9), opts = { repo, env: {}, now: at + 86400_000 };
    expect(decideSameHeadHold(p, runs, { ...opts, env: { WE_REVIEW_SAME_HEAD_MAX_REVIEWS: '0' } })).toBeNull();
    expect(decideSameHeadHold(p, runs.map(r => ({ ...r, persistenceFailed: true })), opts)).toBeNull();
    expect(decideSameHeadHold({ ...p, comments: [comment(REARM_COMMENT_MARKER, at + 1)] }, runs, opts)).toBeNull();
    expect(decideSameHeadHold({ ...p, headRefOid: 'b'.repeat(40) }, runs, opts)).toBeNull();
  });
  it('posts no repeated same-head notice when a cool-down retryAt is present', () => {
    const p = labelled(['review:pending']), runs = lostRuns(3), post = vi.fn(), log = vi.fn(), dir = temp();
    const held = decideSameHeadHold(p, runs, { repo, env: {}, now: at + 30 * 60_000 });
    for (const now of [at + 30 * 60_000, held.retryAt, held.retryAt + 1]) {
      notifyReferralHold({ repo, prNumber: p.number, pr: p, hold: held, dir, post, log, now });
    }
    expect(post).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
  describe('reviewNoVerdictRetry cascade setting (operator 2026-10-20)', () => {
    const absent = () => ({ WE_PLATFORM_PREFERENCES_FILE: join(temp(), 'absent.json') });
    it('standard is 0 (main: permanent hold at the third no-verdict run); tool layer sets 6, source logged', () => {
      expect(NO_VERDICT_RETRY_STANDARD.cooldownReleases).toBe(0);
      expect(resolveNoVerdictRetry(absent(), { tool: {} })).toEqual({ cooldownReleases: 0, source: 'standard' });
      expect(resolveNoVerdictRetry(absent())).toEqual({ cooldownReleases: 6, source: 'tool' });
      const retry = resolveNoVerdictRetry(absent(), { tool: {} });
      expect(decideSameHeadHold(labelled(['review:pending']), lostRuns(3), { repo, env: {}, now: at + 30 * 86400_000, retry }))
        .toMatchObject({ kind: 'same-head', count: 3, retryAt: null, why: oldWhy(3), noVerdict: { exhausted: true, releases: 0, source: 'standard' } });
    });
    it('bounds: 0..6 accepted; out-of-range / non-integer / wrong type fall back to the standard 0; env wins', () => {
      for (const ok of [0, 3, 6]) expect(resolveNoVerdictRetry(absent(), { tool: { cooldownReleases: ok } })).toEqual({ cooldownReleases: ok, source: 'tool' });
      for (const bad of [7, -1, 1.5, '6', null, true, [6], 1e9]) {
        expect(resolveNoVerdictRetry(absent(), { tool: { cooldownReleases: bad } })).toEqual({ cooldownReleases: 0, source: 'standard' });
      }
      for (const tool of [6, [6], 'x', null]) expect(resolveNoVerdictRetry(absent(), { tool })).toEqual({ cooldownReleases: 0, source: 'standard' });
      expect(resolveNoVerdictRetry({ ...absent(), WE_REVIEW_NO_VERDICT_COOLDOWN_RELEASES: '2' })).toEqual({ cooldownReleases: 2, source: 'env' });
      for (const bad of ['7', '-1', 'x']) expect(resolveNoVerdictRetry({ ...absent(), WE_REVIEW_NO_VERDICT_COOLDOWN_RELEASES: bad })).toEqual({ cooldownReleases: 6, source: 'tool' });
      expect(resolveNoVerdictRetry(null)).toEqual({ cooldownReleases: 0, source: 'standard' });
    });
    it('the 6th cool-down release is allowed and the 7th attempt is refused (permanent hold), even past any wait', () => {
      const p = labelled(['review:pending']), retry = { cooldownReleases: 6, source: 'tool' };
      // count 8 = 5 releases spent: the 6th release is due after the 8 h cap.
      expect(decideSameHeadHold(p, lostRuns(8), { repo, env: {}, now: at + 8 * 3600_000, retry })).toBeNull();
      // count 9 = all 6 releases spent: the 7th is refused forever.
      for (const later of [8 * 3600_000, 30 * 86400_000, 365 * 86400_000]) {
        expect(decideSameHeadHold(p, lostRuns(9), { repo, env: {}, now: at + later, retry }))
          .toMatchObject({ retryAt: null, why: oldWhy(9), noVerdict: { exhausted: true, releasesSpent: 6, releases: 6 } });
      }
      // A setting above the hard cap can never buy a 7th release.
      expect(decideSameHeadHold(p, lostRuns(9), { repo, env: {}, now: at + 30 * 86400_000, retry: { cooldownReleases: 99 } }))
        .toMatchObject({ retryAt: null, noVerdict: { exhausted: true, releases: 0 } });
    });
    it('a cool-down hold is not exhausted and raises no needs-you; a landed-verdict hold carries no noVerdict at all', () => {
      const p = labelled(['review:pending']), retry = { cooldownReleases: 6, source: 'tool' };
      expect(decideSameHeadHold(p, lostRuns(3), { repo, env: {}, now: at + 30 * 60_000, retry }).noVerdict).toMatchObject({ exhausted: false });
      expect(decideSameHeadHold(labelled(['review:accepted']), lostRuns(3), { repo, env: {}, now: at + 86400_000, retry }).noVerdict).toBeUndefined();
      const publish = vi.fn(), dir = temp(), log = vi.fn();
      const cool = decideSameHeadHold(p, lostRuns(3), { repo, env: {}, now: at + 30 * 60_000, retry });
      expect(cool.retryAt).toBe(at + 3600_000);
      notifyReferralHold({ repo, prNumber: p.number, pr: p, hold: cool, dir, post: vi.fn(), log, now: at + 30 * 60_000, publishNeedsYou: publish });
      expect(publish).not.toHaveBeenCalled();
    });
    const exhausted = t0 => decideSameHeadHold(labelled(['review:pending']), lostRuns(9), { repo, env: {}, now: t0, retry: { cooldownReleases: 6, source: 'tool' } });
    const T0 = at + 30 * 86400_000, LEASE = 10 * 60_000, GRACE = 15 * 60_000;
    const res = `${repo}#pr:1`;
    const storeAt = (dir, t) => createActionStore({ root: needsYouClaimRoot(dir), now: () => t });
    const raise = (dir, t, o = {}) => raiseNoVerdictNeedsYou({ repo, prNumber: 1, hold: o.hold ?? exhausted(T0), dir, now: t, log: o.log ?? vi.fn(), publish: o.publish, store: o.store, beforePublish: o.beforePublish });
    it('keeps the exhausted-hold alert visible across successful queue polls after its claim settles', async () => {
      const dir = temp(), path = join(dir, 'events.jsonl');
      const publish = vi.fn(item => publishAttention(item, { path, now: T0 }));
      expect(raise(dir, T0, { publish })).toBe(true);
      expect(storeAt(dir, T0).attempts(res)).toEqual([
        expect.objectContaining({ state: 'terminal', outcome: 'settled' }),
      ]);
      const poll = report => pollNeedsYou({
        checkoutRoot: join(dir, 'workspace/.lanes/we/lane-1'),
        env: { WE_NEEDS_YOU_FEED: path }, now: T0 + 1, log: vi.fn(),
        exec: () => JSON.stringify(report),
      });
      // The queue cannot represent review-no-verdict, even in a complete successful report.
      for (const report of [{ ready: [] }, { ready: [], incomplete: true }, { ready: [] }]) {
        expect((await poll(report)).lines).toEqual([]);
        expect(unacknowledged({ path })).toEqual([
          expect.objectContaining({ repo, pr: 1, head, kind: 'review-no-verdict' }),
        ]);
      }
      expect(raise(dir, T0 + 2, { publish })).toBe(false);
      expect(publish).toHaveBeenCalledTimes(1);
      acknowledge({ path });
      expect((await poll({ ready: [] })).lines).toEqual([]);
      expect(unacknowledged({ path })).toEqual([]);
    });
    it.each(['review-no-verdict', 'disk-space'])('preserves event-only %s publication during a queue read and dedupes later publications', async kind => {
      const dir = temp(), path = join(dir, 'events.jsonl');
      const item = { repo, pr: 1, head, kind, reason: 'operator attention needed' };
      const poll = () => pollNeedsYou({
        checkoutRoot: join(dir, 'workspace/.lanes/we/lane-1'),
        env: { WE_NEEDS_YOU_FEED: path }, now: T0 + 1, log: vi.fn(),
        exec: () => {
          // The report is collected outside the feed lock; a second producer can publish meanwhile.
          publishAttention(item, { path, now: T0 });
          return JSON.stringify({ ready: [] });
        },
      });
      expect((await poll()).lines).toEqual([]);
      expect((await poll()).lines).toEqual([]);
      expect(unacknowledged({ path })).toEqual([expect.objectContaining(item)]);
      // The unclaimed fallback also uses publishAttention on every tick: no duplicate event.
      expect(publishAttention(item, { path, now: T0 + 2 }).lines).toEqual([]);
      acknowledge({ path });
      expect((await poll()).lines).toEqual([]);
      expect(unacknowledged({ path })).toEqual([]);
    });
    it.each([
      ['ready', {}], ['needsYourMerge', {}], ['rulingNeeded', {}],
      ['rulingNeeded', { reason: 'round-cap' }], ['rulingNeeded', { reason: 'dispute' }],
      ['stoodDown', {}], ['needsPerson', {}],
    ])('still clears resolved report-owned alerts from %s (%j)', async (field, extra) => {
      const dir = temp(), path = join(dir, 'events.jsonl');
      const poll = report => pollNeedsYou({
        checkoutRoot: join(dir, 'workspace/.lanes/we/lane-1'),
        env: { WE_NEEDS_YOU_FEED: path }, now: T0, log: vi.fn(),
        exec: () => JSON.stringify(report),
      });
      expect((await poll({ ready: [], [field]: [{ repo, number: 1, head, ...extra }] })).lines).toHaveLength(1);
      const resolved = await poll({ ready: [] });
      expect(resolved.lines).toHaveLength(1);
      expect(resolved.lines[0]).toMatch(/^NEEDS-YOU-CLEARED /);
      expect(unacknowledged({ path })).toEqual([]);
    });
    it('at-least-once (operator ruling), deduped in the normal path: once across ticks, again for a new head; claim settled in the ledger', () => {
      const dir = temp(), log = vi.fn(), post = vi.fn(), publish = vi.fn(), p = labelled(['review:pending']), held = exhausted(T0);
      for (let i = 0; i < 4; i++) notifyReferralHold({ repo, prNumber: p.number, pr: p, hold: held, dir, post, log, now: T0 + i, publishNeedsYou: publish });
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish.mock.calls[0][0]).toMatchObject({ repo, pr: p.number, head, kind: 'review-no-verdict' });
      expect(log.mock.calls.flat().filter(l => l.includes('NEEDS-YOU review-no-verdict'))).toHaveLength(1);
      expect(log.mock.calls.flat().find(l => l.includes('NEEDS-YOU'))).toContain('source=tool');
      const rows = storeAt(dir, T0).attempts(`${repo}#pr:${p.number}`);
      expect(rows).toEqual([expect.objectContaining({ kind: NO_VERDICT_NEEDS_YOU_KIND, state: 'terminal', outcome: 'settled', evidence: { head } })]);
      expect(raiseNoVerdictNeedsYou({ repo, prNumber: p.number, hold: { ...held, head: 'b'.repeat(40) }, dir, log, publish, now: T0 + 10 })).toBe(true);
      expect(publish).toHaveBeenCalledTimes(2);
    });
    it('interleaved concurrent reclaim of an EXPIRED claim: exactly one reclaimer publishes', () => {
      const dir = temp(), a = vi.fn(), b = vi.fn();
      // A crashed owner left an intent claim.
      expect(storeAt(dir, T0).claim({ resource: res, kind: NO_VERDICT_NEEDS_YOU_KIND, owner: 'crashed', evidence: { head } }).ok).toBe(true);
      const later = T0 + LEASE + 1;
      // A reclaims and, while it holds the fresh claim (just before publishing), B runs the same reclaim.
      expect(raise(dir, later, { publish: a, beforePublish: () => expect(raise(dir, later, { publish: b })).toBe(false) })).toBe(true);
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).not.toHaveBeenCalled();
      // Two reconcilers racing on the same stale record: the store's CAS lets only one win.
      const d2 = temp(), s2 = storeAt(d2, T0);
      const stale = s2.claim({ resource: res, kind: NO_VERDICT_NEEDS_YOU_KIND, owner: 'crashed', evidence: { head } }).record;
      const s3 = storeAt(d2, T0 + LEASE + 1);
      expect(s3.reconcile(stale, {}).ok).toBe(true);
      expect(s3.reconcile(stale, {}).ok).toBe(false);
    });
    it('paused-then-resumed owner: its claim expired and was taken over, so it does NOT publish; the new owner does', () => {
      const dir = temp(), paused = vi.fn(), takeover = vi.fn(), log = vi.fn();
      const pause = () => expect(raise(dir, T0 + LEASE + 1, { publish: takeover })).toBe(true);
      expect(raise(dir, T0, { publish: paused, beforePublish: pause, log })).toBe(false);
      expect(paused).not.toHaveBeenCalled();
      expect(takeover).toHaveBeenCalledTimes(1);
      expect(log.mock.calls.flat().some(l => l.includes('claim lost before publishing'))).toBe(true);
    });
    it('a corrupt or partial claim-ledger entry never silences: the event is published unclaimed (feed dedupes)', () => {
      for (const content of ['', '{bad', 'null', '{"version":1}']) {
        const dir = temp(), publish = vi.fn(), log = vi.fn();
        const rdir = join(needsYouClaimRoot(dir), 'actions', encodeURIComponent(res));
        mkdirSync(rdir, { recursive: true });
        writeFileSync(join(rdir, 'attempt-000001.json'), content);
        expect(raise(dir, T0, { publish, log })).toBe(true);
        expect(publish).toHaveBeenCalledTimes(1);
        expect(log.mock.calls.flat().some(l => l.includes('claim ledger unusable'))).toBe(true);
      }
    });
    it('many abandoned claims (crashes before publishing) never exhaust into silence: each expiry allows a fresh claim', () => {
      const dir = temp(), crash = () => { throw new Error('killed before publishing'); };
      let t = T0;
      for (let i = 0; i < 40; i++) {
        expect(raise(dir, t, { publish: vi.fn(), beforePublish: crash })).toBe(false);
        expect(raise(dir, t + 1, { publish: vi.fn() })).toBe(false); // the live claim holds until it expires
        t += LEASE + 1;
      }
      const ok = vi.fn();
      expect(raise(dir, t, { publish: ok })).toBe(true);
      expect(ok).toHaveBeenCalledTimes(1);
      expect(storeAt(dir, t).attempts(res).length).toBe(41);
    });
    it('a failed publish retries on the next tick', () => {
      const dir = temp(), flaky = vi.fn().mockImplementationOnce(() => { throw new Error('feed down'); });
      expect(raise(dir, T0, { publish: flaky })).toBe(false);
      expect(raise(dir, T0 + 1, { publish: flaky })).toBe(true);
      expect(raise(dir, T0 + 2, { publish: flaky })).toBe(false);
      expect(flaky).toHaveBeenCalledTimes(2);
    });
    it('at-least-once: a crash after publishing (claim left dispatching) re-raises after expiry + absence grace; a crash after observed does not', () => {
      const dir = temp(), publish = vi.fn();
      const failing = to => ({ ...storeAt(dir, T0), transition(r, n, o) { if (o.to === to) throw new Error('killed'); return storeAt(dir, T0).transition(r, n, o); } });
      expect(raise(dir, T0, { publish, store: failing('observed') })).toBe(true);
      expect(raise(dir, T0 + LEASE + 1, { publish })).toBe(false); // expired but inside the absence grace: held
      expect(raise(dir, T0 + LEASE + GRACE + 1, { publish })).toBe(true); // accepted duplicate
      expect(publish).toHaveBeenCalledTimes(2);
      const d2 = temp(), p2 = vi.fn();
      const failing2 = { ...storeAt(d2, T0), transition(r, n, o) { if (o.to === 'terminal' && o.from === 'observed') throw new Error('killed'); return storeAt(d2, T0).transition(r, n, o); } };
      expect(raise(d2, T0, { publish: p2, store: failing2 })).toBe(true);
      expect(raise(d2, T0 + LEASE + 1, { publish: p2 })).toBe(false); // reconciled to settled: no re-raise
      expect(p2).toHaveBeenCalledTimes(1);
    });
    it('never writes the real feed from a test without an injected publisher', () => {
      const dir = temp();
      const held = decideSameHeadHold(labelled(['review:pending']), lostRuns(9), { repo, env: {}, now: at + 30 * 86400_000, retry: { cooldownReleases: 6 } });
      expect(raiseNoVerdictNeedsYou({ repo, prNumber: 1, hold: held, dir, log: vi.fn() })).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
    });
  });
  it('still holds when a verdict label landed, or the run is too fresh to judge', () => {
    expect(decideSameHeadHold(labelled(['review:pending', 'review:changes']), [lost()], { repo, env: {} })).not.toBeNull();
    expect(decideSameHeadHold(labelled(['review:pending']), [lost({ completedAt: Date.now() - 60_000 })], { repo, env: {} })).not.toBeNull();
  });
});

// Card xq1xbsl — live 2026-10-08, #4361: the operator ruled at 12:09Z on an unchanged head and a FRESH full review
// started at 12:15Z, raising two new referrals. RED on the old code, which has no resume decision at all.
describe('a ruling on an unchanged head resumes the parked run (replay of #4361)', () => {
  const ruledRecord = (result = 'not-real') => {
    const r = record();
    r.rulings = [{ id: 'r1', key, reviewerId: r.reviewer.id, lens: r.reviewer.lens, result, rationale: 'checked', evidence: ['diff'] }];
    return r;
  };
  const thread = (extra = []) => [comment(renderReferralRecord(record()), at - 120_000), ...extra];
  const ruling = comment(renderReferralRecord(ruledRecord()), at + 60_000);
  const find = (p, runs = [evidence()]) => findResumableParkedRun(p, runs, { repo });

  it('names the parked run when the only thing since it began is a ruling', () => {
    expect(find(pr({ comments: thread([ruling]) }))).toEqual({ id: 'review-pr-parked', head });
  });
  it('names nothing while no ruling has arrived (the hold stays, no review at all)', () => {
    expect(find(pr({ comments: thread() }))).toBeNull();
  });
  it('a new push, a re-arm, a send-back or an operator reply still owe a FRESH review', () => {
    expect(find(pr({ headRefOid: 'b'.repeat(40), comments: thread([ruling]) }))).toBeNull();
    expect(find(pr({ comments: thread([ruling, comment(`${REARM_COMMENT_MARKER} round 2`, at + 90_000)]) }))).toBeNull();
    expect(find(pr({ comments: thread([ruling, comment('🔁 review — changes requested', at + 90_000)]) }))).toBeNull();
    expect(find(pr({ comments: thread([ruling, comment('please look again', at + 90_000, 'chalbert')]) }))).toBeNull();
  });
  it('does not resume a run whose referrals never persisted (the retry budget owns that case)', () => {
    const failed = reviewRunEvidence(run({ failure: true }));
    expect(find(pr({ comments: thread([ruling]) }), [failed])).toBeNull();
  });
  it('a run that was already resumed does not resume on the ruling it already answered', () => {
    const resumed = reviewRunEvidence({ ...run(), resumedAt: iso(at + 120_000) });
    expect(find(pr({ comments: thread([ruling]) }), [resumed])).toBeNull();
    // ...and its still-pending referrals stay held rather than waking the next tick again.
    expect(decideReferralHold(pr({ comments: thread([ruling]) }), [resumed], { repo, now: at + 130_000,
      env: { WE_REFERRAL_HOLD_LIVE_RELEASE: '0' } })).not.toBeNull();
  });
  // PR #4441 review round 2 (correctness): the rewind drops the verdict and the referral step and saves the record before
  // the resumed pass finishes. A resume that dies in between must still read as the parked run (`resumeOf`), and stay
  // wakeable by the ruling that started it, or the next tick starts the fresh panel this card exists to stop.
  describe('a resume that never finished', () => {
    const unfinished = () => {
      const parked = run();
      const { referralVerdict, mandatoryReferrals, ...kept } = parked.findings;
      // `advise` follows the referral step, so the rewind drops its timing along with the verdict.
      const adviseFinishedAt = parked.stepTimings.find((t) => t.step === 'advise').finishedAt;
      return { ...parked, findings: kept, verdict: null, pending: null, resumedAt: iso(at + 120_000),
        stepTimings: parked.stepTimings.filter((t) => t.step !== 'advise'),
        resumeOf: { verdict: referralVerdict, mandatoryReferrals, adviseFinishedAt } };
    };
    it('still reads as the parked run it was, and is resumed again by the same ruling', () => {
      const evidenceOf = reviewRunEvidence(unfinished());
      expect(evidenceOf).toMatchObject({ id: 'review-pr-parked', parked: true, attempted: true, pending: [key] });
      expect(evidenceOf.startedAt).toBe(reviewRunEvidence(run()).startedAt);       // the resume answered nothing yet
      expect(find(pr({ comments: thread([ruling]) }), [evidenceOf])).toEqual({ id: 'review-pr-parked', head });
    });
    it('a re-arm that arrived meanwhile still owes a fresh review', () => {
      const rearm = comment(`${REARM_COMMENT_MARKER} round 2`, at + 90_000);
      expect(find(pr({ comments: thread([ruling, rearm]) }), [reviewRunEvidence(unfinished())])).toBeNull();
    });
    it('once the resumed pass has run `advise`, the ruling it answered no longer wakes it', () => {
      const adviseFinishedAt = iso(at + 125_000);
      const finished = { ...unfinished(), verdict: { verdict: 'needs-human', pendingReferrals: [key], referrals: [] },
        stepTimings: [...unfinished().stepTimings, { step: 'advise', stepIndex: 6, startedAt: iso(at + 124_000), finishedAt: adviseFinishedAt, durationMs: 1000 }] };
      expect(find(pr({ comments: thread([ruling]) }), [reviewRunEvidence(finished)])).toBeNull();
    });
    // The step order is referral step -> referralVerdict -> advise -> confirm: a pass that died AFTER it produced a
    // verdict but BEFORE `advise` is as unfinished as one that died in the referral step.
    it('a pass that died after its own verdict but before `advise` is still unfinished and resumable', () => {
      const late = { ...unfinished(), verdict: { verdict: 'needs-human', pendingReferrals: [], referrals: [] } };
      late.findings = { ...late.findings, referralVerdict: late.verdict };
      expect(reviewRunEvidence(late)).toMatchObject({ parked: true, pending: [key] });
      expect(find(pr({ comments: thread([ruling]) }), [reviewRunEvidence(late)])).toEqual({ id: 'review-pr-parked', head });
    });
  });
});


describe('x84m5n2 dispatch respects the latest operator word without clearing the gate', () => {
  const safety = value => ({ value: { noFixerOnClearedRuled: value }, sources: { noFixerOnClearedRuled: 'tool' } });
  const ruling = (result, time, overrides = {}) => {
    const r = { version: 1, repo, pr: 3481, head, actor: 'chalbert', channel: 'operator',
      reason: 'explicit operator instruction', at: iso(time), clearerId: 'session',
      rulings: [{ runId: record().runId, key, result, ...(result === 'card' ? { card: `we:backlog/${readdirSync('backlog').find(n => /^\d+-.+\.md$/.test(n))}` } : {}) }], ...overrides };
    return comment(buildOperatorRulingComment(r), time);
  };
  const auto = time => ruling('block', time, { actor: 'auto-policy' });
  const clear = h => comment(`✅ review — accepted\n<!-- reviewed-sha: ${h} -->\n<!-- cleared-human: chalbert -->`, at + 20);
  const subject = (comments = [], extra = {}) => pr({ comments: [comment(renderReferralRecord(record()), at - 100), auto(at), ...comments], ...extra });
  const options = { repo, cardReadable: () => true, safety: safety(true), log: () => {} };
  const fixes = p => reconcile({ ...p, blockRuledReferrals: [{ key, finding: normalizeFinding(original) }] }, { enrichReferralHolds: x => x }).dispatch.filter(d => d.kind === 'fix');
  it.each([
    ['chalbert/web-everything', 'web-everything/web-everything', 1],
    ['web-everything/web-everything', 'chalbert/web-everything', 1],
    ['web-everything/web-everything', 'other/repo', 0],
  ])('fixer honours latest block across repo aliases %s / %s', (recordRepo, rulingRepo, count) => {
    const p = pr({ comments: [
      comment(renderReferralRecord({ ...record(), repo: recordRepo })),
      ruling('not-real', at + 10, { repo: recordRepo }),
      ruling('block', at + 20, { repo: rulingRepo }), clear(head),
    ] });
    const findings = [{ key, runId: record().runId, finding: normalizeFinding(original) }];
    expect(filterFixerReferrals(p, findings, { ...options, repo: recordRepo })).toHaveLength(count);
  });
  it.each(['card', 'not-real'])('A1 %s suppresses only on the cleared head', result => {
    const clearedHead = 'aa45975'.padEnd(40, '0');
    for (const h of [clearedHead, 'df9ee2d'.padEnd(40, '0')]) {
      const p = pr({ headRefOid: h, comments: [
        comment(renderReferralRecord({ ...record(), head: clearedHead }), at - 100),
        ruling('block', at, { actor: 'auto-policy', head: clearedHead }),
        ruling(result, at + 10, { head: clearedHead, reason: 'deferred to card xildp3y' }), clear(clearedHead),
        comment(renderReferralRecord({ ...record(), head: h }), at + 31),
        ruling('block', at + 32, { actor: 'auto-policy', head: h })] });
      expect(blockRuledReferralsFor(p, options)).toHaveLength(h === clearedHead ? 0 : 1);
      expect(fixes(p)).toHaveLength(h === clearedHead ? 0 : 1);
      expect(reconcile(p).dispatch.filter(d => d.kind === 'fix')).toHaveLength(h === clearedHead ? 0 : 1);
    }
  });
  it('A2 unmatched open block still dispatches', () => {
    expect(blockRuledReferralsFor(subject(), options)).toHaveLength(1);
    expect(fixes(subject())).toHaveLength(1);
  });
  it.each(['card', 'not-real'])('A2 %s omits only its own finding; gate unchanged', result => {
    const otherOriginal = { ...original, summary: 'distinct broken case' };
    const other = { ...record().referrals[0], key: referralFindingKey('judge', otherOriginal), original: otherOriginal, finding: normalizeFinding(otherOriginal) };
    const rec = { ...record(), referrals: [...record().referrals, other], rulings: [
      { id: 'other-block', key: other.key, reviewerId: record().reviewer.id, lens: record().reviewer.lens,
        result: 'block', rationale: 'broken', evidence: ['diff'] }] };
    const p = pr({ comments: [comment(renderReferralRecord(rec), at - 100), auto(at), ruling(result, at + 10), clear(head), auto(at + 30)] });
    const before = mandatoryReferralState(p.comments, { repo, pr: p.number, head, body: p.body, createdAt: p.createdAt, cardReadable: () => true });
    expect(before.pending).toEqual([]);
    expect(before.blocked).toContain(key);
    expect(blockRuledReferralsFor(p, options).map(f => f.key)).toEqual([other.key]);
    const out = reconcile({ ...p, blockRuledReferrals: blockRuledReferralsFor(p, { ...options, safety: safety(false) }) }, { enrichReferralHolds: x => x });
    expect(out.dispatch.find(d => d.kind === 'fix')?.blockRuledReferrals.map(f => f.key)).toEqual([other.key]);
    expect(mandatoryReferralState(p.comments, { repo, pr: p.number, head, body: p.body, createdAt: p.createdAt, cardReadable: () => true })).toEqual(before);
  });
  it.each([
    ['exact', {} , true], ['repo', { repo: 'other/repo' }, false], ['PR', { pr: 3482 }, false],
    ['run', { rulings: [{ runId: 'other-run', key, result: 'not-real' }] }, false],
    ['key', { rulings: [{ runId: record().runId, key: 'other-key', result: 'not-real' }] }, false],
  ])('A3 identity %s', (_name, overrides, suppressed) => {
    const p = subject([ruling('not-real', at + 10, overrides), clear(head), auto(at + 30)]);
    expect(blockRuledReferralsFor(p, options)).toHaveLength(suppressed ? 0 : 1);
    expect(fixes(p)).toHaveLength(suppressed ? 0 : 1);
  });
  it.each([['card', 'block', 1], ['not-real', 'block', 1], ['block', 'card', 0], ['block', 'not-real', 0]])(
    'A4 latest chronologically: %s -> %s', (first, last, count) => {
      // Deliberately reverse comment order; timestamps decide, not array position.
      const p = subject([ruling(last, at + 20), ruling(first, at + 10), clear(head), auto(at + 30)]);
      expect(blockRuledReferralsFor(p, options)).toHaveLength(count);
      expect(fixes(p)).toHaveLength(count);
    });
  it.each(['card', 'not-real', 'block'])('A5 newer policy after operator %s is not a human ruling or clearance', result => {
    const p = subject([ruling(result, at + 10), auto(at + 30)]);
    expect(blockRuledReferralsFor(p, options)).toHaveLength(1);
    expect(fixes(subject([auto(at + 40)]))).toHaveLength(1);
  });
  it('auto-only and explicit operator blocks still dispatch on a cleared head', () => {
    expect(blockRuledReferralsFor(subject([clear(head)]), options)).toHaveLength(1);
    expect(fixes(subject([clear(head)]))).toHaveLength(1);
    expect(fixes(subject([clear(head), ruling('block', at + 40)]))).toHaveLength(1);
  });
  it.each(['card', 'not-real'])('also filters the ignored-ruling dispatch path for %s', result => {
    const p = subject([ruling(result, at + 10), clear(head), auto(at + 30)], { ignoredRulings: {
      matches: [{ finding: { key, summary: original.summary }, runId: record().runId }], misses: 1, effectiveMisses: 1,
    } });
    expect(fixes(p)).toEqual([]);
  });
  it('unreadable card and malformed ruling evidence retain the fixer', () => {
    const p = subject([ruling('card', at + 10), clear(head), auto(at + 30)]);
    expect(blockRuledReferralsFor(p, { ...options, cardReadable: () => false })).toHaveLength(1);
    const damaged = subject([ruling('not-real', at + 10), clear(head), auto(at + 30),
      comment('<!-- mandatory-referral-operator-ruling-v1: broken -->')]);
    expect(blockRuledReferralsFor(damaged, options)).toEqual(
      blockRuledReferralsFor(damaged, { ...options, safety: safety(false) }));
    expect(fixes(damaged)).toHaveLength(1);
  });
  it('rollback retains dispatch and suppression logs value and source', () => {
    const p = subject([ruling('not-real', at + 10), clear(head), auto(at + 30)]), log = vi.fn();
    expect(blockRuledReferralsFor(p, { ...options, safety: safety(false) })).toHaveLength(1);
    expect(blockRuledReferralsFor(p, { ...options, log })).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/review.noFixerOnClearedRuled=true.*tool/));
    vi.stubEnv('WE_REVIEW_NO_FIXER_ON_CLEARED_RULED', 'false');
    expect(fixes(p)).toHaveLength(1);
  });
});


describe('paused review ruling recovery', () => {
  const subject = (ruled = false, extra = {}) => {
    const r = record();
    r.attempted = false; // The ledger intentionally ignores these; the gate still holds them.
    if (ruled) r.rulings = [{ id: 'r1', key, reviewerId: r.reviewer.id, lens: r.reviewer.lens,
      result: 'block', rationale: 'confirmed', evidence: ['diff'] }];
    return pr({ comments: [comment(renderReferralRecord(r), at - 120_000)], ...extra });
  };
  it('raises unattempted pending findings and leaves the same-head hold in place', () => {
    const p = subject();
    expect(classifyPausedReview(p, mandatoryReferralState(p.comments, { repo, pr: p.number, head, body: p.body })))
      .toMatchObject({ action: 'raise', findings: [{ key, summary: 'broken case' }] });
    expect(decideSameHeadHold(p, [evidence({ attempted: false })], { repo })).not.toBeNull();
  });
  it('all-ruled same-head pauses raise a ruling item without a fresh wake', () => {
    const p = subject(true), post = vi.fn(body => p.comments.push(comment(body, at + 1)));
    const args = { repo, prNumber: p.number, hold: { ...hold(), kind: 'same-head' },
      pr: p, comments: p.comments, dir: temp(), post, log: vi.fn() };
    notifyReferralHold(args);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).not.toContain(REARM_COMMENT_MARKER);
    expect(post.mock.calls[0][0]).toContain('Waiting on your ruling');
    expect(decideSameHeadHold(p, [evidence()], { repo })).not.toBeNull();
    expect(classifyPausedReview(p, mandatoryReferralState(p.comments, { repo, pr: p.number, head, body: p.body })).action).toBe('raise');
    p.comments.push(comment(`${REARM_COMMENT_MARKER}\n<!-- paused-review-auto-rearm: ${head} -->`, at + 2));
    expect(decideSameHeadHold(p, [evidence()], { repo })).not.toBeNull();
    notifyReferralHold({ ...args, dir: temp() });
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('partly ruled stays paused and raises only the unruled referral', () => {
    const p = subject(true), r = record();
    const other = { ...original, summary: 'another broken case', file: 'src/case.ts', line: 12 };
    const otherKey = referralFindingKey('judge', other);
    r.runId = 'review-pr-other'; r.reviewer = mandatoryReferralReviewer(r.runId);
    r.referrals = [{ key: otherKey, seat: 'judge', original: other, finding: normalizeFinding(other) }];
    r.attempted = false;
    p.comments.push(comment(renderReferralRecord(r), at - 100_000));
    const decision = classifyPausedReview(p, mandatoryReferralState(p.comments, { repo, pr: p.number, head, body: p.body }));
    expect(decision).toMatchObject({ action: 'raise', findings: [{ key: otherKey, file: 'src/case.ts', line: 12 }] });
    expect(decision.findings).toHaveLength(1);
    const post = vi.fn();
    notifyReferralHold({ repo, prNumber: p.number, pr: p, comments: p.comments,
      hold: decideSameHeadHold(p, [evidence()], { repo }), dir: temp(), post, log: vi.fn() });
    expect(post.mock.calls.every(([body]) => !body.startsWith(REARM_COMMENT_MARKER))).toBe(true);
    expect(decideSameHeadHold(p, [evidence()], { repo })).not.toBeNull();
  });
  it('a live referral that owes a person is never cool-down released, and a cool-down hold never comments', () => {
    const p = subject(false, { labels: [{ name: 'review:pending' }] });
    const runs = [0, 1, 2].map(i => ({ ...evidence(), parked: false, id: `lost-${i}`,
      completedAt: at - i * 120_000, startedAt: at - i * 120_000 - 60_000 }));
    const retry = { cooldownReleases: 6, source: 'tool' }, now = at + 3 * 3600_000;
    const held = decideSameHeadHold(p, runs, { repo, env: {}, now, retry });
    expect(held).toMatchObject({ kind: 'same-head', retryAt: null, noVerdict: { exhausted: false } });
    const post = vi.fn(), args = { repo, prNumber: p.number, pr: p, comments: p.comments, post, log: vi.fn(), now, publishNeedsYou: vi.fn() };
    notifyReferralHold({ ...args, hold: held, dir: temp() });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toContain('Waiting on your ruling');
    // Main's cool-down suppression: a temporary (retryAt) same-head hold posts nothing even when a person is owed.
    notifyReferralHold({ ...args, hold: { ...held, episode: 'cooling', retryAt: now + 1 }, dir: temp() });
    expect(post).toHaveBeenCalledTimes(1);
    // Without the live referral, main's cool-down release still applies to the same runs.
    expect(decideSameHeadHold(pr({ labels: [{ name: 'review:pending' }] }), runs, { repo, env: {}, now, retry })).toBeNull();
  });
});
