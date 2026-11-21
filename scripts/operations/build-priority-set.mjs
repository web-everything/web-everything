/** Runtime priority installation: declared inputs and reader-compatible planning. */
import { op } from './registry.mjs';
import { compute, effect } from './step-kinds.mjs';
import { resolveBuildPriority } from '../lib/build-queue.mjs';

export const BUILD_PRIORITY_SET_OP = 'build-priority-set';
export const BUILD_PRIORITY_SET_EFFECT = 'build-priority-set.install';

export function validateBuildPriorityInput(input) {
  const actor = input.actor?.trim(), reason = input.reason?.trim();
  if (!actor || !reason) throw new Error('build-priority-set: nonblank --actor and --reason required');
  if (!['only', 'lift'].includes(input.mode)) throw new Error('build-priority-set: --mode must be only|lift');
  const ttlHours = Number(input['ttl-hours']);
  if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 168) {
    throw new Error('build-priority-set: --ttl-hours must be finite, >0 and <=168; choose a TTL within that range');
  }
  const ids = typeof input.ids === 'string' ? input.ids.split(',').map(id => id.trim()) : [];
  const normalized = resolveBuildPriority({ tool: { priority: ids }, env: {} });
  if (!ids.length || ids.some(id => !/^\d+$/.test(id)) || new Set(ids).size !== ids.length
      || normalized.source !== 'tool' || normalized.ids.length !== ids.length) {
    throw new Error('build-priority-set: --ids must be nonempty, unique numeric backlog ids');
  }
  // Runtime/environment intersections compare strings, even though card filenames may be padded.
  if (ids.some(id => /^0\d/.test(id))) {
    throw new Error('build-priority-set: --ids must use numeric backlog ids without leading zeroes');
  }
  return { actor, reason, ids: normalized.ids, mode: input.mode, ttlHours };
}

export function buildPrioritySetOperation({ prepare }) {
  return op(BUILD_PRIORITY_SET_OP, {
    input: { ids: 'string', mode: 'string', 'ttl-hours': 'string', actor: 'string', reason: 'string',
      preview: { type: 'boolean', required: false, default: false } },
    verdictFrom: 'plan',
    plan: compute({ reads: ['input.ids', 'input.mode', 'input.ttl-hours', 'input.actor', 'input.reason', 'input.preview'],
      fn: view => prepare(view.input) }),
    install: effect({ reads: ['input', 'verdict'], effects: view => view.input.preview ? []
      : [{ type: BUILD_PRIORITY_SET_EFFECT, idempotent: false, payload: view.input }] }),
  });
}
