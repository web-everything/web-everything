import { runGhSync } from '../gh-throttle.mjs';
import { redTeamForHead, redTeamMarker } from '../red-team-gate.mjs';
import { publishRedTeamPolicyClearCheck } from '../red-team-check-run.mjs';
import { readSealedStatus, sealedStatusPath } from '../red-team-sealed-status.mjs';
import { writeJsonAtomic } from '../atomic-json-file.mjs';
import { latestAcceptRecord } from '../accept-carry-forward.mjs';
import { proveCardOnlyHeadMove } from '../card-only-head-move.mjs';
import { OPERATOR_LOGINS } from '../marker-authorship.mjs';
import * as numbering from '../numbering-carry.mjs';
import { describe, it, expect, vi } from 'vitest';
import { cardOnlyHeadMoveCandidate, normalizeRedTeamResult, planRedTeamOnSkip, runRedTeamOnSkip, resolveReviewRedTeamOnSkip,
  CARRIED_CHECK_ESCALATION } from '../review-red-team-on-skip.mjs';
import { assertMainNotStale, PreStartDispatchRefusalError } from '../main-staleness.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { resetCascadeLogForTest } from '../policy-cascade.mjs';
import { readDrainRedTeamEvidence, readRedTeamStatus, recordRedTeamStatus, redTeamStatusDir,
  readCarriedCheckUnpublished, publishCarriedCheckDurably, markCarriedCheckUnpublished } from '../drain-red-team-evidence.mjs';
import { publishRedTeamCheckFromLive, evaluateRedTeamCheckFact, clearLivePublicationHold,
  readRedTeamPublicationHoldFact, withRedTeamCheckLock } from '../red-team-check-run.mjs';
import { newRunRecord, writeRun } from '../../operations/run-store.mjs';
import { refusedReferralsAreRuled, reviewRunEvidence } from '../../conveyor/review-referral-hold.mjs';
import { buildOperatorRulingComment, mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } from '../jury-core.mjs';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../gh-throttle.mjs', async importOriginal => ({
  ...await importOriginal(), runGhSync: vi.fn(),
}));
vi.mock('../../operations/needs-you-feed.mjs', async importOriginal => ({
  ...await importOriginal(), publishAttention: vi.fn(),
}));
// Pin the live merger identity alongside legacy authors; hermetic settings omit
// the host's configured App roles. Exercise the real marker-authorship gate.
vi.mock('../github-app-identity.mjs', async importOriginal => {
  const original = await importOriginal();
  return { ...original, readBotLogins: () => [...original.readBotLogins(), 'plateau-merger', 'plateau-merger[bot]'] };
});

const repo = 'web-everything/web-everything', head = 'a'.repeat(40), pr = 5762;
const payload = () => ({ verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head } } } });
function fixture(over = {}) {
  return { repo, refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }],
    rawPrs: [{ number: pr, headRefOid: head, comments: [], reviews: [] }],
    readEvidence: () => ({ loopPayload: payload(), recorded: false }), readStatus: () => null,
    now: 2_000_000, setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: new Map(), ...over };
}
const decide = over => planRedTeamOnSkip(fixture(over))[0];

describe('#6345 — resume a stored needs-human review after its refused referrals are ruled', () => {
  function parkedFixture(kind = 'ruled') {
    const id = 'review-pr-stale-referral-trigger';
    const body = '<!-- authored-by-actor: author -->';
    const at = '2026-11-06T13:25:00Z';
    const referrals = ['first defect', 'second defect'].map(summary => {
      const original = { summary, verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
      return { key: referralFindingKey('judge', original), seat: 'judge', original, finding: normalizeFinding(original) };
    });
    const record = { version: 1, repo, pr, head, runId: id,
      reviewer: mandatoryReferralReviewer(id), authorBody: body, attempted: true, referrals, rulings: [] };
    const run = newRunRecord({ id, op: 'review-pr', input: { repo, pr } });
    run.findings = {
      read: { repo, pr, netBasis: { rev: head } },
      mandatoryReferrals: { applied: true, effects: [{ type: 'review.mandatory-referrals', status: 'applied',
        result: { records: [record], pending: referrals.map(f => f.key) } }] },
      referralVerdict: { verdict: 'needs-human', pendingReferrals: referrals.map(f => f.key), referrals },
    };
    run.verdict = run.findings.referralVerdict;
    run.pending = null;
    run.refusedStage = 'stageVerdict';
    run.stepTimings = [
      { step: 'read', startedAt: '2026-11-06T13:20:00Z', finishedAt: '2026-11-06T13:21:00Z' },
      { step: 'advise', startedAt: '2026-11-06T13:22:00Z', finishedAt: '2026-11-06T13:23:00Z' },
      { step: 'stageVerdict', startedAt: '2026-11-06T13:24:00Z' },
    ];
    const comments = [{ body: renderReferralRecord(record), author: { login: 'web-everything' } }];
    if (kind !== 'unruled referral') comments.push({
      body: buildOperatorRulingComment({ version: 1, repo, pr,
        head: kind === 'ruling for other head' ? 'b'.repeat(40) : head,
        rulings: referrals.slice(0, kind === 'partial rulings' ? 1 : 2).map(f => ({
          runId: kind === 'ruling for other run' ? 'review-pr-other' : id, key: f.key,
          result: kind === 'unreadable referral card' ? 'card' : 'not-real',
          ...(kind === 'unreadable referral card' ? { card: 'we:backlog/9999999-missing-referral-card.md' } : {}),
        })), actor: 'chalbert', channel: 'terminal', reason: 'verified ruling', at, clearerId: 'operator-session' }),
      author: { login: 'chalbert' }, createdAt: at,
    });
    const projected = reviewRunEvidence(run);
    expect(projected).toMatchObject({ id, repo, pr, head, parked: true, referralStageRefused: true,
      pending: referrals.map(f => f.key) });
    const why = 'review paused: 2 referrals need a ruling; it resumes on a new push, a ruling, or a send-back';
    // The production shape (notifyReferralHoldNotice): why + findings block + episode marker.
    const findings = '\n\nWaiting on your ruling (block, card or not-real):\n- `scripts/x.mjs:1` — first defect\n- `no file` — second defect';
    const marker = '\n\n<!-- review-referral-hold: 0123456789abcdef -->';
    const notice = `${why}${findings}${marker}`;
    if (/pause notice/.test(kind)) comments.push({ body: notice, author: { login: 'web-everything' }, createdAt: '2026-11-06T13:26:00Z' });
    // The daemon sometimes posts under the operator's own credential; the producer's dedupe trusts that author too.
    if (kind === 'notice posted under the operator credential') comments.push({ body: notice, author: { login: OPERATOR_LOGINS[0] }, createdAt: '2026-11-06T13:26:00Z' });
    if (kind === 'bare notice without episode marker') comments.push({ body: why, author: { login: 'web-everything' }, createdAt: '2026-11-06T13:26:00Z' });
    if (/notice with persistence detail/.test(kind)) comments.push({ author: { login: 'web-everything' }, createdAt: '2026-11-06T13:26:00Z',
      body: `${why}\n\nReferral persistence failed; the next bounded retry is at 2026-11-06T14:00:00.000Z.${marker}` });
    // Finding summaries are interpolated into the notice, so one may quote the persistence phrases without being that detail.
    if (kind === 'a finding summary quoting "Referral persistence failed"') comments.push({ author: { login: 'web-everything' }, createdAt: '2026-11-06T13:26:00Z',
      body: `${why}\n\nWaiting on your ruling (block, card or not-real):\n- \`scripts/x.mjs:1\` — Referral persistence failed; the next bounded retry is at 2026-11-06T14:00:00.000Z is quoted\n- \`no file\` — second defect${marker}` });
    if (kind === 'a finding summary quoting "Referral persistence retries are exhausted"') comments.push({ author: { login: 'web-everything' }, createdAt: '2026-11-06T13:26:00Z',
      body: `${why}\n\nWaiting on your ruling (block, card or not-real):\n- \`scripts/x.mjs:1\` — Referral persistence retries are exhausted; waiting for a new event.\n- \`no file\` — second defect${marker}` });
    if (/findings block then real exhausted detail/.test(kind)) comments.push({ author: { login: 'web-everything' }, createdAt: '2026-11-06T13:26:00Z',
      body: `${why}${findings}\n\nReferral persistence retries are exhausted; waiting for a new event.${marker}` });
    if (/findings block then real failed detail/.test(kind)) comments.push({ author: { login: 'web-everything' }, createdAt: '2026-11-06T13:26:00Z',
      body: `${why}${findings}\n\nReferral persistence failed; the next bounded retry is at 2026-11-06T14:00:00.000Z.${marker}` });
    // The retries-spent notice as the producer posts it: its own lead, the findings block, the exhausted detail, the marker.
    if (/exhausted-lead notice/.test(kind)) comments.push({ author: { login: 'web-everything' }, createdAt: '2026-11-06T13:26:00Z',
      body: `review paused: 2 referrals could not be persisted and the automatic retries are spent; it resumes on a new push or an operator reply${findings}\n\nReferral persistence retries are exhausted; waiting for a new event.${marker}` });
    if (kind === 'persist-exhausted notice') comments.push({ body: 'review paused: 2 referrals could not be persisted and the automatic retries are spent; it resumes on a new push or an operator reply',
      author: { login: 'web-everything' }, createdAt: '2026-11-06T13:26:00Z' });
    if (kind === 'notice from another author') comments.push({ body: notice, author: { login: 'stranger' }, createdAt: '2026-11-06T13:26:00Z' });
    if (kind === 'other hold comment') comments.push({ body: '🛑 conveyor fix — stood down', author: { login: 'web-everything' }, createdAt: '2026-11-06T13:26:00Z' });
    // The production parked run need not carry red-team:pending: "only review:pending" pins that label set.
    const onlyReviewPending = /only review:pending/.test(kind);
    const labels = [...(onlyReviewPending ? [] : ['red-team:pending']), ...(/review:pending/.test(kind) ? ['review:pending'] : []),
      ...(/review:human/.test(kind) ? ['review:human'] : [])];
    const rawPr = { number: pr, headRefOid: head, body, comments, reviews: [], labels };
    // Validate the fixture through the real shared gate, without a planner-only mock seam.
    expect(refusedReferralsAreRuled(rawPr, projected, { repo })).toBe(![
      'unruled referral', 'partial rulings', 'ruling for other head', 'ruling for other run', 'unreadable referral card',
    ].includes(kind));
    let runs = [projected];
    const loopPayload = { verdict: run.verdict, findings: { read: run.findings.read } };
    if (kind === 'no parked run') runs = [];
    // A run that still fails to persist: its persistence notices describe a live hold, so nothing resumes.
    if (/persistence still failing/.test(kind)) runs = [{ ...projected, persistenceFailed: true }];
    if (kind === 'run for other head') runs = [{ ...projected, head: 'b'.repeat(40) }];
    if (kind === 'run for other repo') runs = [{ ...projected, repo: 'other/repo' }];
    if (kind === 'run for other PR') runs = [{ ...projected, pr: pr + 1 }];
    if (kind === 'stored verdict not needs-human') loopPayload.verdict = { verdict: 'changes' };
    if (kind === 'stored review on other head') loopPayload.findings.read = { ...run.findings.read, netBasis: { rev: 'b'.repeat(40) } };
    if (kind === 'missing comments') rawPr.comments = undefined;
    if (kind === 'formal review hold') rawPr.reviews = [{ state: 'CHANGES_REQUESTED', author: { login: 'reviewer' } }];
    if (kind === 'unreadable reviews') rawPr.reviews = undefined;
    // The daemon snapshot omits formal reviews; the wrapper must fetch them itself through the reader.
    const snapshot = /daemon snapshot/.test(kind);
    if (snapshot) delete rawPr.reviews;
    const fetched = /with formal review hold/.test(kind) ? [{ state: 'CHANGES_REQUESTED', author: { login: 'reviewer' } }] : [];
    return runFixture({ rawPrs: [rawPr], readReviews: vi.fn(() => {
      if (/reader throws/.test(kind)) throw new Error('offline');
      return snapshot ? fetched : rawPr.reviews;
    }), readEvidence: () => ({ loopPayload, inFlight: false,
      queued: false, recorded: false, seatRecorded: false }),
    readReviewRuns: vi.fn(() => {
      if (kind === 'unreadable run reader') throw new Error('run evidence unreadable');
      return runs;
    }) });
  }

  it('dispatches one full review for an already-reviewed needs-human head whose refused referrals are all ruled', () => {
    const o = parkedFixture();
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'review', head,
      why: 'stored review needs-human only on referrals now ruled; resume the parked run' });
    expect(o.readReviewRuns).toHaveBeenCalled();
    expect(o.dispatch).toHaveBeenCalledTimes(1);
    expect(o.dispatch).toHaveBeenCalledWith({ pr, repo });
  });

  it.each([
    'pause notice', 'review:pending label', 'pause notice and review:pending label', 'notice posted under the operator credential',
    'a finding summary quoting "Referral persistence failed"', 'a finding summary quoting "Referral persistence retries are exhausted"',
    // Persistence recovered (the newest run no longer fails to persist) and every referral is ruled: the old notices are stale.
    'recovered persistence, stale notice with persistence detail',
    'recovered persistence, stale findings block then real failed detail',
    'recovered persistence, stale findings block then real exhausted detail',
    'recovered persistence, stale exhausted-lead notice',
  ])('resumes when the parked run carries its own settled marks: %s', kind => {
    const o = parkedFixture(kind);
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'review', head,
      why: 'stored review needs-human only on referrals now ruled; resume the parked run' });
    expect(o.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    'only review:pending label, daemon snapshot without reviews',
    'only review:pending label and pause notice, daemon snapshot without reviews',
  ])('fetches the missing formal reviews itself and resumes: %s', kind => {
    const o = parkedFixture(kind);
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'review', head,
      why: 'stored review needs-human only on referrals now ruled; resume the parked run' });
    expect(o.readReviews).toHaveBeenCalledOnce();
    expect(o.readReviews).toHaveBeenCalledWith({ repo, pr });
    expect(o.rawPrs[0]).not.toHaveProperty('reviews');
    expect(o.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    'only review:pending label, daemon snapshot with formal review hold',
    'only review:pending label, daemon snapshot, reader throws',
  ])('fails closed when the fetched formal reviews hold or are unreadable: %s', kind => {
    const o = parkedFixture(kind);
    expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
    expect(o.readReviews).toHaveBeenCalledOnce();
    expect(o.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    'persist-exhausted notice', 'notice from another author', 'bare notice without episode marker', 'other hold comment', 'review:human label',
    'pause notice and review:human label',
    'persistence still failing, findings block then real failed detail',
    'persistence still failing, findings block then real exhausted detail',
    'persistence still failing, exhausted-lead notice',
    'persistence still failing, pause notice',
  ])('fails closed: a hold that is not the settled referral pause still skips: %s', kind => {
    const o = parkedFixture(kind);
    expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
    expect(o.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    'unruled referral', 'partial rulings', 'ruling for other head', 'ruling for other run',
    'unreadable run reader', 'no parked run', 'stored verdict not needs-human',
    'run for other head', 'run for other repo', 'run for other PR', 'stored review on other head',
    'unreadable referral card', 'missing comments', 'formal review hold', 'unreadable reviews',
  ])('fails closed: %s skips without dispatch', kind => {
    const o = parkedFixture(kind);
    expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
    expect(o.dispatch).not.toHaveBeenCalled();
    expect(o.lastDispatch.size).toBe(0);
  });

  it('fails closed: an older ruled run does not mask a newer same-head run that is not ruled', () => {
    const o = parkedFixture();
    const [ruledRun] = o.readReviewRuns();
    // The newer run owes a key no referral record on this head carries, so it is genuinely unruled.
    o.readReviewRuns = vi.fn(() => [{ ...ruledRun, startedAt: 1 },
      { ...ruledRun, id: 'review-pr-newer', startedAt: 2, pending: [...ruledRun.pending, 'judge:unrecorded-newer-defect'] }]);
    expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
    expect(o.dispatch).not.toHaveBeenCalled();
  });

  it('shares the full-review per-head retry cooldown', () => {
    const o = parkedFixture();
    o.lastDispatch.set(`${repo}#${pr}@${head}`, o.now() - 1);
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: 'retry cooldown active' });
    expect(o.dispatch).not.toHaveBeenCalled();
  });
});

