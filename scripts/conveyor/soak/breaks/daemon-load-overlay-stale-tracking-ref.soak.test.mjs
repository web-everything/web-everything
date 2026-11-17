import { expect, it } from 'vitest';
import b from './daemon-load-overlay-stale-tracking-ref.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { gitRun } from '../../../lib/main-staleness.mjs';

defineBreakTest(b);

it('reports the real stale-tip violation with the old plain fetch', async () => {
  const report = await b.run({
    runGit(args, options) {
      const legacy = args[0] === 'fetch' ? [...args.slice(0, -1), 'lane/overlay'] : args;
      return gitRun(legacy, options);
    },
  });
  expect(report.report.result.reason).toBe('up-to-date');
  expect(report.violations.map((v) => v.invariant)).toEqual(['overlay-tip-adopted']);
  expect(b.judge(report)).toHaveLength(1);
});
