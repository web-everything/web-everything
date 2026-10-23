/**
 * @file scripts/operations/pr-sweep.mjs
 * @description THE `pr-sweep` DECLARATION: read-only, two `compute` steps, no sinks. A leaf that imports only the
 *   registry and step kinds, so the read-only pin in `http-adapter.test.mjs` holds for it. The derivation
 *   (`assess`) and the reader (`readSweep`) are INJECTED by `./run.mjs`; they live in `./pr-sweep-core.mjs` (pure) and
 *   `./pr-sweep-io.mjs` (gh / ps / drain log reads, nothing written). See the core's header for what it folds and why.
 */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';

export const PR_SWEEP_OP = 'pr-sweep';
export const STALLED_AFTER_MINUTES_DEFAULT = 45;

export function prSweepOperation({ readSweep, assess } = {}) {
  if (typeof readSweep !== 'function') throw new TypeError('pr-sweep needs a readSweep reader');
  if (typeof assess !== 'function') throw new TypeError('pr-sweep needs an assess function');
  return op(PR_SWEEP_OP, {
    input: {
      repo: { type: 'string', required: false },
      pr: { type: 'number', required: false },
      'stalled-after': { type: 'number', required: false },
    },
    verdictFrom: 'assess',
    read: compute({ reads: ['input.repo', 'input.pr', 'input.stalled-after'], fn: ({ input }) => {
      const { 'stalled-after': stalledAfter, ...rest } = input;
      return readSweep({ ...rest, stalledAfter });
    } }),
    assess: compute({ reads: ['findings.read'], fn: ({ findings }) => assess(findings.read) }),
  });
}
