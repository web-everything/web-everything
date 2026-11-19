import { describe, expect, it } from 'vitest';
import { assessCapacity, resolveDeliveryCapacity } from '../delivery-capacity.mjs';
import { renderCapacityLine, renderCapacitySources, renderLegacyCapacityLine } from '../delivery-capacity-render.mjs';
import { deliveryCapacityOperation, finishDeliveryCapacity } from '../../operations/delivery-capacity.mjs';
import { parseOperationArgv } from '../../operations/cli-adapter.mjs';

// Recorded operator preferences belong in fixtures, never in product defaults.
const PLATFORM = { openPrCap: 30, idleMinPct: 15, memMinGb: 4, maxStartsPerCheck: 12,
  openPrCapMode: 'soft', softOverCapStarts: 4 };
const resolve = (platform = PLATFORM) => resolveDeliveryCapacity({ platform, env: {}, read: () => ({}), log: () => {} });
const prs = open => Array.from({ length: open }, (_, i) => ({ number: i + 1 }));
const assess = ({ open = 20, idle = 25, memGb = 8, load = 12, mode = 'soft' } = {}) => ({
  ...assessCapacity({ prs: prs(open), host: { idlePct: idle, memGb, load1: load },
    policy: resolve({ ...PLATFORM, openPrCapMode: mode }) }), mergedCount2h: 7,
});

// Pure copy of the old capacity-gate verdict branches, independent of product helpers.
function oldOracle({ open, idle, memGb, load, mode }) {
  const OPEN_MAX = 30, IDLE_MIN = 15, MEM_MIN_GB = 4, MAX_STARTS = 12, SOFT_STARTS = 4;
  const CAP_MODE = mode;
  const gateOpen = idle >= IDLE_MIN && memGb >= MEM_MIN_GB;
  let verdict, why, slots = 0;
  if (!gateOpen) {
    verdict = 'hold';
    why = `gate closed: ${idle < IDLE_MIN ? `idle ${idle}% < ${IDLE_MIN}%` : ''}${idle < IDLE_MIN && memGb < MEM_MIN_GB ? ', ' : ''}${memGb < MEM_MIN_GB ? `mem ${memGb.toFixed(1)} GB < ${MEM_MIN_GB}` : ''}`;
  } else if (open >= OPEN_MAX && CAP_MODE === 'soft') {
    verdict = 'build';
    slots = Math.min(MAX_STARTS, SOFT_STARTS);
    why = `O ${open} ≥ soft cap ${OPEN_MAX} — host gate open, START up to ${slots} new PR-producing items (soft cap, operator 2026-11-16), minus running build workers (R785)`;
  } else if (open >= OPEN_MAX) {
    verdict = 'deliver';
    why = `O ${open} ≥ cap ${OPEN_MAX}: no new builds; delivery + review/fix perf only`;
  } else {
    slots = Math.min(MAX_STARTS, CAP_MODE === 'soft' ? Math.max(OPEN_MAX - open, SOFT_STARTS) : OPEN_MAX - open);
    verdict = 'build';
    why = `open-PR cap ${OPEN_MAX} (R927) — START up to ${slots} new PR-producing items now, minus running build workers (R785), quiet hours included`;
  }
  const reducerSlot = memGb >= MEM_MIN_GB && load <= 60;
  return { verdict, slots,
    line: `O=${open} M=7 idle=${idle}% mem=${memGb.toFixed(1)}GB L=${load} → ${verdict} (${why}) · load-reducer slot ${reducerSlot ? 'open' : 'closed'} (R761)` };
}

const STATES = [
  { name: 'hard under cap', open: 20, mode: 'hard' },
  { name: 'hard at cap', open: 30, mode: 'hard' },
  { name: 'soft under cap below cap minus soft starts', open: 20 },
  { name: 'soft near cap', open: 29 },
  { name: 'soft at cap', open: 30 },
  { name: 'soft over cap', open: 35 },
  { name: 'gate closed on idle', open: 20, idle: 10 },
  { name: 'gate closed on memory', open: 20, memGb: 3 },
  { name: 'gate closed on both', open: 20, idle: 10, memGb: 3 },
  { name: 'gate boundary and reducer boundary', open: 29, idle: 15, memGb: 4, load: 60 },
  { name: 'reducer closed on load', open: 29, load: 61 },
].map(state => ({ idle: 25, memGb: 8, load: 12, mode: 'soft', ...state }));

