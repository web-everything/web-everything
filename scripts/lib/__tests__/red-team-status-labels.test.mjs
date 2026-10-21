// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { planRedTeamStatusLabels, syncRedTeamStatusLabels } from '../red-team-status-labels.mjs';
import { resolveRedTeamProbes } from '../red-team-gate.mjs';
import { savedRedTeamFallback } from '../drain-saved-red-team.mjs';
vi.mock('../drain-saved-red-team.mjs', () => ({ savedRedTeamFallback: vi.fn() }));
beforeEach(() => savedRedTeamFallback.mockReset().mockReturnValue(() => null));
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
  const savedResult = { pr: 42, rev: head, scoredAt: '2026-10-18T10:00:00Z', findings: [
    { index: 1, confirmed: true, impact: 'broken', category: 'edge-case', summary: 'break' },
  ] };
  const roundCapGate = { author: { login: 'web-everything' }, createdAt: '2026-10-18T10:01:00Z',
    body: `<!-- we:red-team-gate pr=42 rev=${head} outcome=round-cap -->` };
  const savedInput = { ...input, labels: ['red-team:pending'], comments: [roundCapGate], evidence: { scheduled: true } };
  const syncSaved = (options = {}) => syncRedTeamStatusLabels({ ...savedInput,
    live: { headRefOid: head, labels: savedInput.labels }, dryRun: true, ...options });

  it('keeps an incomplete saved recheck pending even without findings or a round-cap gate', () => {
    const incompleteInput = { ...input, comments: [],
      savedResult: { ...savedResult, recheckIncomplete: true, findings: [] } };
    expect(planRedTeamStatusLabels({ ...incompleteInput, labels: [] }))
      .toEqual({ add: 'red-team:pending', remove: [] });
    expect(planRedTeamStatusLabels({ ...incompleteInput, labels: ['red-team:clear'] }))
      .toEqual({ add: 'red-team:pending', remove: ['red-team:clear'] });
  });
  it('blocks confirmed breaks held at the round cap from an explicit saved result', () => {
    expect(planRedTeamStatusLabels({ ...savedInput, savedResult }))
      .toEqual({ add: 'red-team:blocked', remove: ['red-team:pending'] });
    expect(syncSaved({ savedResult })).toEqual({ add: 'red-team:blocked', remove: ['red-team:pending'] });
    expect(savedRedTeamFallback).not.toHaveBeenCalled();
  });
  it('lazily reads a saved result when the comment thread has no result', () => {
    const readSaved = vi.fn(() => savedResult);
    savedRedTeamFallback.mockReturnValue(readSaved);
    expect(syncSaved()).toEqual({ add: 'red-team:blocked', remove: ['red-team:pending'] });
    expect(savedRedTeamFallback).toHaveBeenCalledWith({ repo: 'o/n', pr: 42, head, env: {} });
    expect(readSaved).toHaveBeenCalledOnce();
  });
  it('keeps pending unchanged when there is no saved result', () => {
    expect(syncSaved()).toEqual({ add: null, remove: [] });
    expect(planRedTeamStatusLabels(savedInput)).toEqual({ add: null, remove: [] });
  });
  it('does not read saved evidence when explicitly absent or a comment result exists', () => {
    expect(syncSaved({ savedResult: null })).toEqual({ add: null, remove: [] });
    expect(syncSaved({ comments: [result()] })).toEqual({ add: 'red-team:clear', remove: ['red-team:pending'] });
    expect(savedRedTeamFallback).not.toHaveBeenCalled();
  });
  it('logs a throwing saved read and keeps the comment-only disposition without throwing', () => {
    savedRedTeamFallback.mockReturnValue(() => { throw new Error('saved evidence unreadable'); });
    const log = vi.fn();
    expect(syncSaved({ log })).toEqual({ add: null, remove: [] });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/saved result unavailable: saved evidence unreadable/));
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