describe('R100 — #5910 accepted stored review does not owe a red team', () => {
  const storedHead = '682e81b3ae1c'.padEnd(40, '0'), storedPr = 5910;
  function storedFixture(over = {}) {
    return fixture({
      refusals: [{ kind: 'already-reviewed-head', prNumber: storedPr, headSha: storedHead }],
      // This R100 fixture previously had only a label; a real accepted head needs its trusted accept comment.
      rawPrs: [{ number: storedPr, headRefOid: storedHead, labels: ['review:accepted'], reviews: [],
        comments: [{ body: `✅ review — accepted\n<!-- reviewed-sha: ${storedHead} -->`, author: { login: 'web-everything' } }] }],
      readEvidence: () => ({ loopPayload: {
        verdict: { verdict: 'needs-human', humanRequired: false },
        findings: { read: { netBasis: { rev: storedHead },
          diffText: 'diff --git a/backlog/5910-card.md b/backlog/5910-card.md\n+update',
          netChangedFiles: ['backlog/5910-card.md'], netRenameSources: [] } },
      } }),
      ...over,
    });
  }
  function storedRun(over = {}) {
    const f = storedFixture();
    const evidence = f.readEvidence();
    evidence.loopPayload.verdict = { verdict: 'accept' };
    evidence.seatRecorded = false;
    evidence.status = { status: 'finished', result: 'not-owed' };
    return runFixture({ ...f, readEvidence: () => evidence,
      readStatus: () => ({ status: 'finished', result: 'not-owed' }),
      plan: { refusals: f.refusals }, now: () => f.now, ...over });
  }

  it.each([['review:accepted'], [{ name: 'review:accepted' }]].map(labels => [labels]))(
    'refuses historical non-accepting stored review despite accepted labels %j', labels => {
      const f = storedFixture(); f.rawPrs[0].labels = labels;
      expect(planRedTeamOnSkip(f)).toEqual([{ prNumber: storedPr, head: storedHead,
        action: 'skip', why: 'stored review does not owe a red team' }]);
    });

  // A red-team-only job on a prevention-outstanding stored verdict returns `red-team-not-owed` before it writes any
  // status (review-job.mjs), so the planner must never dispatch it: it would re-run the same no-op each cooldown.
  const judgeAcceptedFixture = (labels, evidenceOver = {}) => {
    const f = storedFixture(); const rev = storedHead;
    f.rawPrs[0].labels = labels;
    f.readEvidence = () => ({ loopPayload: { verdict: { verdict: 'prevention-outstanding' },
      findings: { read: { netBasis: { rev } } } }, recorded: false, seatRecorded: false, inFlight: false, queued: false,
    ...evidenceOver });
    return f;
  };

  it('clears pending directly for a judge-accepted head with no red-team state, never dispatching a no-op job (#6438 deadlock)', () => {
    const [row] = planRedTeamOnSkip(judgeAcceptedFixture(['ready-to-merge', 'review:accepted', 'red-team:pending']));
    expect(row).toMatchObject({ action: 'clear', why: 'not owed (stored review)' });
    expect(row.action).not.toBe('dispatch');
  });

  it('does not clear a judge-accepted head without a pending label (no new policy-clear comment for settled heads)', () => {
    const [row] = planRedTeamOnSkip(judgeAcceptedFixture(['ready-to-merge', 'review:accepted']));
    expect(row.action).toBe('skip');
  });

  it('does not clear a prevention-outstanding head whose accept label has no provable accept comment', () => {
    const f = judgeAcceptedFixture(['ready-to-merge', 'review:accepted', 'red-team:pending']);
    f.rawPrs[0].comments = [];
    expect(planRedTeamOnSkip(f)[0].action).toBe('skip');
  });

  it('does not clear a judge-accepted head without the review:accepted label', () => {
    const f = judgeAcceptedFixture(['ready-to-merge', 'red-team:pending']);
    expect(planRedTeamOnSkip(f)[0].action).toBe('skip');
  });

  it.each([
    ['a recorded red-team run', { recorded: true }],
    ['a recorded seat', { seatRecorded: true }],
    ['an in-flight pass', { inFlight: true }],
    ['a queued pass', { queued: true }],
  ])('does not clear a judge-accepted head with %s', (_name, evidenceOver) => {
    const f = judgeAcceptedFixture(['ready-to-merge', 'review:accepted', 'red-team:pending'], evidenceOver);
    expect(planRedTeamOnSkip(f)[0].action).toBe('skip');
  });

  it.each([
    ['running', { status: 'running' }],
    ['failed', { status: 'finished', result: { status: 'failed' } }],
    ['deferred by cap', { status: 'finished', result: { status: 'not-owed', deferredByCap: true } }],
  ])('does not clear a judge-accepted head whose red-team status is %s', (_name, status) => {
    const f = judgeAcceptedFixture(['ready-to-merge', 'review:accepted', 'red-team:pending'], { status });
    f.readStatus = () => status;
    expect(planRedTeamOnSkip(f)[0].action).not.toBe('clear');
  });

  // Each conjunct of the judge-accepted clear gate, flipped one at a time: the planner must neither clear nor dispatch.
  const pendingLabels = ['ready-to-merge', 'review:accepted', 'red-team:pending'];
  const acceptComment = (sha = storedHead) => ({ body: `✅ review — accepted\n<!-- reviewed-sha: ${sha} -->`, author: { login: 'web-everything' } });
  it.each([
    ['a later hold comment after the accept', f => { f.rawPrs[0].comments.push({ body: '🔁 review — changes requested', author: { login: 'web-everything' } }); }],
    ['an accept comment for a different head', f => { f.rawPrs[0].comments = [acceptComment('b'.repeat(40))]; }],
    ['unreadable formal reviews', f => { f.rawPrs[0].reviews = null; }],
    ['a formal changes-requested review', f => { f.rawPrs[0].reviews = [{ state: 'CHANGES_REQUESTED', commit: { oid: storedHead }, author: { login: 'someone' } }]; }],
    ['a blocking review:changes label', f => { f.rawPrs[0].labels = [...pendingLabels, 'review:changes']; }],
    ['a blocking review:human label', f => { f.rawPrs[0].labels = [...pendingLabels, 'review:human']; }],
    ['a blocking red-team:blocked label', f => { f.rawPrs[0].labels = [...pendingLabels, 'red-team:blocked']; }],
  ])('refuses to clear or dispatch a judge-accepted head with %s', (_name, mutate) => {
    const f = judgeAcceptedFixture(pendingLabels); mutate(f);
    expect(planRedTeamOnSkip(f)[0].action).toBe('skip');
  });

  it('refuses to clear a judge-accepted head when the red-team status is finished not-owed but the accept is not provable', () => {
    const status = { status: 'finished', result: 'not-owed' };
    const f = judgeAcceptedFixture(pendingLabels, { status }); f.rawPrs[0].comments = []; f.readStatus = () => status;
    expect(planRedTeamOnSkip(f)[0].action).toBe('skip');
  });

  it('refuses to clear when only the live status read shows red-team state (evidence status absent)', () => {
    const f = judgeAcceptedFixture(pendingLabels); f.readStatus = () => ({ status: 'running' });
    expect(planRedTeamOnSkip(f)[0].action).not.toBe('clear');
  });

  it.each(['recorded', 'seatRecorded'])('does not treat an omitted %s as proof the head never ran (explicit-false contrast)', key => {
    const omitted = judgeAcceptedFixture(pendingLabels);
    const evidence = { loopPayload: { verdict: { verdict: 'prevention-outstanding' }, findings: { read: { netBasis: { rev: storedHead } } } },
      recorded: false, seatRecorded: false, inFlight: false, queued: false };
    delete evidence[key];
    omitted.readEvidence = () => evidence;
    // Whatever the planner does with an omitted flag, it must never dispatch the known no-op red-team job.
    expect(planRedTeamOnSkip(omitted)[0].action).not.toBe('dispatch');
  });

  it('clears pending for a judge-accepted head whose red team already finished not-owed (#6438 live state)', () => {
    const f = storedFixture(); const rev = storedHead;
    f.rawPrs[0].labels = ['ready-to-merge', 'review:accepted', 'red-team:pending'];
    const status = { status: 'finished', result: 'not-owed' };
    f.readEvidence = () => ({ loopPayload: { verdict: { verdict: 'prevention-outstanding' },
      findings: { read: { netBasis: { rev } } } }, recorded: false, seatRecorded: false, inFlight: false, queued: false, status });
    f.readStatus = () => status;
    expect(planRedTeamOnSkip(f)[0]).toMatchObject({ action: 'clear' });
  });

  it.each(['inFlight', 'queued'])('skips an accepted not-owed review while %s', key => {
    const f = storedFixture(), evidence = { ...f.readEvidence(), [key]: true };
    f.readEvidence = () => evidence;
    expect(planRedTeamOnSkip(f)[0]).toMatchObject({ action: 'skip', why: 'red-team pass in flight' });
  });

  it('skips an accepted not-owed review with a prior error status row', () => {
    const readStatus = vi.fn(() => ({ status: 'finished', head: storedHead, result: 'error' }));
    expect(planRedTeamOnSkip(storedFixture({ readStatus }))[0])
      .toMatchObject({ action: 'skip', why: 'stored review does not owe a red team' });
    expect(readStatus).toHaveBeenCalledWith({ repo, pr: storedPr, head: storedHead });
  });

  it('skips an accepted not-owed review with recorded red-team evidence', () => {
    const f = storedFixture(), evidence = { ...f.readEvidence(), recorded: true };
    f.readEvidence = () => evidence;
    expect(planRedTeamOnSkip(f)[0]).toMatchObject({ action: 'skip', why: 'stored review does not owe a red team' });
  });

  it('fails closed when prior status is unreadable for an accepted not-owed review', () => {
    const f = storedFixture({ readStatus: () => { throw Error('unreadable'); } });
    expect(planRedTeamOnSkip(f)[0])
      .toMatchObject({ action: 'skip', why: 'red-team evidence unreadable; inspect stored evidence before retrying' });
  });

  it.each([[], ['review:human'], undefined, null, 'review:accepted'].map(labels => [labels]))(
    'keeps the existing skip without readable accepted labels %j', labels => {
      const f = storedFixture(); f.rawPrs[0].labels = labels;
      expect(planRedTeamOnSkip(f)[0]).toMatchObject({ action: 'skip', why: 'stored review does not owe a red team' });
    });

  it.each(['b'.repeat(40), undefined])('keeps the existing skip for a mismatched or missing stored head %j', rev => {
    const f = storedFixture(), evidence = f.readEvidence();
    evidence.loopPayload.findings.read.netBasis.rev = rev;
    f.readEvidence = () => evidence;
    expect(planRedTeamOnSkip(f)[0]).toMatchObject({ action: 'skip', why: 'stored review does not owe a red team' });
  });

  it('fails closed on unreadable stored evidence or comments on an accepted head', () => {
    const f = storedFixture({ readEvidence: () => { throw Error('unreadable'); } });
    expect(planRedTeamOnSkip(f)[0]).toMatchObject({ action: 'skip', why: 'red-team evidence unreadable; inspect stored evidence before retrying' });
    f.rawPrs[0].comments = undefined;
    expect(planRedTeamOnSkip(f)[0]).toMatchObject({ action: 'skip', why: 'PR comments unreadable' });
  });

  it('default settlement posts the head-bound reasoned marker once without consuming dispatch capacity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-stored-clear-'));
    const take = vi.fn(), log = vi.fn();
    const o = storedRun({ env: { WE_SHARED_RUNS_DIR: join(dir, 'runs') }, log,
      capacity: { lanes: 0, budget: { left: 0 }, remainingStarts: 0, take } });
    runGhSync.mockImplementation((_args, options) => {
      o.rawPrs[0].comments.push({ body: options.input, author: { login: 'web-everything' } });
    });
    try {
      expect(runRedTeamOnSkip(o)).toMatchObject({
        rows: [{ action: 'clear', why: 'not owed (stored review)' }], dispatched: [], notStarted: [],
      });
      expect(runGhSync).toHaveBeenCalledOnce();
      expect(runGhSync).toHaveBeenCalledWith([
        'pr', 'comment', String(storedPr), `--repo=${repo}`, '--body-file', '-',
      ], expect.objectContaining({ input: expect.stringContaining('not owed (stored review)') }));
      expect(o.rawPrs[0].comments.at(-1).body.split('\n')[0]).toBe(redTeamMarker(storedPr, storedHead));
      expect(redTeamForHead(o.rawPrs[0].comments, storedPr, storedHead)).toEqual({ pr: storedPr, rev: storedHead, findings: [] });
      expect(redTeamForHead(o.rawPrs[0].comments, storedPr, 'b'.repeat(40))).toBeNull();
      expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: 'red-team result already on head' });
      expect(runGhSync).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('red team cleared'));
      expect(o.capacity).toEqual({ lanes: 0, budget: { left: 0 }, remainingStarts: 0, take });
      expect(take).not.toHaveBeenCalled();
      expect(o.dispatch).not.toHaveBeenCalled();
      expect(o.lastDispatch.size).toBe(0);
    } finally {
      runGhSync.mockReset();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // PR #6535 round 6: the stored not-owed clear runs no round either; its check precedes its comment.
  it('publishes the cleared head check before the policy-clear comment; a failed post posts nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-stored-clear-check-'));
    const order = [];
    const o = storedRun({ env: { WE_SHARED_RUNS_DIR: join(dir, 'runs'), WE_RED_TEAM_GATE_SOURCE: 'both' },
      publishCheck: vi.fn(args => { order.push(['check', args]); return { ok: true }; }) });
    runGhSync.mockImplementation((args, options) => { order.push(['comment', args[0]]); o.rawPrs[0].comments.push({ body: options.input, author: { login: 'web-everything' } }); });
    try {
      expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'clear', why: 'not owed (stored review)' });
      expect(order).toEqual([['check', { repo, pr: storedPr, headSha: storedHead }], ['comment', 'pr']]);
      runGhSync.mockClear();
      const failed = storedRun({ env: { WE_SHARED_RUNS_DIR: join(dir, 'runs-2'), WE_RED_TEAM_GATE_SOURCE: 'both' }, publishCheck: vi.fn(() => ({ ok: false, reason: 'HTTP 502' })) });
      expect(runRedTeamOnSkip(failed).rows[0]).toMatchObject({ action: 'skip', why: expect.stringContaining('clear failed') });
      expect(runGhSync).not.toHaveBeenCalled();
      expect(failed.syncLabels).not.toHaveBeenCalled();
      // A yield whose superseding post failed (the one fail-open case) names that detail in the row, never hides it.
      const yielded = storedRun({ env: { WE_SHARED_RUNS_DIR: join(dir, 'runs-3'), WE_RED_TEAM_GATE_SOURCE: 'both' },
        publishCheck: vi.fn(() => ({ ok: false, reason: 'policy-clear yielded to a concurrent round', detail: 'superseding in_progress not posted (HTTP 503)' })) });
      expect(runRedTeamOnSkip(yielded).rows[0]).toMatchObject({ action: 'skip', why: expect.stringContaining('superseding in_progress not posted (HTTP 503)') });
      expect(runGhSync).not.toHaveBeenCalled();
      // The same 80-char feed bound must not cut a comment failure's cause out of the row either.
      const cause = 'HTTP 502 from the comments endpoint after the check was published; retry owed on this head';
      runGhSync.mockImplementation(() => { throw Error(cause); });
      const commentFailed = storedRun({ env: { WE_SHARED_RUNS_DIR: join(dir, 'runs-4'), WE_RED_TEAM_GATE_SOURCE: 'both' },
        publishCheck: vi.fn(() => ({ ok: true })) });
      expect(runRedTeamOnSkip(commentFailed).rows[0]).toMatchObject({ action: 'skip', why: expect.stringContaining(cause) });
    } finally {
      runGhSync.mockReset();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['policy-clear', 'already'])('retains clear for settlement outcome %s', outcome => {
    const settle = vi.fn(() => ({ outcome })), o = storedRun({ settle });
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'clear', why: 'not owed (stored review)' });
    expect(settle).toHaveBeenCalledOnce();
    expect(o.syncLabels).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({
      redTeam: { status: 'not-owed' }, repo, pr: storedPr, head: storedHead, readHead: storedHead,
      accepted: true, comments: o.rawPrs[0].comments, reason: 'not owed (stored review)',
    }));
    expect(o.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['throws', () => { throw Error('offline'); }, 'offline'],
    ['throws an unprintable value', () => { throw { message: { toString: null } }; }, 'unprintable error'],
    ['returns non-policy', () => ({ outcome: 'non-policy', reason: 'post failed' }), 'post failed'],
    ['returns unknown', () => undefined, 'unknown outcome'],
  ])('settlement that %s becomes a skip without throwing', (_name, settle, why) => {
    const o = storedRun({ settle });
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: `clear failed: ${why}` });
    expect(o.dispatch).not.toHaveBeenCalled();
    expect(o.capacity).toEqual({ lanes: 1, budget: { left: 1 } });
    expect(o.lastDispatch.size).toBe(0);
  });

  it('dry run preserves the clear plan without settling or spending capacity', () => {
    const settle = vi.fn(), o = storedRun({ settle, dryRun: true });
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'clear', why: 'dry run (clear)' });
    expect(settle).not.toHaveBeenCalled();
    expect(o.dispatch).not.toHaveBeenCalled();
    expect(o.capacity).toEqual({ lanes: 1, budget: { left: 1 } });
    expect(o.lastDispatch.size).toBe(0);
  });

  describe('R338 - a round-budget accept leaves a stored `changes` verdict', () => {
    const roundAccept = (result = 'not-owed', over = {}) => {
      const f = storedFixture(), evidence = f.readEvidence();
      evidence.loopPayload.verdict = { verdict: 'changes' };
      evidence.seatRecorded = false;
      evidence.status = { status: 'finished', result };
      return { ...f, readEvidence: () => evidence, readStatus: () => ({ status: 'finished', result }), ...over };
    };
    it('finished not-owed on the accepted live head clears', () => {
      expect(planRedTeamOnSkip(roundAccept())[0]).toMatchObject({ action: 'clear', why: 'not owed (stored review)' });
    });
    it.each(['owed', 'pending', 'error', 'skipped', 'ran'])('result %s stays a skip', result => {
      expect(planRedTeamOnSkip(roundAccept(result))[0]).toMatchObject({ action: 'skip' });
    });
    it('a status still running stays a skip', () => {
      const f = roundAccept();
      expect(planRedTeamOnSkip({ ...f, readStatus: () => ({ status: 'running', result: 'not-owed' }) })[0]).toMatchObject({ action: 'skip' });
    });
    it('a head change never clears', () => {
      const f = roundAccept(), moved = 'c'.repeat(40);
      f.rawPrs[0].headRefOid = moved;
      f.refusals = [{ kind: 'already-reviewed-head', prNumber: storedPr, headSha: moved }];
      expect(planRedTeamOnSkip(f)[0]).toMatchObject({ action: 'skip' });
    });
    it('is idempotent once the result comment exists', () => {
      const f = roundAccept();
      f.rawPrs[0].comments.push({ body: redTeamMarker(storedPr, storedHead), author: { login: 'web-everything' } });
      expect(planRedTeamOnSkip(f)[0]).toMatchObject({ action: 'skip', why: 'red-team result already on head' });
    });
  });

  it('a red-team result already on the head keeps the existing skip and never settles', () => {
    const settle = vi.fn(), readEvidence = vi.fn(), o = storedRun({ settle, readEvidence });
    o.rawPrs[0].comments.push({ body: redTeamMarker(storedPr, storedHead), author: { login: 'web-everything' } });
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: 'red-team result already on head' });
    expect(settle).not.toHaveBeenCalled();
    expect(readEvidence).not.toHaveBeenCalled();
  });
});

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

  it.each([1, 2])('card-only settlement cannot restore a spent retry count of %i', retryCount => {
    const status = { ...heal().readStatus(), retryCount };
    expect(decide(heal({ readStatus: () => status })))
      .toMatchObject({ action: 'skip', why: 'red-team retry already spent; inspect stored evidence' });
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
  // A verdict carry posts ONE comment: carried marker, prose, then the re-keyed result. Every "is there a result on
  // this head" reader must see it as the disposition reader does, or a policy-clear could bury a carried break.
  const carried = (to, gate = '') => ({ author: { login: 'web-everything' }, created_at: '2026-11-07T12:00:00Z', body: [
    ...(gate ? [gate] : []), `<!-- review-verdict-carried from=${'b'.repeat(40)} to=${to} patch-id=${'c'.repeat(40)} -->`,
    'Review verdict carried across an identical contribution.', redTeamMarker(pr, to),
    '1. [**confirmed**] (edge-case, broken) `x.mjs:1` — carried break'].join('\n') });
  it('c: a carried result with a confirmed break covers this head (no policy-clear over it)', () => {
    const readEvidence = vi.fn();
    expect(redTeamForHead([carried(head)], pr, head)?.findings).toMatchObject([{ confirmed: true, summary: 'carried break' }]);
    expect(decide({ rawPrs: [{ number: pr, headRefOid: head, comments: [carried(head)] }], readEvidence }).why)
      .toBe('red-team result already on head');
    expect(readEvidence).not.toHaveBeenCalled();
  });
  it('c: a carry envelope that is malformed, untrusted or names another head does not count', () => {
    const other = 'd'.repeat(40);
    for (const c of [carried(other), { ...carried(head), author: { login: 'outsider' } },
      carried(head, `<!-- we:red-team-gate pr=${pr} rev=${other} outcome=sent-back -->`)])
      expect(redTeamForHead([c], pr, head)).toBeNull();
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
    expect(resolved.value).toEqual({ enabled: true, retryCooldownMin: 30, staleRedispatchDailyCap: 3 });
    expect(resolved.sources).toMatchObject({ enabled: 'tool', retryCooldownMin: 'tool', staleRedispatchDailyCap: 'tool' });
  });
  it('environment disables recovery and logs its source', () => {
    resetCascadeLogForTest(); const log = vi.fn();
    const resolved = resolveReviewRedTeamOnSkip({ env: { WE_REVIEW_RED_TEAM_ON_SKIP: '0', WE_POLICY_CASCADE_LOG: '1' },
      readFile: () => '{"enabled":true}', log });
    expect(resolved.value.enabled).toBe(false);
    expect(resolved.sources.enabled).toBe('env');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('enabled=false (env)'));
  });
  it.each(['0', '-1', '1.5', 'bad'])('rejects invalid stale daily cap %s', cap => {
    const resolved = resolveReviewRedTeamOnSkip({ env: { WE_PLATFORM_PREFERENCES_FILE: '/missing-test-policy',
      WE_REVIEW_RED_TEAM_ON_SKIP_STALE_REDISPATCH_DAILY_CAP: cap },
      readFile: () => '{"staleRedispatchDailyCap":0}' });
    expect(resolved.value.staleRedispatchDailyCap).toBe(3);
    expect(resolved.sources.staleRedispatchDailyCap).toBe('standard');
  });
  it('environment overrides the stale daily cap and logs provenance', () => {
    resetCascadeLogForTest(); const log = vi.fn();
    const resolved = resolveReviewRedTeamOnSkip({ env: { WE_REVIEW_RED_TEAM_ON_SKIP_STALE_REDISPATCH_DAILY_CAP: '5',
      WE_POLICY_CASCADE_LOG: '1' }, readFile: () => '{"staleRedispatchDailyCap":2}', log });
    expect(resolved.value.staleRedispatchDailyCap).toBe(5);
    expect(resolved.sources.staleRedispatchDailyCap).toBe('env');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('staleRedispatchDailyCap=5 (env)'));
  });
  it('malformed tool and environment values retain lower layers', () => {
    const resolved = resolveReviewRedTeamOnSkip({ env: { WE_REVIEW_RED_TEAM_ON_SKIP: 'garbage', WE_REVIEW_RED_TEAM_ON_SKIP_RETRY_COOLDOWN_MIN: '-1', WE_PLATFORM_PREFERENCES_FILE: '/missing-test-policy' },
      readFile: () => '{"enabled":"bad","retryCooldownMin":-1}' });
    expect(resolved.value).toEqual({ enabled: true, retryCooldownMin: 30, staleRedispatchDailyCap: 3 });
  });
});

