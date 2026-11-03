/**
 * @description A DEFERRED open-PR read means "owed unknown", never "nothing owed": the ci-heal pass skips the tick —
 * no timeout rerun, no dispatch, no unsupported-row rewrite that would release rows the unread PRs still owe.
 */
import { it, expect, vi } from 'vitest';
import { runReconcileCiHealDispatch } from '../ci-heal-pr-dispatch.mjs';

const FRESH = () => ({ fresh: true, behind: 0 });
const deferred = { outcome: 'deferred-low-budget', deferred: true, message: 'author lookup throttled', dispatch: [], refusals: [], notes: [], prs: 0, agents: 0 };

it('a deferred read skips the tick: no rerun, no dispatch, no unsupported-row rewrite', async () => {
  const dispatch = vi.fn(); const retryTimeout = vi.fn();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const out = await runReconcileCiHealDispatch({ checkStaleness: FRESH, reconcile: () => deferred, flushOwed: () => ({}),
    pollAttempts: () => [], flushTimeouts: async () => [], pickFreeLanes: () => [], dispatch, retryTimeout,
    unsupportedPath: '/nonexistent/unsupported.json' });
  log.mockRestore();
  expect(out.dispatched).toEqual([]);
  expect(out.refusals).toEqual([]);
  expect(out.readDeferred).toMatch(/author lookup throttled/);
  expect(dispatch).not.toHaveBeenCalled();
  expect(retryTimeout).not.toHaveBeenCalled();
});
