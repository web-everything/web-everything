import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chooseBuilder, readProviderCapacity } from '../provider-capacity.mjs';
import { DEFAULT_ROUTING_POLICY, validateRoutingPolicy } from '../dispatch-routing-policy.mjs';
import { createRoutingPolicyReader, resolveOperationRoute, resolveDispatchRoute } from '../dispatch-routing-policy-io.mjs';

const dirs = [];
const key = 'review-seat:red-team';
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(caps = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-routing-policy-io-'));
  dirs.push(dir);
  const path = join(dir, 'policy.json');
  const prefsPath = join(dir, 'preferences.json');
  const env = { WE_PLATFORM_PREFERENCES_FILE: prefsPath, ...caps };
  writeFileSync(path, JSON.stringify(DEFAULT_ROUTING_POLICY));
  const log = vi.fn(), emit = vi.fn();
  const reader = createRoutingPolicyReader({ path, env, log, emit, initial: DEFAULT_ROUTING_POLICY });
  const set = overrides => writeFileSync(prefsPath, JSON.stringify({ routingOverrides: overrides }));
  return { reader, set, log, emit };
}

it('retains last good policy and applied state on an unusable live edit, then applies a valid edit', () => {
  const f = fixture();
  const original = { [key]: { provider: 'agy-claude' } };
  f.set(original);
  const good = f.reader();
  expect(good.operations[key].provider).toBe('agy-claude');
  expect(f.emit).toHaveBeenCalledTimes(1);

  // Gemini is the only remaining provider, but its default daily cap is zero.
  f.set({ 'review-seat': { provider: 'codex' }, [key]: { disabledProviders: ['codex', 'agy-claude'] } });
  expect(f.reader()).toBe(good);
  expect(f.reader()).toBe(good);
  expect(f.log).toHaveBeenCalledTimes(1);
  expect(f.log).toHaveBeenCalledWith(expect.stringMatching(/routing-policy-invalid:.*no available route/));
  expect(f.emit).toHaveBeenCalledTimes(1);

  // Returning to the last accepted edit must not emit or replace that snapshot.
  f.set(original);
  expect(f.reader()).toBe(good);
  expect(f.emit).toHaveBeenCalledTimes(1);

  f.set({ [key]: { provider: 'codex' } });
  const recovered = f.reader();
  expect(recovered).not.toBe(good);
  expect(recovered.operations[key].provider).toBe('codex');
  expect(f.emit).toHaveBeenCalledTimes(2);
  expect(f.emit).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'routing-override-applied',
    detail: expect.objectContaining({ operation: 'review-seat', taskType: 'red-team', provider: 'codex' }) }));
});

it('accepts a live disable when the reader environment gives the remaining Gemini provider capacity', () => {
  const f = fixture({ WE_REVIEW_SEAT_CAP_AGY_GEMINI: '7' });
  const good = f.reader();
  f.set({ [key]: { disabledProviders: ['codex', 'agy-claude'] } });
  const next = f.reader();
  expect(next).not.toBe(good);
  expect(next.operations[key].disabledProviders).toEqual(['codex', 'agy-claude']);
  expect(f.log).not.toHaveBeenCalled();
  expect(f.emit).toHaveBeenCalledTimes(1);
});

it.each([
  ['critical-work', 'opus'],
  ['ruling-escalation-stronger', 'sonnet'],
])('%s stays pinned when tier-qualified Codex has the best capacity score', (taskType, alias) => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  const capacity = [
    { provider: 'codex', tier: 3, model: 'gpt-6.1-sol', health: 1, known: true,
      windows: [{ usedPercent: 1, resetsAt: now + 3600000 }] },
    { provider: 'claude', account: 'claude-a', health: 1, known: true,
      windows: [{ usedPercent: 80, resetsAt: now + 120 * 3600000 }] },
  ];
  expect(chooseBuilder({ kind: 'fix', capacities: capacity, settings: { now }, fallback: null }).provider).toBe('codex');
  const options = { operation: 'fix', taskType, policy: DEFAULT_ROUTING_POLICY, capacity, now, env: {} };
  for (const observations of [capacity, [], [{ ...capacity[0], held: true }, { ...capacity[1], held: true }]]) {
    const route = resolveOperationRoute({ ...options, capacity: observations });
    expect(route).toMatchObject({ provider: 'claude', model: DEFAULT_ROUTING_POLICY.aliases.claude[alias], fallback: [] });
    expect(route.source).not.toBe('capacity-score');
    const dispatch = resolveDispatchRoute({ kind: 'fix', taskType, scopePaths: ['we:scripts/lib/critical-work.mjs'], risk: 'high' },
      { routingPolicy: DEFAULT_ROUTING_POLICY, capacity: observations, now, env: { WE_ROUTING_BUILDER: 'auto' } });
    expect(dispatch).toMatchObject({ outcome: 'routed', executed: 'claude', policyRoute: { provider: 'claude', model: DEFAULT_ROUTING_POLICY.aliases.claude[alias] } });
  }
});