function runFixture(over = {}) {
  const f = fixture();
  return { repo, plan: { refusals: f.refusals }, rawPrs: f.rawPrs, setting: f.setting,
    readEvidence: f.readEvidence, readStatus: f.readStatus, now: () => f.now, lastDispatch: f.lastDispatch,
    syncLabels: vi.fn(), capacity: { lanes: 1, budget: { left: 1 } }, dispatch: vi.fn(() => ({ jobPid: 42 })), ...over };
}
describe('daemon rows without formal reviews', () => {
  function daemonOptions(number = 5929) {
    const old = (number === 5929 ? '37709504' : 'b64a14a4').padEnd(40, '0');
    const live = (number === 5929 ? '98caad11' : '682e81b3').padEnd(40, '0');
    const fingerprint = 'd'.repeat(64), contribution = 'e'.repeat(64);
    const markers = (sha, diff) => `<!-- reviewed-sha: ${sha} -->\n<!-- reviewed-diff: ${diff} -->\n<!-- reviewed-contribution: ${contribution} -->`;
    const comment = (body, login, createdAt) => ({ body, author: { login }, createdAt });
    const rawPr = { number, state: 'OPEN', headRefName: `lane/recovery-${number}`, headRefOid: live,
      baseRefName: 'main', mergeStateStatus: 'CLEAN', labels: [{ name: 'review:accepted' }],
      comments: [
        comment(`✅ review — accepted\n\nCard-only change; no implementation findings.\n${markers(old, fingerprint)}`,
          'web-everything', '2026-10-24T12:00:00Z'),
        comment(`${redTeamMarker(number, old)}\nRed team not required on this head: card-only diff`,
          'web-everything', '2026-10-24T12:01:00Z'),
        comment(`📌 review — acceptance re-stamped after a rebase (no new review)\n\n${number === 5910 ? 'Merged origin/main; contribution unchanged.' : 'Net diff unchanged after rebase.'}\n${markers(live, number === 5910 ? 'f'.repeat(64) : fingerprint)}\n<!-- numbering-restamp: from=${old} to=${live} -->`,
          'plateau-merger', '2026-10-24T13:00:00Z'),
      ], statusCheckRollup: [{ name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
    return runFixture({ rawPrs: [rawPr],
      plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: number, headSha: live }] },
      readEvidence: () => ({ inFlight: false, queued: false, recorded: false, seatRecorded: false }),
      readReviews: vi.fn(() => []),
      proveMove: vi.fn(() => { throw Error('acceptance re-stamp does not require a linear head move'); }),
    });
  }

  it.each([5929, 5910])('carries daemon PR #%s policy-clear once after re-stamp (including a merge)', number => {
    const o = daemonOptions(number), raw = o.rawPrs[0];
    runGhSync.mockReset();
    runGhSync.mockImplementation((_args, options) => {
      raw.comments.push({ body: options.input, author: { login: 'web-everything' } });
    });
    try {
      expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'carry', head: raw.headRefOid });
      expect(o.readReviews).toHaveBeenCalledOnce();
      expect(o.readReviews).toHaveBeenCalledWith({ repo, pr: number });
      expect(raw).not.toHaveProperty('reviews');
      expect(runGhSync).toHaveBeenCalledOnce();
      expect(runGhSync).toHaveBeenCalledWith([
        'pr', 'comment', String(number), `--repo=${repo}`, '--body-file', '-',
      ], expect.objectContaining({ input: expect.stringContaining(redTeamMarker(number, raw.headRefOid)) }));
      expect(o.syncLabels).toHaveBeenCalledOnce();
      expect(o.syncLabels).toHaveBeenCalledWith(expect.objectContaining({ repo, pr: number, head: raw.headRefOid }));
      expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: 'red-team result already on head' });
      expect(o.readReviews).toHaveBeenCalledTimes(1);
      expect(runGhSync).toHaveBeenCalledTimes(1);
      expect(o.proveMove).not.toHaveBeenCalled();
    } finally { runGhSync.mockReset(); }
  });

  // PR #6535 round 6: the carry settles the head without a round, so it must publish the head-bound red-team check
  // merge-gate now requires, BEFORE its result comment (a comment alone makes recovery skip the head for good).
  it('publishes the carried head check before the result comment; a failed post leaves no comment to retry', () => {
    const o = daemonOptions(5929), raw = o.rawPrs[0], order = [];
    o.publishCheck = vi.fn(args => { order.push(['check', args]); return { ok: true }; });
    o.env = { ...process.env, WE_RED_TEAM_GATE_SOURCE: 'both' };
    runGhSync.mockReset();
    runGhSync.mockImplementation((args, options) => { order.push(['comment', args[0]]); raw.comments.push({ body: options.input, author: { login: 'web-everything' } }); });
    try {
      expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'carry', head: raw.headRefOid });
      expect(order).toEqual([['check', { repo, pr: 5929, headSha: raw.headRefOid }], ['comment', 'pr']]);
      const failed = daemonOptions(5929);
      failed.publishCheck = vi.fn(() => ({ ok: false, reason: 'HTTP 502' }));
      failed.env = o.env;
      runGhSync.mockClear();
      expect(runRedTeamOnSkip(failed).rows[0]).toMatchObject({ action: 'skip', why: expect.stringContaining('carry failed: red-team check not published: HTTP 502') });
      expect(runGhSync).not.toHaveBeenCalled();
      expect(failed.syncLabels).not.toHaveBeenCalled();
      // No comment landed, so the next pass plans the same carry again.
      failed.publishCheck = vi.fn(() => ({ ok: true }));
      expect(runRedTeamOnSkip(failed).rows[0]).toMatchObject({ action: 'carry' });
    } finally { runGhSync.mockReset(); }
  });

  it('under the drain-scan rollback the check is still attempted, but its failure does not block the carry', () => {
    const o = daemonOptions(5929), raw = o.rawPrs[0];
    o.env = { ...process.env, WE_RED_TEAM_GATE_SOURCE: 'drain-scan' };
    o.publishCheck = vi.fn(() => ({ ok: false, reason: 'no App credentials' }));
    runGhSync.mockReset();
    runGhSync.mockImplementation((_args, options) => { raw.comments.push({ body: options.input, author: { login: 'web-everything' } }); });
    try {
      expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'carry', head: raw.headRefOid });
      // Attempted, so a head settled during the rollback is not stranded when the source switches back.
      expect(o.publishCheck).toHaveBeenCalledWith({ repo, pr: 5929, headSha: raw.headRefOid });
      expect(runGhSync).toHaveBeenCalledOnce();
      const ok = daemonOptions(5929);
      ok.env = o.env; ok.publishCheck = vi.fn(() => { throw Error('offline'); });
      expect(runRedTeamOnSkip(ok).rows[0]).toMatchObject({ action: 'carry' });
    } finally { runGhSync.mockReset(); }
  });

  it.each(['throws', 'oversized', 'malformed', 'changes-requested'])('refuses publication when formal review read is %s', kind => {
    const o = daemonOptions();
    o.readReviews.mockImplementation(() => {
      if (kind === 'throws' || kind === 'oversized') throw Error(kind === 'oversized' ? 'ENOBUFS' : 'offline');
      return kind === 'malformed' ? {} : [{ state: 'CHANGES_REQUESTED', submittedAt: '2026-10-24T14:00:00Z', author: { login: 'reviewer' } }];
    });
    runGhSync.mockClear();
    // Neither policy carry nor fresh-review recovery may cross a standing formal hold
    // or an unreadable formal-review channel.
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: kind === 'changes-requested'
      ? 'later verdict or hold supersedes acceptance' : 'PR reviews unreadable; inspect formal reviews before policy-clear' });
    expect(runGhSync).not.toHaveBeenCalled();
    expect(o.syncLabels).not.toHaveBeenCalled();
    expect(o.dispatch).not.toHaveBeenCalled();
  });

  it('default reader uses throttled gh with bounded output and timeout', () => {
    const o = daemonOptions(); delete o.readReviews; o.dryRun = true;
    runGhSync.mockReset(); runGhSync.mockReturnValue(JSON.stringify({ reviews: [] }));
    try {
      expect(runRedTeamOnSkip(o).rows[0].action).toBe('carry');
      expect(runGhSync).toHaveBeenCalledOnce();
      expect(runGhSync).toHaveBeenCalledWith(['pr', 'view', '5929', '--repo', repo, '--json', 'reviews'],
        expect.objectContaining({ encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 }));
    } finally { runGhSync.mockReset(); }
  });

  it.each(['disabled', 'not-refused', 'unaccepted', 'unreadable-comments', 'changed-head', 'reviews-present'])(
    'avoids formal review reads for %s PRs', kind => {
      const o = daemonOptions();
      if (kind === 'disabled') o.setting.enabled = false;
      if (kind === 'not-refused') o.plan.refusals = [];
      if (kind === 'unaccepted') o.rawPrs[0].labels = [];
      if (kind === 'unreadable-comments') delete o.rawPrs[0].comments;
      if (kind === 'changed-head') o.plan.refusals[0].headSha = head;
      if (kind === 'reviews-present') { o.rawPrs[0].reviews = []; o.dryRun = true; }
      runRedTeamOnSkip(o);
      expect(o.readReviews).not.toHaveBeenCalled();
    });
});
describe('runRedTeamOnSkip', () => {
  it.each(['not-owed', { status: 'not-owed' }].flatMap(result =>
    ['changes', 'accept'].map(verdict => [result, verdict])))(
    'never clears a newer accepting review using an obsolete %j status with verdict %s', (result, verdict) => {
      const dir = mkdtempSync(join(tmpdir(), 'red-team-stale-not-owed-'));
      const runsDir = join(dir, 'runs');
      const env = { WE_SHARED_RUNS_DIR: runsDir };
      const input = { repo, pr, head, runsDir, env, readScorecards: () => [] };
      try {
        recordRedTeamStatus({ repo, pr, loopPayload: { ...payload(), verdict: { verdict } },
          status: 'finished', result }, { env });
        const statusFile = join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${pr}-${head}.json`);
        utimesSync(statusFile, new Date(1000), new Date(1000));
        const id = 'review-pr-newer-accept';
        writeRun({ ...newRunRecord({ id, op: 'review-pr', input: { repo, pr } }), ...payload() }, runsDir);
        utimesSync(join(runsDir, `${id}.json`), new Date(2000), new Date(2000));
        const evidence = readDrainRedTeamEvidence(input);
        expect(evidence).toMatchObject({ scheduled: true, skipCardOnly: false, seatRecorded: false,
          recorded: false, loopPayload: { verdict: { verdict: 'accept' } } });
        expect(evidence.status).toBeUndefined();
        const o = runFixture({ readEvidence: () => readDrainRedTeamEvidence(input),
          readStatus: () => readRedTeamStatus(input) });
        o.rawPrs[0].labels = ['review:accepted'];
        o.rawPrs[0].comments = [{ body: `✅ review — accepted\n<!-- reviewed-sha: ${head} -->`,
          author: { login: 'web-everything' }, createdAt: new Date(2000).toISOString() }];
        runGhSync.mockClear();
        const out = runRedTeamOnSkip(o);
        expect(out.rows[0].action).not.toBe('clear');
        expect(o.syncLabels).not.toHaveBeenCalled();
        expect(runGhSync).not.toHaveBeenCalled();

        // Once this accepting review writes its own status, the clear is valid again.
        recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'finished', result }, { env });
        utimesSync(statusFile, new Date(3000), new Date(3000));
        expect(readDrainRedTeamEvidence(input)).toMatchObject({ scheduled: false,
          status: { status: 'finished', result, loopPayload: { verdict: { verdict: 'accept' } } } });
        o.settle = vi.fn(() => ({ outcome: 'policy-clear' }));
        expect(runRedTeamOnSkip(o).rows[0].action).toBe('clear');
        expect(o.settle).toHaveBeenCalledOnce();
        expect(o.syncLabels).toHaveBeenCalledOnce();
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
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
    expect(out.rows[0].why).toBe('dispatch failed; start unknown: unknown start');
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
    expect(runRedTeamOnSkip(o).rows[0].why).toBe('dispatch failed; start unknown: failed');
    expect(o.capacity.budget.left).toBe(0); expect(o.lastDispatch.size).toBe(0);
  });
  it.each(['behind origin/main — refusing', 'stale guard', 'stale abandonment refused'])(
    'a pre-start refusal refunds capacity, logs the cause and retries next tick: %s', message => {
      const take = vi.fn(), log = vi.fn();
      const o = runFixture({ log, capacity: { lanes: 2, budget: { left: 2 }, remainingStarts: 1, take },
        dispatch: vi.fn(() => { throw new PreStartDispatchRefusalError(message); }) });
      const out = runRedTeamOnSkip(o);
      expect(out.rows[0]).toMatchObject({ action: 'skip', why: `dispatch refused before start: ${message}` });
      expect(out.dispatched).toEqual([]);
      expect(o.capacity).toEqual({ lanes: 2, budget: { left: 2 }, remainingStarts: 1, take });
      expect(take).not.toHaveBeenCalled(); expect(o.lastDispatch.size).toBe(0);
      expect(log).toHaveBeenCalledWith(`review-daemon: ${repo}#${pr} red-team dispatch threw: ${message}`);
      runRedTeamOnSkip(o);
      expect(o.dispatch).toHaveBeenCalledTimes(2);
    });
  it('the real staleness guard emits a pre-start refusal that refunds recovery capacity', () => {
    const take = vi.fn(), log = vi.fn();
    const o = runFixture({ log, capacity: { lanes: 2, budget: { left: 2 }, remainingStarts: 1, take },
      dispatch: () => assertMainNotStale('/fixture', () => ({ action: 'warn', behind: 1 }), {
        listBehindFiles: () => null, lastGood: () => null, rebuildGrace: () => null,
      }) });
    const out = runRedTeamOnSkip(o);
    expect(out.rows[0].why).toMatch(/^dispatch refused before start: .*behind origin\/main/);
    expect(o.capacity).toEqual({ lanes: 2, budget: { left: 2 }, remainingStarts: 1, take });
    expect(take).not.toHaveBeenCalled(); expect(o.lastDispatch.size).toBe(0);
    expect(log.mock.calls[0][0]).toContain('red-team dispatch threw: review-dispatch:');
  });
  it('an unclassified dispatch error logs boom and retains all start reservations', () => {
    const take = vi.fn(), log = vi.fn();
    const o = runFixture({ log, capacity: { lanes: 2, budget: { left: 2 }, remainingStarts: 1, take },
      dispatch: () => { throw Error('boom'); } });
    const out = runRedTeamOnSkip(o);
    expect(out.rows[0]).toMatchObject({ action: 'skip', why: 'dispatch failed; start unknown: boom' });
    expect(out.dispatched).toEqual([]);
    expect(o.capacity).toEqual({ lanes: 1, budget: { left: 1 }, remainingStarts: 0, take });
    expect(take).toHaveBeenCalledOnce(); expect(o.lastDispatch.size).toBe(0);
    expect(log).toHaveBeenCalledWith(`review-daemon: ${repo}#${pr} red-team dispatch threw: boom`);
  });
  it.each(['stale post-spawn record', 'refusing post-spawn cleanup', 'behind origin/main — refusing'])(
    'a post-spawn keyword-bearing error consumes every reservation: %s', message => {
      const take = vi.fn(), spawn = vi.fn(), log = vi.fn();
      const o = runFixture({ log, capacity: { lanes: 2, budget: { left: 2 }, remainingStarts: 1, take },
        dispatch: vi.fn(() => { spawn(); throw Error(message); }) });
      const out = runRedTeamOnSkip(o);
      expect(spawn).toHaveBeenCalledOnce();
      expect(out.rows[0]).toMatchObject({ action: 'skip', why: `dispatch failed; start unknown: ${message}` });
      expect(out.dispatched).toEqual([]);
      expect(o.capacity).toEqual({ lanes: 1, budget: { left: 1 }, remainingStarts: 0, take });
      expect(take).toHaveBeenCalledOnce(); expect(o.lastDispatch.size).toBe(0);
      expect(log).toHaveBeenCalledWith(`review-daemon: ${repo}#${pr} red-team dispatch threw: ${message}`);
    });
  it('bounds oversized dispatch error text and strips controls from rows and logs', () => {
    const log = vi.fn(), message = `boom\n\u001b${'x'.repeat(500)}`;
    const o = runFixture({ log, dispatch: () => { throw Error(message); } });
    const out = runRedTeamOnSkip(o);
    const text = `boom  ${'x'.repeat(294)}`;
    expect(out.rows[0].why).toBe(`dispatch failed; start unknown: ${text}`);
    expect(log).toHaveBeenCalledWith(`review-daemon: ${repo}#${pr} red-team dispatch threw: ${text}`);
    expect(o.capacity.budget.left).toBe(0);
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


describe('R100 recovery regressions', () => {
  const old = 'b'.repeat(40);
  const trusted = body => ({ body, author: { login: 'web-everything' } });
  const carryOptions = () => runFixture({
    rawPrs: [{ number: pr, headRefOid: head, labels: ['review:accepted'], reviews: [], comments: [
      trusted(`✅ review — accepted\n<!-- reviewed-sha: ${old} -->`),
      trusted(`${redTeamMarker(pr, old)}\nRed team not required on this head: card-only diff`),
      trusted(`📌 review — acceptance re-stamped after a rebase (no new review)\n<!-- reviewed-sha: ${head} -->\n<!-- numbering-restamp: from=${old} to=${head} -->`),
    ] }], readEvidence: () => ({ inFlight: false, recorded: false }),
  });

  it.each(['carry', 'clear'].flatMap(action => [
    [action, 'post', 'offline', () => Error('offline')],
    [action, 'post', 'unprintable error', () => ({ message: { toString: null } })],
    [action, 'label sync', 'offline', () => Error('offline')],
    [action, 'label sync', 'unprintable error', () => ({ message: { toString: null } })],
  ]))('%s publication failing at %s (%s) skips without spending capacity', (action, stage, why, error) => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-publish-failure-'));
    const o = action === 'carry' ? carryOptions() : runFixture({
      rawPrs: [{ number: pr, headRefOid: head, labels: ['review:accepted'], reviews: [],
        comments: [trusted(`✅ review — accepted\n<!-- reviewed-sha: ${head} -->`)] }],
      readEvidence: () => ({ loopPayload: payload(), recorded: false, seatRecorded: false,
        status: { status: 'finished', result: 'not-owed' } }),
      readStatus: () => ({ status: 'finished', result: 'not-owed' }),
    });
    o.env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
    const raw = o.rawPrs[0];
    const failure = action === 'clear' && stage === 'post'
      ? `clear failed: policy-clear comment failed: ${why}` : `${action} failed: ${why}`;
    runGhSync.mockReset();
    runGhSync.mockImplementation((_args, options) => {
      if (stage === 'post') throw error();
      raw.comments.push(trusted(options.input));
    });
    if (stage === 'label sync') o.syncLabels.mockImplementation(() => { throw error(); });
    try {
      const out = runRedTeamOnSkip(o);
      expect(out).toMatchObject({ rows: [{ action: 'skip', why: failure }],
        dispatched: [], notStarted: [] });
      expect(runGhSync).toHaveBeenCalledOnce();
      expect(o.syncLabels).toHaveBeenCalledTimes(stage === 'post' ? 0 : 1);
      expect(Boolean(redTeamForHead(raw.comments, pr, head))).toBe(stage === 'label sync');
      expect(o.dispatch).not.toHaveBeenCalled();
      expect(o.capacity).toEqual({ lanes: 1, budget: { left: 1 } });
      expect(o.lastDispatch.size).toBe(0);
      // A visible comment deduplicates the next tick; label repair belongs to the label sweep.
      expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: stage === 'post'
        ? failure : 'red-team result already on head' });
      expect(runGhSync).toHaveBeenCalledTimes(stage === 'post' ? 2 : 1);
      expect(o.syncLabels).toHaveBeenCalledTimes(stage === 'post' ? 0 : 1);
    } finally {
      runGhSync.mockReset();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['carry', 'not-owed', 'full-review'].flatMap(mode =>
    ['stale fork', 'invalid ancestor', 'changed clearance'].map(kind => ({ mode, kind }))))(
    'refuses $mode publication with a canonical rejected re-stamp: $kind', ({ mode, kind }) => {
      const o = carryOptions(), raw = o.rawPrs[0];
      raw.reviews = [];
      o.settle = vi.fn(() => ({ outcome: 'policy-clear' }));
      if (mode === 'not-owed') {
        const status = { status: 'finished', result: 'not-owed' };
        o.readStatus = () => status;
        o.readEvidence = () => ({ loopPayload: payload(), inFlight: false, recorded: false,
          seatRecorded: false, status });
      }
      const intermediate = 'c'.repeat(40);
      const restamp = (from, to) => trusted(`📌 review — acceptance re-stamped after a rebase (no new review)\n<!-- reviewed-sha: ${to} -->\n<!-- numbering-restamp: from=${from} to=${to} -->`);
      if (kind === 'stale fork') raw.comments.splice(2, 0, restamp(old, intermediate));
      if (kind === 'invalid ancestor') {
        raw.comments.splice(2, 0, restamp(intermediate, old));
      }
      if (kind === 'changed clearance') {
        raw.comments[0].body += '\n<!-- cleared-human: reviewer -->';
      }
      if (mode === 'full-review') {
        raw.comments.splice(1, 1);
        o.readEvidence = () => ({ inFlight: false, recorded: false, seatRecorded: false });
      }
      expect(numbering.strandedNumberingRecords(raw.comments, raw.reviews)).not.toHaveLength(0);
      runGhSync.mockClear();
      expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip',
        why: 'invalid acceptance re-stamp; withdraw stranded records before recovery' });
      expect(runGhSync).not.toHaveBeenCalled();
      expect(o.settle).not.toHaveBeenCalled();
      expect(o.syncLabels).not.toHaveBeenCalled();
      expect(o.dispatch).not.toHaveBeenCalled();
    });

  it('preserves policy-clear carry across a valid sequential re-stamp chain', () => {
    const o = carryOptions(), raw = o.rawPrs[0], intermediate = 'c'.repeat(40);
    raw.comments.splice(2, 0,
      trusted(`📌 review — acceptance re-stamped after a rebase (no new review)\n<!-- reviewed-sha: ${intermediate} -->\n<!-- numbering-restamp: from=${old} to=${intermediate} -->`),
      trusted(`${redTeamMarker(pr, intermediate)}\nRed team not required on this head: card-only diff`));
    raw.comments.at(-1).body = raw.comments.at(-1).body.replace(`from=${old}`, `from=${intermediate}`);
    expect(numbering.strandedNumberingRecords(raw.comments, raw.reviews)).toEqual([]);
    runGhSync.mockClear();
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'carry', from: intermediate });
    expect(runGhSync).toHaveBeenCalledOnce();
    expect(o.syncLabels).toHaveBeenCalledOnce();
    expect(o.dispatch).not.toHaveBeenCalled();
  });

  const publicationOptions = kind => {
    const o = kind === 'carry' ? carryOptions() : runFixture({
      readEvidence: () => ({ loopPayload: payload(), recorded: false, seatRecorded: false,
        status: kind === 'finished/not-owed' ? { status: 'finished', result: 'not-owed' } : null }),
      readStatus: () => kind === 'finished/not-owed' ? { status: 'finished', result: 'not-owed' } : null,
    });
    if (kind !== 'carry') {
      o.rawPrs[0].labels = ['review:accepted'];
      o.rawPrs[0].comments = [trusted(`✅ review — accepted\n<!-- reviewed-sha: ${head} -->`)];
    }
    o.settle = vi.fn(() => ({ outcome: 'policy-clear' }));
    return o;
  };
  describe.each(['carry', 'finished/not-owed'])('%s acceptance evidence audit', kind => {
    function options() {
      const o = publicationOptions(kind);
      o.rawPrs[0].reviews = [];
      for (const comment of o.rawPrs[0].comments) comment.createdAt = '2026-10-09T14:00:00Z';
      return o;
    }
    function expectSkip(o, why) {
      runGhSync.mockClear();
      expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', ...(why ? { why } : {}) });
      expect(runGhSync).not.toHaveBeenCalled();
      expect(o.settle).not.toHaveBeenCalled();
      expect(o.syncLabels).not.toHaveBeenCalled();
      expect(o.dispatch).not.toHaveBeenCalled();
    }
    it('publishes with readable reviews and established acceptance on the live head', () => {
      const o = options();
      expect(runRedTeamOnSkip(o).rows[0].action).toBe(kind === 'carry' ? 'carry' : 'clear');
    });
    it('refuses a formal CHANGES_REQUESTED review after acceptance', () => {
      const o = options();
      o.rawPrs[0].reviews = [{ state: 'CHANGES_REQUESTED', submittedAt: '2026-10-09T15:00:00Z',
        author: { login: 'reviewer' } }];
      expectSkip(o);
    });
    it.each([undefined, null, {}])('refuses unreadable formal reviews %j for operator inspection', reviews => {
      const o = options(); o.rawPrs[0].reviews = reviews;
      o.readReviews = vi.fn(() => reviews);
      expectSkip(o, 'PR reviews unreadable; inspect formal reviews before policy-clear');
      expect(o.readReviews).toHaveBeenCalledWith({ repo, pr });
    });
    if (kind !== 'carry') {
      it.each(['missing', 'untrusted', 'wrong-head'])('refuses %s acceptance evidence', evidence => {
        const o = options();
        if (evidence === 'missing') o.rawPrs[0].comments = [];
        if (evidence === 'untrusted') o.rawPrs[0].comments[0].author.login = 'stranger';
        if (evidence === 'wrong-head') o.rawPrs[0].comments[0].body = o.rawPrs[0].comments[0].body.replace(head, old);
        expectSkip(o, 'stored review does not owe a red team');
      });
    }
  });
  describe.each(['carry', 'finished/not-owed'])('%s publication guard', kind => {
    it.each(['Please hold this acceptance', 'manifest baseline mismatch', '🔁 review — changes requested'])(
      'refuses a later hold comment after acceptance: %s', body => {
        const o = publicationOptions(kind);
        o.rawPrs[0].comments.push(trusted(body));
        runGhSync.mockClear();
        expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip',
          why: 'later verdict or hold supersedes acceptance' });
        expect(runGhSync).not.toHaveBeenCalled();
        expect(o.settle).not.toHaveBeenCalled();
        expect(o.syncLabels).not.toHaveBeenCalled();
        expect(o.dispatch).not.toHaveBeenCalled();
      });
    it('finished not-owed clears despite the stale red-team:pending status label (D-R338)', () => {
      const o = publicationOptions(kind);
      o.rawPrs[0].labels.push('red-team:pending');
      expect(runRedTeamOnSkip(o).rows[0].action).toBe(kind === 'carry' ? 'skip' : 'clear');
    });
    it.each(['red-team:blocked', 'red-team:pending', 'review:changes', 'review:human', 'review:pending',
      'review:held-mechanical', 'review:awaiting-advisory', 'review:prep', 'review:future-hold',
      'review-status:pending', 'review-status:future-hold']
      .flatMap(label => [label, { name: label }]))('refuses a conflicting label %j', label => {
      // The stale pending status of a finished not-owed head is the state being settled, not a hold (D-R338).
      if (kind === 'finished/not-owed' && (label === 'red-team:pending' || label?.name === 'red-team:pending')) return;
      const o = publicationOptions(kind);
      o.rawPrs[0].labels.push(label);
      runGhSync.mockClear();
      expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip',
        why: 'conflicting label prevents policy-clear' });
      expect(runGhSync).not.toHaveBeenCalled();
      expect(o.settle).not.toHaveBeenCalled();
      expect(o.syncLabels).not.toHaveBeenCalled();
      expect(o.dispatch).not.toHaveBeenCalled();
    });
  });
  it.each(['fresh', 'resume'].flatMap(mode => [
    ...['red-team:blocked', 'red-team:pending', 'review:changes', 'review:human', 'review:pending']
      .flatMap(label => [label, { name: label }]).map(label => ({ mode, label })),
    ...['Please hold this acceptance', 'manifest baseline mismatch', '🔁 review — changes requested']
      .map(body => ({ mode, body })),
  ]))('publication guard preserves the complete $mode dispatch plan with $label / $body', ({ mode, label, body }) => {
    const o = publicationOptions('null-status');
    const completed = mode === 'resume';
    const input = fixture({ rawPrs: o.rawPrs,
      readEvidence: () => ({ loopPayload: payload(), recorded: completed,
        seatRecorded: completed, completedRecorded: completed }),
      readStatus: () => completed ? { status: 'finished', result: 'ran' } : null,
    });
    const expected = planRedTeamOnSkip(input);
    expect(expected).toEqual([{ prNumber: pr, head, action: 'dispatch', mode,
      why: completed ? 'recorded pass needs its result comment/effects' : 'head never had a red-team pass' }]);
    if (label) input.rawPrs[0].labels.push(label);
    if (body) input.rawPrs[0].comments.push(trusted(body));
    expect(planRedTeamOnSkip(input)).toEqual(expected);
  });
  it.each(['untrusted', 'extra-prose', 'malformed-marker'])(
    'source policy-clear remains a possible hold with %s', kind => {
      const comments = carryOptions().rawPrs[0].comments.slice(0, 2);
      if (kind === 'untrusted') comments[1].author.login = 'stranger';
      if (kind === 'extra-prose') comments[1].body += '\nPlease hold this acceptance';
      if (kind === 'malformed-marker') comments[1].body = comments[1].body.replace(old, 'bad');
      expect(latestAcceptRecord(comments).laterVerdict).toBe(true);
    });
  it.each(['status', 'recorded', 'seatRecorded', 'completedRecorded', 'blocked-label', 'withheld'])(
    'refuses policy carry with live-head %s evidence', kind => {
      const o = carryOptions();
      if (kind === 'status' || kind === 'withheld') o.readStatus = () => ({ status: 'finished',
        result: kind === 'withheld' ? { status: 'ran', comment: 'withheld' } : 'error' });
      else if (kind === 'blocked-label') o.rawPrs[0].labels.push('red-team:blocked');
      else o.readEvidence = () => ({ inFlight: false, [kind]: true });
      expect(runRedTeamOnSkip(o).rows[0].action).not.toBe('carry');
      expect(o.syncLabels).not.toHaveBeenCalled();
    });
  it.each(['Please hold this acceptance', 'manifest baseline mismatch'])(
    'refuses policy carry after a later hold: %s', body => {
      const o = carryOptions();
      o.rawPrs[0].comments.push(trusted(body));
      expect(runRedTeamOnSkip(o).rows[0].action).not.toBe('carry');
      expect(o.syncLabels).not.toHaveBeenCalled();
    });
  it.each(['Please hold this acceptance', 'manifest baseline mismatch', '🔁 review — changes requested'])(
    'refuses policy carry when the source acceptance was held before re-stamp: %s', body => {
      const o = carryOptions();
      o.rawPrs[0].comments.splice(2, 0, trusted(body));
      runGhSync.mockClear();
      expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
      expect(runGhSync).not.toHaveBeenCalled();
      expect(o.syncLabels).not.toHaveBeenCalled();
    });
  it.each([null, 'finished'].flatMap(status =>
    ['changes', 'needs-human', undefined].flatMap(verdict =>
      [undefined, 'red-team:blocked', 'red-team:pending', 'review:changes', 'review:human', 'review:pending']
        .map(label => [status, verdict, label]))))(
    'refuses stored clear with status %s, verdict %s, label %s', (status, verdict, label) => {
      const o = runFixture({
        readEvidence: () => ({ loopPayload: { verdict: { verdict }, findings: { read: { netBasis: { rev: head } } } },
          recorded: false, seatRecorded: false, status: status && ({ status, result: 'not-owed' }) }),
        readStatus: () => status && ({ status, result: 'not-owed' }),
      });
      o.rawPrs[0].labels = ['review:accepted', ...(label ? [{ name: label }] : [])];
      runGhSync.mockClear();
      expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
      expect(runGhSync).not.toHaveBeenCalled();
      expect(o.syncLabels).not.toHaveBeenCalled();
      expect(o.dispatch).not.toHaveBeenCalled();
    });
  it.each(['red-team:blocked', 'review:changes', 'review:human', 'review:pending'])(
    'refuses clear of an accepting finished/not-owed review carrying %s', label => {
      const o = runFixture({ readEvidence: () => ({ loopPayload: payload(), recorded: false, seatRecorded: false,
        status: { status: 'finished', result: 'not-owed' } }),
        readStatus: () => ({ status: 'finished', result: 'not-owed' }) });
      o.rawPrs[0].labels = ['review:accepted', label];
      // Keep a real accepted head so this fixture exercises the label guard.
      o.rawPrs[0].comments = [trusted(`✅ review — accepted\n<!-- reviewed-sha: ${head} -->`)];
      expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
      expect(o.syncLabels).not.toHaveBeenCalled();
    });
  it('clears an accepting finished/not-owed review whose stale status label is red-team:pending (D-R338)', () => {
    const o = runFixture({ readEvidence: () => ({ loopPayload: payload(), recorded: false, seatRecorded: false,
      status: { status: 'finished', result: 'not-owed' } }),
      readStatus: () => ({ status: 'finished', result: 'not-owed' }) });
    o.rawPrs[0].labels = ['review:accepted', 'red-team:pending'];
    o.rawPrs[0].comments = [trusted(`✅ review — accepted\n<!-- reviewed-sha: ${head} -->`)];
    expect(runRedTeamOnSkip(o).rows[0].action).toBe('clear');
  });
  it('keeps an accepting review with null status owed rather than clearing it', () => {
    const o = runFixture();
    o.rawPrs[0].labels = ['review:accepted'];
    expect(runRedTeamOnSkip(o).rows[0].action).toBe('dispatch');
    expect(o.syncLabels).not.toHaveBeenCalled();
  });
  it('carries prior policy-clear across trusted acceptance re-stamp once and syncs labels', () => {
    const o = carryOptions();
    runGhSync.mockImplementation((_args, options) => o.rawPrs[0].comments.push(trusted(options.input)));
    try {
      expect(runRedTeamOnSkip(o).rows[0].action).toBe('carry');
      expect(o.rawPrs[0].comments.at(-1).body).toContain(`${redTeamMarker(pr, head)}\nRed team not required on this head: prior policy-clear carried from ${old.slice(0, 8)} across a content-preserving rebase (acceptance re-stamped)`);
      expect(o.syncLabels).toHaveBeenCalledOnce();
      expect(runRedTeamOnSkip(o).rows[0].why).toBe('red-team result already on head');
      expect(o.syncLabels).toHaveBeenCalledOnce();
    } finally { runGhSync.mockReset(); }
  });
  it.each(['missing', 'untrusted', 'wrong-head', 'blocked', 'ran', 'unaccepted', 'inFlight', 'queued', 'unknown-evidence', 'old-untrusted', 'ran-with-policy-quote', 'superseded-clear', 'missing-source', 'untrusted-source', 'mismatched-source', 'late-source-result'])(
    'refuses carry for %s', kind => {
      const o = carryOptions(), comments = o.rawPrs[0].comments;
      if (kind === 'missing') comments.pop();
      if (kind === 'untrusted') comments[2].author.login = 'stranger';
      if (kind === 'wrong-head') comments[2].body = comments[2].body.replace(head, old);
      if (['blocked', 'ran'].includes(kind)) comments[1].body = `${redTeamMarker(pr, old)}\nRed team ${kind}`;
      if (kind === 'old-untrusted') comments[1].author.login = 'stranger';
      if (kind === 'ran-with-policy-quote') comments[1].body += '\nRed team ran';
      if (kind === 'superseded-clear') comments.splice(2, 0, trusted(`${redTeamMarker(pr, old)}\nRed team ran`));
      if (kind === 'late-source-result') comments.push(trusted(`${redTeamMarker(pr, old)}\nRed team ran`));
      if (kind === 'missing-source') comments.shift();
      if (kind === 'untrusted-source') comments[0].author.login = 'stranger';
      if (kind === 'mismatched-source') comments[0].body = comments[0].body.replace(old, 'c'.repeat(40));
      if (kind === 'unknown-evidence') o.readEvidence = () => null;
      if (kind === 'unaccepted') o.rawPrs[0].labels = [];
      if (['inFlight', 'queued'].includes(kind)) o.readEvidence = () => ({ [kind]: true });
      expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
      expect(o.syncLabels).not.toHaveBeenCalled();
    });
  it('selects acceptance A in an A then B history for a declared A-to-C carry, retaining the later verdict', () => {
    const o = carryOptions(), newer = 'c'.repeat(40);
    const comments = o.rawPrs[0].comments;
    comments.splice(1, 0, trusted(`✅ review — accepted\n<!-- reviewed-sha: ${newer} -->`));
    const source = latestAcceptRecord(comments.slice(0, -1), [], { sha: old });
    expect(source).toMatchObject({ sha: old, index: 0, laterVerdict: true });
    // B supersedes A: selecting A must not discard B or publish B's clearance as A-to-C.
    runGhSync.mockClear();
    expect(runRedTeamOnSkip(o).rows[0].action).not.toBe('carry');
    expect(runGhSync).not.toHaveBeenCalled();
    expect(o.syncLabels).not.toHaveBeenCalled();
  });
  it.each(['missing', 'untrusted'])(
    'falls back to the normal red-team run when the declared from acceptance is %s', kind => {
      const o = carryOptions(), missing = 'd'.repeat(40);
      const comments = o.rawPrs[0].comments;
      if (kind === 'missing') comments.at(-1).body = comments.at(-1).body.replace(`from=${old}`, `from=${missing}`);
      else comments[0].author.login = 'stranger';
      o.readEvidence = () => ({ loopPayload: payload(), inFlight: false, recorded: false });
      expect(latestAcceptRecord(comments.slice(0, -1), [], { sha: kind === 'missing' ? missing : old })).toBeNull();
      runGhSync.mockClear();
      expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'dispatch', mode: 'fresh' });
      expect(runGhSync).not.toHaveBeenCalled();
      expect(o.syncLabels).not.toHaveBeenCalled();
    });
  it.each(['matching', 'mismatching', 'missing', 'wrong-target', 'malformed'])(
    'binds B policy-clear to the declared source in an A/B/C history: %s', provenance => {
      const o = carryOptions(), newer = 'c'.repeat(40);
      const comments = o.rawPrs[0].comments;
      comments.splice(1, 1,
        trusted(`✅ review — accepted\n<!-- reviewed-sha: ${newer} -->`),
        trusted(`${redTeamMarker(pr, newer)}\nRed team not required on this head: card-only diff`));
      const marker = `<!-- numbering-restamp: from=${old} to=${head} -->`;
      const replacement = provenance === 'matching' ? `<!-- numbering-restamp: from=${newer} to=${head} -->`
        : provenance === 'missing' ? ''
          : provenance === 'wrong-target' ? `<!-- numbering-restamp: from=${newer} to=${old} -->`
            : provenance === 'malformed' ? `<!-- numbering-restamp: from=unknown to=${head} -->` : marker;
      comments.at(-1).body = comments.at(-1).body.replace(marker, replacement);
      runGhSync.mockClear();
      const row = runRedTeamOnSkip(o).rows[0];
      if (provenance === 'matching') {
        expect(row).toMatchObject({ action: 'carry', from: newer });
        expect(runGhSync).toHaveBeenCalledOnce();
        expect(o.syncLabels).toHaveBeenCalledOnce();
      } else {
        expect(row.action).not.toBe('carry');
        expect(runGhSync).not.toHaveBeenCalled();
        expect(o.syncLabels).not.toHaveBeenCalled();
      }
    });
  it.each([true, false])('refuses ancient policy-clear when a newer blocked revision precedes the live-head re-stamp (source accepted: %s)', acceptedSource => {
    const o = carryOptions(), source = 'c'.repeat(40);
    o.rawPrs[0].comments.splice(2, 0,
      ...(acceptedSource ? [trusted(`✅ review — accepted\n<!-- reviewed-sha: ${source} -->`)] : []),
      trusted(`${redTeamMarker(pr, source)}\nRed team blocked`));
    runGhSync.mockClear();
    expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
    expect(runGhSync).not.toHaveBeenCalled();
    expect(o.syncLabels).not.toHaveBeenCalled();
  });
  it('refuses carry when a trusted blocked result on another revision arrives after the live-head re-stamp', () => {
    const o = carryOptions();
    o.rawPrs[0].comments.push(trusted(`${redTeamMarker(pr, 'c'.repeat(40))}\nRed team blocked`));
    runGhSync.mockClear();
    expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
    expect(runGhSync).not.toHaveBeenCalled();
    expect(o.syncLabels).not.toHaveBeenCalled();
  });
  // A late result read through the shared record split: one carried inside a verdict-carry comment is as late as a
  // direct one, so it supersedes the proposed source clear too (PR 6606 self-review, same class as the finding).
  it.each([['after', 3], ['before', 2]])('refuses carry when a trusted CARRIED result on another revision arrives %s the live-head re-stamp', (_, at) => {
    const o = carryOptions(), other = 'c'.repeat(40);
    o.rawPrs[0].comments.splice(at, 0, trusted([
      `<!-- review-verdict-carried from=${'e'.repeat(40)} to=${other} patch-id=${'f'.repeat(40)} -->`,
      'Review verdict carried across an identical contribution.', redTeamMarker(pr, other),
      '1. [**confirmed**] (edge-case, broken) `x.mjs:1` — carried break'].join('\n')));
    runGhSync.mockClear();
    expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
    expect(runGhSync).not.toHaveBeenCalled();
    expect(o.syncLabels).not.toHaveBeenCalled();
  });
  // The writer's exact non-blocking carry (a clean advisory re-keyed to the carried-to head) is no acceptance hold, so
  // only the late-result check sees it; it must read the same record split, like a direct clean late result.
  it.each([['after', 3], ['before', 2]])('refuses carry when a trusted clean CARRIED result on another revision arrives %s the live-head re-stamp', (_, at) => {
    const o = carryOptions(), other = 'c'.repeat(40), from = 'e'.repeat(40);
    const advisory = renderRedTeamComment({ pr, rev: from, provider: 'codex', model: 'm', findings: [], foldedVerdict: 'accept' })
      .replace(redTeamMarker(pr, from), redTeamMarker(pr, other));
    o.rawPrs[0].comments.splice(at, 0, trusted([
      `<!-- review-verdict-carried from=${from} to=${other} patch-id=${'f'.repeat(40)} -->`,
      'Review verdict carried across an identical contribution.', advisory].join('\n')));
    expect(redTeamForHead(o.rawPrs[0].comments, pr, other)?.findings).toEqual([]);
    runGhSync.mockClear();
    expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
    expect(runGhSync).not.toHaveBeenCalled();
    expect(o.syncLabels).not.toHaveBeenCalled();
  });
  it.each(['untrusted', 'other-pr'])('refuses carry when a late %s result supersedes acceptance under latestAcceptRecord', kind => {
    const o = carryOptions();
    const late = trusted(`${redTeamMarker(kind === 'other-pr' ? pr + 1 : pr, 'c'.repeat(40))}\nRed team blocked`);
    if (kind === 'untrusted') late.author.login = 'stranger';
    o.rawPrs[0].comments.push(late);
    runGhSync.mockImplementation(() => {});
    try {
      expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
      expect(runGhSync).not.toHaveBeenCalled();
      expect(o.syncLabels).not.toHaveBeenCalled();
    } finally { runGhSync.mockReset(); }
  });
  it.each(['not-owed', { status: 'not-owed' }])('finished %j clears accepted matching stored review and syncs', result => {
    const o = runFixture({ readEvidence: () => ({ loopPayload: payload(), seatRecorded: false, recorded: false,
      status: { status: 'finished', result } }),
      readStatus: () => ({ status: 'finished', result }) });
    o.rawPrs[0].labels = ['review:accepted'];
    // This R100 clear-success fixture previously lacked the accept comment establishing the accepted head.
    o.rawPrs[0].comments = [trusted(`✅ review — accepted\n<!-- reviewed-sha: ${head} -->`)];
    runGhSync.mockImplementation((_args, options) => o.rawPrs[0].comments.push(trusted(options.input)));
    try {
      expect(runRedTeamOnSkip(o).rows[0].action).toBe('clear');
      expect(redTeamForHead(o.rawPrs[0].comments, pr, head)).toMatchObject({ pr, rev: head });
      expect(o.syncLabels).toHaveBeenCalledOnce();
    } finally { runGhSync.mockReset(); }
  });
  it.each(['unaccepted', 'seat-recorded', 'running', 'queued'])('finished not-owed refuses %s evidence', kind => {
    const evidence = { loopPayload: payload(), seatRecorded: false, recorded: false,
      status: { status: ['running', 'queued'].includes(kind) ? kind : 'finished', result: 'not-owed' } };
    const o = runFixture({ readEvidence: () => evidence,
      readStatus: () => ({ status: ['running', 'queued'].includes(kind) ? kind : 'finished', result: 'not-owed' }) });
    o.rawPrs[0].labels = kind === 'unaccepted' ? [] : ['review:accepted'];
    if (kind === 'seat-recorded') evidence.seatRecorded = true;
    expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
    expect(o.syncLabels).not.toHaveBeenCalled();
  });
  it.each([
    { status: 'queued', result: null },
    { status: 'running', result: null },
    { status: 'finished', result: 'error' },
    { status: 'finished', result: { status: 'not-owed', deferredByGuard: true } },
    { status: 'finished', result: { status: 'not-owed', deferredByCap: true } },
    null,
  ].flatMap(status => ['selected', 'live'].map(source => [source, status])))(
    'refuses clear when the %s status disagrees with not-owed: %j', (source, status) => {
      const o = publicationOptions('finished/not-owed');
      if (source === 'live') o.readStatus = () => status;
      else {
        const evidence = o.readEvidence();
        o.readEvidence = () => ({ ...evidence, status });
      }
      runRedTeamOnSkip(o);
      expect(o.settle).not.toHaveBeenCalled();
      expect(o.syncLabels).not.toHaveBeenCalled();
    });
  it.each(['error', 'skipped', 'ran', { status: 'not-owed', deferredByGuard: true }, { status: 'not-owed', deferredByCap: true }])('non-policy or deferred %j never clears an accepting stored review', result => {
    const o = runFixture({ readEvidence: () => ({ loopPayload: payload(), seatRecorded: false,
      status: { status: 'finished', result } }),
      readStatus: () => ({ status: 'finished', result }) });
    o.rawPrs[0].labels = ['review:accepted'];
    expect(runRedTeamOnSkip(o).rows[0].action).toBe(result === 'ran' ? 'dispatch' : 'skip');
    expect(o.syncLabels).not.toHaveBeenCalled();
  });
  it.each([1, 2, 3])('ran with %i failed seats permits only one bounded fresh retry', failedSeatCount => {
    const o = runFixture({ readEvidence: () => ({ loopPayload: payload(), recorded: true, seatRecorded: true, completedRecorded: false, failedSeatCount }),
      readStatus: () => ({ status: 'finished', result: 'ran' }) });
    const row = runRedTeamOnSkip(o).rows[0];
    expect(row).toMatchObject(failedSeatCount === 1 ? { action: 'dispatch', mode: 'fresh' }
      : { action: 'skip', why: 'prior result ran (status finished); not re-run' });
    expect(o.syncLabels).not.toHaveBeenCalled();
    if (failedSeatCount === 1) expect(runRedTeamOnSkip(o).rows[0].why).toBe('retry cooldown active');
  });
  it.each([1, 2].flatMap(retryCount => [0, 1, 2].flatMap(failedSeatCount =>
    ['ran', { status: 'ran' }, 'resumed', { status: 'resumed' }].map(result => ({ retryCount, failedSeatCount, result })))))(
    'spent retry refuses fresh dispatch with $failedSeatCount seat rows, count=$retryCount, result=$result', ({ retryCount, failedSeatCount, result }) => {
      const o = runFixture({
        readEvidence: () => ({ loopPayload: payload(), inFlight: false, queued: false,
          recorded: failedSeatCount > 0, seatRecorded: failedSeatCount > 0, completedRecorded: false, failedSeatCount }),
        readStatus: () => ({ status: 'finished', result, retryCount }),
      });
      o.rawPrs[0].labels = ['review:accepted'];
      o.rawPrs[0].comments = [trusted(`✅ review — accepted\n<!-- reviewed-sha: ${head} -->`)];
      expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
      expect(o.dispatch).not.toHaveBeenCalled();
      expect(o.syncLabels).not.toHaveBeenCalled();
    });
  it.each([undefined, 0, 1, 2])('ran with completed seat retains effects-only resume with retryCount=%s', retryCount => {
    expect(decide({ readEvidence: () => ({ loopPayload: payload(), recorded: true, completedRecorded: true, failedSeatCount: 1 }),
      readStatus: () => ({ status: 'finished', result: 'ran', retryCount }) })).toMatchObject({ action: 'dispatch', mode: 'resume' });
  });
});


