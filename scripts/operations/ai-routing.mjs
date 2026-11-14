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
  return { code, lines: !json && run?.verdict?.routes
    ? run.verdict.routes.flatMap(({ role, coordinator, executors, error }) => error ? [`${role}: refused: ${error}`] : [
      `${role}: ${JSON.stringify(coordinator)}`,
      `  executors: ${JSON.stringify(executors)}`,
    ]) : lines };
}
