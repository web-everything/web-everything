// @vitest-environment node
// R1103: fixDispatchMaxConcurrent remains live: loadResourceGateSettings reads it when
// fixCap.floor is null, and decider-daemon also resolves it directly. Raise the file default to 6.
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { CAPACITY_LEAVES, operatorOverridesPath, readOperatorOverrides } from '../operator-override-reader.mjs';
import { writeOperatorOverride } from '../operator-override-store.mjs';
import { cascadePolicy, readOperatorPolicy, resolveCapacityLeaf, resolveCascade } from '../policy-cascade.mjs';
import { resolveCiHealReserve } from '../ci-heal-reserve.mjs';
import { resolveMaxConcurrentLanes } from '../lane-concurrency.mjs';
import { resolveResourceGateSettings, loadResourceGateSettings } from '../resource-gate.mjs';
import { loadRedTeamQueueFloor, applyRedTeamQueueFloor, redTeamQueueAdmitCount } from '../red-team-dispatch-queue.mjs';
import { loadAdmissionPolicy, resolveAdmissionPolicy } from '../../readiness/heavy-admission.mjs';
import { resolveDeliveryCapacity } from '../delivery-capacity.mjs';
import { resolveProviderCap, resolveDailyCap } from '../review-seat-caps.mjs';
import { resolveForgeSlots } from '../../readiness/forge-slots.mjs';
import { resolveGhCapDetailed } from '../gh-throttle.mjs';
import { ghHolderPolicy, loadGhThrottleSettings } from '../gh-throttle-holders.mjs';
import { resolveFixDispatchMaxConcurrent } from '../dispatch-throttle.mjs';

const quiet = () => {};
const gate = leaf => resolveResourceGateSettings({ env: {}, tool: { fixCap: { [leaf]: 3 } }, log: quiet }).settings.fixCap[leaf];
const queue = leaf => loadRedTeamQueueFloor({ env: {}, readFile: () => JSON.stringify({ redTeam: { queue: {
  minConcurrent: 3, minConcurrentIdlePct: 10, reviewStartsPerTickWhileIdle: 3 } } }) })[leaf];
