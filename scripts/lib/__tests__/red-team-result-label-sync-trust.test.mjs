import { describe, expect, it, vi } from 'vitest';
import { OPERATOR_LOGINS } from '../marker-authorship.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { syncResultOnHeadLabels } from '../red-team-result-label-sync.mjs';
import { readRedTeamResult } from '../red-team-result-schema.mjs';

const repo = 'web-everything/web-everything';
const pr = 5762;
const head = 'a'.repeat(40);
const sealedAt = '2026-11-08T12:00:00.000Z';

vi.mock('../red-team-sealed-status.mjs', async importOriginal => ({
  ...await importOriginal(), readSealedStatus: vi.fn(() => null),
}));

function fixture() {
  const plan = { add: 'red-team:clear', remove: ['red-team:pending'] };
  const input = {
    repo, env: { WE_RED_TEAM_STATUS_LABELS: 'true' }, log: vi.fn(),
    status: { repo, pr, head, status: 'finished', sealedBreaks: [],
      result: { status: 'ran', comment: 'posted', findings: [], foldedVerdict: 'accept', confirmedMissCount: 0 },
      seal: { schema: 3, repo, pr, head, breaks: [], foldedVerdict: 'accept', confirmedMissCount: 0, sealedAt } },
    readStatus: vi.fn(() => structuredClone(input.status)), readResult: vi.fn(readRedTeamResult),
    rawPrs: [{ number: pr, state: 'OPEN', headRefOid: head, labels: ['bug', 'red-team:pending'], comments: [{
      author: { login: OPERATOR_LOGINS[0] },
      body: renderRedTeamComment({ pr, rev: head, provider: 'codex', model: 'fixture',
        findings: [], foldedVerdict: 'accept' }),
    }] }],
    sync: vi.fn(({ provider }) => {
      provider.ensureLabel(repo, plan.add, {});
      provider.setLabels(repo, pr, plan);
      return plan;
    }),
    provider: { readPrState: vi.fn(() => structuredClone(input.rawPrs[0])),
      readComments: vi.fn(() => input.rawPrs[0].comments), ensureLabel: vi.fn(), setLabels: vi.fn() },
  };
  return input;
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
    'does not sync when the stored head %s differs from the full live head', storedHead => {
      const input = fixture();
      input.status.head = storedHead;
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
    expect(input.readStatus).toHaveBeenCalledTimes(2);
    expect(input.provider.setLabels).toHaveBeenCalledWith(repo, pr, { add: 'red-team:clear', remove: ['red-team:pending'] });
  });

  it.each(['b'.repeat(40), head.slice(0, 12)])('ignores stale refusal head %s when validated status and live head agree', refusalHead => {
    const input = fixture();
    input.refusals = [{ kind: 'already-reviewed-head', prNumber: pr, headSha: refusalHead }];
    const result = syncResultOnHeadLabels(input);
    expect(result.errors).toEqual([]);
    expect(result.rawPrs[0].labels).toEqual(['bug', 'red-team:clear']);
    expect(input.provider.setLabels).toHaveBeenCalledTimes(1);
  });
});