describe('delivery capacity legacy parity', () => {
  it.each(STATES)('$name matches old verdict, slots and exact legacy text', state => {
    const expected = oldOracle(state);
    const actual = assess(state);
    expect(actual).toMatchObject({ verdict: expected.verdict, slots: expected.slots });
    expect(renderLegacyCapacityLine(actual)).toBe(expected.line);
  });

  it('operator platform values beat code defaults and retain platform provenance', () => {
    const policy = resolve();
    expect(policy.value).toMatchObject(PLATFORM);
    for (const key of Object.keys(PLATFORM)) expect(policy.sources[key]).toBe('platform');
    expect(renderCapacitySources(assess())).toBe('policy-cascade · deliveryCapacity: openPrCap=30 (platform), openPrCapMode=soft (platform), softOverCapStarts=4 (platform), maxStartsPerCheck=12 (platform), idleMinPct=15 (platform), memMinGb=4 (platform), mode=count (standard)');
  });

  it.each([
    ['openPrCapMode', 'invalid', 'hard'], ['softOverCapStarts', -1, 2],
    ['softOverCapStarts', 1.5, 2], ['loadReducerMaxLoad', -1, 60],
    ['loadReducerMaxLoad', Infinity, 60],
  ])('invalid %s falls back to code default', (key, value, expected) => {
    const policy = resolve({ [key]: value });
    expect(policy.value[key]).toBe(expected);
    expect(policy.sources[key]).toBe('standard');
  });

  it.each([
    { host: null }, { prs: null }, { fallbackReason: 'collector failed; inspect full population' },
  ])('unreadable evidence or fallbackReason holds with a reason: %j', bad => {
    const readout = assessCapacity({ policy: resolve(), prs: prs(20),
      host: { idlePct: 25, memGb: 8, load1: 12 }, ...bad });
    expect(readout).toMatchObject({ verdict: 'hold', slots: 0 });
    expect(readout.why.join(' ')).toMatch(/unreadable|collector failed/);
    expect(renderLegacyCapacityLine(readout)).toMatch(/→ hold .*unreadable|→ hold .*collector failed/);
  });

  it('soft mode leaves the units verdict unchanged', () => {
    expect(assessCapacity({ prs: prs(35), host: { idlePct: 25, memGb: 8 },
      policy: resolve({ ...PLATFORM, mode: 'units' }) })).toMatchObject({ verdict: 'deliver', slots: 0 });
  });

  it('soft starts are bounded by maxStartsPerCheck, including zero', () => {
    for (const maxStartsPerCheck of [0, 2]) {
      expect(assessCapacity({ prs: prs(35), host: { idlePct: 25, memGb: 8 },
        policy: resolve({ ...PLATFORM, maxStartsPerCheck }) }).slots).toBe(maxStartsPerCheck);
    }
  });

  it.each([null, undefined, NaN, -1, '12'])('unreadable load closes reducer slot: %j', load1 => {
    const readout = assessCapacity({ prs: [], host: { idlePct: 25, memGb: 8, load1 }, policy: resolve() });
    expect(readout.loadReducerSlot).toBe(false);
    expect(JSON.parse(JSON.stringify(readout)).loadReducerSlot).toBe(false);
  });

  it('reducer threshold is resolved from platform and does not require idle gate', () => {
    const readout = assessCapacity({ prs: [], host: { idlePct: 0, memGb: 4, load1: 61 },
      policy: resolve({ loadReducerMaxLoad: 62 }) });
    expect(readout).toMatchObject({ verdict: 'hold', loadReducerSlot: true });
  });

  it('unknown merged count renders M=?', () => {
    expect(renderLegacyCapacityLine({ ...assess(), mergedCount2h: null })).toContain(' M=? ');
  });

  it('declared legacy flag reaches finish through adapter run input; JSON stays JSON', () => {
    const verdict = assess();
    const declaration = deliveryCapacityOperation({ collect: () => verdict });
    const parsed = parseOperationArgv(declaration, ['--legacy-line']);
    expect(parsed.ok).toBe(true);
    const run = { input: parsed.input, verdict };
    const args = { run, code: 0, lines: [JSON.stringify({ verdict })] };
    expect(finishDeliveryCapacity(args, { tune: () => ({ line: 'shadow', row: {} }) }).lines)
      .toEqual([renderLegacyCapacityLine(verdict)]);
    expect(finishDeliveryCapacity({ ...args, json: true }, { tune: null }).lines).toEqual(args.lines);
    expect(finishDeliveryCapacity({ ...args, run: { verdict } }, { tune: null }).lines)
      .toEqual([renderCapacityLine(verdict), renderCapacitySources(verdict)]);
  });
});