describe('unprovable accepted head move — fresh full review', () => {
  const old = 'b'.repeat(40);
  function moved(over = {}) {
    const loopPayload = payload();
    loopPayload.findings.read.netBasis.rev = old;
    return runFixture({
      rawPrs: [{ number: pr, headRefOid: head, labels: ['review:accepted'], reviews: [], comments: [
        { body: `✅ review — accepted\n<!-- reviewed-sha: ${old} -->`, author: { login: 'web-everything' } },
        { body: `${redTeamMarker(pr, old)}\nRed team not required on this head: card-only diff`, author: { login: 'web-everything' } },
      ] }],
      // Old review/red-team file survives a merge commit with no trusted re-stamp.
      readEvidence: () => ({ loopPayload, inFlight: false, queued: false, recorded: false, seatRecorded: false }),
      proveMove: vi.fn(() => ({ ok: false, reason: 'merge commit' })),
      log: vi.fn(), settle: vi.fn(), ...over,
    });
  }
  it.each(['old', 'absent', 'no-prior-clear'])('dispatches one full review with %s payload, then observes per-head cooldown', kind => {
    const o = moved();
    if (kind === 'no-prior-clear') o.rawPrs[0].comments.pop();
    if (kind === 'absent') o.readEvidence = () => ({ inFlight: false, recorded: false, seatRecorded: false });
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'review', head });
    expect(o.dispatch).toHaveBeenCalledTimes(1); expect(o.dispatch).toHaveBeenCalledWith({ pr, repo });
    expect(o.settle).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled();
    expect(o.log).toHaveBeenCalledWith(`review-daemon: ${repo}#${pr} already-reviewed-head — fresh review dispatched for unprovable head move ${head.slice(0, 12)}`);
    o.capacity = { lanes: 1, budget: { left: 1 } };
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: 'retry cooldown active' });
    expect(o.dispatch).toHaveBeenCalledTimes(1);
  });
  it('refuses a standing formal CHANGES_REQUESTED without an acceptance comment or live-head evidence', () => {
    const o = moved({ readEvidence: () => ({ inFlight: false, recorded: false, seatRecorded: false }) });
    o.rawPrs[0].comments = [];
    o.rawPrs[0].reviews = [{ state: 'CHANGES_REQUESTED', submittedAt: '2026-10-01T00:00:00Z',
      author: { login: 'reviewer' } }];
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip',
      why: 'formal review hold prevents full review; inspect formal reviews' });
    expect(o.dispatch).not.toHaveBeenCalled();
    expect(o.lastDispatch.size).toBe(0);
  });
  it.each([undefined, null, {}])('refuses unreadable formal reviews %j without an acceptance comment or live-head evidence', reviews => {
    const o = moved({ readEvidence: () => ({ inFlight: false, recorded: false, seatRecorded: false }) });
    o.rawPrs[0].comments = [];
    o.rawPrs[0].reviews = reviews;
    o.readReviews = vi.fn(() => reviews);
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip',
      why: 'PR reviews unreadable; inspect formal reviews before full review' });
    expect(o.readReviews).toHaveBeenCalledWith({ repo, pr });
    expect(o.dispatch).not.toHaveBeenCalled();
    expect(o.lastDispatch.size).toBe(0);
  });
  it('allows readable empty formal reviews without an acceptance comment or live-head evidence', () => {
    const o = moved({ readEvidence: () => ({ inFlight: false, recorded: false, seatRecorded: false }) });
    o.rawPrs[0].comments = [];
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'review', head });
    expect(o.dispatch).toHaveBeenCalledWith({ pr, repo });
  });
  it.each([
    '🔁 review — changes requested\n\nFix the guard.',
    '🔁 human review — changes requested\n\nFix the guard.',
    '🔁 review - changes requested\n\nFix the guard.',
    '🛑 conveyor fix — stood down (needs-judgment)',
  ])('refuses an explicit comment hold without an acceptance comment: %j', body => {
    const o = moved({ readEvidence: () => ({ inFlight: false, recorded: false, seatRecorded: false }) });
    o.rawPrs[0].comments = [{ body, author: { login: 'chalbert' } }];
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip',
      why: 'explicit review hold comment prevents full review; inspect the PR thread' });
    expect(o.dispatch).not.toHaveBeenCalled();
    expect(o.lastDispatch.size).toBe(0);
  });
  it.each(['review:human', 'review:held-mechanical', 'review-status:reviewing', 'red-team:blocked'])(
    'does not re-review a held PR with %s', label => {
      const o = moved(); o.rawPrs[0].labels.push(label);
      expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
      expect(o.dispatch).not.toHaveBeenCalled();
    });
  // R640: operator-accepted change, class correctness-in-normal-use.
  it('R640 (operator ruling): a lone red-team:pending does not block the full review', () => {
    const o = moved(); o.rawPrs[0].labels.push('red-team:pending');
    expect(runRedTeamOnSkip(o).rows[0].action).toBe('review');
    expect(o.dispatch).toHaveBeenCalledWith({ pr, repo });
    expect(o.rawPrs[0].labels).toContain('red-team:pending');
  });
  it.each(['inFlight', 'queued', 'recorded', 'seatRecorded', 'completedRecorded', 'status', 'unknown'])(
    'fails closed with live-head %s evidence', kind => {
      const o = moved(), evidence = o.readEvidence();
      if (kind === 'status') o.readStatus = () => ({ head, status: 'finished', result: 'error' });
      else if (kind === 'unknown') o.readEvidence = () => null;
      else o.readEvidence = () => ({ ...evidence, [kind]: true });
      expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
      expect(o.dispatch).not.toHaveBeenCalled();
    });
  it.each([{ lanes: 0 }, { lanes: 1, budget: { left: 0 } }, { lanes: 1, remainingStarts: 0 }])(
    'shares dispatch capacity checks %j', capacity => {
      const o = moved({ capacity });
      expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: 'no review capacity left' });
      expect(o.dispatch).not.toHaveBeenCalled(); expect(o.lastDispatch.size).toBe(0);
    });
  it('dry run spends no capacity, cooldown, or publication effects', () => {
    const o = moved({ dryRun: true });
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: 'dry run (review)' });
    expect(o.capacity).toEqual({ lanes: 1, budget: { left: 1 } });
    expect(o.lastDispatch.size).toBe(0); expect(o.dispatch).not.toHaveBeenCalled();
    expect(o.settle).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled();
  });
  it.each(['result', 'invalid-head', 'unaccepted', 'unknown-stored-head', 'unreadable-status'])(
    'does not start a full review with %s', kind => {
      const o = moved();
      if (kind === 'result') o.rawPrs[0].comments.push({ body: `${redTeamMarker(pr, head)}\nRed team not required on this head: card-only diff`, author: { login: 'web-everything' } });
      if (kind === 'invalid-head') o.rawPrs[0].headRefOid = 'unknown';
      if (kind === 'unaccepted') o.rawPrs[0].labels = [];
      if (kind === 'unknown-stored-head') {
        const evidence = o.readEvidence(); delete evidence.loopPayload.findings.read.netBasis.rev;
        o.readEvidence = () => evidence;
      }
      if (kind === 'unreadable-status') o.readStatus = () => { throw Error('unreadable'); };
      expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
      expect(o.dispatch).not.toHaveBeenCalled();
    });
  it('keeps the red-team-only dispatch for an owed stored payload at the live head', () => {
    const o = moved({ readEvidence: () => ({ loopPayload: payload(), inFlight: false, recorded: false, seatRecorded: false }) });
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'dispatch', mode: 'fresh' });
    expect(o.dispatch).toHaveBeenCalledTimes(1); expect(o.dispatch).toHaveBeenCalledWith({ pr, repo, redTeamOnly: true, redTeamMode: 'fresh' });
  });
});


