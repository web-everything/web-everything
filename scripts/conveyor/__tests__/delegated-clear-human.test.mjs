import { describe, expect, it } from 'vitest';
import {
  clearHumanViaCli, R11_REASON, resolveDelegatedClearHumanMode, evaluateEligibility, runDelegatedClearHuman,
} from '../delegated-clear-human.mjs';
import { FALLBACK_REQUIRED_STATUS_CHECKS } from '../../lib/required-status-checks.mjs';

const HEAD = 'a'.repeat(40);
const greenRollup = () => FALLBACK_REQUIRED_STATUS_CHECKS.map((name) => ({ name, conclusion: 'SUCCESS' }));
const pr = (over = {}) => ({
  number: 7, headRefOid: HEAD, headRefName: 'lane/x', baseRefName: 'main',
  labels: ['review:human', 'advisory:accepted', 'red-team:clear'].map((name) => ({ name })),
  statusCheckRollup: [...greenRollup(), { name: 'merge-gate', conclusion: 'FAILURE' }],
  ...over,
});
const deps = (over = {}) => ({
  repo: 'web-everything/web-everything',
  requiredChecks: FALLBACK_REQUIRED_STATUS_CHECKS,
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
    const p = pr({ statusCheckRollup: [...greenRollup(), { name: 'review-gate', conclusion: 'FAILURE' }] });
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

describe('required checks present', () => {
  it('review-gate alone cannot establish clear-human eligibility', () => {
    const r = evaluateEligibility(pr({ statusCheckRollup: [{ name: 'review-gate', conclusion: 'SUCCESS' }] }), deps());
    expect(r.eligible).toBe(false);
    expect(r.failed).toContain('required check test missing');
  });
  it('hold rows only (merge-gate and review-gate) refuse', () => {
    const r = evaluateEligibility(pr({ statusCheckRollup: [
      { name: 'merge-gate', conclusion: 'FAILURE' }, { name: 'review-gate', conclusion: 'SUCCESS' },
    ] }), deps());
    expect(r.eligible).toBe(false);
    expect(r.failed).toContain('required check test missing');
  });
  it.each(FALLBACK_REQUIRED_STATUS_CHECKS)('each missing required check refuses: %s', (name) => {
    const r = evaluateEligibility(pr({ statusCheckRollup: greenRollup().filter((c) => c.name !== name) }), deps());
    expect(r.eligible).toBe(false);
    expect(r.failed).toContain(`required check ${name} missing`);
  });
  it('a review-gate row in any state equals its absence', () => {
    for (const rollup of [greenRollup(), greenRollup().filter((c) => c.name !== 'test'), []]) {
      const result = (statusCheckRollup) => {
        const { eligible, failed } = evaluateEligibility(pr({ statusCheckRollup }), deps());
        return { eligible, failed };
      };
      for (const conclusion of ['SUCCESS', 'FAILURE', 'NEUTRAL', 'SKIPPED', 'CANCELLED', null]) {
        expect(result([...rollup, { name: 'review-gate', conclusion }])).toEqual(result(rollup));
      }
    }
  });
  it('a stale failure beside a newer success still refuses (accepted, ruling 4)', () => {
    const r = evaluateEligibility(pr({ statusCheckRollup: [
      { name: 'test', conclusion: 'FAILURE', completedAt: '2026-11-26T00:00:00Z' },
      ...greenRollup().map((c) => ({ ...c, completedAt: '2026-11-27T00:00:00Z' })),
    ] }), deps());
    expect(r.eligible).toBe(false);
    expect(r.failed).toContain('check test is FAILURE');
  });
  it('sibling repos use their own list', async () => {
    for (const [repo, names, failed] of [
      ['plateauapp/plateau-app', ['test', 'e2e'], []],
      ['plateauapp/plateau-app', ['test'], ['required check e2e missing']],
      ['frontier-ui/frontierui', ['test'], []],
    ]) {
      const events = []; const calls = [];
      const out = await runDelegatedClearHuman({ ...deps(), repo, mode: 'shadow',
        prs: [pr({ statusCheckRollup: names.map((name) => ({ name, conclusion: 'SUCCESS' })) })],
        emit: async (e) => events.push(e), clearHuman: async (a) => calls.push(a) });
      expect(out.refused).toEqual(failed.length ? [{ pr: 7, failed }] : []);
      expect(out.wouldApprove).toEqual(failed.length ? [] : [7]);
      expect(events).toHaveLength(failed.length ? 0 : 1);
      expect(calls).toEqual([]);
    }
  });
  it.each(['shadow', 'on'])('unknown repo refuses in %s mode', async (mode) => {
    const events = []; const calls = [];
    const out = await runDelegatedClearHuman({ ...deps(), repo: 'x/y', prs: [pr()], mode,
      emit: async (e) => events.push(e), clearHuman: async (a) => calls.push(a) });
    expect(out.refused).toEqual([{ pr: 7, failed: ['required check list invalid'] }]);
    expect(out.wouldApprove).toEqual([]);
    expect(out.cleared).toEqual([]);
    expect(events).toEqual([]);
    expect(calls).toEqual([]);
  });
  it.each([undefined, [], ['merge-gate'], ['Review-Gate'], 'test', [''], ['  '], [null]].map((value) => [value]))(
    'invalid requiredChecks override refuses: %j', (requiredChecks) => {
      const r = evaluateEligibility(pr(), deps({ requiredChecks }));
      expect(r.eligible).toBe(false);
      expect(r.failed).toContain('required check list invalid');
    },
  );
  it('a valid requiredChecks override is honoured', () => {
    const r = evaluateEligibility(pr({ statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }] }), deps({ requiredChecks: ['test'] }));
    expect(r.eligible).toBe(true);
    expect(r.failed).toEqual([]);
  });
  it('legacy status contexts count', () => {
    const r = evaluateEligibility(pr({ statusCheckRollup: greenRollup().map((c) => (
      c.name === 'smoke' ? { context: 'smoke', state: 'SUCCESS' } : c
    )) }), deps());
    expect(r.eligible).toBe(true);
    expect(r.failed).toEqual([]);
  });
  it('a non-hold failure still refuses when all required checks pass', () => {
    const r = evaluateEligibility(pr({ statusCheckRollup: [...greenRollup(), { name: 'extra', conclusion: 'FAILURE' }] }), deps());
    expect(r.eligible).toBe(false);
    expect(r.failed).toContain('check extra is FAILURE');
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
