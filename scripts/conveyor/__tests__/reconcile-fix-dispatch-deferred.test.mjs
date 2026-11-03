/**
 * @description A DEFERRED open-PR read (gh low budget / slot throttle / author-lookup budget) means "owed unknown",
 * never "nothing owed": the fix-dispatch pass skips the tick — no dispatch, no refusal records — and says so.
 */
import { it, expect, vi } from 'vitest';
import { runReconcileFixDispatch } from '../reconcile-fix-dispatch.mjs';

const FRESH = () => ({ fresh: true, behind: 0 });
const deferred = { outcome: 'deferred-low-budget', deferred: true, message: 'author lookup throttled', dispatch: [], refusals: [], notes: [], prs: 0, agents: 0 };

it('a deferred read skips the tick: nothing dispatched, no scope/netScope work, readDeferred reported', () => {
  const dispatch = vi.fn(); const netScope = vi.fn(); const pickFreeLanes = vi.fn(() => []);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const out = runReconcileFixDispatch({ root: '/repo', checkStaleness: FRESH, reconcile: () => deferred,
    loadItems: () => [], listFixClaims: () => [], pickFreeLanes, dispatch, netScope });
  log.mockRestore();
  expect(out.dispatched).toEqual([]);
  expect(out.refusals).toEqual([]);
  expect(out.readDeferred).toMatch(/author lookup throttled/);
  expect(dispatch).not.toHaveBeenCalled();
  expect(netScope).not.toHaveBeenCalled();
  expect(pickFreeLanes).not.toHaveBeenCalled();
});

it('a normal (non-deferred) empty plan is unchanged: no readDeferred', () => {
  const out = runReconcileFixDispatch({ root: '/repo', checkStaleness: FRESH, reconcile: () => ({ dispatch: [], refusals: [], notes: [] }),
    loadItems: () => [], listFixClaims: () => [], pickFreeLanes: () => [], dispatch: vi.fn() });
  expect(out.readDeferred).toBeUndefined();
});
