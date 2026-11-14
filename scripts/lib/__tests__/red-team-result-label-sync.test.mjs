import { describe, expect, it, vi } from 'vitest';
import { OPERATOR_LOGINS } from '../marker-authorship.mjs';
import { redTeamForHead, sealedBreakKeys } from '../red-team-gate.mjs';
import { readRedTeamResult } from '../red-team-result-schema.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { syncResultOnHeadLabels } from '../red-team-result-label-sync.mjs';

const repo = 'web-everything/web-everything';
const pr = 5762;
const head = 'a'.repeat(40);
const olderHead = 'b'.repeat(40);
const sealedAt = '2026-11-08T12:00:00.000Z';
const confirmedFinding = { confirmedByRecheck: true, category: 'correctness', summary: 'Confirmed break', file: 'example.mjs', line: 1 };

// The sync's status read is injected; prevent disposition reads from using host state.
vi.mock('../red-team-sealed-status.mjs', async importOriginal => ({
  ...await importOriginal(), readSealedStatus: vi.fn(() => null),
}));

function storedStatus(findings = []) {
  const breaks = sealedBreakKeys(findings);
  const foldedVerdict = breaks.length ? 'changes' : 'accept';
  return { repo, pr, head, status: 'finished', sealedBreaks: breaks,
    result: { status: 'ran', comment: 'posted', findings, foldedVerdict, confirmedMissCount: breaks.length },
    seal: { schema: 3, repo, pr, head, breaks, foldedVerdict, confirmedMissCount: breaks.length, sealedAt } };
}

const legacyStatus = () => ({ repo, pr, head, status: 'finished', result: 'ran' });
const writePlan = plan => ({ provider }) => {
  provider.ensureLabel(repo, plan.add, {});
  provider.setLabels(repo, pr, plan);
  return plan;
};

function resultComment(rev = head, findings = []) {
  return {
    body: renderRedTeamComment({ pr, rev, provider: 'codex', model: 'fixture', findings, foldedVerdict: findings.length ? 'changes' : 'accept' }),
    author: { login: OPERATOR_LOGINS[0] },
    createdAt: '2026-11-08T12:00:00Z',
  };
}

function fixture(findings = []) {
  const plan = { add: findings.length ? 'red-team:blocked' : 'red-team:clear', remove: ['red-team:pending'] };
  const input = {
    repo,
    env: { WE_RED_TEAM_STATUS_LABELS: 'true' },
    rawPrs: [{ number: pr, state: 'OPEN', headRefOid: head, comments: [resultComment(head, findings)], labels: ['bug', 'red-team:pending'] }],
    status: storedStatus(findings),
    readStatus: vi.fn(() => structuredClone(input.status)),
    readResult: vi.fn(readRedTeamResult),
    sync: vi.fn(writePlan(plan)),
    sealStored: vi.fn(() => { input.status = storedStatus(findings); return { status: 'sealed' }; }),
    provider: {
      readPrState: vi.fn(() => structuredClone(input.rawPrs[0])),
      readComments: vi.fn(() => input.rawPrs[0].comments),
      ensureLabel: vi.fn(), setLabels: vi.fn(),
    },
    log: vi.fn(),
  };
  return input;
}

