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
it('drain tick shares ONE 50-parse budget between the open-PR and the full backfill', () => {
  const context = { contextComplete: true, prsByRepo: new Map() };
  const budgets = [];
  const run = parsed => backfillDrainReviewRuns(context, { resolveDir: () => 'runs',
    backfill: () => ({ parsed }), backfillAll: options => { budgets.push(options.maxParsesPerCall); } });
  run(30);
  expect(budgets).toEqual([20]);
  run(50);
  run(undefined);
  expect(budgets).toEqual([20]); // nothing left (or spend unknown): the full backfill is not run this tick
  run(0);
  expect(budgets).toEqual([20, 50]);
});
it('a throwing open-PR backfill leaves no budget for the full backfill, and a throwing full backfill is soft', () => {
  const context = { contextComplete: true, prsByRepo: new Map() };
  let all = 0;
  backfillDrainReviewRuns(context, { resolveDir: () => 'runs', backfill: () => { throw Error('x'); },
    backfillAll: () => { all++; } });
  expect(all).toBe(0);
  expect(backfillDrainReviewRuns(context, { resolveDir: () => 'runs', backfill: () => ({ parsed: 1 }),
    backfillAll: () => { throw Error('y'); } })).toBe(context);
});
it('drain backfill receives the resolved directory and local repository', () => {
  const context = { contextComplete: false };
  let received;
  expect(backfillDrainReviewRuns(context, { resolveDir: () => 'runs', localSlug: 'o/r',
    backfill: (...args) => { received = args; },
  })).toBe(context);
  expect(received).toEqual([context, { runsDir: 'runs', localSlug: 'o/r' }]);
});