describe('R756 independent backlog-only pass', () => {
  function backlogOptions(over = {}) {
    return { repo, rawPrs: [{ number: pr, headRefOid: head,
      labels: ['ready-to-merge', 'review:prep', 'red-team:pending'],
      netFiles: { ok: true, files: ['backlog/742.md'] }, comments: [] }],
      plan: { refusals: [] }, setting: { enabled: false }, syncLabels: vi.fn(),
      env: { WE_RED_TEAM_SKIP_BACKLOG_ONLY_PREP: '1' }, ...over };
  }
  it('settles without prep comments even when on-skip is disabled; own setting off preserves behavior', () => {
    const options = backlogOptions(); vi.mocked(runGhSync).mockClear();
    expect(runRedTeamOnSkip(options).rows).toMatchObject([{ action: 'clear', rule: 'backlog-only' }]);
    expect(runGhSync).toHaveBeenCalledWith(expect.arrayContaining(['comment']), expect.objectContaining({
      input: `${redTeamMarker(pr, head)}\n\nRed team not required on this head: backlog-only`,
    }));
    expect(options.syncLabels).toHaveBeenCalledTimes(1);
    vi.mocked(runGhSync).mockClear(); options.syncLabels.mockClear();
    expect(runRedTeamOnSkip({ ...options, env: { WE_RED_TEAM_SKIP_BACKLOG_ONLY_PREP: '0' } }).rows).toEqual([]);
    expect(runGhSync).not.toHaveBeenCalled(); expect(options.syncLabels).not.toHaveBeenCalled();
  });
  it('passes the pinned identity to an injected net reader', () => {
    const readHeadFiles = vi.fn(() => ({ ok: true, files: ['backlog/742.md'] }));
    const options = backlogOptions({ readHeadFiles });
    expect(runRedTeamOnSkip(options).rows[0].action).toBe('clear');
    expect(readHeadFiles).toHaveBeenCalledWith({ repo, number: pr, headRefOid: head });
  });
  it('holds a rename from outside backlog reported by the net reader', () => {
    const options = backlogOptions({ readHeadFiles: () => ({ ok: true, files: ['src/old', 'backlog/new'] }) });
    vi.mocked(runGhSync).mockClear();
    expect(runRedTeamOnSkip(options).rows[0].action).toBe('skip');
    expect(runGhSync).not.toHaveBeenCalled(); expect(options.syncLabels).not.toHaveBeenCalled();
  });
  it('never falls back to GitHub files when the net read is unavailable', () => {
    const options = backlogOptions();
    delete options.rawPrs[0].netFiles;
    options.rawPrs[0].files = [{ filename: 'backlog/a', status: 'modified' }];
    vi.mocked(runGhSync).mockClear();
    expect(runRedTeamOnSkip(options).rows[0].action).toBe('skip');
    expect(runGhSync).not.toHaveBeenCalled(); expect(options.syncLabels).not.toHaveBeenCalled();
  });
});

