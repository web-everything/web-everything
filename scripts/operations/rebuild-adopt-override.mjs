/** R796: explicitly adopt one verified ready build; effects live in the IO shell. */
import { op } from './registry.mjs';
import { compute, effect } from './step-kinds.mjs';

export const REBUILD_ADOPT_OVERRIDE_OP = 'rebuild-adopt-override';
export const REBUILD_ADOPT_OVERRIDE_EFFECT = 'rebuild-adopt-override.run';
export const REBUILD_DAEMONS = Object.freeze(['review', 'fix', 'verify', 'build', 'drain']);

export function validateRebuildAdoptOverride(input = {}) {
  if (typeof input.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(input.sha)) {
    throw new Error('rebuild-adopt-override: --sha must be a full 40-hex sha');
  }
  const daemon = input.daemon === undefined ? 'review' : input.daemon;
  if (!REBUILD_DAEMONS.includes(daemon)) {
    throw new Error('rebuild-adopt-override: --daemon must be review|fix|verify|build|drain');
  }
  return { sha: input.sha, daemon };
}

export function rebuildAdoptOverrideOperation() {
  return op(REBUILD_ADOPT_OVERRIDE_OP, {
    input: {
      sha: 'string',
      daemon: { type: 'string', enum: [...REBUILD_DAEMONS], required: false, default: 'review' },
    },
    verdictFrom: 'plan',
    plan: compute({ reads: ['input.sha', 'input.daemon'], fn: ({ input }) => validateRebuildAdoptOverride(input) }),
    run: effect({ reads: ['verdict'], effects: ({ verdict }) => [{
      type: REBUILD_ADOPT_OVERRIDE_EFFECT, idempotent: false, payload: verdict,
    }] }),
  });
}
