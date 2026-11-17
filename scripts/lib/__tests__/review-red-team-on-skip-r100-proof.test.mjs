// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { planRedTeamOnSkip } from '../review-red-team-on-skip.mjs';
import { redTeamOwedFor } from '../review-red-team-policy.mjs';

const head = 'a'.repeat(40), otherHead = 'b'.repeat(40);
function fixture() {
  const read = { netBasis: { rev: head }, diffText: 'diff --git a/code.mjs b/code.mjs\n+change',
    netChangedFiles: ['code.mjs'] };
  const loopPayload = { verdict: { verdict: 'accept' }, findings: { read } };
  const status = { head, status: 'finished', result: 'not-owed', loopPayload, sealedBreaks: [] };
  const evidence = { loopPayload, status, owed: false, inFlight: false, queued: false,
    recorded: false, seatRecorded: false };
  const raw = { number: 42, headRefOid: head, labels: ['review:accepted', 'red-team:pending'], reviews: [],
    comments: [{ author: { login: 'web-everything' }, body: `✅ review — accepted\n<!-- reviewed-sha: ${head} -->` }] };
  const options = { repo: 'example/project', rawPrs: [raw],
    refusals: [{ kind: 'already-reviewed-head', prNumber: 42, headSha: head }],
    readEvidence: () => evidence, readStatus: () => status, readSeal: () => null,
    setting: { enabled: true, retryCooldownMin: 30 }, now: 2_000_000, lastDispatch: new Map() };
  return { evidence, status, read, raw, options, plan: () => planRedTeamOnSkip(options)[0] };
}

describe('R100 stored owed-pass proof', () => {
  it('clears an accepted exact-head stored review with explicit owed false', () => {
    expect(fixture().plan()).toMatchObject({ action: 'clear', why: 'not owed (stored review)' });
  });

  it.each([true, undefined])('keeps an owed code diff closed with owed=%j', owed => {
    const f = fixture();
    f.evidence.owed = owed;
    expect(f.plan()).toMatchObject({ action: 'review', settlementRetry: true });
  });

  it.each(['stored read', 'selected status', 'live status', 'status read'])(
    'rejects explicit owed false for another head in the %s', source => {
      const f = fixture();
      if (source === 'stored read') f.read.netBasis.rev = otherHead;
      if (source === 'selected status') f.evidence.status = { ...f.status, head: otherHead };
      if (source === 'live status') f.options.readStatus = () => ({ ...f.status, head: otherHead });
      if (source === 'status read') f.status.loopPayload = { ...f.evidence.loopPayload,
        findings: { read: { ...f.read, netBasis: { rev: otherHead } } } };
      const row = f.plan();
      expect(row.action).not.toBe('clear');
      expect(row.settle).toBeUndefined();
    });

  it('requires acceptance provenance for explicit owed false', () => {
    const f = fixture();
    f.raw.comments = [];
    expect(f.plan().action).not.toBe('clear');
  });

  it('does not let a legacy card-only result override explicit owed true', () => {
    const f = fixture();
    f.evidence.owed = true;
    f.read.netChangedFiles = ['backlog/42-card.md'];
    expect(f.plan()).toMatchObject({ action: 'review', settlementRetry: true });
  });

  describe.each([
    ['omitted diff fields', f => {
      delete f.read.diffText;
      delete f.read.netChangedFiles;
    }],
    ['card-only exemption', f => {
      f.read.diffText = 'diff --git a/backlog/42-card.md b/backlog/42-card.md\n+change';
      f.read.netChangedFiles = ['backlog/42-card.md'];
    }],
  ])('legacy finished not-owed with %s', (_name, configure) => {
    function legacyFixture() {
      const f = fixture();
      delete f.evidence.owed;
      configure(f);
      return f;
    }

    it('clears the accepted exact head with owed omitted', () => {
      const f = legacyFixture();
      expect(f.evidence).not.toHaveProperty('owed');
      expect(redTeamOwedFor(f.evidence.loopPayload)).toBe(true);
      expect(f.plan()).toMatchObject({ action: 'clear', why: 'not owed (stored review)' });
    });

    it.each(['stored read', 'selected status', 'live status', 'status read'])(
      'rejects other-head evidence in the %s with owed omitted', source => {
        const f = legacyFixture();
        if (source === 'stored read') f.read.netBasis.rev = otherHead;
        if (source === 'selected status') f.evidence.status = { ...f.status, head: otherHead };
        if (source === 'live status') f.options.readStatus = () => ({ ...f.status, head: otherHead });
        if (source === 'status read') f.status.loopPayload = { ...f.evidence.loopPayload,
          findings: { read: { ...f.read, netBasis: { rev: otherHead } } } };
        const row = f.plan();
        expect(row.action).not.toBe('clear');
        expect(row.settle).toBeUndefined();
      });
  });
});
