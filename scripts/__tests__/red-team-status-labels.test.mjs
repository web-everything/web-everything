// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { syncResultOnHeadLabels } from '../lib/red-team-result-label-sync.mjs';
import { publishStoredRedTeamResult } from '../lib/red-team-withheld-publish.mjs';
import { sealedFromStatus } from '../lib/red-team-sealed-status.mjs';
import { parseRedTeamComment, readRedTeamDisposition, redTeamGateMarker, redTeamResultId, sealedBreakKeys } from '../lib/red-team-gate.mjs';
import { OPERATOR_LOGINS } from '../lib/marker-authorship.mjs';
import { renderRedTeamComment } from '../operations/review-extra-seats.mjs';

// Mock persistence only: tests that omit readResult exercise the production reader wiring.
const memory = vi.hoisted(() => ({ status: null }));
vi.mock('../lib/red-team-sealed-status.mjs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, readStoredRedTeamStatus: vi.fn(() => structuredClone(memory.status)),
    readSealedStatus: vi.fn(({ head }) => actual.sealedFromStatus(memory.status, head)) };
});

const repo = 'o/n', pr = 42, head = 'a'.repeat(40), olderHead = 'b'.repeat(40);
const now = '2026-11-14T12:00:00.000Z', identity = { repo, pr, head };
const finding = { confirmedByRecheck: true, category: 'correctness', file: 'scripts/x.mjs', line: 1, summary: 'Boundary bypass' };
const result = (extra = {}) => ({ status: 'ran', comment: 'posted', foldedVerdict: 'accept', confirmedMissCount: 0, findings: [], ...extra });
const seal = () => ({ schema: 3, ...identity, breaks: [], foldedVerdict: 'accept', confirmedMissCount: 0, sealedAt: now });
const stored = (extra = {}) => ({ ...identity, status: 'finished', result: result(), sealedBreaks: [], seal: seal(), ...extra });
const comment = (findings = [], rev = head) => ({ author: { login: OPERATOR_LOGINS[0] }, createdAt: now,
  body: renderRedTeamComment({ pr, rev, findings, foldedVerdict: findings.length ? 'changes' : 'accept', provider: 'codex', model: 'fixture' }) });
function publisher(extra = {}) {
  return { status: identity, statusDir: 'fixture-red-team-status', readStatus: () => structuredClone(memory.status),
    writeStatus: vi.fn(next => { memory.status = structuredClone(next); }), withLock: (_path, fn) => fn(),
    listComments: () => [], postComment: vi.fn(), publishNeedsYou: vi.fn(), now: () => now, ...extra };
}
function fixture(labels = ['red-team:pending'], comments = [comment()]) {
  const row = { number: pr, headRefOid: head, labels, comments };
  const provider = { readPrState: vi.fn(() => structuredClone(row)), readComments: vi.fn(() => comments),
    readPrFiles: vi.fn(() => [{ path: 'scripts/x.mjs' }]), ensureLabel: vi.fn(), setLabels: vi.fn() };
  return { repo, env: { WE_RED_TEAM_STATUS_LABELS: 'true', WE_RED_TEAM_OPERATOR_RULINGS_ANY_STATE: 'true' },
    refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }], rawPrs: [row], provider,
    readStatus: () => structuredClone(memory.status),
    readSeal: () => sealedFromStatus(memory.status, head), isLegacyRan: () => memory.status?.result === 'ran',
    sealStored: vi.fn(args => publishStoredRedTeamResult({ ...publisher(), ...args })), log: vi.fn() };
}
const pending = () => ({ outcome: 'pending', reason: 'unreadable evidence; operator review required', breaks: [] });

function candidateBatch(labels) {
  memory.status = null;
  const input = fixture();
  input.refusals = [];
  // A result on an older head proves each head moved, so a stale blocked label may be refreshed (audit r3).
  const thread = [comment([], olderHead)];
  input.rawPrs = labels.map((label, index) => ({ number: index + 1, state: 'OPEN', headRefOid: head, labels: [label],
    comments: thread.map(c => ({ ...c, body: c.body.replace(`pr=${pr} `, `pr=${index + 1} `) })) }));
  input.provider.readPrState.mockImplementation((_repo, number) => structuredClone(input.rawPrs[number - 1]));
  input.provider.readComments.mockImplementation((_repo, number) => input.rawPrs[number - 1].comments);
  return input;
}

beforeEach(() => { memory.status = stored(); });

