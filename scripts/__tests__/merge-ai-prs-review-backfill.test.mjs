// @vitest-environment node
import { expect, it } from 'vitest';
import { backfillDrainReviewRuns } from '../merge-ai-prs.mjs';

it('drain context is returned unchanged when the backfill throws', () => {
  const context = { contextComplete: true, prsByRepo: new Map() };
  let calls = 0;
  expect(backfillDrainReviewRuns(context, { resolveDir: () => 'unused',
    backfill: received => { calls++; expect(received).toBe(context); throw Error('unavailable'); },
  })).toBe(context);
  expect(calls).toBe(1);
});
it('drain context survives directory resolution errors and malformed PR rows', () => {
  const context = { contextComplete: true, prsByRepo: new Map([['o/r', [null]]]) };
  expect(backfillDrainReviewRuns(context, { resolveDir: () => { throw Error('no directory'); } })).toBe(context);
  expect(backfillDrainReviewRuns(context, { resolveDir: () => 'unused' })).toBe(context);
});
it('drain backfill receives the resolved directory and local repository', () => {
  const context = { contextComplete: false };
  let received;
  expect(backfillDrainReviewRuns(context, { resolveDir: () => 'runs', localSlug: 'o/r',
    backfill: (...args) => { received = args; },
  })).toBe(context);
  expect(received).toEqual([context, { runsDir: 'runs', localSlug: 'o/r' }]);
});
