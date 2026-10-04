import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FIXER_ESCALATION, validateFixerEscalation, resolveFixerEscalation, pickRung, humanAtMisses,
} from '../fixer-escalation-policy.mjs';
import { FIX_END_PREFIX } from '../ruling-ledger.mjs';
import { FIX_END_MARKER } from '../../conveyor/fix-procedure.mjs';

const ids = (policy, misses, o) => pickRung(policy, misses, o)?.id ?? null;
const claudeOnly = { available: (r) => r.provider !== 'codex' };

describe('platform default ladder', () => {
  const p = DEFAULT_FIXER_ESCALATION;
  it('is resend, stronger model (test first), cross-provider (test first), operator', () => {
    expect(p.rungs.map((r) => [r.id, r.at, r.action, r.instruction])).toEqual([
      ['resend', 1, 'dispatch', null], ['stronger-model', 2, 'dispatch', 'test-first'],
      ['cross-provider', 3, 'dispatch', 'test-first'], ['human', 4, 'needs-you', null],
    ]);
  });
  it('picks the rung by miss count', () => {
    expect(ids(p, 0)).toBeNull();
    expect([1, 2, 3, 4, 9].map((m) => ids(p, m))).toEqual(['resend', 'stronger-model', 'cross-provider', 'human', 'human']);
  });
  it('an unavailable cross-provider rung skips FORWARD to the operator, never back to a weaker fixer', () => {
    expect([1, 2, 3, 4].map((m) => ids(p, m, claudeOnly))).toEqual(['resend', 'stronger-model', 'human', 'human']);
    expect(humanAtMisses(p, claudeOnly)).toBe(3);
    expect(humanAtMisses(p)).toBe(4);
  });
  it('the fix-end marker prefix the ledger counts is the real marker', () => {
    expect(FIX_END_MARKER.startsWith(FIX_END_PREFIX)).toBe(true);
  });
});

describe('config extends the platform default', () => {
  it('no override: the default, no error', () => {
    const r = resolveFixerEscalation(null);
    expect(r.error).toBeNull();
    expect(r.policy.rungs).toHaveLength(4);
  });
  it('patches a rung by id, leaving the others as they were', () => {
    const { policy, error } = resolveFixerEscalation({ rungs: { 'stronger-model': { at: 3 }, 'cross-provider': { at: 2 } } });
    expect(error).toBeNull();
    expect(policy.rungs.map((r) => [r.id, r.at])).toEqual([['resend', 1], ['cross-provider', 2], ['stronger-model', 3], ['human', 4]]);
  });
  it('disables a rung', () => {
    const { policy } = resolveFixerEscalation({ disable: ['cross-provider'] });
    expect([1, 2, 3, 4].map((m) => ids(policy, m))).toEqual(['resend', 'stronger-model', 'stronger-model', 'human']);
  });
  it('adds a rung (it must be complete)', () => {
    const { policy, error } = resolveFixerEscalation({ rungs: { arbiter: { at: 5, action: 'needs-you' } } });
    expect(error).toBeNull();
    expect(policy.rungs.at(-1).id).toBe('arbiter');
    expect(resolveFixerEscalation({ rungs: { odd: { at: 5, action: 'dispatch' } } }).error).toMatch(/needs a provider/);
  });
  it.each([
    ['unknown key', { nonsense: 1 }, /unknown/],
    ['bad action', { rungs: { resend: { action: 'shrug' } } }, /action/],
    ['bad threshold', { rungs: { resend: { at: 0 } } }, /positive integer/],
    ['same threshold twice', { rungs: { resend: { at: 2 } } }, /same `at`/],
    ['ladder not ending at a person', { disable: ['human'] }, /ends at a person|last rung must be needs-you/],
    ['bad instruction', { rungs: { resend: { instruction: 'think-harder' } } }, /instruction/],
  ])('rejects %s and keeps the default (never half-applied)', (_, override, message) => {
    const r = resolveFixerEscalation(override);
    expect(r.error).toMatch(message);
    expect(r.policy.rungs.map((x) => x.id)).toEqual(['resend', 'stronger-model', 'cross-provider', 'human']);
  });
  it('validate: needs distinct ids and a non-empty list', () => {
    expect(() => validateFixerEscalation({ version: 1, rungs: [] })).toThrow(/non-empty/);
    expect(() => validateFixerEscalation({ version: 2, rungs: [] })).toThrow(/version/);
  });
});
