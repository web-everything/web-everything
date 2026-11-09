import { describe, expect, it, vi } from 'vitest';
import { OPERATOR_LOGINS } from '../marker-authorship.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { syncResultOnHeadLabels } from '../red-team-result-label-sync.mjs';

const pr = 5762;
const head = 'a'.repeat(40);

function fixture() {
  return {
    repo: 'web-everything/web-everything',
    refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }],
    rawPrs: [{ number: pr, headRefOid: head, labels: ['bug', 'red-team:pending'], comments: [{
      author: { login: OPERATOR_LOGINS[0] },
      body: renderRedTeamComment({ pr, rev: head, provider: 'codex', model: 'fixture',
        findings: [], foldedVerdict: 'accept' }),
    }] }],
    sync: vi.fn(() => ({ add: 'red-team:clear', remove: ['red-team:pending'] })),
  };
}

describe('result label repair trust boundary', () => {
  it('does not sync an exact-head result from an untrusted author', () => {
    const input = fixture();
    input.rawPrs[0].comments[0].author.login = 'untrusted-contributor';
    const before = structuredClone(input.rawPrs);

    expect(syncResultOnHeadLabels(input)).toEqual({ rawPrs: before, applied: [], errors: [] });
    expect(input.sync).not.toHaveBeenCalled();
    expect(input.rawPrs).toEqual(before);
  });

  it.each(['b'.repeat(40), head.slice(0, 12)])(
    'does not sync when the refusal head %s differs from the full live head', refusalHead => {
      const input = fixture();
      input.refusals[0].headSha = refusalHead;
      const before = structuredClone(input.rawPrs);

      expect(syncResultOnHeadLabels(input)).toEqual({ rawPrs: before, applied: [], errors: [] });
      expect(input.sync).not.toHaveBeenCalled();
      expect(input.rawPrs).toEqual(before);
    },
  );

  it('repairs pending labels for a trusted result matching the unchanged full head', () => {
    const input = fixture();
    const before = structuredClone(input.rawPrs);

    const result = syncResultOnHeadLabels(input);

    expect(input.sync).toHaveBeenCalledTimes(1);
    expect(input.sync).toHaveBeenCalledWith({ repo: input.repo, pr, head,
      env: expect.any(Object), log: expect.any(Function), provider: expect.any(Object) });
    expect(result).toEqual({
      rawPrs: [{ ...before[0], labels: ['bug', 'red-team:clear'] }],
      applied: [{ pr, head, add: 'red-team:clear', remove: ['red-team:pending'] }],
      errors: [],
    });
    expect(input.rawPrs).toEqual(before);
  });
});
