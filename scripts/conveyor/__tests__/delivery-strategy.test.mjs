import { describe, it, expect } from 'vitest';
import { selectStrategy, STRATEGIES, REASONS } from '../delivery-strategy.mjs';
import settings from '../../settings/delivery-strategy.json';
const NOW = Date.parse('2026-11-25T12:00:00Z');
const at = NOW - 60_000;
const HEAD = 'a'.repeat(40);
const v = (value) => ({ value, at });
const calm = { review: 'ok', redteam: 'ok', ci: 'ok', conflicts: 'ok', wip: 'ok' };

function inputs(over = {}) {
  return {
    stages: v(calm),
    kind: v('daemon-tooling'),
    blockerRank: v(null),
    overlayLoadable: v(true),
    audit: v({ sha: HEAD, head: HEAD, tests: 'green', verdict: 'NOT WEAKENED' }),
    rounds: v(0),
    daemonsAdopting: v(true),
    prep: v({ ok: true }),
    stackParent: v(null),
    loadsStages: v([]),
    ...over,
  };
}
const run = (over, s = settings) => selectStrategy(inputs(over), s, NOW);

describe('replay 11-24..25: each fix gets the winning strategy', () => {
  it('7458 and 7463: daemon fix, audited green, daemons adopting -> prototype-first', () => {
    expect(run({}).strategy).toBe(STRATEGIES.PROTOTYPE_FIRST);
    expect(run({ blockerRank: v(2) }).strategy).toBe(STRATEGIES.PROTOTYPE_FIRST);
  });
  it('7472 in the hold, blocker rank 1 -> incident', () => {
    const r = run({ daemonsAdopting: v(false), blockerRank: v(1) });
    expect(r.strategy).toBe(STRATEGIES.INCIDENT);
  });
  it('7478/7480 in the hold -> hold/await-adoption, then prototype-first once adopting', () => {
    const held = run({ daemonsAdopting: v(false), blockerRank: v(2) });
    expect(held.strategy).toBe(STRATEGIES.HOLD);
    expect(held.reasonCode).toBe(REASONS.AWAIT_ADOPTION);
    expect(run({ blockerRank: v(2) }).strategy).toBe(STRATEGIES.PROTOTYPE_FIRST);
  });
  it('7485 on its ci-red head -> not prototype-first', () => {
    const r = run({ audit: v({ sha: HEAD, head: HEAD, tests: 'red', verdict: 'NOT WEAKENED' }) });
    expect(r.strategy).not.toBe(STRATEGIES.PROTOTYPE_FIRST);
  });
  it('an audit on an older sha does not count', () => {
    const r = run({ audit: v({ sha: 'b'.repeat(40), head: HEAD, tests: 'green', verdict: 'NOT WEAKENED' }) });
    expect(r.strategy).not.toBe(STRATEGIES.PROTOTYPE_FIRST);
  });
  it('a product step loading redteam while a gate fix is unloaded -> hold/gate-fix-unloaded', () => {
    const r = run({
      kind: v('product'),
      stages: v({ ...calm, redteam: 'stressed' }),
      loadsStages: v(['redteam']),
      blockerRank: v(1),
      gateFixUnloaded: v(true),
    });
    expect(r.strategy).toBe(STRATEGIES.HOLD);
    expect(r.reasonCode).toBe(REASONS.GATE_FIX_UNLOADED);
  });
});

describe('rule boundaries', () => {
  it('needs a prototype overlay to go prototype-first', () => {
    expect(run({ overlayLoadable: v(false) }).strategy).not.toBe(STRATEGIES.PROTOTYPE_FIRST);
  });
  it('no prep -> design-pass-first; too many rounds -> design-pass-first', () => {
    const p = { kind: v('product'), prep: v({ ok: false }) };
    expect(run(p).strategy).toBe(STRATEGIES.DESIGN_PASS_FIRST);
    expect(run({ kind: v('product'), rounds: v(settings.designPassAfterRounds) }).strategy).toBe(
      STRATEGIES.DESIGN_PASS_FIRST,
    );
  });
  it('unmerged stack parent -> stacked', () => {
    const r = run({ kind: v('product'), stackParent: v({ merged: false }) });
    expect(r.strategy).toBe(STRATEGIES.STACKED);
  });
  it('only wip stressed and step unblocks PRs -> normal-pr/unblocks-pr', () => {
    const r = run({
      kind: v('product'),
      stages: v({ ...calm, wip: 'stressed' }),
      loadsStages: v(['wip']),
      unblocksPrs: v(true),
    });
    expect(r.strategy).toBe(STRATEGIES.NORMAL_PR);
    expect(r.reasonCode).toBe(REASONS.UNBLOCKS_PR);
  });
  it('known incident with landed fix -> build-ahead', () => {
    const r = run({
      kind: v('product'),
      stages: v({ ...calm, review: 'stressed' }),
      loadsStages: v(['review']),
      knownIncidentFixLanded: v(true),
      buildAheadCount: v(0),
    });
    expect(r.strategy).toBe(STRATEGIES.BUILD_AHEAD);
  });
  it('stressed stage otherwise holds', () => {
    const r = run({
      kind: v('product'),
      stages: v({ ...calm, review: 'stressed' }),
      loadsStages: v(['review']),
    });
    expect(r.strategy).toBe(STRATEGIES.HOLD);
    expect(r.reasonCode).toBe(REASONS.STAGE_STRESSED);
  });
  it('calm product step -> normal-pr/default', () => {
    const r = run({ kind: v('product') });
    expect(r.strategy).toBe(STRATEGIES.NORMAL_PR);
    expect(r.reasonCode).toBe(REASONS.DEFAULT);
  });
  it('result carries why and inputsUsed', () => {
    const r = run({});
    expect(typeof r.why).toBe('string');
    expect(Array.isArray(r.inputsUsed)).toBe(true);
  });
});

describe('unknown or stale input never yields prototype-first or incident', () => {
  const bad = [
    ['missing audit', { audit: undefined }],
    ['unknown audit', { audit: { value: 'unknown', at } }],
    ['stale audit', { audit: { value: inputs().audit.value, at: NOW - 3 * 3600_000 } }],
    ['stale adoption', { daemonsAdopting: { value: true, at: NOW - 3 * 3600_000 } }],
    ['unknown adoption', { daemonsAdopting: { value: 'unknown', at } }],
    ['unknown overlay', { overlayLoadable: { value: 'unknown', at } }],
    ['unknown kind', { kind: { value: 'unknown', at } }],
  ];
  for (const [name, over] of bad) {
    it(name, () => {
      const r = run({ ...over, blockerRank: v(1) });
      expect(r.strategy).toBe(STRATEGIES.HOLD);
      expect(r.reasonCode).toBe(REASONS.INPUT_UNKNOWN);
    });
  }
});

describe('settings', () => {
  it('a missing settings key yields hold/settings-missing', () => {
    for (const key of Object.keys(settings).filter((k) => !k.startsWith('_'))) {
      const s = { ...settings };
      delete s[key];
      const r = run({}, s);
      expect(r.strategy).toBe(STRATEGIES.HOLD);
      expect(r.reasonCode).toBe(REASONS.SETTINGS_MISSING);
    }
  });
  it('no settings object at all -> hold/settings-missing', () => {
    expect(selectStrategy(inputs(), null, NOW).reasonCode).toBe(REASONS.SETTINGS_MISSING);
  });
});