it('pinned routes still refuse an unavailable Claude launcher', () => {
  expect(() => resolveOperationRoute({ operation: 'fix', taskType: 'critical-work', policy: DEFAULT_ROUTING_POLICY,
    availability: { claude: 'operator hold' } })).toThrow(/no available route/);
});

it.each([
  ['claude-alt', 'claude', 'claude-sonnet-5-5', false],
  ['claude', 'claude', 'claude-sonnet-5-5', false],
  ['codex-alt', 'codex', 'gpt-6.1-sol', false],
  ['claude-alt', 'claude', 'claude-sonnet-5-5', true],
  ['codex-alt', 'codex', 'gpt-6.1-sol', true],
])('projects capacity provider %s through its configured %s launcher with %s (emergency=%s)', (id, launcher, model, emergency) => {
  const now = Date.parse('2026-11-20T15:00:00Z');
  const provider = { id, launcher, model, tier: 3, allowedKinds: ['build'], windowModel: 'fixed',
    windows: [{ name: 'five_hour', lengthHours: 5 }], readers: [], emergencyOnly: emergency };
  const record = vi.fn();
  const dispatch = { kind: 'build', size: 3, scopePaths: ['we:scripts/example.mjs'] };
  const options = {
    env: {}, repo: { routing: { builder: 'auto', capacity: { allowUnknownEmergency: emergency } },
      providerCapacity: { providers: [provider] } },
    routingPolicy: DEFAULT_ROUTING_POLICY, now, quota: () => null, record, scorecards: [],
    capacity: [{ provider: id, health: 1, known: !emergency,
      windows: emergency ? [] : [{ name: 'five_hour', usedPercent: 10, resetsAt: now + 2 * 3600000 }] }],
  };
  const route = resolveDispatchRoute(dispatch, options);
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ provider: id, launcher, model,
    reason: emergency ? 'unknown-emergency' : 'capacity-score' }), expect.any(Object));
  expect(route).toMatchObject({ outcome: 'routed', executed: launcher, model,
    policyRoute: { provider: launcher, model } });
  expect(resolveDispatchRoute(dispatch, { ...options, availability: { [launcher]: 'operator hold' } }))
    .toMatchObject({ outcome: 'refused' });
});

it.each([false, true])('retains the eligible Claude route when capacity projects an ordinary critical fix onto Codex (explicit=%s)', explicit => {
  const now = Date.parse('2026-11-20T15:00:00Z');
  const capacity = readProviderCapacity({ env: { WE_CAPACITY_READERS: 'off' }, now,
    settings: { claudeUsageAccount: 'claude-a' }, readers: {
      codex: () => ({ at: now, used_percent: 20, resets_at: now + 3600000 }),
      claude: () => ({ at: now, seven_day: { usedPercent: 20, resetsAt: now + 120 * 3600000 } }),
    } });
  expect(chooseBuilder({ kind: 'fix', capacities: capacity, settings: { now }, fallback: null }).provider).toBe('codex');
  const dispatch = { kind: 'fix', size: 3, scopePaths: ['we:scripts/lib/critical-work.mjs'] };
  const policy = structuredClone(DEFAULT_ROUTING_POLICY);
  if (explicit) policy.operations.fix = { provider: 'claude', model: 'opus', effort: 'high', fallback: [] };
  const options = { env: {}, repo: { routing: { builder: 'auto', capacity: { claudeUsageAccount: 'claude-a' } } },
    routingPolicy: policy, capacity, now, quota: () => null, record: () => {}, scorecards: [] };
  const baseline = resolveDispatchRoute(dispatch, { ...options,
    repo: { routing: { builder: 'auto', capacity: { enabled: false } } } });
  expect(baseline).toMatchObject({ outcome: 'routed', executed: 'claude' });
  expect(resolveDispatchRoute(dispatch, options)).toMatchObject({ outcome: 'routed', executed: 'claude', model: baseline.model });
  expect(resolveDispatchRoute(dispatch, { ...options, availability: { claude: 'operator hold' } }))
    .toMatchObject({ outcome: 'refused' });
  expect(resolveDispatchRoute(dispatch, { ...options,
    capacity: capacity.map(c => c.provider === 'claude' ? { ...c, held: true } : c) }))
    .toMatchObject({ outcome: 'refused' });
  policy.operations.fix.disabledProviders = ['claude'];
  expect(resolveDispatchRoute(dispatch, options)).toMatchObject({ outcome: 'refused' });
});

