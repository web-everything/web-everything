// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDrainRedTeamEvidence, recordRedTeamStatus } from '../drain-red-team-evidence.mjs';
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

it('a blocked label with no result and no local status record is kept, never planned for removal', () => {
  expect(planRedTeamStatusLabels({ ...input, labels: ['red-team:blocked'], comments: [], evidence: {} }))
    .toEqual({ add: null, remove: [] });
});

it('a pending label with no result and nothing owed is kept, never planned for removal', () => {
  expect(planRedTeamStatusLabels({ ...input, labels: ['red-team:pending'], comments: [], evidence: {} }))
    .toEqual({ add: null, remove: [] });
  expect(planRedTeamStatusLabels({ ...input, labels: ['red-team:pending', 'red-team:clear'], comments: [], evidence: {} }))
    .toEqual({ add: null, remove: ['red-team:clear'] });
});

describe('finished stored results without a marker', () => {
  it.each([
    ['changes', 1, 'red-team:blocked'], ['accept', 0, 'red-team:clear'],
    ['changes', 0, 'red-team:blocked'], ['changes', undefined, 'red-team:blocked'],
    ['accept', 3, 'red-team:clear'],
  ])('finished %s with %s confirmed becomes %s, never pending', (foldedVerdict, confirmedMissCount, desired) => {
    expect(planRedTeamStatusLabels({ ...input, labels: ['red-team:pending'], comments: [],
      evidence: { scheduled: true, status: { status: 'finished', result: { foldedVerdict, confirmedMissCount } } } }))
      .toEqual({ add: desired, remove: ['red-team:pending'] });
  });
  it('keeps existing scheduling behavior for a finished result without a verdict', () => {
    expect(planRedTeamStatusLabels({ ...input, comments: [], evidence: { scheduled: true, status: { status: 'finished', result: {} } } }).add).toBe('red-team:pending');
  });
  it.each(['unknown', '', null])('unknown verdict %s falls through without clearing', foldedVerdict => {
    expect(planRedTeamStatusLabels({ ...input, comments: [], evidence: { scheduled: true,
      status: { status: 'finished', result: { foldedVerdict } } } }).add).toBe('red-team:pending');
  });
  it('live marker disposition takes precedence over the stored verdict', () => {
    expect(planRedTeamStatusLabels({ ...input, labels: [], comments: [result(broken)],
      evidence: { status: { status: 'finished', result: { foldedVerdict: 'accept' } } } }).add).toBe('red-team:blocked');
  });
});


it('the real drain evidence reader exposes the finished status and its full result for label recovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'red-team-label-evidence-'));
  try {
    const env = { WE_SHARED_RUNS_DIR: join(root, 'runs') };
    const storedResult = { status: 'ran', comment: 'withheld', foldedVerdict: 'changes', confirmedMissCount: 1, findings: [] };
    recordRedTeamStatus({ repo: input.repo, pr: input.pr, loopPayload: { findings: { read: { netBasis: { rev: head } } } },
      status: 'finished', result: storedResult }, { env, readPidStart: () => null });
    const evidence = readDrainRedTeamEvidence({ repo: input.repo, pr: input.pr, head, env,
      runsDir: env.WE_SHARED_RUNS_DIR, list: () => [], readScorecards: () => [] });
    expect(evidence.status).toMatchObject({ repo: input.repo, pr: input.pr, head, status: 'finished', result: storedResult });
    expect(planRedTeamStatusLabels({ ...input, labels: ['red-team:pending'], comments: [], evidence }))
      .toEqual({ add: 'red-team:blocked', remove: ['red-team:pending'] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe('card-only head that bypasses the red-team pass loses a stale pending label (#6733)', () => {
  const card = { findings: { read: { netChangedFiles: ['backlog/8182-card.md'], netRenameSources: [], netBasis: { rev: head } } } };
  const plan = (labels, evidence, env = {}) => planRedTeamStatusLabels({ ...input, labels, comments: [], env, evidence });
  it('removes red-team:pending when the head is proven card-only and nothing is owed', () => {
    expect(plan(['red-team:pending'], { loopPayload: card })).toEqual({ add: null, remove: ['red-team:pending'] });
  });
  it('never removes red-team:blocked on a card-only head', () => {
    expect(plan(['red-team:blocked'], { loopPayload: card })).toEqual({ add: null, remove: [] });
  });
  it.each([['inFlight'], ['scheduled'], ['recorded']])('keeps pending while a pass is %s', key => {
    expect(plan(['red-team:pending'], { loopPayload: card, [key]: true })).toEqual({ add: null, remove: [] });
  });
  it('keeps pending when the card-only skip policy is off (evidence or env)', () => {
    expect(plan(['red-team:pending'], { loopPayload: card }, { WE_RED_TEAM_SKIP_CARD_ONLY: 'false' })).toEqual({ add: null, remove: [] });
    expect(plan(['red-team:pending'], { loopPayload: card, skipCardOnly: false })).toEqual({ add: null, remove: [] });
  });
  const bound = read => ({ findings: { read: { netBasis: { rev: head }, ...read } } });
  it.each([
    ['unreadable net files', bound({ netChangedFiles: [], netRenameSources: [] })],
    ['missing net files', bound({ netRenameSources: [] })],
    ['missing read', {}],
    ['a code file in the diff', bound({ netChangedFiles: ['backlog/1-card.md', 'scripts/x.mjs'], netRenameSources: [] })],
    ['a rename source outside cards', bound({ netChangedFiles: ['backlog/1-card.md'], netRenameSources: ['scripts/old.mjs'] })],
    ['missing rename evidence (audit probe)', bound({ netChangedFiles: ['backlog/1-card.md'] })],
    ['null rename evidence (audit probe)', bound({ netChangedFiles: ['backlog/1-card.md'], netRenameSources: null })],
  ])('keeps pending on %s', (_name, loopPayload) => {
    expect(plan(['red-team:pending'], { loopPayload })).toEqual({ add: null, remove: [] });
  });
  it('audit probe: card-only evidence bound to a different head (historical fallback) never removes pending', () => {
    const older = { findings: { read: { netChangedFiles: ['backlog/8182-card.md'], netRenameSources: [], netBasis: { rev: 'b'.repeat(40) } } } };
    const unbound = { findings: { read: { netChangedFiles: ['backlog/8182-card.md'], netRenameSources: [] } } };
    expect(plan(['red-team:pending'], { loopPayload: older })).toEqual({ add: null, remove: [] });
    expect(plan(['red-team:pending'], { loopPayload: unbound })).toEqual({ add: null, remove: [] });
  });
  it('audit probe: a carry conflict on the evidence keeps pending', () => {
    expect(plan(['red-team:pending'], { loopPayload: card, carryConflict: { reason: 'conflicting carry' } })).toEqual({ add: null, remove: [] });
  });
  it('keeps pending when the run evidence is unreadable', () => {
    expect(plan(['red-team:pending'], { ok: false, loopPayload: card })).toEqual({ add: null, remove: [] });
  });
  it('still removes a stale clear label alongside the pending one', () => {
    expect(plan(['red-team:pending', 'red-team:clear'], { loopPayload: card }).remove.sort()).toEqual(['red-team:clear', 'red-team:pending']);
  });
});
