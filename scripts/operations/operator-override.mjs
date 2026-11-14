/** Capacity override operations. Host IO is injected by the runner; show only invokes a reader. */
import { op } from './registry.mjs';
import { compute, effect } from './step-kinds.mjs';

export const OPERATOR_OVERRIDE_OPS = Object.freeze(['operator-override-set', 'operator-override-clear', 'operator-override-show']);
export const OPERATOR_OVERRIDE_EFFECT = 'operator-override.write';
export function operatorOverrideOperation(name, { readOverrides = () => ({ readable: true, values: {} }) } = {}) {
  if (!OPERATOR_OVERRIDE_OPS.includes(name)) throw Error(`Unknown operator override operation: ${name}`);
  if (name === 'operator-override-show') return op(name, {
    input: {}, verdictFrom: 'show', show: compute({ reads: [], fn: () => {
      const result = readOverrides();
      if (!result.readable) throw Error('operator-override: unreadable store; repair it before proceeding');
      return result;
    } }),
  });
  const clear = name === 'operator-override-clear';
  return op(name, {
    input: { key: 'string', ...(!clear ? { value: 'number' } : {}), reason: 'string', actor: 'string' },
    verdictFrom: 'plan',
    plan: compute({ reads: ['input'], fn: ({ input }) => {
      for (const key of ['reason', 'actor']) if (!input[key]?.trim()) throw Error(`--${key} must be non-empty`);
      return { ...input, clear };
    } }),
    write: effect({ reads: ['verdict'], effects: view => [{ type: OPERATOR_OVERRIDE_EFFECT,
      idempotent: true, payload: view.verdict }] }),
  });
}
