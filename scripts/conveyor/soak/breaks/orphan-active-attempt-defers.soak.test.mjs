import { expect, it, vi } from 'vitest';
import b, { replayReadDeferral } from './orphan-active-attempt-defers.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { defaultRedispatch } from '../../orphan-fix-round.mjs';
import * as fixDispatch from '../../reconcile-fix-dispatch.mjs';

defineBreakTest(b);

it('defers concurrent orphan passes, holds ambiguous launch timeouts, and retries proven prelaunch refusals', () => {
  expect(b.judge(b.run())).toEqual([]);
});

it('retries an orphan after the real dispatcher defers its author lookup', async () => {
  const dispatch = fixDispatch.runReconcileFixDispatch;
  const reconcile = vi.fn(() => ({ deferred: true, reason: 'author-lookup budget exhausted' }));
  const dispatcher = vi.spyOn(fixDispatch, 'runReconcileFixDispatch')
    .mockImplementationOnce(options => dispatch({ ...options, checkStaleness: () => ({ fresh: true }),
      fixSettings: {}, reconcile: () => options.reconcile({}) }))
    .mockReturnValueOnce({ dispatched: [{ pr: 1 }], refusals: [] });
  try {
    await replayReadDeferral(options => defaultRedispatch({ ...options, reconcile }));
    expect(reconcile).toHaveBeenCalledOnce();
    expect(dispatcher).toHaveBeenCalledTimes(2);
  } finally { dispatcher.mockRestore(); }
});
