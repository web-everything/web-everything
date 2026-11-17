/** Declared operator writer; repeatable findings retain their exact text and order. */
import { op } from './registry.mjs';
import { effect } from './step-kinds.mjs';

export const RULED_WEAKENED_ADD_OP = 'ruled-weakened-add';
export const RULED_WEAKENED_ADD_EFFECT = 'ruled-weakened.append';
export function ruledWeakenedAddOperation() {
  return op(RULED_WEAKENED_ADD_OP, {
    input: { ref: 'string', sha: 'string', ruling: 'string', finding: { type: 'array', repeatable: true }, actor: 'string', quote: 'string' },
    append: effect({ reads: ['input.ref', 'input.sha', 'input.ruling', 'input.finding', 'input.actor', 'input.quote'],
      effects: ({ input: { finding, ...entry } }) => [{ type: RULED_WEAKENED_ADD_EFFECT,
        payload: { ...entry, findings: finding } }] }),
  });
}
export function finishRuledWeakenedAdd({ run, code, lines }) {
  const written = run?.effects?.find(e => e.type === RULED_WEAKENED_ADD_EFFECT && e.status === 'applied');
  return code === 0 && written ? { code, lines: [JSON.stringify(written.result)] } : { code, lines };
}
