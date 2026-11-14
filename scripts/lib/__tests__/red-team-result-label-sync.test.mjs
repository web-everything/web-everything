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
    readSeal: vi.fn(() => null),
    readStatus: vi.fn(() => null),
    sealStored: vi.fn(() => ({ status: 'sealed' })),
    isLegacyRan: vi.fn(() => true),
    log: vi.fn(),
  };
}

describe('syncResultOnHeadLabels', () => {
  it.each(['sealed', 'skipped'])('seals an unsealed trusted same-head result (%s) before syncing clear labels without posting', status => {
    const input = fixture();
    input.readSeal.mockReturnValue({ unsealed: true });
    input.sealStored.mockReturnValue({ status });
    input.sync.mockImplementation(() => {
      expect(input.sealStored).toHaveBeenCalledTimes(1);
      return { add: 'red-team:clear', remove: ['red-team:pending'] };
    });

    const result = syncResultOnHeadLabels(input);

    expect(input.readSeal).toHaveBeenCalledWith({ repo, pr, head, env: expect.any(Object) });
    expect(input.sealStored).toHaveBeenCalledWith({ status: { repo, pr, head }, sealOnly: true,
      listComments: expect.any(Function), postComment: expect.any(Function) });
    const call = input.sealStored.mock.calls[0][0];
    expect(call.listComments()).toBe(input.rawPrs[0].comments);
    expect(() => call.postComment()).toThrow('seal-only never posts');
    expect(input.sync).toHaveBeenCalledTimes(1);
    expect(result.rawPrs[0].labels).toEqual(['bug', 'red-team:clear']);
    expect(result.errors).toEqual([]);
  });

  it.each([null, { breaks: [] }])('does not seal when the seal reader returns %j', seal => {
    const input = fixture();
    input.readSeal.mockReturnValue(seal);
    expect(syncResultOnHeadLabels(input).rawPrs[0].labels).toEqual(['bug', 'red-team:clear']);
    expect(input.sealStored).not.toHaveBeenCalled();
    expect(input.sync).toHaveBeenCalledTimes(1);
  });

  it('ignores a same-head marker from an untrusted author', () => {
    const input = fixture();
    input.rawPrs[0].comments[0].author.login = 'untrusted-contributor';
    expect(syncResultOnHeadLabels(input)).toEqual({ rawPrs: input.rawPrs, applied: [], errors: [] });
    expect(input.readSeal).not.toHaveBeenCalled();
    expect(input.sealStored).not.toHaveBeenCalled();
    expect(input.sync).not.toHaveBeenCalled();
  });

  it.each(['throw', 'retry', 'failed', 'held'])('leaves labels alone and records/logs a seal failure: %s', failure => {
    const input = fixture();
    input.readSeal.mockReturnValue({ unsealed: true });
    input.sealStored.mockImplementation(() => {
      if (failure === 'throw') throw Error('seal failed');
      return { status: failure };
    });
    const result = syncResultOnHeadLabels(input);
    expect(result.rawPrs).toBe(input.rawPrs);
    expect(result.rawPrs[0].labels).toEqual(['bug', 'red-team:pending']);
    expect(result.applied).toEqual([]);
    expect(result.errors).toEqual([{ pr, head, error: expect.any(Error) }]);
    expect(input.log).toHaveBeenCalledTimes(1);
    expect(input.sync).not.toHaveBeenCalled();
  });

  it('never seals a non-legacy unsealed status here (its findings are trusted as stored)', () => {
    const input = fixture();
    input.readSeal.mockReturnValue({ unsealed: true });
    input.isLegacyRan.mockReturnValue(false);
    const result = syncResultOnHeadLabels(input);
    expect(input.sealStored).not.toHaveBeenCalled();
    expect(input.sync).not.toHaveBeenCalled();
    expect(result.rawPrs[0].labels).toEqual(['bug', 'red-team:pending']);
  });

  it('with the REAL publisher, a legacy status whose seat row holds a confirmed break the comment omits stays pending', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { publishStoredRedTeamResult } = await import('../red-team-withheld-publish.mjs');
    const statusDir = mkdtempSync(join(tmpdir(), 'rt-seal-'));
    const status = { repo, pr, head, status: 'finished', result: 'ran' };
    writeFileSync(join(statusDir, `${encodeURIComponent(repo)}-${pr}-${head}.json`), JSON.stringify(status));
    const row = { rev: head, findings: [{ confirmedByRecheck: true, category: 'correctness', summary: 'Break', file: 'a.mjs', line: 1 }],
      foldedVerdict: 'changes', confirmedMissCount: 1, provider: 'codex', model: 'x', callId: 'c', recheckStatus: 'done' };
    const input = fixture();
    input.readSeal.mockReturnValue({ unsealed: true });
    input.sealStored = args => publishStoredRedTeamResult({ ...args, statusDir, readSeatRow: () => row, publishNeedsYou: () => {} });
    const result = syncResultOnHeadLabels(input);
    expect(input.sync).not.toHaveBeenCalled();
    expect(result.rawPrs[0].labels).toEqual(['bug', 'red-team:pending']);
    expect(result.errors).toHaveLength(1);
  });

  it('keeps a sealed same-head result with confirmed breaks blocked', () => {
    const input = fixture();
    input.rawPrs[0].comments[0].body = renderRedTeamComment({ pr, rev: head, provider: 'codex', model: 'fixture',
      findings: [{ confirmedByRecheck: true, category: 'correctness', summary: 'Confirmed break', file: 'example.mjs', line: 1 }],
      foldedVerdict: 'changes' });
    input.readSeal.mockReturnValue({ unsealed: true });
    input.sync.mockReturnValue({ add: 'red-team:blocked', remove: ['red-team:pending'] });
    const result = syncResultOnHeadLabels(input);
    expect(input.sealStored).toHaveBeenCalledTimes(1);
    expect(input.sync).toHaveBeenCalledTimes(1);
    expect(result.rawPrs[0].labels).toEqual(['bug', 'red-team:blocked']);
  });

  it.each(['red-team:clear', 'red-team:blocked'])('syncs a finished current-head result with stale pending and projects the returned %s plan', label => {
    const input = fixture();
    const before = structuredClone(input.rawPrs);
    const plan = { add: label, remove: ['red-team:pending'] };
    input.sync.mockReturnValue(plan);
    // Validate the fixture with the real shared trust and exact-head gate.
    expect(redTeamForHead(input.rawPrs[0].comments, pr, head)).toMatchObject({ pr, rev: head });

    const result = syncResultOnHeadLabels(input);

    expect(input.sync).toHaveBeenCalledTimes(1);
    expect(input.sync).toHaveBeenCalledWith({ repo, pr, head, env: expect.any(Object), log: input.log, provider: expect.any(Object) });
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
    expect(input.readSeal).not.toHaveBeenCalled();
    expect(input.sealStored).not.toHaveBeenCalled();
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

import { headGuardedProvider } from '../red-team-result-label-sync.mjs';
describe('syncResultOnHeadLabels without a refusal', () => {
  it('clears pending for a finished current-head result with no already-reviewed-head refusal', () => {
    const input = { ...fixture(), refusals: [] };
    input.readSeal.mockReturnValue({ breaks: [], legacyHold: false });
    input.readStatus.mockReturnValue({ sealVersion: 2 });
    const result = syncResultOnHeadLabels(input);
    expect(input.sync).toHaveBeenCalledTimes(1);
    expect(result.applied).toHaveLength(1);
    expect(result.rawPrs[0].labels).toEqual(['bug', 'red-team:clear']);
  });

  it('keeps pending for a garbled result and for a non-legacy unsealed result', () => {
    const garbled = { ...fixture(), refusals: [] };
    garbled.rawPrs[0].comments = [{ ...resultComment(), body: 'red-team result: ??? garbled' }];
    expect(syncResultOnHeadLabels(garbled)).toEqual({ rawPrs: garbled.rawPrs, applied: [], errors: [] });
    expect(garbled.sync).not.toHaveBeenCalled();
    const unsealed = { ...fixture(), refusals: [] };
    unsealed.readSeal.mockReturnValue({ unsealed: true });
    unsealed.isLegacyRan.mockReturnValue(false);
    expect(syncResultOnHeadLabels(unsealed).applied).toEqual([]);
    expect(unsealed.sync).not.toHaveBeenCalled();
  });

  it('keeps pending when no stored evidence backs the comment (marker alone is not proof)', () => {
    const input = { ...fixture(), refusals: [] };
    expect(syncResultOnHeadLabels(input).applied).toEqual([]);
    expect(input.sync).not.toHaveBeenCalled();
  });

  it('keeps pending on an old-format (unversioned) sealedBreaks: [] seal', () => {
    const input = { ...fixture(), refusals: [] };
    input.readSeal.mockReturnValue({ breaks: [], legacyHold: false });
    input.readStatus.mockReturnValue({ sealedBreaks: [] });
    expect(syncResultOnHeadLabels(input).applied).toEqual([]);
    expect(input.sync).not.toHaveBeenCalled();
  });

  it('keeps pending when only unvalidated stored findings exist (no seal)', () => {
    const input = { ...fixture(), refusals: [] };
    input.readSeal.mockReturnValue({ findings: [null, { confirmedByRecheck: 'true' }] });
    expect(syncResultOnHeadLabels(input).applied).toEqual([]);
    expect(input.sync).not.toHaveBeenCalled();
  });

  it('keeps pending when the stored seal is unreadable', () => {
    const input = { ...fixture(), refusals: [] };
    input.readSeal.mockReturnValue({ unreadable: true });
    expect(syncResultOnHeadLabels(input).applied).toEqual([]);
    expect(input.sync).not.toHaveBeenCalled();
  });

  it('leaves a PR whose only result is for another head untouched', () => {
    const input = { ...fixture(), refusals: [] };
    input.rawPrs[0].comments = [resultComment(olderHead)];
    expect(syncResultOnHeadLabels(input)).toEqual({ rawPrs: input.rawPrs, applied: [], errors: [] });
    expect(input.sync).not.toHaveBeenCalled();
  });
});

describe('headGuardedProvider', () => {
  const head = 'a'.repeat(40);
  it('writes when the live head still matches', () => {
    const setLabels = vi.fn();
    headGuardedProvider({ readPrState: () => ({ headRefOid: head }), setLabels }, head).setLabels('r', 1, { add: 'x' });
    expect(setLabels).toHaveBeenCalledOnce();
  });
  it('refuses the write when the head moved before it', () => {
    const setLabels = vi.fn();
    expect(() => headGuardedProvider({ readPrState: () => ({ headRefOid: 'b'.repeat(40) }), setLabels }, head).setLabels('r', 1, {})).toThrow(/head moved/);
    expect(setLabels).not.toHaveBeenCalled();
  });
});