describe('slice 1 result reader adoption and guarded publication', () => {
  it("publisher seals v3 only from validated evidence; malformed evidence seals 'unreadable' and posts nothing that clears", () => {
    memory.status = stored({ seal: undefined, sealedBreaks: undefined, result: result({ comment: 'withheld' }) });
    const valid = publisher();
    expect(publishStoredRedTeamResult(valid).status).toBe('posted');
    expect(memory.status.seal).toEqual(seal());
    expect(valid.postComment).toHaveBeenCalledTimes(1);
    for (const r of [result({ findings: [null] }), result({ findings: [{ confirmedByRecheck: 'true' }] }),
      result({ findings: [{}], confirmedMissCount: 1 }), result({ foldedVerdict: 'changes' }), result({ foldedVerdict: undefined })]) {
      memory.status = stored({ seal: undefined, sealedBreaks: undefined, result: { ...r, comment: 'withheld' } });
      const invalid = publisher();
      publishStoredRedTeamResult(invalid);
      expect(memory.status.sealedBreaks).toBe('unreadable');
      expect(memory.status.seal).toBeUndefined();
      expect(invalid.postComment).not.toHaveBeenCalled();
      expect(invalid.writeStatus).toHaveBeenCalled();
    }
  });

  it('#1370 refused branch: an unversioned empty seal on an already-reviewed-head refusal never adds red-team:clear', () => {
    memory.status = stored({ seal: undefined, result: 'resumed' });
    const input = fixture(); // Default reader and default label synchronizer.
    const output = syncResultOnHeadLabels(input);
    expect(output.rawPrs[0].labels).not.toContain('red-team:clear');
    expect(output.applied.some(plan => plan.add === 'red-team:clear')).toBe(false);
    expect(input.provider.setLabels.mock.calls.some(([, , plan]) => plan.add === 'red-team:clear')).toBe(false);
  });

  it('stale red-team:blocked on a moved head (live head has no own or carried result) is refreshed to red-team:pending', () => {
    memory.status = null;
    const input = fixture(['bug', 'red-team:blocked'], [comment([], olderHead)]);
    input.refusals = [];
    input.readResult = vi.fn(pending);
    const output = syncResultOnHeadLabels(input);
    expect(input.readResult).toHaveBeenCalled();
    expect(input.provider.setLabels).toHaveBeenCalledWith(repo, pr, expect.objectContaining({ add: 'red-team:pending', remove: ['red-team:blocked'] }));
    expect(output.rawPrs[0].labels).toEqual(['bug', 'red-team:pending']);
  });

  it('audit: red-team:blocked stays when this head has a stored break but no posted comment', () => {
    const breaks = sealedBreakKeys([finding]);
    for (const status of [stored({ result: 'ran', sealedBreaks: breaks, seal: { ...seal(), breaks, foldedVerdict: 'changes', confirmedMissCount: 1 } }),
      { unreadable: true }]) {
      memory.status = status;
      const input = fixture(['red-team:blocked'], []);
      input.readResult = vi.fn(pending);
      const output = syncResultOnHeadLabels(input);
      expect(input.provider.setLabels).not.toHaveBeenCalled();
      expect(output.rawPrs[0].labels).toEqual(['red-team:blocked']);
    }
  });

  it('red-team:blocked on the SAME head is never downgraded when the reader says pending', () => {
    memory.status = stored({ seal: undefined, result: 'resumed' });
    const input = fixture(['red-team:blocked']);
    input.readResult = vi.fn(pending);
    const output = syncResultOnHeadLabels(input);
    expect(input.readResult).toHaveBeenCalled();
    expect(input.provider.setLabels).not.toHaveBeenCalled();
    expect(output.rawPrs[0].labels).toEqual(['red-team:blocked']);
  });

  it('audit r3: blocked stays on an unchanged head with no status and no comments', () => {
    memory.status = null;
    const input = fixture(['red-team:blocked'], []);
    const output = syncResultOnHeadLabels(input);
    expect(input.provider.setLabels).not.toHaveBeenCalled();
    expect(output.rawPrs).toBe(input.rawPrs);
    expect(output.rawPrs[0].labels).toEqual(['red-team:blocked']);
    expect(output.applied).toEqual([]);
    expect(output.errors).toEqual([]);
  });

  it('audit r3: an untrusted older-head red-team comment is no proof the head moved', () => {
    memory.status = null;
    const forged = { ...comment([], olderHead), author: { login: 'someone-else' } };
    const input = fixture(['red-team:blocked'], [forged]);
    const output = syncResultOnHeadLabels(input);
    expect(input.provider.setLabels).not.toHaveBeenCalled();
    expect(output.rawPrs[0].labels).toEqual(['red-team:blocked']);
  });

  it('audit r3: head moving during the evidence re-read blocks the label write', () => {
    const input = fixture();
    const before = structuredClone(input.rawPrs);
    input.provider.readComments.mockImplementationOnce(() => input.rawPrs[0].comments)
      .mockImplementationOnce(() => {
        input.provider.readPrState.mockReturnValue({ ...before[0], headRefOid: olderHead });
        return input.rawPrs[0].comments;
      });
    const output = syncResultOnHeadLabels(input);
    expect(input.provider.readComments).toHaveBeenCalledTimes(2);
    expect(input.provider.setLabels).not.toHaveBeenCalled();
    expect(output.rawPrs).toEqual(before);
    expect(output.applied).toEqual([]);
    expect(output.errors).toEqual([{ pr, head, error: expect.any(Error) }]);
    expect(output.errors[0].error.message).toBe('head moved before label write');
  });

  it('red-team:blocked with reader clear (operator-carded break, agreeing v3 seal) becomes red-team:clear', () => {
    // #6777: recover the legacy bare ran + [] through the real publisher's sealOnly path.
    const c = comment([finding]);
    const ruling = { author: { login: OPERATOR_LOGINS[0] }, createdAt: '2026-11-14T12:01:00.000Z',
      body: `${redTeamGateMarker(pr, head, 'operator-card', redTeamResultId(parseRedTeamComment(c.body)))}\n- 1 finding(s) carded by the operator to \`we:123\` (#1).` };
    memory.status = stored({ seal: undefined, result: 'ran' });
    const input = fixture(['bug', 'red-team:blocked'], [c, ruling]);
    const io = publisher({ readSeatRow: () => ({ rev: head, findings: [finding], foldedVerdict: 'changes', confirmedMissCount: 1,
      provider: 'codex', model: 'fixture', callId: 'fixture-call', recheckStatus: 'done' }) });
    input.sealStored = vi.fn(args => publishStoredRedTeamResult({ ...io, ...args }));
    const output = syncResultOnHeadLabels(input);
    expect(input.sealStored).toHaveBeenCalledWith(expect.objectContaining({ sealOnly: true }));
    expect(io.postComment).not.toHaveBeenCalled();
    expect(memory.status.seal).toMatchObject({ schema: 3, ...identity, breaks: sealedBreakKeys([finding]), foldedVerdict: 'changes', confirmedMissCount: 1 });
    expect(readRedTeamDisposition({ ...identity, comments: [c, ruling], env: input.env, sealed: { breaks: sealedBreakKeys([finding]) } }))
      .toMatchObject({ sendBack: [], held: [] });
    expect(input.provider.setLabels).toHaveBeenCalledWith(repo, pr, expect.objectContaining({ add: 'red-team:clear', remove: ['red-team:blocked'] }));
    expect(output.rawPrs[0].labels).toEqual(['bug', 'red-team:clear']);
  });

  it('#1349/#1347 re-read at publish: head moves or the status file changes between plan and setLabels -> no label write', () => {
    for (const race of ['head', 'status']) {
      memory.status = stored();
      const input = fixture();
      // Provisioning occurs after planning and before the guarded provider's setLabels.
      input.provider.ensureLabel.mockImplementation(() => {
        if (race === 'head') input.rawPrs[0].headRefOid = olderHead;
        else memory.status = stored({ seal: undefined, sealedBreaks: 'unreadable', result: {} });
      });
      const output = syncResultOnHeadLabels(input);
      expect(input.provider.ensureLabel).toHaveBeenCalled();
      expect(input.provider.setLabels).not.toHaveBeenCalled();
      expect(output.rawPrs[0].labels).toEqual(['red-team:pending']);
      expect(output.applied).toEqual([]);
    }
  });

  it('reconciles the 33rd candidate when the first 32 need no label changes', () => {
    const input = candidateBatch([...Array(32).fill('red-team:pending'), 'red-team:blocked']);
    const output = syncResultOnHeadLabels(input);
    expect(output.errors).toEqual([]);
    expect(input.provider.setLabels).toHaveBeenCalledTimes(1);
    expect(input.provider.setLabels).toHaveBeenCalledWith(repo, 33, { add: 'red-team:pending', remove: ['red-team:blocked'] });
    expect(output.rawPrs[32].labels).toEqual(['red-team:pending']);
  });

  it('caps label writes at 32 and reconciles the deferred 33rd PR on the next tick', () => {
    const input = candidateBatch(Array(33).fill('red-team:blocked'));
    const first = syncResultOnHeadLabels(input);
    expect(first.errors).toEqual([]);
    expect(first.applied).toHaveLength(32);
    expect(input.provider.setLabels).toHaveBeenCalledTimes(32);
    expect(first.rawPrs[32].labels).toEqual(['red-team:blocked']);
    expect(input.log).toHaveBeenCalledWith('red-team label write cap reached; retry remaining PRs next tick');
    input.rawPrs = first.rawPrs;
    input.provider.setLabels.mockClear();
    const second = syncResultOnHeadLabels(input);
    expect(second.errors).toEqual([]);
    expect(second.applied).toHaveLength(1);
    expect(input.provider.setLabels).toHaveBeenCalledTimes(1);
    expect(input.provider.setLabels).toHaveBeenCalledWith(repo, 33, { add: 'red-team:pending', remove: ['red-team:blocked'] });
    expect(second.rawPrs[32].labels).toEqual(['red-team:pending']);
  });

  it('a PR with neither refusal nor red-team label is untouched', () => {
    const input = fixture(['bug']);
    input.refusals = [];
    input.readResult = vi.fn(pending);
    const output = syncResultOnHeadLabels(input);
    expect(output.rawPrs).toBe(input.rawPrs);
    expect(output.applied).toEqual([]);
    expect(input.readResult).not.toHaveBeenCalled();
    expect(input.sealStored).not.toHaveBeenCalled();
    expect(input.provider.readPrState).not.toHaveBeenCalled();
    expect(input.provider.setLabels).not.toHaveBeenCalled();
  });
});
