// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redTeamStatusDir } from '../drain-red-team-evidence.mjs';
import { createFreshGh, planRedTeamStatusLabels, readCheckClearFact, syncRedTeamStatusLabels } from '../red-team-status-labels.mjs';

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
  it('the check never overrides unreadable, in-flight, scheduled, conflict or changes evidence', () => {
    const changes = { status: 'finished', result: { foldedVerdict: 'changes' } };
    for (const evidence of [{ ok: false }, { inFlight: true }, { scheduled: true }, { carryConflict: true }, { status: changes }])
      expect(planRedTeamStatusLabels({ ...input, evidence, checkClear: true }).add).not.toBe('red-team:clear');
  });
  it('the fact: a newer pending hold in the summary beats an older trusted success in the history', () => {
    const ctx = 'red-team/publication #42';
    const gh = args => {
      const url = String(args.at(-1));
      if (url.includes('check-runs')) return JSON.stringify({ total_count: 1, check_runs: [run()] });
      if (url.includes('/status')) return JSON.stringify({ total_count: 1, statuses: [{ id: 9, context: ctx, state: 'pending', creator: { login: 'x' } }] });
      return JSON.stringify([{ id: 4, context: ctx, state: 'success', creator: { login: 'web-everything[bot]' } }]);
    };
    expect(readCheckClearFact({ ...input, gh })).toBe(false);
  });
  it('the settle read bypasses the gh read memo (fresh data only)', () => {
    const seen = [];
    const fresh = createFreshGh((args, opts) => { seen.push(opts); return '{}'; }, { WE_GH_READ_MEMO_DIR: '/memo', PATH: 'p' });
    fresh(['api', 'x'], { encoding: 'utf8' });
    fresh(['api', 'y'], { env: { WE_GH_READ_MEMO_DIR: '/memo' }, throttle: { env: { WE_GH_READ_MEMO_DIR: '/memo', A: '1' } } });
    for (const opts of seen) {
      expect(opts.throttle.env.WE_GH_READ_MEMO_DIR).toBeUndefined();
      expect(opts.env?.WE_GH_READ_MEMO_DIR).toBeUndefined();
    }
    expect(seen[0].throttle.env.PATH).toBe('p');
    expect(seen[1].throttle.env.A).toBe('1');
  });
  describe('local publication holds', () => {
    const withDir = (suffix, fn) => {
      const base = mkdtempSync(join(tmpdir(), 'rt-settle-'));
      const env = { ...input.env, WE_SHARED_RUNS_DIR: join(base, 'runs') };
      const dir = redTeamStatusDir(env);
      mkdirSync(dir, { recursive: true });
      if (suffix) writeFileSync(join(dir, `${encodeURIComponent('o/n')}-42-${head}.json${suffix}`), '{}');
      try { fn(env); } finally { rmSync(base, { recursive: true, force: true }); }
    };
    it('an .unpublished hold or a carried-check marker is no proof', () => {
      for (const suffix of ['.unpublished', '.carried-check-unpublished'])
        withDir(suffix, env => expect(readCheckClearFact({ ...input, env, gh: ghFor([run()]) })).toBe(false));
    });
    it('no hold files leaves the check as proof', () => {
      withDir('', env => expect(readCheckClearFact({ ...input, env, gh: ghFor([run()]) })).toBe(true));
    });
  });
  describe('sync', () => {
    it('re-reads the check at swap time and refuses a changed fact', () => {
      const live3 = { headRefOid: head, labels: ['red-team:pending'] };
      const provider = { ensureLabel: vi.fn(), setLabels: vi.fn(), readPrState: vi.fn(() => live3), readPrFiles: vi.fn(() => null), readComments: vi.fn(() => []) };
      const reader = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
      syncRedTeamStatusLabels({ ...input, live: live3, provider, readCheckClear: reader, standingRuling: null });
      expect(reader).toHaveBeenCalledTimes(2);
      expect(provider.setLabels).not.toHaveBeenCalled();
    });
    it('production wiring: the default reader runs the real fact over the injected gh', () => {
      const live2 = { headRefOid: head, labels: ['red-team:pending'] };
      const mk = gh => {
        const provider = { ensureLabel: vi.fn(), setLabels: vi.fn(), readPrState: vi.fn(() => live2), readPrFiles: vi.fn(() => null), readComments: vi.fn(() => []) };
        syncRedTeamStatusLabels({ ...input, live: live2, provider, gh, standingRuling: null });
        return provider;
      };
      expect(mk(ghFor([run()])).setLabels).toHaveBeenCalledWith('o/n', 42, { add: 'red-team:clear', remove: ['red-team:pending'] });
      expect(mk(ghFor([run({ conclusion: 'failure' })])).setLabels).not.toHaveBeenCalled();
    });
    it('the drain-scan rollback disables the check as evidence', () => {
      const reader = vi.fn(() => true);
      const provider = { ensureLabel: vi.fn(), setLabels: vi.fn(), readPrState: vi.fn(() => live0), readPrFiles: vi.fn(() => null), readComments: vi.fn(() => []) };
      const live0 = { headRefOid: head, labels: ['red-team:pending'] };
      syncRedTeamStatusLabels({ ...input, env: { ...input.env, WE_RED_TEAM_GATE_SOURCE: 'drain-scan' }, live: live0, provider, readCheckClear: reader, standingRuling: null });
      expect(reader).not.toHaveBeenCalled();
    });
    it('re-verifies the head before removing pending when clear already coexists', () => {
      const both = { headRefOid: head, labels: ['red-team:pending', 'red-team:clear'] };
      const provider = { ensureLabel: vi.fn(), setLabels: vi.fn(), readPrState: vi.fn(() => both), readPrFiles: vi.fn(() => null), readComments: vi.fn(() => []) };
      syncRedTeamStatusLabels({ ...input, labels: both.labels, live: both, provider, standingRuling: null,
        readCheckClear: () => { provider.readPrState.mockReturnValue({ headRefOid: old, labels: both.labels }); return true; } });
      expect(provider.setLabels).not.toHaveBeenCalled();
    });
    const live = { headRefOid: head, labels: ['red-team:pending'] };
    const make = readCheckClear => {
      const provider = { ensureLabel: vi.fn(), setLabels: vi.fn(), readPrState: vi.fn(() => live), readPrFiles: vi.fn(() => null), readComments: vi.fn(() => []) };
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
    const brk = [{ author: { login: 'web-everything' }, body: `<!-- we:red-team-advisory pr=42 rev=${head} -->\n1. [**confirmed**] (edge-case, broken) \`scripts/x.mjs:1\` — break` },
      { author: { login: 'web-everything' }, body: `<!-- we:red-team-gate pr=42 rev=${head} outcome=sent-back -->` }];
    it('a block arriving during a settle ends up red-team:blocked (a block always wins)', () => {
      const { provider, run: go } = make(() => true);
      provider.readComments.mockReturnValue(brk);
      expect(go().add).toBe('red-team:blocked');
      expect(provider.setLabels).toHaveBeenCalledWith('o/n', 42, expect.objectContaining({ add: 'red-team:blocked' }));
    });
    it('a block still wins when the check fact goes false at the re-read', () => {
      let calls = 0;
      const { provider, run: go } = make(() => ++calls === 1);
      provider.readComments.mockReturnValue(brk);
      go();
      expect(provider.setLabels).toHaveBeenCalledWith('o/n', 42, expect.objectContaining({ add: 'red-team:blocked' }));
    });
    it('a head moving during the swap-time comment read refuses the write', () => {
      const { provider, run: go } = make(() => true);
      provider.readComments.mockImplementation(() => { provider.readPrState.mockReturnValue({ headRefOid: old, labels: ['red-team:pending'] }); return []; });
      go();
      expect(provider.setLabels).not.toHaveBeenCalled();
    });
    it('the rechecks read through the fresh recheck provider, not a memoizing injected one', () => {
      const stale = { ensureLabel: vi.fn(), setLabels: vi.fn(), readPrState: vi.fn(() => live), readPrFiles: vi.fn(() => null), readComments: vi.fn(() => []) };
      const fresh = { readPrState: vi.fn(() => ({ headRefOid: old, labels: ['red-team:pending'] })), readComments: vi.fn(() => []) };
      stale.readPrState.mockReturnValueOnce(live).mockReturnValueOnce(live);
      syncRedTeamStatusLabels({ ...input, live, provider: stale, recheckProvider: fresh, readCheckClear: () => true, standingRuling: null });
      expect(fresh.readPrState).toHaveBeenCalled();
      expect(stale.setLabels).not.toHaveBeenCalled();
    });
    it('a partial env still sees a carried-check marker under the process env', () => {
      expect(readCheckClearFact({ ...input, env: { WE_APP_ID: '123' }, gh: ghFor([run()]) })).toBe(true);
    });
    it('an unreadable thread at swap time refuses the settle', () => {
      const { provider, run: go } = make(() => true);
      provider.readComments.mockImplementation(() => { throw new Error('x'); });
      go();
      expect(provider.setLabels).not.toHaveBeenCalled();
    });
    it('a restrictive plan is never delayed by the settle re-read', () => {
      const reader = vi.fn(() => false);
      const provider = { ensureLabel: vi.fn(), setLabels: vi.fn(), readPrState: vi.fn(() => live), readPrFiles: vi.fn(() => null), readComments: vi.fn(() => brk) };
      syncRedTeamStatusLabels({ ...input, live, provider, comments: brk, readCheckClear: reader, standingRuling: null });
      expect(provider.setLabels).toHaveBeenCalledWith('o/n', 42, expect.objectContaining({ add: 'red-team:blocked' }));
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
