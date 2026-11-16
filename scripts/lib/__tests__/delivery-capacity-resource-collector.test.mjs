import { describe, expect, it } from 'vitest';
import { buildResourceRows, shadowTune } from '../delivery-capacity-tune.mjs';
import { DELIVERY_CAPACITY_DEFAULTS, assessCapacity } from '../delivery-capacity.mjs';

const NOW = Date.UTC(2026, 10, 16, 12);
const MIN = 60000;
const policy = {
  ...structuredClone(DELIVERY_CAPACITY_DEFAULTS), mode: 'units',
  autoTune: { ...DELIVERY_CAPACITY_DEFAULTS.autoTune, mode: 'shadow',
    heavyWaitMaxMin: 10, lanesFreeMin: 3, activeHighRatio: 0.6, activeLowRatio: 0.3,
    sessionUnits: 1, minutesPerUnit: 30, laneUnits: 0.5, rebaseUnits: 0.25 },
};
const openPrs = [{ number: 11, headRefName: 'lane/alpha-fix' }, { number: 12, headRefName: 'lane/beta-build' },
  { number: 13, headRefName: 'lane/gamma-idle' }];
const quiet = () => ({
  agents: { ok: true, rows: [] }, heavy: { ok: true, records: [], waitMin: 0 },
  leases: { ok: true, leases: [], laneCount: 10 }, rebases: { ok: true, events: [] },
});
const busy = () => ({ ...quiet(),
  agents: { ok: true, rows: [{ name: 'fix-alpha-fix', lease: null }, { name: 'redteam #11', lease: null }] },
  leases: { ok: true, leases: [{ purpose: 'alpha-fix', session: 'x' }], laneCount: 10 },
  heavy: { ok: true, waitMin: 0, records: [
    { at: new Date(NOW - 10 * MIN).toISOString(), ms: 40 * MIN, session: 'conveyor-fix-alpha-fix-1', dispatchKind: 'fix' },
    { at: new Date(NOW - 20 * MIN).toISOString(), ms: 30 * MIN, session: 'ci-heal-alpha-fix', dispatchKind: 'ci-heal' },
    { at: new Date(NOW - 3 * 3600000).toISOString(), ms: 99 * MIN, session: 'alpha-fix', dispatchKind: 'fix' }] },
  rebases: { ok: true, events: [{ tsMs: NOW - 5 * MIN, number: 11 }, { tsMs: NOW - 2 * 3600000, number: 11 }] } });

describe('R940 resource row collector', () => {
  it('emits one row per open PR, with explicit zero rows for idle PRs', () => {
    const { resources } = buildResourceRows({ openPrs, nowMs: NOW, sources: busy() });
    expect(resources.prs.map(p => p.number)).toEqual([11, 12, 13]);
    expect(resources.prs[1]).toEqual({ number: 12, liveSessions: 0, ciMin: 0, heavyMin: 0, laneHeld: false, rebases: 0 });
    expect(resources.prs[0]).toEqual({ number: 11, liveSessions: 2, ciMin: 30, heavyMin: 40, laneHeld: true, rebases: 1 });
    expect(resources).toMatchObject({ heavyWaitMin: 0, lanesFree: 9 });
  });
  it('a quiet host yields all-zero rows for every PR', () => {
    const { resources } = buildResourceRows({ openPrs, nowMs: NOW, sources: quiet() });
    expect(resources.prs).toHaveLength(3);
    expect(resources.prs.every(p => p.liveSessions + p.ciMin + p.heavyMin + p.rebases === 0 && !p.laneHeld)).toBe(true);
  });
  for (const name of ['agents', 'heavy', 'leases', 'rebases']) {
    it(`an unreadable ${name} source is marked unreadable, never counted as zero`, () => {
      const out = buildResourceRows({ openPrs, nowMs: NOW, sources: { ...quiet(), [name]: { ok: false } } });
      expect(out.resources).toBeNull();
      expect(out.unreadable).toEqual([name]);
    });
  }
  it('an unreadable open PR list or a malformed PR row fails closed', () => {
    expect(buildResourceRows({ openPrs: null, nowMs: NOW, sources: quiet() }).resources).toBeNull();
    expect(buildResourceRows({ openPrs: [{ number: 'x' }], nowMs: NOW, sources: quiet() }).resources).toBeNull();
  });
  it('short slugs do not match inside longer words', () => {
    const sources = { ...quiet(), agents: { ok: true, rows: [{ name: 'alpha-fixture-run' }] } };
    expect(buildResourceRows({ openPrs, nowMs: NOW, sources }).resources.prs[0].liveSessions).toBe(0);
  });
});

