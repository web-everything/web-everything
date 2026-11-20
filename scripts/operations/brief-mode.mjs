/** Read-only delivery brief text; settings IO is supplied by the runner. */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
import { briefModeText } from '../lib/delivery-routes.mjs';

export const BRIEF_MODE_OP = 'brief-mode';
export function briefModeOperation({ collect } = {}) {
  if (typeof collect !== 'function') throw new TypeError('brief-mode needs a collect reader');
  return op(BRIEF_MODE_OP, {
    input: { kind: 'string', 'daemon-degraded': { type: 'boolean', required: false, default: false } },
    verdictFrom: 'read',
    read: compute({ reads: ['input.kind', 'input.daemon-degraded'], fn: ({ input }) =>
      briefModeText(collect(), input.kind, { daemonDegraded: input['daemon-degraded'] }) }),
  });
}

export function finishBriefMode({ run, code, lines, json }) {
  return { code, lines: !json && typeof run?.verdict === 'string' ? run.verdict.split('\n') : lines };
}
