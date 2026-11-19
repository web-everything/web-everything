import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_ROUTING_POLICY } from '../dispatch-routing-policy.mjs';
import { createRoutingPolicyReader, resolveOperationRoute } from '../dispatch-routing-policy-io.mjs';

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
  { gateClosed: true, availability: { codex: 'operator hold' }, vetoes: [{ provider: 'codex', model: 'gpt-6.1-sol' }] },
  { availability: { codex: 'operator hold' } },
  { vetoes: [{ provider: 'codex', model: 'gpt-6.1-sol' }] },
  { disabled: ['codex'] },
  { invalidModel: true },
  { available: ['claude'] },
])('capacity selection enforces existing route checks %j and tries the next candidate', checks => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  const capacity = ['codex', 'claude'].map((provider, i) => ({ provider, known: true, health: 1,
    model: i ? 'claude-opus-5-5' : checks.invalidModel ? 'invalid-model' : 'gpt-6.1-sol',
    windows: [{ usedPercent: i ? 80 : 1, resetsAt: now + 3600000 }] }));
  const policy = structuredClone(DEFAULT_ROUTING_POLICY);
  policy.operations['fix:critical-work'] = { inherit: true, disabledProviders: checks.disabled ?? [] };
  const out = resolveOperationRoute({ operation: 'fix', taskType: 'critical-work', policy, capacity, now, env: {}, ...checks });
  expect(out.provider).toBe('claude');
  expect(out.model).toBe('claude-opus-5-5');
});
it('capacity rejection reaches the historical policy fallback when no candidate passes', () => {
  const policy = structuredClone(DEFAULT_ROUTING_POLICY);
  policy.operations['fix:critical-work'] = { inherit: true };
  policy.operations.fix = { provider: 'claude', model: 'opus', fallback: [] };
  expect(resolveOperationRoute({ operation: 'fix', taskType: 'critical-work', gateClosed: true, policy,
    env: {}, capacity: [] }).provider).toBe('claude');
});

it('capacity cannot bypass a disabled provider on the inherited parent operation', () => {
  const policy = structuredClone(DEFAULT_ROUTING_POLICY);
  policy.operations.fix = { inherit: true, disabledProviders: ['codex'] };
  policy.operations['fix:critical-work'] = { inherit: true };
  expect(() => resolveOperationRoute({ operation: 'fix', taskType: 'critical-work', policy, env: {},
    inheritedRoute: { provider: 'codex', model: 'sol', fallback: [] },
    now: 1800000000000, capacity: [{ provider: 'codex', known: true, health: 1,
      windows: [{ usedPercent: 10, resetsAt: 1800003600000 }] }] })).toThrow(/unknown tier|disabled providers/);
});