describe('collector feeds the shadow tune', () => {
  const readout = { ...assessCapacity({ prs: [], host: { idlePct: 30, memGb: 8 }, policy, nowMs: NOW }),
    used: 30, verdict: 'deliver', slots: 0, openCount: 3 };
  const run = sources => shadowTune({ readout, policy, merged: [], rows: [], nowMs: NOW,
    resources: buildResourceRows({ openPrs, nowMs: NOW, sources }).resources });
  it('unreadable source holds on resource evidence unreadable', () => {
    expect(run({ ...quiet(), heavy: { ok: false } }).row)
      .toMatchObject({ action: 'hold', changed: false, reason: 'resource evidence unreadable' });
  });
  it('quiet PRs let the suggestion raise; a busy PR lowers it', () => {
    const idle = run(quiet()).row;
    const hot = run({ ...busy(), agents: { ok: true, rows: Array.from({ length: 20 }, () => ({ name: 'fix-alpha-fix' })) } }).row;
    expect(idle.action).toBe('raise');
    expect(hot.action).toBe('lower');
    expect(hot.reason).toContain('high active units');
  });
  it('shadow only: the enforced cap in the readout is unchanged', () => {
    const before = JSON.stringify(readout);
    run(busy());
    expect(JSON.stringify(readout)).toBe(before);
    expect(readout.cap).toBe(policy.unitCap);
  });
});

describe('production shell feeds the collector', () => {
  const mk = async (extra) => {
    const { createDeliveryCapacityTune } = await import('../../operations/delivery-capacity-tune-shell.mjs');
    const io = { statSync: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); }, mkdirSync() {}, appendFileSync() {} };
    const exec = () => JSON.stringify({ data: { search: { nodes: [], pageInfo: { hasNextPage: false } } } });
    return createDeliveryCapacityTune({ resolvePolicy: () => ({ value: policy }), coordinationRoot: () => 'x', io, exec, now: () => NOW, ...extra });
  };
  const readout = { ...assessCapacity({ prs: [], host: { idlePct: 30, memGb: 8 }, policy, nowMs: NOW }), used: 30, verdict: 'deliver', openCount: 3 };
  it('supplies one row per open PR from the sources', async () => {
    const out = (await mk({ readOpenPrs: () => openPrs, readSources: () => busy() }))(readout);
    expect(out.row.signals.prs.map(p => p.number)).toEqual([11, 12, 13]);
  });
  it('an unreadable PR list or source holds on resource evidence unreadable', async () => {
    const a = (await mk({ readOpenPrs: () => null, readSources: () => busy() }))(readout);
    const b = (await mk({ readOpenPrs: () => openPrs, readSources: () => ({ ...busy(), leases: { ok: false } }) }))(readout);
    for (const out of [a, b]) expect(out.row).toMatchObject({ action: 'hold', reason: 'resource evidence unreadable' });
  });
  it('reads sources once per tick, not per PR', async () => {
    let calls = 0;
    (await mk({ readOpenPrs: () => openPrs, readSources: () => { calls++; return quiet(); } }))(readout);
    expect(calls).toBe(1);
  });
});

describe('audit repairs', () => {
  it('malformed heavy or rebase records mark the evidence unreadable instead of zero', () => {
    const bad = { ...quiet(), heavy: { ok: true, waitMin: 0, records: [{ at: 'nope', ms: 5 }] } };
    expect(buildResourceRows({ openPrs, nowMs: NOW, sources: bad }).resources).toBeNull();
    const neg = { ...quiet(), heavy: { ok: true, waitMin: 0, records: [{ at: new Date(NOW).toISOString(), ms: -1 }] } };
    expect(buildResourceRows({ openPrs, nowMs: NOW, sources: neg }).resources).toBeNull();
    const reb = { ...quiet(), rebases: { ok: true, events: [{ tsMs: NaN, number: 11 }] } };
    expect(buildResourceRows({ openPrs, nowMs: NOW, sources: reb }).resources).toBeNull();
  });
  it('codex rows are attributed through their slug', () => {
    const sources = { ...quiet(), agents: { ok: true, rows: [{ runtime: 'codex', codexSlug: 'codex-alpha-fix-1' }] } };
    expect(buildResourceRows({ openPrs, nowMs: NOW, sources }).resources.prs[0].liveSessions).toBe(1);
  });
  it('a corrupt duration log makes the shell source unreadable', async () => {
    const { readResourceSources } = await import('../../operations/delivery-capacity-tune-shell.mjs');
    const io = { statSync: () => ({ size: 8 }), openSync: () => 1, closeSync() {},
      readSync: (fd, buf) => { buf.write('{broken\n'); return 8; } };
    const out = readResourceSources({ io, coordinationRoot: () => 'x',
      run: () => JSON.stringify({ lanes: [] }), readAgents: () => () => ({ rows: [] }), heavyQueue: () => ({ projectedWaitMinutesForNewJob: 0 }) });
    expect(out.heavy.ok).toBe(false);
  });
});