// #6606 red team: a transient verification failure made the carried-check publisher supersede its own success, and
// recovery then skipped the head for good because the carried result was on it. The outbox marker keeps the head owed
// until a re-validation confirms the check; the recovery pass retries it from live evidence.
describe('#6606 carried check recovered after a transient verification failure', () => {
  const APP = 5037855;
  const carry = () => ({ author: { login: 'web-everything', type: 'Bot' }, created_at: '2026-11-07T12:00:00Z', body: [
    `<!-- review-verdict-carried from=${'b'.repeat(40)} to=${head} patch-id=${'c'.repeat(40)} -->`,
    'Review verdict carried across an identical contribution.',
    renderRedTeamComment({ pr, rev: head, provider: 'codex', model: 'm', findings: [], recheckStatus: 'not-needed', foldedVerdict: 'accept' }),
  ].join('\n') });
  function world({ failReadAt = 2, failCheckPosts = new Set(), statusReadError = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'carried-check-'));
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs'), WE_RED_TEAM_CHECK_LOCK_DIR: join(dir, 'locks') };
    const checkRuns = [], extraRuns = [], statuses = [];
    let nextId = 40, reads = 0, checkPosts = 0, statusId = 1;
    const gh = (args, options) => {
      if (statusReadError && !args.includes('POST') && /\/status(?:es)?\?/.test(args[1])) throw Error('HTTP 502');
      if (args.includes('POST') && args[1].includes('/statuses/')) {
        statuses.unshift({ ...JSON.parse(options.input), id: statusId++, creator: { login: 'web-everything' } });
        return '{}';
      }
      // GitHub pages both reads at 100; the combined summary holds the newest status per context.
      const page = Number(/[?&]page=(\d+)/.exec(args[1])?.[1] ?? 1);
      const paged = list => list.slice((page - 1) * 100, page * 100);
      if (args[1].includes('/statuses?')) return JSON.stringify(paged(statuses));
      if (args[1].includes('/status?')) {
        const latest = [...new Map([...statuses].reverse().map(status => [status.context, status])).values()];
        return JSON.stringify({ total_count: latest.length, statuses: paged(latest) });
      }
      if (args.includes('POST')) {
        if (failCheckPosts.has(++checkPosts)) throw Error('check-runs POST timed out');
        const id = nextId++;
        checkRuns.push({ ...JSON.parse(options.input), id, app: { id: APP }, completed_at: '2026-11-07T13:00:00Z' });
        return JSON.stringify({ id });
      }
      const all = [...checkRuns, ...extraRuns];
      return JSON.stringify({ total_count: all.length, check_runs: all });
    };
    const publish = vi.fn(({ pr: n, headSha }) => publishCarriedCheckDurably({ repo, pr: n, head: headSha, env,
      publish: hooks => publishRedTeamCheckFromLive({ repo, pr: n, headSha, appId: APP, env, gh, ...hooks,
        readLive: () => {
          if (++reads === failReadAt) throw Error('gh pr view timed out');
          return { headRefOid: head, labels: [] };
        },
        readComments: () => [carry()], readStandingRuling: () => null, holdFn: () => null }),
      clearHold: () => clearLivePublicationHold({ repo, pr: n, headSha, gh }) }));
    const owed = () => readCarriedCheckUnpublished({ repo, pr, head, env });
    const fact = () => evaluateRedTeamCheckFact({ repo, pr, headSha: head, appId: APP, checkRuns: [...checkRuns, ...extraRuns] });
    const holdFact = () => readRedTeamPublicationHoldFact({ repo, pr, headSha: head, gh });
    const tick = (over = {}) => runRedTeamOnSkip(runFixture({ env,
      rawPrs: [{ number: pr, headRefOid: head, comments: [carry()], labels: [] }],
      readCarriedCheck: key => readCarriedCheckUnpublished({ ...key, env }), publishCarriedCheck: publish, ...over }));
    return { dir, env, gh, checkRuns, extraRuns, statuses, publish, owed, fact, holdFact, tick };
  }

  it('a retry that succeeds clears the publication hold the failed attempt set (and only that hold)', () => {
    // Attempt 1: success posted, verification read times out, the failure supersede POST also fails → hold set.
    const w = world({ failCheckPosts: new Set([2]) });
    try {
      expect(w.publish({ pr, headSha: head })).toMatchObject({ ok: false, reason: expect.stringMatching(/publication hold posted/) });
      expect(w.holdFact()).toMatchObject({ ok: false });
      expect(w.owed()).toBe(true);
      expect(w.tick().rows[0]).toMatchObject({ why: 'carried red-team check republished from live evidence' });
      expect(w.fact()).toMatchObject({ ok: true });
      expect(w.holdFact()).toMatchObject({ ok: true });
      expect(w.statuses[0]).toMatchObject({ state: 'success', context: `red-team/publication #${pr}` });
      expect(w.owed()).toBe(false);
    } finally { rmSync(w.dir, { recursive: true, force: true }); }
    // A newer hold from a round writer is its owner's: the retry leaves it and the head stays held.
    const v = world({ failCheckPosts: new Set([2]) });
    try {
      v.publish({ pr, headSha: head });
      v.statuses.unshift({ id: 99, state: 'failure', context: `red-team/publication #${pr}`, description: 'held: finished round publication in progress',
        creator: { login: 'web-everything' } });
      expect(v.tick().rows[0]).toMatchObject({ why: 'carried red-team check republished from live evidence' });
      expect(v.statuses[0]).toMatchObject({ id: 99, state: 'failure' });
      expect(v.holdFact()).toMatchObject({ ok: false });
    } finally { rmSync(v.dir, { recursive: true, force: true }); }
    // Third self-review: an OLDER round-writer hold under the helper's own hold must survive too (a trusted success
    // would clear every hold beneath it), so nothing is posted and the gate stays held.
    const u = world({ failCheckPosts: new Set([2]) });
    try {
      u.statuses.push({ id: 0, state: 'failure', context: `red-team/publication #${pr}`, description: 'held: started round not confirmed published',
        creator: { login: 'web-everything' } });
      u.publish({ pr, headSha: head });
      expect(u.statuses.map(status => `${status.id}:${status.state}`)).toEqual(['1:failure', '0:failure']);
      expect(u.tick().rows[0]).toMatchObject({ why: 'carried red-team check republished from live evidence' });
      expect(u.statuses.filter(status => status.state === 'success')).toEqual([]);
      expect(u.holdFact()).toMatchObject({ ok: false });
    } finally { rmSync(u.dir, { recursive: true, force: true }); }
  });

  // Red team on c639d9ba108e, end to end: 100 unrelated statuses and no publication context. The confirmed carry
  // settles (marker gone) on the first attempt instead of keeping its retry marker.
  it('a confirmed carry settles on a head whose status history is full of unrelated contexts', () => {
    const w = world({ failReadAt: 0 });
    try {
      for (let i = 0; i < 100; i++) w.statuses.push({ id: 1000 - i, state: 'success', context: 'ci/build', creator: { login: 'x' } });
      expect(w.publish({ pr, headSha: head })).toMatchObject({ ok: true });
      expect(w.owed()).toBe(false);
      expect(w.checkRuns).toHaveLength(1);
      expect(w.fact()).toMatchObject({ ok: true });
    } finally { rmSync(w.dir, { recursive: true, force: true }); }
  });

  // Same red team, recovery path: the recovery pass retries an unsettled carry once per cooldown with no cap. While the
  // clear keeps failing, each retry reuses the helper's confirmed success instead of posting another, so the head's
  // check history never reaches the 100-run bound the gate refuses at.
  it('retries whose publication-hold clear keeps failing reuse the confirmed success (one check run, not one per retry)', () => {
    const w = world({ failReadAt: 0, statusReadError: true });
    try {
      for (let attempt = 0; attempt < 120; attempt++) {
        expect(w.publish({ pr, headSha: head })).toMatchObject({ ok: false, reason: expect.stringMatching(/publication hold not cleared/) });
        expect(w.owed()).toBe(true);
      }
      expect(w.checkRuns).toHaveLength(1);
      expect(w.tick().rows[0]).toMatchObject({ why: CARRIED_CHECK_ESCALATION });
      expect(w.checkRuns).toHaveLength(1);
      expect(w.fact()).toMatchObject({ ok: true });
    } finally { rmSync(w.dir, { recursive: true, force: true }); }
  });

  // Self-review variant of the same class: while every check write fails, each uncapped retry used to add one more
  // publication-hold status, until the clearer's status page cap made settlement impossible. The helper's own hold,
  // already set, still binds: retries post no further hold, and the head stays held.
  it('retries while check writes keep failing post one publication hold, not one per retry', () => {
    const w = world({ failReadAt: 0, failCheckPosts: { has: () => true } });
    try {
      for (let attempt = 0; attempt < 30; attempt++)
        expect(w.publish({ pr, headSha: head })).toMatchObject({ ok: false, remoteHold: true });
      expect(w.statuses.filter(status => status.context === `red-team/publication #${pr}`)).toHaveLength(1);
      expect(w.holdFact()).toMatchObject({ ok: false });
      expect(w.owed()).toBe(true);
    } finally { rmSync(w.dir, { recursive: true, force: true }); }
    // A round writer's hold on top is not the helper's own: the helper still posts its hold over it (fail closed).
    const v = world({ failReadAt: 0, failCheckPosts: { has: () => true } });
    try {
      v.statuses.unshift({ id: 99, state: 'failure', context: `red-team/publication #${pr}`, description: 'held: finished round publication in progress',
        creator: { login: 'web-everything' } });
      v.publish({ pr, headSha: head });
      expect(v.statuses[0]).toMatchObject({ state: 'failure', description: expect.stringMatching(/^held: live red-team check not clear:/) });
    } finally { rmSync(v.dir, { recursive: true, force: true }); }
  });

  it('an older confirmed attempt never removes the marker a newer attempt owns', () => {
    const w = world();
    try {
      const out = publishCarriedCheckDurably({ repo, pr, head, env: w.env, newAttempt: () => 'older', clearHold: () => ({ ok: true }),
        // A newer attempt marks the head while this one publishes, and then fails.
        publish: () => {
          publishCarriedCheckDurably({ repo, pr, head, env: w.env, newAttempt: () => 'newer', publish: () => ({ ok: false, reason: 'HTTP 502' }) });
          return { ok: true };
        } });
      expect(out).toMatchObject({ ok: true });
      expect(w.owed()).toBe(true);
      // When THIS attempt's own mark failed, the id read before marking decides (red team on a67e77345). The same id
      // still there means no attempt marked since: that marker and its hold are OLDER, so this confirmed attempt clears
      // the hold (the recovery pass would otherwise fail on the same unwritable marker forever).
      const clearHold = vi.fn(() => ({ ok: true }));
      const statusDir = redTeamStatusDir(w.env);
      chmodSync(statusDir, 0o555);
      let failedMark;
      try {
        failedMark = publishCarriedCheckDurably({ repo, pr, head, env: w.env, newAttempt: () => 'this', clearHold,
          publish: () => ({ ok: true }), lock: fn => fn() });
      } finally { chmodSync(statusDir, 0o755); }
      expect(failedMark).toMatchObject({ ok: true });
      expect(clearHold).toHaveBeenCalledTimes(1);
      // A different id at settlement proves an attempt marked AFTER this one read: it is newer and owns marker and hold.
      const keptHold = vi.fn(() => ({ ok: true }));
      chmodSync(statusDir, 0o555);
      let newerMarked;
      try {
        newerMarked = publishCarriedCheckDurably({ repo, pr, head, env: w.env, newAttempt: () => 'stale-read', clearHold: keptHold,
          publish: () => {
            chmodSync(statusDir, 0o755);
            publishCarriedCheckDurably({ repo, pr, head, env: w.env, newAttempt: () => 'later', publish: () => ({ ok: false, reason: 'HTTP 502' }) });
            chmodSync(statusDir, 0o555);
            return { ok: true };
          }, lock: fn => fn() });
      } finally { chmodSync(statusDir, 0o755); }
      expect(newerMarked).toMatchObject({ ok: true });
      expect(keptHold).not.toHaveBeenCalled();
      expect(w.owed()).toBe(true);
    } finally { rmSync(w.dir, { recursive: true, force: true }); }
  });

  // Operator send-back on 0f1cf7bb, item 1 (race 1, fail-open): the live helper used to post its success check and only
  // then re-validate, with no publication hold, so the merge gate (check fact AND hold fact) read clear while the
  // validation was still running, and kept reading clear when it failed until the failure supersede landed. The gate
  // view is sampled after every GitHub write and at the post-publication read.
  describe('send-back item 1: the success is merge-visible only after its post-publication validation', () => {
    function sampled(w, { failValidation = false } = {}) {
      const open = [];
      const gateOpen = () => w.fact().ok === true && w.holdFact().ok === true;
      let reads = 0;
      const out = publishRedTeamCheckFromLive({ repo, pr, headSha: head, appId: APP, env: w.env,
        gh: (args, options) => {
          const response = w.gh(args, options);
          if (args.includes('POST')) open.push(`${args[1].includes('/statuses/') ? 'status' : 'check'}:${gateOpen()}`);
          return response;
        },
        readLive: () => {
          if (++reads === 2) open.push(`validating:${gateOpen()}`);
          return { headRefOid: head, labels: reads >= 2 && failValidation ? [{ name: 'red-team:blocked' }] : [] };
        },
        readComments: () => [carry()], readStandingRuling: () => null, holdFn: () => null });
      return { out, open, gateOpen };
    }
    it('a hold is posted first, the gate stays closed through validation, and only the confirmed clear opens it', () => {
      const w = world();
      try {
        const { out, open, gateOpen } = sampled(w);
        expect(out).toMatchObject({ ok: true });
        expect(open).toEqual(['status:false', 'check:false', 'validating:false', 'status:true']);
        expect(gateOpen()).toBe(true);
      } finally { rmSync(w.dir, { recursive: true, force: true }); }
    });
    it('a failed validation never opens the gate: the success is superseded and the hold stays', () => {
      const w = world();
      try {
        const { out, open, gateOpen } = sampled(w, { failValidation: true });
        expect(out).toMatchObject({ ok: false, reason: expect.stringMatching(/red-team:blocked/) });
        expect(open).toEqual(['status:false', 'check:false', 'validating:false', 'check:false']);
        expect(gateOpen()).toBe(false);
        expect(w.holdFact()).toMatchObject({ ok: false });
      } finally { rmSync(w.dir, { recursive: true, force: true }); }
    });
    it('a hold that cannot be posted posts no success at all', () => {
      const w = world();
      try {
        const out = publishRedTeamCheckFromLive({ repo, pr, headSha: head, appId: APP, env: w.env,
          gh: (args, options) => {
            if (args.includes('POST') && args[1].includes('/statuses/')) throw Error('HTTP 502');
            return w.gh(args, options);
          },
          readLive: () => ({ headRefOid: head, labels: [] }), readComments: () => [carry()],
          readStandingRuling: () => null, holdFn: () => null });
        expect(out).toMatchObject({ ok: false, reason: expect.stringMatching(/publication hold not posted.*HTTP 502/) });
        expect(w.checkRuns).toEqual([]);
      } finally { rmSync(w.dir, { recursive: true, force: true }); }
    });
  });

  // Operator send-back on 0f1cf7bb, item 2 (race 2): settlement reads the marker, clears the hold, then removes the
  // marker, all under the writers' lock; but the initial attempt mark and the review job's owed mark were written
  // without it, so one could land between that read and the remove and be deleted with it. The injected host lock
  // queues a contender until the holder releases, exactly as the real lock blocks a second process.
  describe('send-back item 2: every retry-marker write takes the writers\' lock', () => {
    function queueingLock() {
      let held = false;
      const waiting = [];
      const lock = fn => {
        if (held) { waiting.push(fn); return { ok: true, queued: true }; }
        held = true;
        try { return fn(); } finally { held = false; while (waiting.length) lock(waiting.shift()); }
      };
      return lock;
    }
    it('a newer attempt\'s mark racing an older attempt\'s settlement survives it', () => {
      const w = world();
      try {
        const lock = queueingLock();
        let newer;
        const out = publishCarriedCheckDurably({ repo, pr, head, env: w.env, lock, newAttempt: () => 'older',
          publish: () => ({ ok: true }),
          // Settlement has read the marker and is clearing the hold when a newer attempt starts and then fails.
          clearHold: () => {
            newer = publishCarriedCheckDurably({ repo, pr, head, env: w.env, lock, newAttempt: () => 'newer',
              publish: () => ({ ok: false, reason: 'HTTP 502' }) });
            return { ok: true };
          } });
        expect(out).toMatchObject({ ok: true });
        expect(newer).toMatchObject({ ok: false });
        expect(w.owed()).toBe(true);
      } finally { rmSync(w.dir, { recursive: true, force: true }); }
    });
    it('the review job\'s owed mark racing a settlement survives it', () => {
      const w = world();
      try {
        const lock = queueingLock();
        const out = publishCarriedCheckDurably({ repo, pr, head, env: w.env, lock, newAttempt: () => 'older',
          publish: () => ({ ok: true }),
          clearHold: () => { markCarriedCheckUnpublished({ repo, pr, head, env: w.env, lock }); return { ok: true }; } });
        expect(out).toMatchObject({ ok: true });
        expect(w.owed()).toBe(true);
      } finally { rmSync(w.dir, { recursive: true, force: true }); }
    });
    it('the default marker write takes the real host lock (a held lock refuses it)', () => {
      const w = world();
      try {
        const inside = withRedTeamCheckLock({ repo, pr, headSha: head, env: w.env }, () => {
          try { markCarriedCheckUnpublished({ repo, pr, head, env: w.env, lockTimeoutMs: 0 }); return 'written'; }
          catch (error) { return String(error.message); }
        });
        expect(inside).toMatch(/lock failed/);
        expect(w.owed()).toBe(false);
        markCarriedCheckUnpublished({ repo, pr, head, env: w.env, lockTimeoutMs: 0 });
        expect(w.owed()).toBe(true);
      } finally { rmSync(w.dir, { recursive: true, force: true }); }
    });
  });

  it('settlement runs inside the publisher\'s writers\' lock, so no later attempt\'s hold lands before the clear', () => {
    // Red team on a67e77345: publish and settlement took the lock separately, so a later attempt could post its hold in
    // between (with no marker of its own) and the earlier attempt's late clear removed it.
    const w = world({ failCheckPosts: new Set([2]) });
    try {
      w.publish({ pr, headSha: head });
      const probes = [];
      let publishing = false;
      const out = publishCarriedCheckDurably({ repo, pr, head, env: w.env,
        // The attempt's own mark takes the lock before publication (send-back item 2); settlement never does again.
        lock: fn => {
          if (publishing) throw Error('settlement must not take a second lock acquisition');
          return fn();
        },
        publish: hooks => (publishing = true) && publishRedTeamCheckFromLive({ repo, pr, headSha: head, appId: APP, env: w.env, ...hooks,
          gh: (args, options) => w.gh(args, options),
          readLive: () => ({ headRefOid: head, labels: [] }), readComments: () => [carry()],
          readStandingRuling: () => null, holdFn: () => null }),
        clearHold: () => {
          // The writers' lock is still held here: another writer cannot acquire it.
          probes.push(withRedTeamCheckLock({ repo, pr, headSha: head, env: w.env, lockTimeoutMs: 0 }, () => ({ ok: true })));
          return clearLivePublicationHold({ repo, pr, headSha: head, gh: w.gh });
        } });
      expect(out).toMatchObject({ ok: true });
      expect(out).not.toHaveProperty('settled');
      expect(probes).toEqual([expect.objectContaining({ ok: false, reason: expect.stringMatching(/lock failed/) })]);
      expect(w.holdFact()).toMatchObject({ ok: true });
      expect(w.owed()).toBe(false);
    } finally { rmSync(w.dir, { recursive: true, force: true }); }
  });

  it('a settlement lock failure with no marker written names that the operator must republish', () => {
    const w = world();
    const statusDir = redTeamStatusDir(w.env);
    try {
      mkdirSync(statusDir, { recursive: true });
      chmodSync(statusDir, 0o555);
      const clearHold = vi.fn(() => ({ ok: true }));
      const out = publishCarriedCheckDurably({ repo, pr, head, env: w.env, publish: () => ({ ok: true }), clearHold,
        lock: () => ({ ok: false, reason: 'red-team check lock failed: timed out' }) });
      expect(out).toMatchObject({ ok: false, reason: expect.stringMatching(/lock failed: timed out; carried-check retry marker not written.*operator must republish/) });
      expect(clearHold).not.toHaveBeenCalled();
    } finally { chmodSync(statusDir, 0o755); rmSync(w.dir, { recursive: true, force: true }); }
  });

  it('a confirmed attempt clears the helper hold even when no marker could ever be written', () => {
    // Red team on 914348f86: marker writes fail (the outbox directory is not writable), attempt 1 posts the hold, the
    // retry succeeds. With no marker to read, settlement used to return ok without clearing: merge stayed blocked.
    const w = world({ failCheckPosts: new Set([2]) });
    const statusDir = redTeamStatusDir(w.env);
    try {
      mkdirSync(statusDir, { recursive: true });
      chmodSync(statusDir, 0o555);
      expect(w.publish({ pr, headSha: head })).toMatchObject({ ok: false, reason: expect.stringMatching(/retry marker not written/) });
      expect(w.holdFact()).toMatchObject({ ok: false });
      expect(w.owed()).toBe(false);
      expect(w.publish({ pr, headSha: head })).toMatchObject({ ok: true });
      expect(w.fact()).toMatchObject({ ok: true });
      expect(w.holdFact()).toMatchObject({ ok: true });
      // A clear that fails with no marker left is not ok, and names that nothing will retry it.
      const out = publishCarriedCheckDurably({ repo, pr, head, env: w.env, publish: () => ({ ok: true }),
        clearHold: () => ({ ok: false, reason: 'HTTP 502' }) });
      expect(out).toMatchObject({ ok: false, reason: expect.stringMatching(/hold not cleared: HTTP 502.*retry marker not written.*operator must republish/) });
    } finally { chmodSync(statusDir, 0o755); rmSync(w.dir, { recursive: true, force: true }); }
    // With writable storage, a failed clear on an absent marker writes one, so the recovery pass retries the clear.
    const v = world();
    try {
      expect(v.owed()).toBe(false);
      expect(publishCarriedCheckDurably({ repo, pr, head, env: v.env, newAttempt: () => 'a', lock: fn => {
        rmSync(join(redTeamStatusDir(v.env), `${encodeURIComponent(repo)}-${pr}-${head}.json.carried-check-unpublished`), { force: true });
        return fn();
      }, publish: () => ({ ok: true }), clearHold: () => ({ ok: false, reason: 'HTTP 502' }) }))
        .toMatchObject({ ok: false, reason: expect.stringMatching(/hold not cleared: HTTP 502$/) });
      expect(v.owed()).toBe(true);
    } finally { rmSync(v.dir, { recursive: true, force: true }); }
  });

  it('a hold clear that fails keeps the marker so the next retry clears it', () => {
    const w = world({ failCheckPosts: new Set([2]) });
    try {
      w.publish({ pr, headSha: head });
      const out = publishCarriedCheckDurably({ repo, pr, head, env: w.env, publish: () => ({ ok: true }),
        clearHold: () => ({ ok: false, reason: 'HTTP 502' }) });
      expect(out).toMatchObject({ ok: false, reason: expect.stringMatching(/publication hold not cleared: HTTP 502/) });
      expect(w.owed()).toBe(true);
    } finally { rmSync(w.dir, { recursive: true, force: true }); }
  });

  it('a stale marker under a non-carried result (the carry comment failed; a round ran) is ignored', () => {
    const w = world();
    try {
      publishCarriedCheckDurably({ repo, pr, head, env: w.env, publish: () => ({ ok: false, reason: 'HTTP 502' }) });
      const round = { author: { login: 'web-everything' }, created_at: '2026-11-07T14:00:00Z',
        body: renderRedTeamComment({ pr, rev: head, provider: 'codex', model: 'm', findings: [], recheckStatus: 'not-needed', foldedVerdict: 'accept' }) };
      const escalate = vi.fn();
      for (const comments of [[round], [carry(), round]])
        expect(w.tick({ escalate, rawPrs: [{ number: pr, headRefOid: head, comments, labels: [] }] }).rows[0])
          .toMatchObject({ action: 'skip', why: 'red-team result already on head' });
      expect(w.publish).not.toHaveBeenCalled();
      expect(escalate).not.toHaveBeenCalled();
    } finally { rmSync(w.dir, { recursive: true, force: true }); }
  });

  it('the recovery pass republishes the carried check once reads recover, then settles the head', () => {
    const w = world();
    try {
      // The review job's carry attempt: success posted, the verification read times out, the helper supersedes it.
      expect(w.publish({ pr, headSha: head })).toMatchObject({ ok: false, reason: expect.stringMatching(/timed out/) });
      expect(w.checkRuns.map(run => run.conclusion)).toEqual(['success', 'failure']);
      expect(w.fact()).toMatchObject({ ok: false });
      expect(w.owed()).toBe(true);
      // The next recovery tick does not skip the head: it re-validates and republishes.
      expect(w.tick().rows[0]).toMatchObject({ action: 'publish-carried-check', why: 'carried red-team check republished from live evidence' });
      expect(w.checkRuns.map(run => run.conclusion)).toEqual(['success', 'failure', 'success']);
      expect(w.fact()).toMatchObject({ ok: true });
      expect(w.owed()).toBe(false);
      // Settled: later ticks skip as before and post nothing.
      expect(w.tick().rows[0]).toMatchObject({ action: 'skip', why: 'red-team result already on head' });
      expect(w.checkRuns).toHaveLength(3);
    } finally { rmSync(w.dir, { recursive: true, force: true }); }
  });

  it('a round failure newer than the carry still refuses the retry; the head stays owed and retries after the cooldown', () => {
    const w = world();
    try {
      w.publish({ pr, headSha: head });
      w.extraRuns.push({ name: 'red-team', head_sha: head, external_id: `${repo}#${pr}`, app: { id: APP }, id: 99,
        status: 'completed', conclusion: 'failure', completed_at: '2026-11-07T14:00:00Z', output: { title: 'Red team held' } });
      let clock = 2_000_000;
      const lastDispatch = new Map();
      const escalate = vi.fn();
      const first = w.tick({ now: () => clock, lastDispatch, escalate }).rows[0];
      // A failed retry is escalated with a stable reason (one needs-you item), its cause in the context.
      expect(first).toMatchObject({ action: 'publish-carried-check', why: CARRIED_CHECK_ESCALATION, escalate: true,
        escalationContext: expect.stringMatching(/not demonstrably newer/) });
      expect(escalate).toHaveBeenCalledWith(expect.objectContaining({ pr, head, why: CARRIED_CHECK_ESCALATION }));
      expect(w.owed()).toBe(true);
      expect(w.tick({ now: () => clock + 60_000, lastDispatch, escalate }).rows[0])
        .toMatchObject({ action: 'skip', why: 'carried red-team check unconfirmed; retry cooldown active' });
      expect(w.publish).toHaveBeenCalledTimes(2);
      clock += 31 * 60_000;
      expect(w.tick({ now: () => clock, lastDispatch, escalate }).rows[0]).toMatchObject({ action: 'publish-carried-check' });
      expect(w.publish).toHaveBeenCalledTimes(3);
      expect(escalate).toHaveBeenCalledTimes(2);
      expect(w.fact()).toMatchObject({ ok: false });
    } finally { rmSync(w.dir, { recursive: true, force: true }); }
  });

  it('a kept red-team:pending label still escalates while a carried check is owed, and nothing is republished', () => {
    const w = world();
    try {
      publishCarriedCheckDurably({ repo, pr, head, env: w.env, publish: () => ({ ok: false, reason: 'HTTP 502' }) });
      const escalate = vi.fn();
      const row = w.tick({ escalate, rawPrs: [{ number: pr, headRefOid: head, comments: [carry()], labels: [{ name: 'red-team:pending' }] }] }).rows[0];
      expect(row).toMatchObject({ action: 'skip', why: 'red-team result already on head', escalate: true,
        escalationContext: expect.stringMatching(/red-team:pending is still set/) });
      expect(escalate).toHaveBeenCalledTimes(1);
      expect(w.publish).not.toHaveBeenCalled();
      expect(w.owed()).toBe(true);
    } finally { rmSync(w.dir, { recursive: true, force: true }); }
  });

  it('keeps the marker when the publisher throws, and an unreadable or throwing marker read counts as owed', () => {
    const w = world();
    try {
      expect(publishCarriedCheckDurably({ repo, pr, head, env: w.env, publish: () => { throw Error('HTTP 502'); } }))
        .toMatchObject({ ok: false, reason: 'HTTP 502' });
      expect(w.owed()).toBe(true);
      expect(publishCarriedCheckDurably({ repo, pr, head, env: w.env, publish: () => ({ ok: true }),
        clearHold: () => ({ ok: true }) })).toMatchObject({ ok: true });
      expect(w.owed()).toBe(false);
      expect(decide({ rawPrs: [{ number: pr, headRefOid: head, comments: [carry()] }], readCarriedCheck: () => { throw Error('EACCES'); } }))
        .toMatchObject({ action: 'publish-carried-check' });
      expect(decide({ rawPrs: [{ number: pr, headRefOid: head, comments: [carry()] }], readCarriedCheck: () => false }))
        .toMatchObject({ action: 'skip', why: 'red-team result already on head' });
      // Dry runs and a missing publisher attempt nothing.
      publishCarriedCheckDurably({ repo, pr, head, env: w.env, publish: () => ({ ok: false, reason: 'HTTP 502' }) });
      expect(w.owed()).toBe(true);
      expect(w.tick({ dryRun: true }).rows[0]).toMatchObject({ action: 'publish-carried-check', why: 'dry run (carried check)' });
      expect(w.tick({ publishCarriedCheck: null }).rows[0]).toMatchObject({ why: 'carried check publisher unavailable' });
      expect(w.publish).not.toHaveBeenCalled();
    } finally { rmSync(w.dir, { recursive: true, force: true }); }
  });

  // Merge of main's result-on-head check recovery: a carried result has no sealed stored status for its head, so that
  // recovery would refuse it on every tick. An owed carried check goes to the carried-check republisher first.
  it('an owed carried check is republished by the carried-check path, never the result-check recovery', () => {
    const w = world();
    try {
      expect(w.publish({ pr, headSha: head })).toMatchObject({ ok: false });
      expect(w.owed()).toBe(true);
      w.publish.mockClear();
      const readCheckFact = vi.fn(() => ({ ok: false, reason: 'no red-team check run on head' }));
      const publishCheck = vi.fn(() => ({ ok: true }));
      expect(w.tick({ readCheckFact, publishCheck }).rows[0]).toMatchObject({ action: 'publish-carried-check' });
      expect(w.publish).toHaveBeenCalledTimes(1);
      expect(publishCheck).not.toHaveBeenCalled();
      expect(readCheckFact).not.toHaveBeenCalled();
    } finally { rmSync(w.dir, { recursive: true, force: true }); }
  });
});

