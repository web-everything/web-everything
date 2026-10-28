import { describe, expect, it } from 'vitest';
import {
  R11_REASON, resolveDelegatedClearHumanMode, evaluateEligibility, runDelegatedClearHuman,
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
