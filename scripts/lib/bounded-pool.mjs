import { mapWithConcurrency } from './drain-concurrency.mjs';

function requireBound(bound, minimum) {
  if (!Number.isSafeInteger(bound) || bound < minimum) throw new RangeError('invalid pool/budget bound');
}
/** Ordered results and a full settlement barrier, even when an individual read fails. */
export async function boundedPool(items, bound, run) {
  requireBound(bound, 1);
  const results = await mapWithConcurrency(items, bound, async (item, i) => {
    try { return { value: await run(item, i) }; }
    catch (error) { return { error }; }
  });
  const failed = results.find(result => 'error' in result);
  if (failed) throw failed.error;
  return results.map(result => result.value);
}

/** Claims happen before awaiting: duplicate keys and failed attempts still spend this pass's budget. */
export function createRefreshBudget(bound) {
  requireBound(bound, 0);
  const attempted = new Set();
  return {
    async run(key, refresh) {
      if (typeof key !== 'string' || !key) throw new TypeError('missing PR key');
      if (attempted.has(key)) return { ok: false, action: 'refresh-already-attempted' };
      if (attempted.size >= bound) return { ok: false, action: 'refresh-cap-retry-next-pass' };
      attempted.add(key);
      return refresh();
    },
  };
}
