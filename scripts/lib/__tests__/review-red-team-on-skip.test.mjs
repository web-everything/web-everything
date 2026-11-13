import { runGhSync } from '../gh-throttle.mjs';
import { redTeamForHead, redTeamMarker } from '../red-team-gate.mjs';
import { latestAcceptRecord } from '../accept-carry-forward.mjs';
import { proveCardOnlyHeadMove } from '../card-only-head-move.mjs';
import { OPERATOR_LOGINS } from '../marker-authorship.mjs';
import * as numbering from '../numbering-carry.mjs';
import { describe, it, expect, vi } from 'vitest';
import { cardOnlyHeadMoveCandidate, normalizeRedTeamResult, planRedTeamRecovery, planRedTeamOnSkip, runRedTeamOnSkip, resolveReviewRedTeamOnSkip } from '../review-red-team-on-skip.mjs';
import { assertMainNotStale, PreStartDispatchRefusalError } from '../main-staleness.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { resetCascadeLogForTest } from '../policy-cascade.mjs';
import { readDrainRedTeamEvidence, readRedTeamStatus, recordRedTeamStatus, redTeamStatusDir } from '../drain-red-team-evidence.mjs';
import { newRunRecord, writeRun } from '../../operations/run-store.mjs';
import { refusedReferralsAreRuled, reviewRunEvidence } from '../../conveyor/review-referral-hold.mjs';
import { buildOperatorRulingComment, mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } from '../jury-core.mjs';
import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
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

describe('unfinished retryable record effect', () => {
  const options = (rows) => ({ readEvidence: () => ({ ok: false, reason: 'review-unfinished' }),
    headNeverReviewed: () => false, readReviewRuns: () => rows });
  const row = { id: 'review-pr-retry', repo, pr, head, startedAt: 1, completedAt: 2, retryableRecordEffect: true };
  it('dispatches review to resume the retryable run', () => {
    const o = runFixture(options([row]));
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'review',
      why: 'unfinished review has only a retryable pre-write effect; resume it' });
    expect(o.dispatch).toHaveBeenCalledWith({ repo, pr });
  });
  it.each([
    ['not retryable', [{ ...row, retryableRecordEffect: false }]],
    ['other head', [{ ...row, head: 'b'.repeat(40) }]],
    ['other PR', [{ ...row, pr: pr + 1 }]],
    ['newer hold', [row, { ...row, id: 'newer', startedAt: 3, completedAt: 4, retryableRecordEffect: false }]],
    ['missing evidence', []],
  ])('escalates %s', (_, rows) => {
    expect(decide(options(rows))).toMatchObject({ action: 'skip', why: 'review-unfinished', escalate: true });
  });
  it('a non-retryable unfinished run escalates and never dispatches a review (so review-loop-cli is not reached)', () => {
    const o = runFixture(options([{ ...row, retryableRecordEffect: false }]));
    const out = runRedTeamOnSkip(o).rows[0];
    expect(out).toMatchObject({ action: 'skip', why: 'review-unfinished', escalate: true });
    expect(o.dispatch).not.toHaveBeenCalled();
  });
  it('keeps unreadable evidence held', () => {
    expect(decide({ ...options([]), readReviewRuns: () => { throw Error('unreadable'); } }))
      .toMatchObject({ action: 'skip', why: 'review-unfinished', escalate: true });
  });
  it('honours the dispatch cooldown', () => {
    expect(decide({ ...options([row]), lastDispatch: new Map([[`${repo}#${pr}@${head}`, 2_000_000]]) }))
      .toMatchObject({ action: 'skip', why: 'retry cooldown active' });
  });
});