const heavy = leaf => resolveAdmissionPolicy({ platform: { [leaf]: 3 }, env: {} }).settings[leaf];
const delivery = leaf => resolveDeliveryCapacity({ env: {}, platform: {}, read: () => ({ deliveryCapacity: { [leaf]: 3 } }) }).value[leaf];
const forge = host => resolveForgeSlots({ forgeSlots: { default: 8, hosts: { forge: 14, 'forge-b': 8 } } }, { host, env: { FORGE_EXEC_SLOTS: '3' } });
// Each row exercises the actual consumer, not a duplicate of its implementation.
const cases = [
  ['ciHeal.reserve', 0, 24, 3, () => resolveCiHealReserve({ env: { WE_CI_HEAL_RESERVE: '3' } })],
  ['lanes.maxConcurrent', 1, 48, 3, () => resolveMaxConcurrentLanes({ WE_MAX_CONCURRENT_LANES: '3' })],
  ['resourceGate.fixCap.raiseQueueOver', 0, 100, 3, () => gate('raiseQueueOver')],
  ['resourceGate.fixCap.raiseStepPerPass', 1, 24, 3, () => gate('raiseStepPerPass')],
  ['resourceGate.fixCap.raiseMaxSwapUsedPct', 0, 100, 3, () => gate('raiseMaxSwapUsedPct')],
  ['resourceGate.fixCap.raiseMaxHeavyWaitMinutes', 0, 120, 3, () => gate('raiseMaxHeavyWaitMinutes')],
  ['redTeam.queue.cap', 0, 24, 12, () => loadRedTeamQueueFloor({ env: {}, readFile: () => JSON.stringify({ redTeam: { queue: { minConcurrent: 99 } } }) }).minConcurrent],
  ['redTeam.queue.minConcurrentIdlePct', 0, 100, 10, () => queue('idlePct')],
  ['redTeam.queue.reviewStartsPerTickWhileIdle', 0, 24, 3, () => queue('reviewStartsPerTick')],
  ['heavyAdmission.cap', 1, 32, 3, () => heavy('cap')],
  ['heavyAdmission.fastSlots', 0, 16, 3, () => heavy('fastSlots')],
  ['deliveryCapacity.openPrCap', 1, 200, 3, () => delivery('openPrCap')],
  ['deliveryCapacity.maxStartsPerCheck', 0, 48, 3, () => delivery('maxStartsPerCheck')],
  ['deliveryCapacity.softOverCapStarts', 0, 24, 3, () => delivery('softOverCapStarts')],
  ['reviewSeats.codex', 0, 10000, 3, () => resolveProviderCap('codex', { WE_REVIEW_SEAT_CAP_CODEX: '3' })],
  ['reviewSeats.agy-claude', 0, 10000, 3, () => resolveProviderCap('agy-claude', { WE_REVIEW_SEAT_CAP_AGY_CLAUDE: '3' })],
  ['reviewSeats.agy-gemini', 0, 10000, 3, () => resolveProviderCap('agy-gemini', { WE_REVIEW_SEAT_CAP_AGY_GEMINI: '3' })],
  ['reviewSeats.extraSeatsDailyCap', 0, 10000, 3, () => resolveDailyCap({ WE_REVIEW_EXTRA_SEATS_DAILY_CAP: '3' })],
  ['forgeSlots.forge', 1, 128, 3, () => forge('forge')],
  ['forgeSlots.forge-b', 1, 128, 3, () => forge('forge-b')],
  ['ghThrottle.cap', 1, 50, 3, () => resolveGhCapDetailed({ WE_GH_THROTTLE_CAP: '3' }, { tool: { cap: 2 } }).cap],
  ['ghThrottle.perCallerMax', 1, 50, 3, () => loadGhThrottleSettings({ env: { WE_GH_THROTTLE_PER_CALLER_MAX: '3' }, file: {} }).value.perCallerMax],
  ['fixDispatchMaxConcurrent', 1, 16, 3, () => resolveFixDispatchMaxConcurrent({ env: { WE_FIX_DISPATCH_MAX_CONCURRENT: '3' }, file: { fixDispatchMaxConcurrent: 2 } })],
];
let file;
const seed = data => writeFileSync(file, JSON.stringify(data));
beforeEach(() => {
  file = operatorOverridesPath();
  expect(file.startsWith(join(tmpdir(), 'we-test-home-'))).toBe(true);
  mkdirSync(dirname(file), { recursive: true });
  rmSync(file, { force: true });
});
afterEach(() => rmSync(file, { force: true, recursive: true }));

