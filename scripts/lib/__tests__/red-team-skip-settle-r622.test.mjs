// @vitest-environment node
// R622: the review side saw "red-team result already on head" while the drain held the same head as
// unknown run evidence (review-unfinished / scan-capped). A trusted result comment bound to the exact
// head settles those two reasons; a recorded break still sends back; missing evidence still fails closed.
import { describe, expect, it } from 'vitest';
import { settleUnknownEvidenceByComment } from '../drain-red-team-evidence.mjs';
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
});
