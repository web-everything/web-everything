import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chooseBuilder } from '../provider-capacity.mjs';
import { DEFAULT_ROUTING_POLICY } from '../dispatch-routing-policy.mjs';
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