it('excludes a policy-disabled Claude capacity winner before reserving Codex for audits', () => {
  const now = Date.parse('2026-11-20T15:00:00Z');
  const capacity = readProviderCapacity({ env: { WE_CAPACITY_READERS: 'off' }, now,
    settings: { claudeUsageAccount: 'claude-a' }, readers: {
      codex: () => ({ at: now, used_percent: 20, resets_at: now + 120 * 3600000 }),
      claude: () => ({ at: now, seven_day: { usedPercent: 10, resetsAt: now + 2 * 3600000 } }),
    } });
  const policy = structuredClone(DEFAULT_ROUTING_POLICY);
  policy.operations['prepare-item'].disabledProviders = ['claude'];
  validateRoutingPolicy(policy);
  const dispatch = { kind: 'prepare-item', size: 3, scopePaths: ['we:scripts/example.mjs'] };
  const record = vi.fn();
  const options = { env: {}, repo: { routing: { builder: 'auto', capacity: { claudeUsageAccount: 'claude-a' } } },
    routingPolicy: policy, capacity, now, quota: () => ({ used_percent: 20 }), record, scorecards: [] };
  expect(chooseBuilder({ kind: dispatch.kind, capacities: capacity, settings: { now }, fallback: null }).provider).toBe('claude');
  expect(resolveDispatchRoute(dispatch, { ...options,
    repo: { routing: { builder: 'auto', capacity: { enabled: false } } } }))
    .toMatchObject({ outcome: 'role', executed: 'codex' });
  expect(resolveDispatchRoute(dispatch, options)).toMatchObject({ outcome: 'role', executed: 'codex' });
  expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'codex', reason: 'capacity-score' }), expect.any(Object));
});