describe('invalid operator evidence never relaxes capacity bounds', () => {
  const bounds = [
    ['ciHeal.reserve', 0], ['ciHeal.reserve', 20], ['lanes.maxConcurrent', 40],
    ['resourceGate.fixCap.floor', 20], ['resourceGate.fixCap.ceiling', 20],
    ['resourceGate.fixCap.raiseQueueOver', 1], ['resourceGate.fixCap.raiseQueueOver', 10],
    ['resourceGate.fixCap.raiseMinMemFreePct', 25], ['resourceGate.fixCap.raiseMinMemFreePct', 60],
    ['resourceGate.fixCap.raiseMaxSwapUsedPct', 90], ['heavyAdmission.cap', 20],
    ['redTeam.queue.minConcurrentIdlePct', 1], ['reviewConcurrency.maxLiveReviewRounds', 12],
  ];
  const failures = [
    ['corrupt store', () => writeFileSync(file, '{')],
    ['invalid store shape', () => seed([])],
    ['unreadable store', () => mkdirSync(file)],
    ['out of range', key => seed({ [key]: 1e9 })],
    ['wrong type', key => seed({ [key]: 'bad' })],
    ['forbidden key under leaf', key => seed({ [`${key}.forbidden`]: 1 })],
    ['object at numeric leaf', key => seed({ [key]: { forbidden: 1 } })],
    ['empty object at numeric leaf', key => seed({ [key]: {} })],
  ];
  it.each(bounds.flatMap(([key, lower]) => failures.map(([failure, setup]) =>
    ({ key, lower, failure, setup }))))('$key lower=$lower: $failure uses the stricter built-in/lower bound', ({ key, lower, setup }) => {
    setup(key);
    const spec = CAPACITY_LEAVES[key];
    const standard = spec.failClosedFallback;
    const expected = (spec.direction === 'cap' ? Math.min : Math.max)(lower, standard);
    expect(resolveCapacityLeaf(key, { tool: lower, envValue: lower, env: {}, log: quiet }).value).toBe(expected);
    const policy = key.split('.')[0];
    const leaf = key.slice(policy.length + 1);
    for (const nested of [false, true]) {
      const block = value => nested ? leaf.split('.').reduceRight((v, part) => ({ [part]: v }), value) : { [leaf]: value };
      const result = cascadePolicy(policy, block(lower), {
        standard: block(standard), platform: null, env: {}, log: quiet,
      });
      const at = value => nested ? leaf.split('.').reduce((v, part) => v[part], value) : value[leaf];
      expect(at(result.value)).toBe(expected);
      expect(at(result.layered)).toBe(expected);
    }
    if (key === 'ciHeal.reserve') expect(resolveCiHealReserve({ env: { WE_CI_HEAL_RESERVE: String(lower) } })).toBe(expected);
    if (key === 'lanes.maxConcurrent') expect(resolveMaxConcurrentLanes({ WE_MAX_CONCURRENT_LANES: String(lower) })).toBe(expected);
  });
  it('applies valid sibling overrides while invalid leaves close in value and layered results', () => {
    seed({ 'resourceGate.fixCap.floor.forbidden': 1, 'resourceGate.fixCap.ceiling': 24 });
    const result = cascadePolicy('resourceGate', { fixCap: { floor: 20, ceiling: 20 } }, {
      standard: { fixCap: { floor: 2, ceiling: 6 } }, platform: null, env: {}, log: quiet,
    });
    expect(result.value.fixCap).toEqual({ floor: 2, ceiling: 24, raiseQueueOver: 5,
      raiseStepPerPass: 2, raiseMaxSwapUsedPct: 60, raiseMaxHeavyWaitMinutes: 15, raiseMinMemFreePct: 40 });
    expect(result.layered.fixCap).toEqual(result.value.fixCap);
    expect(result.sources['fixCap.ceiling']).toBe('operator-db');
  });
  it.each([{ floor: 'bad' }, { floor: 25 }, { floor: {} }, { 'floor.forbidden': 1 }])('pure cascade closes invalid leaf %j and applies a valid sibling', invalid => {
    const result = resolveCascade({ standard: { fixCap: { floor: 2, ceiling: 6 } },
      tool: { fixCap: { floor: 20, ceiling: 20 } },
      operatorOverride: { fixCap: { ...invalid, ceiling: 24 } }, log: quiet });
    expect(result.value.fixCap).toEqual({ floor: 2, ceiling: 24 });
  });
  it('invalid threshold evidence preserves a stricter reader standard and its provenance', () => {
    const result = resolveCascade({ standard: { fixCap: { raiseMinMemFreePct: 60 } },
      tool: { fixCap: { raiseMinMemFreePct: 25 } },
      operatorOverride: { 'fixCap.raiseMinMemFreePct': 'bad' }, log: quiet });
    expect(result.value.fixCap.raiseMinMemFreePct).toBe(60);
    expect(result.sources['fixCap.raiseMinMemFreePct']).toBe('standard');
  });
});

