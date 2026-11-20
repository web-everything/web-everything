import { it, expect } from 'vitest';
import b from './rebuild-evidence-compatibility.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);
it('consumes a null-reason result and queues changed inputs without rewriting legacy evidence', async () => {
  expect(b.judge(await b.run())).toEqual([]);
});
