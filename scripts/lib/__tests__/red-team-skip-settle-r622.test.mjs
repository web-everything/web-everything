// @vitest-environment node
// R622: the review side saw "red-team result already on head" while the drain held the same head as
// unknown run evidence (review-unfinished / scan-capped). A trusted result comment bound to the exact
// head settles those two reasons; a recorded break still sends back; missing evidence still fails closed.
import { describe, expect, it } from 'vitest';
import { readDrainRedTeamEvidence, settleUnknownEvidenceByComment } from '../drain-red-team-evidence.mjs';
import { redTeamEnqueueHold } from '../drain-queue-safety.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';

const head = 'a'.repeat(40), other = 'b'.repeat(40), pr = 6244;
const comment = (rev = head, findings = [], login = 'web-everything') => ({ author: { login }, createdAt: '2026-11-05T12:00:00Z',
  body: renderRedTeamComment({ pr, rev, findings, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: findings.length ? 'changes' : 'accept' }) });
const broken = [{ summary: 'break', category: 'edge-case', impactIfUnfixed: 'broken', confirmedByRecheck: true }];
const T = Date.parse('2026-11-05T12:00:00Z');
const unknown = (reason, bounds) => Object.defineProperty({ ok: false, reason }, 'settleBounds', { value: bounds, enumerable: false });
const older = { unfinishedStartedAt: T - 3600e3, unreadBoundaryAt: T - 3600e3 };
const holdFor = (evidence, comments) => redTeamEnqueueHold({ ...settleUnknownEvidenceByComment(evidence, comments, pr, head), comments, pr, head, env: {} });

describe('R622 unknown run evidence settled by a head-bound result comment', () => {
  for (const reason of ['review-unfinished', 'scan-capped']) {
    it(`${reason} with a trusted clean result on this head releases the hold`, () => {
      expect(holdFor(unknown(reason, older), [comment()])).toBeNull();
    });
    it(`${reason} with no result comment still fails closed`, () => {
      expect(holdFor(unknown(reason, older), [])).toMatch(/evidence unknown/);
    });
    it(`${reason} with a result for ANOTHER head still fails closed`, () => {
      expect(holdFor(unknown(reason, older), [comment(other)])).toMatch(/evidence unknown/);
    });
    it(`${reason} with an untrusted author's result still fails closed`, () => {
      expect(holdFor(unknown(reason, older), [comment(head, [], 'someone-else')])).toMatch(/evidence unknown/);
    });
    it(`${reason} with a confirmed break on this head still sends back`, () => {
      expect(holdFor(unknown(reason, older), [comment(head, broken)])).toMatch(/break requiring send-back/);
    });
  }
  it('review-unfinished started AFTER the result comment (a later re-review) stays held', () => {
    expect(holdFor(unknown('review-unfinished', { unfinishedStartedAt: T + 60e3 }), [comment()])).toMatch(/evidence unknown/);
  });
  it('scan-capped with an unread record written after the result comment stays held', () => {
    expect(holdFor(unknown('scan-capped', { unreadBoundaryAt: T + 60e3 }), [comment()])).toMatch(/evidence unknown/);
    expect(holdFor(unknown('scan-capped', { unreadBoundaryAt: T - 1000 }), [comment()])).toMatch(/evidence unknown/); // inside the mtime slack
  });
  it('missing bounds never settle', () => {
    for (const reason of ['review-unfinished', 'scan-capped']) expect(holdFor(unknown(reason, {}), [comment()])).toMatch(/evidence unknown/);
    expect(holdFor({ ok: false, reason: 'scan-capped' }, [comment()])).toMatch(/evidence unknown/);
  });
  it('review-unfinished that is also capped needs the unread boundary beaten too', () => {
    expect(holdFor(unknown('review-unfinished', { unfinishedStartedAt: T - 3600e3, unreadBoundaryAt: T + 60e3 }), [comment()])).toMatch(/evidence unknown/);
    expect(holdFor(unknown('review-unfinished', { unfinishedStartedAt: T - 3600e3, unreadBoundaryAt: T - 3600e3 }), [comment()])).toBeNull();
  });
  it('other unknown reasons are never settled by a comment', () => {
    for (const reason of ['run-start-missing', 'read-failed']) {
      expect(settleUnknownEvidenceByComment(unknown(reason, older), [comment()], pr, head)).toMatchObject({ ok: false, reason });
    }
  });
  it('known evidence passes through untouched', () => {
    const evidence = { scheduled: true, recorded: false };
    expect(settleUnknownEvidenceByComment(evidence, [comment()], pr, head)).toBe(evidence);
  });
  it('a resumed review stamps a later resume time: a comment older than the resume stays held', () => {
    expect(holdFor(unknown('review-unfinished', { unfinishedStartedAt: T + 60e3 }), [comment()])).toMatch(/evidence unknown/);
  });
});