it.each([
  ['native Claude', 'operation', 'claude', false],
  ['Claude alias', 'operation', 'claude-alt', false],
  ['unknown emergency alias', 'operation', 'claude-alt', true],
  ['inherited operation', 'inherited', 'claude', false],
  ['scoped disable', 'scoped', 'claude', false],
  ['large prepare', 'large', 'claude', false],
  ['small prepare', 'small', 'claude', false],
  ['derived build task', 'build', 'claude', false],
  ['task type fallback', 'task', 'claude', false],
])('filters disabled capacity before selection: %s', (_name, variant, id, emergency) => {
  const now = Date.parse('2026-11-20T15:00:00Z');
  const policy = structuredClone(DEFAULT_ROUTING_POLICY);
  const dispatch = { kind: variant === 'build' ? 'build' : 'prepare-item', size: 3, scopePaths: ['we:scripts/example.mjs'] };
  let controls = policy.operations[dispatch.kind];
  if (variant === 'inherited' || variant === 'scoped') {
    policy.operations['prepare-item:prepare'] = { inherit: true };
    if (variant === 'scoped') controls = policy.operations['prepare-item:prepare'];
  }
  if (variant === 'large') { dispatch.size = 5; controls = policy.operations['prepare-decision']; }
  if (variant === 'small') { dispatch.designQuestion = false; dispatch.wellScoped = true; controls = policy.smallPrepare.route; }
  if (variant === 'build') controls = policy.operations['build:build-new-feature'];
  if (variant === 'task') {
    policy.operations['prepare-item'] = { inherit: true };
    controls = policy.taskTypes.prepare = structuredClone(DEFAULT_ROUTING_POLICY.operations['prepare-item']);
  }
  controls.disabledProviders = ['claude'];
  validateRoutingPolicy(policy);
  const providers = [
    { id, launcher: 'claude', model: 'claude-sonnet-5-5', emergencyOnly: emergency },
    { id: 'codex', launcher: 'codex', model: 'gpt-6.1-sol' },
  ].map(p => ({ ...p, tier: 3, allowedKinds: [dispatch.kind], windowModel: 'fixed', windows: [], readers: [] }));
  const capacity = providers.map(p => ({ ...p, provider: p.id, health: 1, known: !p.emergencyOnly,
    windows: p.emergencyOnly ? [] : [{ usedPercent: 10, resetsAt: now + (p.launcher === 'claude' ? 2 : 120) * 3600000 }] }));
  const record = vi.fn();
  const options = { env: {}, routingPolicy: policy, now, quota: () => ({ used_percent: 20 }), record, scorecards: [], capacity,
    repo: { routing: { builder: 'auto', capacity: { allowUnknownEmergency: true } }, providerCapacity: { providers } } };
  const route = resolveDispatchRoute(dispatch, options);
  expect(route).toMatchObject({ outcome: variant === 'build' ? 'routed' : 'role', executed: 'codex' });
  expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'codex', inputs: expect.arrayContaining([
    expect.objectContaining({ provider: id, allowed: false, eligible: false }),
  ]) }), expect.any(Object));
  expect(resolveDispatchRoute(dispatch, { ...options, capacity: capacity.map(c => c.provider === 'codex' ? { ...c, held: true } : c) }))
    .toMatchObject({ outcome: 'refused', refusal: expect.stringContaining('no eligible capacity') });
});

it.each([
  ['native Claude hold', 'claude', 'claude', false],
  ['Claude launcher hold with alias', 'claude-alt', 'claude', false],
  ['unknown emergency launcher hold', 'claude-alt', 'claude', true],
  ['Antigravity family hold', 'agy-claude', 'antigravity', false],
  ['Antigravity provider hold', 'agy-claude', 'agy-claude', false],
  ['CI-heal native hold', 'claude', 'claude', false, 'ci-heal', 'ciHealAvailability'],
])('excludes availability before capacity selection: %s', (_name, id, held, emergency, kind = 'build', holdSource = 'availability') => {
  const now = Date.parse('2026-11-20T15:00:00Z');
  const providers = [
    { id, launcher: id.startsWith('agy-') ? 'antigravity' : 'claude', model: 'claude-sonnet-5-5', emergencyOnly: emergency },
    { id: 'codex', launcher: 'codex', model: 'gpt-6.1-sol' },
  ].map(p => ({ ...p, tier: 3, allowedKinds: [kind], windowModel: 'fixed', windows: [], readers: [] }));
  const capacity = providers.map(p => ({ ...p, provider: p.id, health: 1, known: !p.emergencyOnly,
    windows: p.emergencyOnly ? [] : [{ usedPercent: p.id === 'codex' ? 20 : 10,
      resetsAt: now + (p.id === 'codex' ? 120 : 2) * 3600000 }] }));
  const record = vi.fn();
  const dispatch = { kind, size: 3, scopePaths: ['we:scripts/example.mjs'] };
  const options = { env: {}, routingPolicy: DEFAULT_ROUTING_POLICY, now, quota: () => ({ used_percent: 20 }), record,
    scorecards: [], capacity, [holdSource]: { [held]: 'operator hold' },
    repo: { routing: { builder: 'auto', capacity: { claudeUsageAccount: 'claude-a', allowUnknownEmergency: true } },
      providerCapacity: { providers } } };
  // The eligible Codex route must survive a hold on a more urgent competitor.
  expect(resolveDispatchRoute(dispatch, options)).toMatchObject({ outcome: 'routed', executed: 'codex' });
  expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'codex',
    inputs: expect.arrayContaining([expect.objectContaining({ provider: id, allowed: false, eligible: false })]) }), expect.any(Object));
  // With no remaining launcher, unknown/emergency fallbacks must not revive a held route.
  expect(resolveDispatchRoute(dispatch, { ...options, availability: { ...options.availability, codex: 'operator hold' } }))
    .toMatchObject({ outcome: 'refused', refusal: expect.stringContaining('no eligible capacity') });
});

