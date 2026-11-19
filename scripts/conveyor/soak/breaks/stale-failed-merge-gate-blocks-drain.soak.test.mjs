import { expect, it } from 'vitest';
import b from './stale-failed-merge-gate-blocks-drain.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);
it('BEFORE: skipping BLOCKED heads strands cleared stale-failed gates', async () => {
  expect(b.judge(await b.run({ updateBranches: () => [] })))
    .toContain('stale-failed gate was not repaired with two pinned branch updates');
});