describe('result-on-head check recovery', () => {
  const comments = () => [{ body: `${redTeamMarker(pr, head)}\nRed team not required on this head: policy clear`, author: { login: 'web-everything' } }];
  function options(over = {}) {
    const f = fixture();
    f.rawPrs[0].comments = comments();
    return { ...f, plan: { refusals: f.refusals }, now: () => 2_000_000,
      readCheckFact: vi.fn(() => ({ ok: false, reason: 'no red-team check run on head' })),
      publishCheck: vi.fn(() => ({ ok: true })), dispatch: vi.fn(), ...over };
  }
  it('publishes the missing check once per head without dispatching another seat', () => {
    const o = options();
    o.plan.refusals.push({ ...o.plan.refusals[0] });
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'publish-result' });
    expect(o.publishCheck).toHaveBeenCalledTimes(1);
    expect(o.publishCheck).toHaveBeenCalledWith({ repo, pr, headSha: head, resultComments: o.rawPrs[0].comments });
    expect(o.dispatch).not.toHaveBeenCalled();
  });
  it.each(['sealed', 'skipped'])('seals legacy unsealed ran once before attempting publication (%s)', status => {
    const sealStored = vi.fn(args => {
      expect(args.status).toEqual({ repo, pr, head });
      expect(args.sealOnly).toBe(true);
      expect(args.listComments()).toBe(o.rawPrs[0].comments);
      expect(() => args.postComment()).toThrow('seal-only never posts');
      expect(o.publishCheck).not.toHaveBeenCalled();
      return { status };
    });
    const isLegacyRan = vi.fn(() => true);
    const o = options({ readSeal: () => ({ unsealed: true }), isLegacyRan, sealStored });
    o.rawPrs[0].labels = ['red-team:clear'];
    o.plan.refusals.push({ ...o.plan.refusals[0] });
    expect(runRedTeamOnSkip(o).rows[0].settleError).toBeUndefined();
    expect(isLegacyRan).toHaveBeenCalledWith({ repo, pr, head, env: process.env });
    expect(sealStored).toHaveBeenCalledTimes(1);
    expect(o.publishCheck).toHaveBeenCalledTimes(1);
    expect(o.dispatch).not.toHaveBeenCalled();
  });
  it.each(['retry', 'unknown', 'throws'])('refuses publication when legacy sealing fails: %s', status => {
    const sealStored = vi.fn(() => {
      if (status === 'throws') throw Error('seal unavailable; inspect stored evidence');
      return { status };
    });
    const o = options({ readSeal: () => ({ unsealed: true }), isLegacyRan: () => true, sealStored });
    expect(runRedTeamOnSkip(o).rows[0].settleError).toMatch(/seal/);
    expect(sealStored).toHaveBeenCalledTimes(1);
    expect(o.publishCheck).not.toHaveBeenCalled();
  });
  it.each([
    { result: { status: 'ran', comment: 'withheld', findings: [] } },
    { result: 'ran', sealedBreaks: ['confirmed break'] },
    { status: 'running', result: 'ran', sealedBreaks: [] },
    { status: 'queued', result: 'ran', sealedBreaks: [] },
  ])('guarded publisher refuses unsealed, held or unfinished stored evidence: %j', stored => {
    const dir = mkdtempSync(join(tmpdir(), 'on-skip-seal-'));
    try {
      const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs'), WE_RED_TEAM_GATE_SOURCE: 'both' };
      mkdirSync(join(dir, 'red-team-status'));
      writeJsonAtomic(sealedStatusPath({ repo, pr, head }, env), { repo, pr, head, status: 'finished', ...stored });
      const gh = vi.fn(() => JSON.stringify({ total_count: 0, check_runs: [] }));
      const sealStored = vi.fn();
      const o = options({ env, readSeal: readSealedStatus, sealStored, isLegacyRan: () => stored.result === 'ran',
        publishCheck: args => publishRedTeamPolicyClearCheck({ ...args, env, appId: '123', gh }) });
      expect(runRedTeamOnSkip(o).rows[0].settleError).toContain('result check not posted');
      expect(sealStored).not.toHaveBeenCalled();
      expect(gh).toHaveBeenCalled();
      expect(gh.mock.calls.every(([args]) => !args.includes('POST'))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each([{ ok: true }, { ok: false, reason: 'red-team check run failed (failure)' },
    { ok: false, reason: 'red-team check runs unreadable or incomplete at 100-run bound; operator must inspect full check history' }])(
    'does not publish over existing or unreadable check evidence: %j', fact => {
      const o = options({ readCheckFact: () => fact });
      expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
      expect(o.publishCheck).not.toHaveBeenCalled();
    });
  it('refuses a changed head or removed result at the publication boundary', () => {
    for (const live of [{ headRefOid: 'b'.repeat(40) }, { headRefOid: head }]) {
      const o = options({ provider: { readPrState: () => live }, readComments: () => [] });
      expect(runRedTeamOnSkip(o).rows[0].settleError).toBeTruthy();
      expect(o.publishCheck).not.toHaveBeenCalled();
    }
  });
  it.each([head, 'b'.repeat(40)])('reads the head after fresh comments and checks (head=%s)', liveHead => {
    let current = head;
    const o = options({ provider: { readPrState: () => ({ headRefOid: current }) },
      readComments: () => { current = liveHead; return comments(); } });
    const row = runRedTeamOnSkip(o).rows[0];
    expect(o.publishCheck).toHaveBeenCalledTimes(liveHead === head ? 1 : 0);
    if (liveHead !== head) expect(row.settleError).toContain('head or result changed');
  });
  it.each(['both', 'drain-scan'])('publication failure is visible under %s', source => {
    const o = options({ env: { WE_RED_TEAM_GATE_SOURCE: source }, log: vi.fn(),
      publishCheck: () => ({ ok: false, reason: 'HTTP 502' }) });
    const row = runRedTeamOnSkip(o).rows[0];
    if (source === 'both') expect(row.settleError).toContain('HTTP 502');
    else { expect(row.settleError).toBeUndefined(); expect(o.log).toHaveBeenCalledWith(expect.stringContaining('HTTP 502')); }
  });
});


it('a recovered result check settles the next pass without a recovery seat', () => {
  const f = fixture();
  f.rawPrs[0].comments = [{ body: `${redTeamMarker(pr, head)}\nRed team not required on this head: clear`, author: { login: 'web-everything' } }];
  let published = false;
  const o = { ...f, plan: { refusals: f.refusals }, now: () => 2_000_000, dispatch: vi.fn(),
    readCheckFact: () => published ? { ok: true } : { ok: false, reason: 'no red-team check run on head' },
    publishCheck: vi.fn(() => { published = true; return { ok: true }; }) };
  expect(runRedTeamOnSkip(o).rows[0].action).toBe('publish-result');
  expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: 'red-team result already on head' });
  expect(o.publishCheck).toHaveBeenCalledTimes(1);
  expect(o.dispatch).not.toHaveBeenCalled();
});
