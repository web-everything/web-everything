import { describe, expect, it, vi } from 'vitest';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { settleUnknownEvidenceByComment } from '../../lib/drain-red-team-evidence.mjs';
import {
  clearHumanViaCli, R11_REASON, resolveDelegatedClearHumanMode, evaluateEligibility, runDelegatedClearHuman, liveRedTeam,
} from '../delegated-clear-human.mjs';

const HEAD = 'a'.repeat(40);
const pr = (over = {}) => ({
  number: 7, headRefOid: HEAD, headRefName: 'lane/x', baseRefName: 'main',
  labels: ['review:human', 'advisory:accepted', 'red-team:clear'].map((name) => ({ name })),
  statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }, { name: 'merge-gate', conclusion: 'FAILURE' }],
  ...over,
});
const deps = (over = {}) => ({
  scoreNet: () => ({ scored: true, humanRequired: false, files: 3 }),
  redTeamClearAtHead: () => true,
  readLiveHead: () => HEAD,
  ...over,
});

describe('live red-team evidence for delegated clear-human (PR 6945)', () => {
  const repo = 'example/project', number = 6945;
  const at = Date.parse('2026-11-10T12:00:00Z');
  const unknown = (over = {}) => ({ ok: false, reason: 'review-unfinished', settleBounds: {
    unfinishedUndecided: true, unfinishedStartedAt: at - 4 * 3600e3,
    unfinishedActiveAt: at - 3 * 3600e3, evaluatedAt: at,
    completeHeadRead: () => ({ complete: true, blocked: false }), ...over,
  } });
  const result = (rev = HEAD, blocked = false) => ({ author: { login: 'web-everything' }, createdAt: new Date(at).toISOString(),
    body: renderRedTeamComment({ pr: number, rev, provider: 'codex', model: 'm', recheckStatus: 'ok',
      foldedVerdict: blocked ? 'changes' : 'accept', findings: blocked
        ? [{ summary: 'break', category: 'edge-case', impactIfUnfixed: 'broken', confirmedByRecheck: true }] : [] }) });

  it('proves clear from a head-bound result despite a stale unfinished review run', async () => {
    const readEvidence = vi.fn(() => unknown());
    const checker = await liveRedTeam({ repo, readEvidence });
    const p = pr({ number, comments: [result()], reviews: [] });
    expect(readEvidence()).toMatchObject({ ok: false, reason: 'review-unfinished' });
    expect(checker(p, HEAD)).toBe(true);
    const evaluated = evaluateEligibility(p, deps({ redTeamClearAtHead: checker }));
    expect(evaluated.eligible).toBe(true);
    expect(evaluated.evidence.redTeam).toBe('clear');
    expect(evaluated.failed).not.toContain('red-team:clear not proven on the current head');
    expect(readEvidence).toHaveBeenLastCalledWith({ repo, pr: number, head: HEAD });
  });

  it.each(['blocked', 'absent', 'another head', 'untrusted', 'still active', 'incomplete read'])('does not prove clear with %s evidence', async kind => {
    const evidence = unknown(kind === 'still active' ? { unfinishedActiveAt: at } : kind === 'incomplete read'
      ? { completeHeadRead: () => ({ complete: false, blocked: false }) } : {});
    const comments = kind === 'absent' ? [] : [result(kind === 'another head' ? 'b'.repeat(40) : HEAD, kind === 'blocked')];
    if (kind === 'untrusted') comments[0].author.login = 'outsider';
    const checker = await liveRedTeam({ repo, readEvidence: () => evidence });
    const p = pr({ number, comments, reviews: [] });
    if (kind === 'blocked') expect(settleUnknownEvidenceByComment(evidence, comments, number, HEAD).ok).toBe(true);
    expect(checker(p, HEAD)).toBe(false);
    const evaluated = evaluateEligibility(p, deps({ redTeamClearAtHead: checker }));
    expect(evaluated.eligible).toBe(false);
    expect(evaluated.failed).toContain('red-team:clear not proven on the current head');
  });
});

describe('mode setting', () => {
  it('defaults to shadow and reports the source', () => {
    expect(resolveDelegatedClearHumanMode({})).toMatchObject({ value: 'shadow', source: 'standard' });
  });
  it('cascades platform < repo < env and ignores invalid values', () => {
    const r = resolveDelegatedClearHumanMode({
      platform: { delegatedClearHuman: { mode: 'on' } },
      repo: { delegatedClearHuman: { mode: 'bogus' } },
      env: { WE_DELEGATED_CLEAR_HUMAN_MODE: 'off' },
    });
    expect(r.value).toBe('off');
    expect(r.source).toBe('env');
    expect(r.ignored.length).toBe(1);
  });
});

