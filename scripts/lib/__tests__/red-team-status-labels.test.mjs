// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { planRedTeamStatusLabels, syncRedTeamStatusLabels } from '../red-team-status-labels.mjs';
import { resolveRedTeamProbes } from '../red-team-gate.mjs';
const head = 'a'.repeat(40);
const result = (findings = '') => ({ author: { login: 'web-everything' }, body: `<!-- we:red-team-advisory pr=42 rev=${head} -->\n${findings}` });
const broken = '1. [**confirmed**] (edge-case, broken) `scripts/x.mjs:1` — break';
const input = { repo: 'o/n', pr: 42, head, env: {}, labels: ['red-team:clear'] };
describe('head-bound red-team operator labels', () => {
  it('shows scheduled/in-flight as pending and provisions through the label provider', () => {
    const provider = { ensureLabel: vi.fn(), setLabels: vi.fn() };
    const log = vi.fn();
    const plan = syncRedTeamStatusLabels({ ...input, evidence: { scheduled: true, inFlight: true },
      live: { headRefOid: head, labels: input.labels }, comments: [], provider, log });
    expect(plan).toEqual({ add: 'red-team:pending', remove: ['red-team:clear'] });
    expect(provider.ensureLabel).toHaveBeenCalledWith('o/n', 'red-team:pending', expect.objectContaining({ color: 'fbca04' }));
    expect(provider.setLabels).toHaveBeenCalledWith('o/n', 42, plan);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/statusLabels=true.*standard/));
  });
  it('a clean recorded result is clear', () => {
    expect(planRedTeamStatusLabels({ ...input, labels: ['red-team:pending'], comments: [result()] }))
      .toEqual({ add: 'red-team:clear', remove: ['red-team:pending'] });
  });
  it.each(['sent-back', 'round-cap'])('a %s break is blocked', outcome => {
    const gate = { author: { login: 'web-everything' }, body: `<!-- we:red-team-gate pr=42 rev=${head} outcome=${outcome} -->` };
    expect(planRedTeamStatusLabels({ ...input, comments: [result(broken), gate] }).add).toBe('red-team:blocked');
  });
  it('cards and advisories are clear', () => {
    const gate = { author: { login: 'web-everything' }, body: `<!-- we:red-team-gate pr=42 rev=${head} outcome=card-queued -->\n- 1 finding(s) filed as a follow-up card (#1).` };
    expect(planRedTeamStatusLabels({ ...input, labels: [], comments: [result(broken), gate] }).add).toBe('red-team:clear');
  });
  it('drops old-head labels without trusting stale or forged results', () => {
    for (const comments of [[result()], [{ ...result(), author: { login: 'attacker' } }]]) {
      expect(planRedTeamStatusLabels({ ...input, head: 'b'.repeat(40), comments }))
        .toEqual({ add: null, remove: ['red-team:clear'] });
    }
  });
  it('does not publish against a changed head or when disabled', () => {
    const provider = { setLabels: vi.fn() };
    syncRedTeamStatusLabels({ ...input, live: { headRefOid: 'b'.repeat(40) }, provider });
    syncRedTeamStatusLabels({ ...input, env: { WE_RED_TEAM_STATUS_LABELS: 'false' }, provider });
    expect(provider.setLabels).not.toHaveBeenCalled();
  });
  it('shows a card-only head as pending only when the pass is not skipped or has started', () => {
    const loopPayload = { findings: { read: { netChangedFiles: ['backlog/123-card.md'], netRenameSources: [] } } };
    const plan = (env, evidence) => planRedTeamStatusLabels({ ...input, labels: [], comments: [], env, evidence: { loopPayload, ...evidence } }).add;
    expect(plan({}, { scheduled: true })).toBeNull();
    expect(plan({}, { scheduled: true, attempted: true })).toBeNull();
    expect(plan({}, { attempted: true, skipCardOnly: false })).toBe('red-team:pending');
    expect(plan({}, { attempted: true, recorded: true })).toBe('red-team:pending');
    expect(planRedTeamStatusLabels({ ...input, comments: [], evidence: { attempted: true } }).add).toBe('red-team:pending');
    expect(plan({ WE_RED_TEAM_SKIP_CARD_ONLY: 'false' }, { scheduled: true })).toBe('red-team:pending');
    expect(plan({}, { scheduled: true, inFlight: true })).toBe('red-team:pending');
  });
  it('resolves the setting through standard, platform, tool, and env', () => {
    expect(resolveRedTeamProbes({ platform: { statusLabels: false } })).toMatchObject({ value: { statusLabels: false }, sources: { statusLabels: 'platform' } });
    expect(resolveRedTeamProbes({ platform: { statusLabels: false }, file: { redTeam: { statusLabels: true } } }))
      .toMatchObject({ value: { statusLabels: true }, sources: { statusLabels: 'tool' } });
    expect(resolveRedTeamProbes({ file: { redTeam: { statusLabels: false } }, env: { WE_RED_TEAM_STATUS_LABELS: 'on' } }))
      .toMatchObject({ value: { statusLabels: true }, sources: { statusLabels: 'env' } });
  });
});