describe('R622 the evidence reader bounds a resumed unfinished review by its resume stamp', () => {
  const rev = head;
  const run = extra => ({ op: 'review-pr', input: { repo: 'o/r', pr }, findings: { read: { netBasis: { rev } } },
    stepTimings: [{ step: 'read', startedAt: new Date(T - 7200e3).toISOString() }], verdict: { verdict: 'needs-human' }, pending: { kind: 'confirm' }, ...extra });
  const read = r => readDrainRedTeamEvidence({ repo: 'o/r', pr, head: rev, env: { WE_SHARED_RUNS_DIR: '/nonexistent-r622' },
    runsDir: '/runs', list: () => ['review-pr-1'], stat: () => ({ mtimeMs: T - 60e3 }), read: () => r, readScorecards: () => [], now: T });
  const settled = r => settleUnknownEvidenceByComment(read(r), [comment()], pr, head);
  it('plain unfinished run older than the comment settles', () => { expect(settled(run({}))).toMatchObject({ ok: true }); });
  it('a resume stamped after the comment stays held', () => {
    expect(settled(run({ resumeOf: 'x', resumedAt: new Date(T + 60e3).toISOString() }))).toMatchObject({ ok: false, reason: 'review-unfinished' });
  });
  it('a resumed run with no readable stamp stays held', () => {
    expect(settled(run({ resumeOf: 'x' }))).toMatchObject({ ok: false, reason: 'review-unfinished' });
  });
});

describe('R622 several unfinished reviews', () => {
  const mk = (id, startedAt, extra = {}) => ({ id, run: { op: 'review-pr', input: { repo: 'o/r', pr }, findings: { read: { netBasis: { rev: head } } },
    stepTimings: [{ step: 'read', startedAt: new Date(startedAt).toISOString() }], verdict: { verdict: 'needs-human' }, pending: { kind: 'confirm' }, ...extra } });
  const settledFor = runs => settleUnknownEvidenceByComment(readDrainRedTeamEvidence({ repo: 'o/r', pr, head, env: { WE_SHARED_RUNS_DIR: '/nonexistent-r622' },
    runsDir: '/runs', list: () => runs.map(r => r.id), stat: () => ({ mtimeMs: T - 60e3 }), read: id => runs.find(r => r.id === id).run, readScorecards: () => [], now: T }), [comment()], pr, head);
  it('an older run resumed after the comment holds even when a newer unfinished run started before it', () => {
    const a = mk('review-pr-a', T - 7200e3, { resumeOf: 'x', resumedAt: new Date(T + 3600e3).toISOString() });
    const b = mk('review-pr-b', T - 3600e3);
    expect(settledFor([a, b])).toMatchObject({ ok: false, reason: 'review-unfinished' });
  });
  it('all unfinished runs older than the comment settle', () => {
    expect(settledFor([mk('review-pr-a', T - 7200e3), mk('review-pr-b', T - 3600e3)])).toMatchObject({ ok: true });
  });
});
