// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { planRedTeamStatusLabels, readCheckClearFact, syncRedTeamStatusLabels } from '../red-team-status-labels.mjs';

const head = 'a'.repeat(40);
const old = 'b'.repeat(40);
const input = { repo: 'o/n', pr: 42, head, env: { WE_APP_ID: '123' }, labels: ['red-team:pending'], comments: [], evidence: {} };
const run = (over = {}) => ({ id: 10, name: 'red-team', head_sha: head, external_id: 'o/n#42', app: { id: 123 },
  status: 'completed', conclusion: 'success', output: { title: 'Red team clear' }, ...over });
const ghFor = (runs, { statuses = [] } = {}) => args => {
  const url = String(args.at(-1));
  if (url.includes('check-runs')) return JSON.stringify({ total_count: runs.length, check_runs: runs });
  return JSON.stringify({ total_count: statuses.length, statuses });
};

describe('red-team label settles from the head\'s check', () => {
  it('a clear check on this head swaps pending to clear', () => {
    expect(planRedTeamStatusLabels({ ...input, checkClear: true })).toEqual({ add: 'red-team:clear', remove: ['red-team:pending'] });
  });
  it('without a clear check fact pending stays (unknown means pending)', () => {
    for (const checkClear of [undefined, false, 'yes', null])
      expect(planRedTeamStatusLabels({ ...input, evidence: { ok: false }, checkClear }).add).not.toBe('red-team:clear');
  });
  it('a recorded break still blocks even with a clear check', () => {
    const gate = { author: { login: 'web-everything' }, body: `<!-- we:red-team-gate pr=42 rev=${head} outcome=sent-back -->` };
    const found = { author: { login: 'web-everything' }, body: `<!-- we:red-team-advisory pr=42 rev=${head} -->\n1. [**confirmed**] (edge-case, broken) \`scripts/x.mjs:1\` — break` };
    expect(planRedTeamStatusLabels({ ...input, comments: [found, gate], checkClear: true }).add).toBe('red-team:blocked');
  });
  it('the fact: success on this head from the app is clear', () => {
    expect(readCheckClearFact({ ...input, gh: ghFor([run()]) })).toBe(true);
  });
  it('the fact: a check on an older head does not settle the current head', () => {
    expect(readCheckClearFact({ ...input, gh: ghFor([run({ head_sha: old })]) })).toBe(false);
  });
  it('the fact: failure, in-progress, foreign app, other PR and missing all refuse', () => {
    for (const bad of [run({ conclusion: 'failure' }), run({ status: 'in_progress', conclusion: null }), run({ app: { id: 999 } }),
      run({ external_id: 'o/n#43' }), run({ id: 0 })])
      expect(readCheckClearFact({ ...input, gh: ghFor([bad]) })).toBe(false);
    expect(readCheckClearFact({ ...input, gh: ghFor([]) })).toBe(false);
  });
  it('the fact: a newer failing run beats an older success (ordered by id)', () => {
    expect(readCheckClearFact({ ...input, gh: ghFor([run({ id: 11, conclusion: 'failure' }), run({ id: 10 })]) })).toBe(false);
  });
  it('the fact: unreadable check runs, unset app id or a throw refuse', () => {
    expect(readCheckClearFact({ ...input, gh: () => { throw new Error('boom'); } })).toBe(false);
    expect(readCheckClearFact({ ...input, gh: () => 'not json' })).toBe(false);
    expect(readCheckClearFact({ ...input, env: {}, gh: ghFor([run()]) })).toBe(false);
  });
  it('the fact: an open publication hold refuses', () => {
    const hold = { id: 5, context: 'red-team/publication #42', state: 'pending', creator: { login: 'x' }, description: 'hold' };
    expect(readCheckClearFact({ ...input, gh: ghFor([run()], { statuses: [hold] }) })).toBe(false);
  });
  describe('sync', () => {
    const live = { headRefOid: head, labels: ['red-team:pending'] };
    const make = readCheckClear => {
      const provider = { ensureLabel: vi.fn(), setLabels: vi.fn(), readPrState: vi.fn(() => live), readPrFiles: vi.fn(() => null) };
      return { provider, run: () => syncRedTeamStatusLabels({ ...input, live, provider, readCheckClear, standingRuling: null }) };
    };
    it('writes clear when the check fact is clear', () => {
      const { provider, run: go } = make(() => true);
      expect(go().add).toBe('red-team:clear');
      expect(provider.setLabels).toHaveBeenCalledWith('o/n', 42, { add: 'red-team:clear', remove: ['red-team:pending'] });
    });
    it('writes nothing when the fact is false or throws', () => {
      for (const reader of [() => false, () => { throw new Error('x'); }]) {
        const { provider, run: go } = make(reader);
        go();
        expect(provider.setLabels).not.toHaveBeenCalledWith('o/n', 42, expect.objectContaining({ add: 'red-team:clear' }));
      }
    });
    it('refuses when the head moved after the check was read', () => {
      const { provider, run: go } = make(() => { provider.readPrState.mockReturnValue({ headRefOid: old, labels: ['red-team:pending'] }); return true; });
      go();
      expect(provider.setLabels).not.toHaveBeenCalled();
    });
    it('does not read the check unless pending is the live label', () => {
      const reader = vi.fn(() => true);
      const provider = { ensureLabel: vi.fn(), setLabels: vi.fn(), readPrState: vi.fn(), readPrFiles: vi.fn() };
      syncRedTeamStatusLabels({ ...input, labels: [], live: { headRefOid: head, labels: [] }, provider, readCheckClear: reader, standingRuling: null });
      expect(reader).not.toHaveBeenCalled();
    });
  });
});