describe('evaluateEligibility', () => {
  it('is eligible when every condition holds (merge-gate review hold is ignored)', () => {
    const r = evaluateEligibility(pr(), deps());
    expect(r.eligible).toBe(true);
    expect(r.evidence.head).toBe(HEAD);
  });
  it.each([
    ['no acceptance label', pr({ labels: [{ name: 'review:human' }, { name: 'red-team:clear' }] })],
    ['red-team:clear missing', pr({ labels: [{ name: 'review:human' }, { name: 'advisory:accepted' }] })],
    ['a failing required check', pr({ statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE' }] })],
    ['empty check rollup (fail closed)', pr({ statusCheckRollup: [] })],
    ['not human-held', pr({ labels: [{ name: 'advisory:accepted' }, { name: 'red-team:clear' }] })],
    ['no head', pr({ headRefOid: null })],
  ])('refuses: %s', (_n, p) => {
    expect(evaluateEligibility(p, deps()).eligible).toBe(false);
  });
  it('ignores the review-gate hold check too', () => {
    const p = pr({ statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }, { name: 'review-gate', conclusion: 'FAILURE' }] });
    expect(evaluateEligibility(p, deps()).eligible).toBe(true);
  });
  it('refuses when the net diff still scores humanRequired', () => {
    expect(evaluateEligibility(pr(), deps({ scoreNet: () => ({ scored: true, humanRequired: true }) })).eligible).toBe(false);
  });
  it('refuses when the net diff is unscored or the score throws', () => {
    expect(evaluateEligibility(pr(), deps({ scoreNet: () => ({ scored: false }) })).eligible).toBe(false);
    expect(evaluateEligibility(pr(), deps({ scoreNet: () => { throw new Error('x'); } })).eligible).toBe(false);
  });
  it('refuses when red-team is not clear on the current head', () => {
    expect(evaluateEligibility(pr(), deps({ redTeamClearAtHead: () => false })).eligible).toBe(false);
  });
});

describe('runDelegatedClearHuman', () => {
  it('quotes R11 verbatim', () => {
    expect(R11_REASON).toBe('Standing delegation R11 (operator chalbert, Claude Code chat 2026-10-21 21:50 ET): "Ok, I allow you to approve any of those until this is changed"');
  });
  it('shadow appends would-approve and changes nothing', async () => {
    const events = []; const calls = [];
    const out = await runDelegatedClearHuman({ prs: [pr()], mode: 'shadow', ...deps(),
      emit: async (e) => { events.push(e); }, clearHuman: async (a) => { calls.push(a); } });
    expect(calls).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'would-approve', pr: 7, head: HEAD });
    expect(events[0].evidence).toBeTruthy();
    expect(out.wouldApprove).toEqual([7]);
  });
  it('off does nothing', async () => {
    const events = []; const calls = [];
    await runDelegatedClearHuman({ prs: [pr()], mode: 'off', ...deps(), emit: async (e) => events.push(e), clearHuman: async (a) => calls.push(a) });
    expect(events).toEqual([]); expect(calls).toEqual([]);
  });
  it('on clears through the CLI with R11 as the reason, never by label edit', async () => {
    const calls = [];
    const out = await runDelegatedClearHuman({ prs: [pr()], mode: 'on', ...deps(), emit: async () => {}, clearHuman: async (a) => { calls.push(a); } });
    expect(calls).toEqual([{ pr: 7, head: HEAD, reason: R11_REASON, actor: 'chalbert' }]);
    expect(out.cleared).toEqual([7]);
  });
  it('an unknown mode never reaches the write path', async () => {
    const calls = []; const events = [];
    for (const mode of ['bogus', undefined, 'ON']) {
      await runDelegatedClearHuman({ prs: [pr()], mode, ...deps(), emit: async (e) => events.push(e), clearHuman: async (a) => calls.push(a) });
    }
    expect(calls).toEqual([]);
  });
  it('the default CLI writer refuses until review-set-label can pin the head (fail closed)', async () => {
    const calls = [];
    await expect(clearHumanViaCli({ pr: 7, head: HEAD, reason: R11_REASON, actor: 'chalbert', exec: (...a) => calls.push(a) })).rejects.toThrow(/pin/);
    expect(calls).toEqual([]);
  });
  it('flags a head that moved right after the clear', async () => {
    let reads = 0;
    const out = await runDelegatedClearHuman({ prs: [pr()], mode: 'on', ...deps({ readLiveHead: () => (reads++ === 0 ? HEAD : 'b'.repeat(40)) }),
      emit: async () => {}, clearHuman: async () => {} });
    expect(out.cleared).toEqual([7]);
    expect(out.headMovedAfterClear).toEqual([7]);
  });
  it('on refuses when the live head moved since evaluation', async () => {
    const calls = [];
    const out = await runDelegatedClearHuman({ prs: [pr()], mode: 'on', ...deps({ readLiveHead: () => 'b'.repeat(40) }), emit: async () => {}, clearHuman: async (a) => calls.push(a) });
    expect(calls).toEqual([]);
    expect(out.cleared).toEqual([]);
  });
  it('ineligible PRs produce no event and no clear', async () => {
    const events = [];
    await runDelegatedClearHuman({ prs: [pr({ statusCheckRollup: [] })], mode: 'on', ...deps(), emit: async (e) => events.push(e), clearHuman: async () => { throw new Error('no'); } });
    expect(events).toEqual([]);
  });
});