it.each([
  ['agy-gemini', 'flash'],
  ['agy-gemini', 'gemini-3.8-flash'],
  ['antigravity', 'flash'],
  ['antigravity', 'pro'],
  ['antigravity', 'carbon'],
  ['antigravity', 'sonnet', false],
])('checks Codex availability against the resolved capacity model %s/%s', (id, model, gemini = true) => {
  const now = Date.parse('2026-11-20T15:00:00Z');
  const providers = [
    { id, launcher: 'antigravity', model },
    { id: 'claude', launcher: 'claude', model: 'claude-sonnet-5-5' },
  ].map(p => ({ ...p, tier: 3, allowedKinds: ['fix'], windowModel: 'fixed', windows: [], readers: [] }));
  const capacity = providers.map(p => ({ ...p, provider: p.id, known: true, health: 1,
    windows: [{ usedPercent: 10, resetsAt: now + (p.id === id ? 2 : 120) * 3600000 }] }));
  const record = vi.fn();
  const route = resolveDispatchRoute({ kind: 'fix', size: 3, scopePaths: ['we:scripts/example.mjs'] }, {
    env: {}, routingPolicy: DEFAULT_ROUTING_POLICY, now, capacity, availability: { codex: 'operator hold' },
    quota: () => null, record, scorecards: [], repo: { routing: { builder: 'auto' }, providerCapacity: { providers } },
  });
  const expected = gemini ? 'claude' : id;
  expect(route).toMatchObject({ outcome: 'routed', executed: expected });
  expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ provider: expected,
    inputs: expect.arrayContaining([expect.objectContaining({ provider: id, allowed: !gemini, eligible: !gemini })]) }), expect.any(Object));
});

it.each(['fix', 'ci-heal'])('%s dispatch injects settings, quota, capacity and decision persistence', kind => {
  const f = fixture();
  const now = Date.parse('2026-11-19T12:00:00Z');
  const quota = vi.fn(() => null), record = vi.fn();
  const options = { env: { WE_PLATFORM_PREFERENCES_FILE: join(dirs.at(-1), 'absent.json') },
    repo: { routing: { builder: 'auto' } }, routingPolicy: f.reader(), now, quota, record,
    scorecards: [], capacity: [{ provider: 'claude', health: 1, known: false, held: false, windows: [] }] };
  const dispatch = { kind, scopePaths: ['we:scripts/example.mjs'], size: 3 };
  expect(resolveDispatchRoute(dispatch, options)).toMatchObject({ outcome: 'routed', executed: 'claude' });
  expect(quota).toHaveBeenCalledTimes(1);
  expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'all-readers-unknown' }), expect.any(Object));

  options.capacity = [{ provider: 'codex', health: 1, known: true, held: false,
    windows: [{ name: 'weekly', usedPercent: 31, resetsAt: now + 24 * 3600000 }] }];
  expect(resolveDispatchRoute(dispatch, options)).toMatchObject({ outcome: 'routed', executed: 'codex' });
  expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'capacity-score' }), expect.any(Object));

  options.capacity[0].held = true;
  expect(resolveDispatchRoute(dispatch, options)).toMatchObject({ outcome: 'refused', refusal: expect.stringContaining('no eligible capacity') });
});

it.each(['fix', 'ci-heal', 'build'])('%s uses shipped capacity defaults and unattributed Claude after Codex rejection', kind => {
  const now = Date.parse('2026-11-20T15:00:00Z');
  for (const [used_percent, held] of [[95, false], [99, false], [20, true]]) {
    const quota = () => ({ at: now, used_percent, resets_at: now + 120 * 3600000 });
    const capacity = readProviderCapacity({ env: { WE_CAPACITY_READERS: 'off' }, now,
      readers: { codex: quota, hold: provider => provider === 'codex' && held } });
    const route = resolveDispatchRoute({ kind, size: 3, scopePaths: ['we:scripts/example.mjs'] }, {
      env: {}, repo: { routing: { builder: 'auto' } }, routingPolicy: DEFAULT_ROUTING_POLICY,
      capacity, now, quota, record: () => {}, scorecards: [],
    });
    expect(route).toMatchObject({ outcome: 'routed', executed: 'claude' });
  }
});
