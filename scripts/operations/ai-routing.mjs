/** Read-only inspection; the runner supplies the routing reader. */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';

export const AI_ROUTING_OP = 'ai-routing';
export function aiRoutingOperation({ collect } = {}) {
  if (typeof collect !== 'function') throw new TypeError('ai-routing needs a collect reader');
  return op(AI_ROUTING_OP, {
    input: {},
    verdictFrom: 'read',
    read: compute({ reads: [], fn: () => collect() }),
  });
}
export function finishAiRouting({ run, code, lines, json }) {
  const result = run?.verdict;
  return { code, lines: !json && result?.inputs ? [
    `settings: ${JSON.stringify(result.settings)}`,
    ...Object.entries(result.inputs).map(([role, inputs]) => `${role}: ${JSON.stringify(inputs)}`),
    `sources: ${JSON.stringify(result.sources)}`,
    `invalid: ${JSON.stringify(result.invalid)}`,
  ] : lines };
}