describe('instant bounded capacity leaves', () => {
  it.each(cases)('%s: writer accepts endpoints and rejects oversized/wrong types', (key, min, max) => {
    for (const value of [min, max]) {
      writeOperatorOverride({ file, key, value, reason: 'R1103 regression', actor: 'test' });
      expect(readOperatorOverrides({ file }).values[key]).toBe(value);
    }
    for (const value of [min - 1, max + 1, '3', null, true, Infinity, NaN])
      expect(() => writeOperatorOverride({ file, key, value, reason: 'bounds', actor: 'test' })).toThrow();
    expect(CAPACITY_LEAVES[key].validate(max + 1)).toBe(false);
  });
  it.each(cases)('%s: consumer reads override before lower layers and rereads instantly', (key, min, max, lower, read) => {
    expect(read()).toBe(lower);
    seed({ [key]: max }); expect(read()).toBe(max);
    seed({ [key]: min }); expect(read()).toBe(min);
    rmSync(file); expect(read()).toBe(lower);
  });
  it.each(cases)('%s: invalid/unreadable evidence tightens bounds; missing/unrelated entries retain lower values', (key, min, max, lower, read) => {
    const spec = CAPACITY_LEAVES[key];
    const closed = (spec.direction === 'cap' ? Math.min : Math.max)(lower, spec.failClosedFallback);
    for (const data of [{ [key]: max + 1 }, { [key]: '3' }]) {
      seed(data); expect(read()).toBe(closed);
    }
    for (const data of [{ unknown: 1 }, {}]) {
      seed(data); expect(read()).toBe(lower);
    }
    writeFileSync(file, '{'); expect(read()).toBe(key === 'redTeam.queue.cap' ? 0 : closed);
    rmSync(file); mkdirSync(file); expect(read()).toBe(key === 'redTeam.queue.cap' ? 0 : closed);
  });
  it.each(['unknown', 'host.unknown', 'reviewConcurrency.unknown'])('drops only bad key %s; valid siblings and policies survive', bad => {
    const log = vi.fn();
    seed({ [bad]: 1, 'host.maxReviewDispatchPerTick': 8, 'reviewConcurrency.maxLiveReviewRounds': 12 });
    expect(readOperatorOverrides({ file, log }).values).toEqual({
      'host.maxReviewDispatchPerTick': 8, 'reviewConcurrency.maxLiveReviewRounds': 12 });
    expect(readOperatorPolicy('host', { file, log })).toEqual({ maxReviewDispatchPerTick: 8 });
    expect(log.mock.calls.flat().join(' ')).toContain('operator-db-invalid');
  });
  it('flattens nested host data, tolerates one invalid known leaf and refuses unsafe paths', () => {
    seed(JSON.parse('{"host":{"maxReviewDispatchPerTick":8,"unknown":1},"reviewConcurrency.maxLiveReviewRounds":99,"ciHeal.reserve":6,"__proto__":{"polluted":1}}'));
    expect(readOperatorOverrides({ file, log: quiet }).values).toEqual({ 'host.maxReviewDispatchPerTick': 8, 'ciHeal.reserve': 6 });
    expect({}.polluted).toBeUndefined();
  });
  it('gh holder policy rereads changes with the same env object', () => {
    const env = {};
    seed({ 'ghThrottle.perCallerMax': 8 }); expect(ghHolderPolicy(env).perCallerMax).toBe(8);
    seed({ 'ghThrottle.perCallerMax': 2 }); expect(ghHolderPolicy(env).perCallerMax).toBe(2);
  });
  it.each(cases)('%s: each lower layer has a finite maximum and explicit fallback', (key, min, max) => {
    const read = options => resolveCapacityLeaf(key, { standard: min, env: {}, ...options }).value;
    expect(read({ tool: max })).toBe(max);
    expect(read({ tool: max, envValue: min })).toBe(min);
    expect(read({ tool: max, envValue: max + 1 })).toBe(max);
    expect(read({ tool: max + 1, envValue: max + 1 })).toBe(min);
    seed({ [key]: max }); expect(read({ tool: min, envValue: min })).toBe(max);
  });
  it('red-team cap override reaches the actual admission count', () => {
    seed({ 'redTeam.queue.cap': 24 });
    const floor = loadRedTeamQueueFloor({ env: { WE_RED_TEAM_QUEUE_MIN_CONCURRENT: '24' } });
    const capacity = { lanes: 24, startsCeiling: 24, remainingStarts: 0, budget: { left: 24 } };
    applyRedTeamQueueFloor(capacity, { floor, cpuIdlePct: 100 });
    expect(redTeamQueueAdmitCount(capacity)).toBe(24);
  });
  it('shared cap names resolve their own full policy bounds', () => {
    seed({ 'redTeam.queue.cap': 24, 'ghThrottle.cap': 50 });
    expect(loadGhThrottleSettings({ env: {}, file: {} }).value.cap).toBe(50);
  });
  it('cascade retains a valid operator sibling when another override is invalid', () => {
    const result = resolveCascade({ standard: { openPrCap: 18, maxStartsPerCheck: 8 },
      operatorOverride: { openPrCap: 90, maxStartsPerCheck: 'bad' } });
    expect(result.value).toEqual({ openPrCap: 90, maxStartsPerCheck: 8 });
  });
  it.each([
    ['raiseMaxSwapUsedPct', 80.5], ['raiseMaxHeavyWaitMinutes', 30.5],
  ])('preserves fractional resource threshold %s', (leaf, value) => {
    seed({ [`resourceGate.fixCap.${leaf}`]: value });
    expect(gate(leaf)).toBe(value);
  });
  it.each([100.5, 101, 200])('rejects swap percentage %s in every policy layer', value => {
    const key = 'resourceGate.fixCap.raiseMaxSwapUsedPct';
    seed({ [key]: value });
    expect(readOperatorOverrides({ file, log: quiet }).values[key]).toBeUndefined();
    for (const options of [
      { tool: { fixCap: { raiseMaxSwapUsedPct: value } } },
      { platform: { fixCap: { raiseMaxSwapUsedPct: value } } },
      { env: { WE_FIX_CAP_RAISE_MAX_SWAP_USED_PCT: String(value) } },
    ]) {
      expect(resolveResourceGateSettings({ env: {}, log: quiet, ...options }).settings.fixCap.raiseMaxSwapUsedPct).toBe(60);
    }
  });
  it('loadAdmissionPolicy observes override creation, changes, corruption and removal within its cache lifetime', () => {
    const root = dirname(file);
    const platform = join(root, 'platform-preferences.json');
    writeFileSync(platform, JSON.stringify({ heavyAdmission: { cap: 4, fastSlots: 2 } }));
    const options = { env: {}, repoRoot: root, home: dirname(root) };
    const read = () => {
      const { settings } = loadAdmissionPolicy(options);
      return [settings.cap, settings.fastSlots];
    };
    expect(read()).toEqual([4, 2]);
    seed({ 'heavyAdmission.cap': 8, 'heavyAdmission.fastSlots': 4 });
    expect(read()).toEqual([8, 4]);
    seed({ 'heavyAdmission.cap': 1, 'heavyAdmission.fastSlots': 0 });
    expect(read()).toEqual([1, 0]);
    writeFileSync(file, '{');
    expect(read()).toEqual([2, 1]);
    seed({ 'heavyAdmission.cap': 6, 'heavyAdmission.fastSlots': 3 });
    expect(read()).toEqual([6, 3]);
    rmSync(file);
    expect(read()).toEqual([4, 2]);
  });
  it('provider routing keeps an operator zero disabled even when routing enables Gemini', async () => {
    const { resolveRoutingProviderCap } = await import('../review-seat-caps.mjs');
    seed({ 'reviewSeats.agy-gemini': 0 });
    expect(resolveRoutingProviderCap('agy-gemini', {}, { enabledProviders: ['agy-gemini'] })).toBe(0);
  });
  it.each(['cap', 'fastSlots'])('heavyAdmission.%s follows operator > env > file > platform on the shared pool', leaf => {
    const name = leaf === 'cap' ? 'WE_HEAVY_ADMISSION_CAP' : 'WE_HEAVY_ADMISSION_FAST_SLOTS';
    const read = env => resolveAdmissionPolicy({ env, platform: { [leaf]: 2 }, tool: { [leaf]: 3 } }).settings[leaf];
    expect(read({ [name]: '4' })).toBe(4);
    expect(read({ [name]: '999' })).toBe(3);
    expect(read({})).toBe(3);
    seed({ [`heavyAdmission.${leaf}`]: 5 }); expect(read({ [name]: '4' })).toBe(5);
    writeFileSync(file, '{'); expect(read({ [name]: '4' })).toBe(CAPACITY_LEAVES[`heavyAdmission.${leaf}`].failClosedFallback);
  });
  it('resource-gate loads the live legacy floor leaf before deriving its fallback floor', () => {
    seed({ fixDispatchMaxConcurrent: 16 });
    const options = { env: { WE_PLATFORM_PREFERENCES: join(dirname(file), 'absent.json') },
      home: dirname(file), repoRoot: dirname(file) };
    expect(loadResourceGateSettings(options).settings.fixCap.floor).toBe(16);
    seed({ fixDispatchMaxConcurrent: 16, 'resourceGate.fixCap.floor': 14 });
    expect(loadResourceGateSettings(options).settings.fixCap.floor).toBe(14);
  });
  it('ships the requested live defaults and file/env red-team cap of twelve', () => {
    expect(resolveCiHealReserve({ env: {} })).toBe(6);
    expect(resolveMaxConcurrentLanes({})).toBe(12);
    expect(resolveFixDispatchMaxConcurrent({ env: {} })).toBe(6);
    expect(loadRedTeamQueueFloor({ env: {} }).minConcurrent).toBe(12);
    expect(loadRedTeamQueueFloor({ env: { WE_RED_TEAM_QUEUE_MIN_CONCURRENT: '12' } }).minConcurrent).toBe(12);
  });
});