describe('unfinished-review exception requires proven owner death', () => {
  const now = Date.parse('2026-11-13T12:00:00Z'), deadlineMs = 7_200_000;
  const birth = '2026-11-13T01:00:00Z';
  function plan({ exception = true, foreign = false, age = deadlineMs + 1,
    isAlive = () => false, readPidStart = () => birth, deadline = deadlineMs,
    raw = {}, marker = null, omitDeadline = false, deathReason } = {}) {
    return planRedTeamRecovery({ head, newest: payload(), seats: [],
      ...(exception ? { unfinishedReviewException: true } : {}), statusAt: now - age,
      rawWriter: { sha256: 'writer', parsed: { status: 'running', host: foreign ? 'other' : 'here',
        pidNamespace: 'ns', pid: 123, pidStart: birth, ...raw } },
      evidenceSha256: 'evidence', markers: { redispatch: marker } },
    { now, deadlineMs: omitDeadline ? undefined : deadline, env: {}, setting: { enabled: true, retryCooldownMin: 30 },
      probe: { host: 'here', namespace: 'ns', isAlive, readPidStart, deathReason } });
  }

  it.each([true, false])('preserves observed zombie death with unfinished-review exception %s', exception => {
    expect(plan({ exception, deathReason: () => 'zombie' }))
      .toMatchObject({ abandon: true, deathReason: 'zombie' });
  });

  it.each([
    ['throws', () => { throw Error('unreadable'); }],
    ['undefined', () => undefined], ['null', () => null],
  ])('holds an old local owner when its existence probe %s', (_name, isAlive) => {
    expect(plan({ isAlive })).toMatchObject({ mode: 'skip' });
    expect(plan({ exception: false, isAlive })).toMatchObject({ abandon: true });
  });

  it.each([1_800_001, deadlineMs - 1, deadlineMs])('holds a dead foreign PID with record age %i', age => {
    expect(plan({ foreign: true, age })).toMatchObject({ mode: 'skip' });
    expect(plan({ exception: false, foreign: true, age })).toMatchObject({ abandon: true });
  });

  it('requires the default two-hour deadline when no deadline is supplied', () => {
    expect(plan({ foreign: true, age: 1_800_001, omitDeadline: true })).toMatchObject({ mode: 'skip' });
    expect(plan({ foreign: true, omitDeadline: true })).toMatchObject({ abandon: true });
  });

  it('honors a supplied stale-run deadline for foreign records', () => {
    expect(plan({ foreign: true, age: deadlineMs + 1, deadline: 2 * deadlineMs })).toMatchObject({ mode: 'skip' });
  });

  it.each([
    ['dead PID', () => false, () => null],
    ['verified birth mismatch', () => true, () => 'different-birth'],
  ])('recovers a foreign record older than the deadline with %s', (_name, isAlive, readPidStart) => {
    expect(plan({ foreign: true, isAlive, readPidStart })).toMatchObject({ abandon: true });
  });

  it.each([
    ['throwing existence probe', () => { throw Error('unreadable'); }, () => birth],
    ['unknown existence probe', () => undefined, () => birth],
    ['live PID', () => true, () => birth],
    ['unreadable birth', () => true, () => null],
    ['empty birth', () => true, () => ''],
    ['throwing birth probe', () => true, () => { throw Error('unreadable'); }],
  ])('holds an old foreign record with %s despite an old pidStart', (_name, isAlive, readPidStart) => {
    expect(plan({ foreign: true, isAlive, readPidStart })).toMatchObject({ mode: 'skip' });
  });

  it.each([NaN, Infinity, 0])('holds an unreadable foreign statusAt (%s)', statusAt => {
    expect(plan({ foreign: true, age: now - statusAt })).toMatchObject({ mode: 'skip' });
  });

  it.each([
    ['dead PID', () => false, () => null, 'gone'],
    ['verified birth mismatch', () => true, () => 'different-birth', 'start-mismatch'],
  ])('redispatches a bound abandoned foreign writer with fresh statusAt and %s', (_name, isAlive, readPidStart, deathReason) => {
    const probe = vi.fn(isAlive);
    expect(plan({ foreign: true, age: 0, raw: { staleAbandoned: true }, isAlive: probe, readPidStart,
      marker: { writer: 'writer', evidence: 'evidence' } }))
      .toMatchObject({ mode: 'fresh', abandon: false, executionPrior: null, deathReason });
    expect(probe).toHaveBeenCalledWith(123);
  });

  it.each([
    ['live PID with recorded birth', () => true, () => birth],
    ['throwing existence probe', () => { throw Error('unreadable'); }, () => birth],
    ['unknown existence probe', () => undefined, () => birth],
    ['unreadable birth', () => true, () => null],
    ['throwing birth probe', () => true, () => { throw Error('unreadable'); }],
  ])('holds a bound abandoned foreign writer with fresh statusAt and %s', (_name, isAlive, readPidStart) => {
    const probe = vi.fn(isAlive);
    expect(plan({ foreign: true, age: 0, raw: { staleAbandoned: true }, isAlive: probe, readPidStart,
      marker: { writer: 'writer', evidence: 'evidence' } })).toMatchObject({ mode: 'skip' });
    expect(probe).toHaveBeenCalledWith(123);
  });

  it.each([
    ['missing marker', { staleAbandoned: true }, null],
    ['unbound writer', { staleAbandoned: true }, { writer: 'other', evidence: 'evidence' }],
    ['different evidence', { staleAbandoned: true }, { writer: 'writer', evidence: 'other' }],
    ['not abandoned', {}, { writer: 'writer', evidence: 'evidence' }],
    ['different namespace', { staleAbandoned: true, pidNamespace: 'other' }, { writer: 'writer', evidence: 'evidence' }],
    ['missing PID', { staleAbandoned: true, pid: undefined }, { writer: 'writer', evidence: 'evidence' }],
  ])('holds a fresh foreign writer with %s', (_name, raw, marker) => {
    expect(plan({ foreign: true, age: 0, raw, marker })).toMatchObject({ mode: 'skip' });
  });
});

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
