import { it, expect } from 'vitest';
import { readBuilderSlotSettings, BUILDER_SLOT_DEFAULTS } from '../builder-slots-settings.mjs';
import { BUILD_DISPATCH_POLICY } from '../../conveyor/build-dispatch-policy.mjs';
it('standards match unchanged planner caps', () => {
  expect(BUILDER_SLOT_DEFAULTS.maxClaude).toBe(BUILD_DISPATCH_POLICY.maxConcurrentBuilds);
  expect(BUILDER_SLOT_DEFAULTS.maxExternal).toBe(BUILD_DISPATCH_POLICY.maxConcurrentExternalBuilds);
  expect(readBuilderSlotSettings({ env: {}, platform: {}, read: () => ({}) })).toEqual({ ...BUILDER_SLOT_DEFAULTS, sources: Object.fromEntries(Object.keys(BUILDER_SLOT_DEFAULTS).map(k => [k, 'standard'])) });
});
it('resolves each validated layer and logs env provenance', () => {
  const lines = [];
  const result = readBuilderSlotSettings({ env: { WE_POLICY_CASCADE_LOG: '1', WE_BUILDER_SLOTS: 'off', WE_BUILDER_SLOTS_MAX_EXTERNAL: '7', WE_BUILDER_SLOTS_TTL_MS: '2000', WE_BUILDER_SLOTS_WAIT_MS: '0' },
    platform: { maxClaude: 2 }, read: () => ({ builderSlots: { maxClaude: 3, maxExternal: 6 } }), log: l => lines.push(l) });
  expect(result).toMatchObject({ enabled: false, maxClaude: 3, maxExternal: 7, ttlMs: 2000, waitMs: 0, sources: { enabled: 'env', maxClaude: 'tool', maxExternal: 'env' } });
  expect(lines.join()).toContain('maxExternal=7 (env)');
});
it('ignores invalid layer values and retains valid lower values', () => {
  const r = readBuilderSlotSettings({ env: { WE_BUILDER_SLOTS: 'nope', WE_BUILDER_SLOTS_MAX_CLAUDE: '-1', WE_BUILDER_SLOTS_MAX_EXTERNAL: '1.5', WE_BUILDER_SLOTS_TTL_MS: '999', WE_BUILDER_SLOTS_WAIT_MS: '' }, platform: { maxClaude: 2, enabled: false }, read: () => ({ builderSlots: { maxClaude: -2, enabled: 'yes', maxExternal: 0 } }) });
  expect(r).toMatchObject({ enabled: false, maxClaude: 2, maxExternal: 0, ttlMs: 1800000, waitMs: 600000 });
});

it('ignores oversized integer bounds', () => {
  expect(readBuilderSlotSettings({ env: { WE_BUILDER_SLOTS_MAX_CLAUDE: '999999999999999999999' }, platform: {}, read: () => ({}) }).maxClaude).toBe(1);
});

it('rejects object-shaped and unknown leaves', () => {
  const r = readBuilderSlotSettings({ env: {}, platform: { enabled: false }, read: () => ({ builderSlots: { enabled: { nested: true }, maxClaude: { nested: 9 }, unrelated: true } }) });
  expect(r.enabled).toBe(false); expect(r.maxClaude).toBe(1); expect(r.unrelated).toBeUndefined();
});
