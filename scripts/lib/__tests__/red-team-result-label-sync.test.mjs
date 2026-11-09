import { describe, expect, it, vi } from 'vitest';
import { OPERATOR_LOGINS } from '../marker-authorship.mjs';
import { redTeamForHead } from '../red-team-gate.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { syncResultOnHeadLabels } from '../red-team-result-label-sync.mjs';

const repo = 'web-everything/web-everything';
const pr = 5762;
const head = 'a'.repeat(40);
const olderHead = 'b'.repeat(40);

function resultComment(rev = head) {
  return {
    body: renderRedTeamComment({ pr, rev, provider: 'codex', model: 'fixture', findings: [], foldedVerdict: 'accept' }),
    author: { login: OPERATOR_LOGINS[0] },
    createdAt: '2026-11-08T12:00:00Z',
  };
}

function fixture() {
  return {
    repo,
    refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }],
    rawPrs: [{ number: pr, headRefOid: head, comments: [resultComment()], labels: ['bug', 'red-team:pending'] }],
    sync: vi.fn(() => ({ add: 'red-team:clear', remove: ['red-team:pending'] })),
    log: vi.fn(),
  };
}

describe('syncResultOnHeadLabels', () => {
  it.each(['red-team:clear', 'red-team:blocked'])('syncs a finished current-head result with stale pending and projects the returned %s plan', label => {
    const input = fixture();
    const before = structuredClone(input.rawPrs);
    const plan = { add: label, remove: ['red-team:pending'] };
    input.sync.mockReturnValue(plan);
    // Validate the fixture with the real shared trust and exact-head gate.
    expect(redTeamForHead(input.rawPrs[0].comments, pr, head)).toMatchObject({ pr, rev: head });

    const result = syncResultOnHeadLabels(input);

    expect(input.sync).toHaveBeenCalledTimes(1);
    expect(input.sync).toHaveBeenCalledWith({ repo, pr, head, env: expect.any(Object), log: input.log });
    expect(result).toEqual({
      rawPrs: [{ ...before[0], labels: ['bug', label] }],
      applied: [{ pr, head, ...plan }],
      errors: [],
    });
    expect(result.rawPrs).not.toBe(input.rawPrs);
    expect(input.rawPrs).toEqual(before);
  });

  it('fails closed when the trusted result is only for an older head', () => {
    const input = fixture();
    input.rawPrs[0].comments = [resultComment(olderHead)];
    expect(redTeamForHead(input.rawPrs[0].comments, pr, olderHead)).toMatchObject({ rev: olderHead });
    expect(redTeamForHead(input.rawPrs[0].comments, pr, head)).toBeNull();

    expect(syncResultOnHeadLabels(input)).toEqual({ rawPrs: input.rawPrs, applied: [], errors: [] });
    expect(input.sync).not.toHaveBeenCalled();
  });

  it.each(['red-team:clear', 'red-team:blocked'])('skips an already settled %s label without pending', label => {
    const input = fixture();
    input.rawPrs[0].labels = ['bug', label];

    expect(syncResultOnHeadLabels(input)).toEqual({ rawPrs: input.rawPrs, applied: [], errors: [] });
    expect(input.sync).not.toHaveBeenCalled();
  });

  it('fails closed when refusal headSha mismatches the live head despite a current-head result', () => {
    const input = fixture();
    input.refusals[0].headSha = olderHead;

    expect(syncResultOnHeadLabels(input)).toEqual({ rawPrs: input.rawPrs, applied: [], errors: [] });
    expect(input.sync).not.toHaveBeenCalled();
  });

  it('records a sync exception without throwing or projecting unapplied labels', () => {
    const input = fixture();
    const before = structuredClone(input.rawPrs);
    input.sync.mockImplementation(() => { throw new Error('injected label write failure'); });
    let result;

    expect(() => { result = syncResultOnHeadLabels(input); }).not.toThrow();

    expect(input.sync).toHaveBeenCalledTimes(1);
    expect(result.errors).toHaveLength(1);
    expect(result.applied).toEqual([]);
    expect(result.rawPrs).toEqual(before);
    expect(input.rawPrs).toEqual(before);
  });

  it('is idempotent on a second call using the updated rawPrs', () => {
    const input = fixture();
    const first = syncResultOnHeadLabels(input);
    expect(first.rawPrs[0].labels).toEqual(['bug', 'red-team:clear']);
    expect(first.applied).toHaveLength(1);
    expect(input.sync).toHaveBeenCalledTimes(1);

    const second = syncResultOnHeadLabels({ ...input, rawPrs: first.rawPrs });

    expect(input.sync).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ rawPrs: first.rawPrs, applied: [], errors: [] });
  });
});