describe('syncResultOnHeadLabels', () => {
  it.each(['sealed', 'skipped'])('seals an unsealed trusted same-head result (%s) before syncing clear labels without posting', status => {
    const input = fixture();
    input.status = legacyStatus();
    input.sealStored.mockImplementation(() => { input.status = storedStatus(); return { status }; });
    input.sync.mockImplementation(args => {
      expect(input.sealStored).toHaveBeenCalledTimes(1);
      return writePlan({ add: 'red-team:clear', remove: ['red-team:pending'] })(args);
    });

    const result = syncResultOnHeadLabels(input);

    expect(input.readStatus).toHaveBeenCalledWith({ repo, pr, head, env: expect.any(Object) });
    expect(input.readStatus).toHaveBeenCalledTimes(3);
    expect(input.sealStored).toHaveBeenCalledWith({ status: { repo, pr, head }, sealOnly: true,
      listComments: expect.any(Function), postComment: expect.any(Function) });
    const call = input.sealStored.mock.calls[0][0];
    expect(call.listComments()).toBe(input.rawPrs[0].comments);
    expect(() => call.postComment()).toThrow('seal-only never posts');
    expect(input.sync).toHaveBeenCalledTimes(1);
    expect(input.provider.setLabels).toHaveBeenCalledTimes(1);
    expect(result.rawPrs[0].labels).toEqual(['bug', 'red-team:clear']);
    expect(result.errors).toEqual([]);
  });

  it.each([
    ['a trusted comment without stored evidence', null],
    ['an unversioned empty seal without validated posted findings', { ...legacyStatus(), result: { status: 'ran', comment: 'posted' }, sealedBreaks: [] }],
  ])('refuses clear from %s', (_name, status) => {
    const input = fixture();
    input.status = status;
    expect(syncResultOnHeadLabels(input)).toEqual({ rawPrs: input.rawPrs, applied: [], errors: [] });
    expect(input.rawPrs[0].labels).toEqual(['bug', 'red-team:pending']);
    expect(input.sealStored).not.toHaveBeenCalled();
    expect(input.sync).not.toHaveBeenCalled();
    expect(input.provider.setLabels).not.toHaveBeenCalled();
    expect(input.readResult).toHaveReturnedWith(expect.objectContaining({ outcome: 'pending' }));
  });

  it('clears a validated posted result without a seal and does not reseal it', () => {
    const input = fixture();
    delete input.status.seal;
    delete input.status.sealedBreaks;
    expect(syncResultOnHeadLabels(input).rawPrs[0].labels).toEqual(['bug', 'red-team:clear']);
    expect(input.sealStored).not.toHaveBeenCalled();
    expect(input.sync).toHaveBeenCalledTimes(1);
    expect(input.provider.setLabels).toHaveBeenCalledTimes(1);
  });

  it('ignores a same-head marker from an untrusted author', () => {
    const input = fixture();
    input.rawPrs[0].comments[0].author.login = 'untrusted-contributor';
    expect(syncResultOnHeadLabels(input)).toEqual({ rawPrs: input.rawPrs, applied: [], errors: [] });
    expect(input.provider.setLabels).not.toHaveBeenCalled();
    expect(input.sealStored).not.toHaveBeenCalled();
    expect(input.sync).not.toHaveBeenCalled();
  });

  it.each(['throw', 'retry', 'failed', 'held'])('leaves labels alone and records/logs a seal failure: %s', failure => {
    const input = fixture();
    input.status = legacyStatus();
    input.sealStored.mockImplementation(() => {
      if (failure === 'throw') throw Error('seal failed');
      return { status: failure };
    });
    const result = syncResultOnHeadLabels(input);
    expect(result.rawPrs).toBe(input.rawPrs);
    expect(result.rawPrs[0].labels).toEqual(['bug', 'red-team:pending']);
    expect(result.applied).toEqual([]);
    expect(result.errors).toEqual([{ pr, head, error: expect.any(Error) }]);
    const failureLog = `red-team result label sync failed for PR #${pr}; retry next tick`;
    expect(input.log).toHaveBeenCalledTimes(2); // Setting provenance plus exactly one failure.
    expect(input.log.mock.calls[0][0]).toMatch(/statusLabels=true/);
    expect(input.log.mock.calls.filter(([line]) => line === failureLog)).toEqual([[failureLog]]);
    expect(input.sync).not.toHaveBeenCalled();
    expect(input.provider.setLabels).not.toHaveBeenCalled();
  });

  it('never seals a non-legacy unsealed status here (its findings are trusted as stored)', () => {
    const input = fixture();
    delete input.status.seal;
    delete input.status.sealedBreaks;
    input.status.result.comment = 'withheld';
    const result = syncResultOnHeadLabels(input);
    expect(input.sealStored).not.toHaveBeenCalled();
    expect(input.sync).not.toHaveBeenCalled();
    expect(result.rawPrs[0].labels).toEqual(['bug', 'red-team:pending']);
  });

  it('with the REAL publisher, a legacy status whose seat row holds a confirmed break the comment omits stays pending', async () => {
    const { publishStoredRedTeamResult } = await import('../red-team-withheld-publish.mjs');
    const row = { rev: head, findings: [{ confirmedByRecheck: true, category: 'correctness', summary: 'Break', file: 'a.mjs', line: 1 }],
      foldedVerdict: 'changes', confirmedMissCount: 1, provider: 'codex', model: 'x', callId: 'c', recheckStatus: 'done' };
    const input = fixture();
    input.status = legacyStatus();
    input.sealStored = args => publishStoredRedTeamResult({ ...args, statusDir: 'fixture-red-team-status',
      readStatus: () => structuredClone(input.status), writeStatus: next => { input.status = next; },
      withLock: (_path, fn) => fn(), readSeatRow: () => row, publishNeedsYou: () => {}, now: () => sealedAt });
    const result = syncResultOnHeadLabels(input);
    expect(input.sync).not.toHaveBeenCalled();
    expect(result.rawPrs[0].labels).toEqual(['bug', 'red-team:pending']);
    expect(result.errors).toHaveLength(1);
  });

  it('keeps a sealed same-head result with confirmed breaks blocked', () => {
    const input = fixture([confirmedFinding]);
    input.status = legacyStatus();
    const result = syncResultOnHeadLabels(input);
    expect(input.sealStored).toHaveBeenCalledTimes(1);
    expect(input.sync).toHaveBeenCalledTimes(1);
    expect(result.rawPrs[0].labels).toEqual(['bug', 'red-team:blocked']);
  });

  it.each(['red-team:clear', 'red-team:blocked'])('syncs a finished current-head result with stale pending and projects the returned %s plan', label => {
    const input = fixture(label === 'red-team:blocked' ? [confirmedFinding] : []);
    const before = structuredClone(input.rawPrs);
    const plan = { add: label, remove: ['red-team:pending'] };
    input.sync.mockImplementation(writePlan(plan));
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
    expect(input.provider.setLabels).not.toHaveBeenCalled();
    expect(input.sealStored).not.toHaveBeenCalled();
  });

  it.each(['red-team:clear', 'red-team:blocked'])('skips an already settled %s label without pending', label => {
    const input = fixture(label === 'red-team:blocked' ? [confirmedFinding] : []);
    input.rawPrs[0].labels = ['bug', label];

    expect(syncResultOnHeadLabels(input)).toEqual({ rawPrs: input.rawPrs, applied: [], errors: [] });
    expect(input.sync).not.toHaveBeenCalled();
  });

  it('fails closed when the stored status head mismatches the live head despite a current-head result', () => {
    const input = fixture();
    input.status.head = olderHead;

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
