// @vitest-environment node
import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backfillAllReviewRuns, backfillOpenReviewRuns } from '../lib/review-run-index.mjs';
import { newRunRecord } from '../operations/run-record.mjs';
import { backfillDrainReviewRuns } from '../merge-ai-prs.mjs';

it.each(['reported', 'unknown', 'throwing'])('repeated drain ticks complete the full backfill with saturated %s open hints', spend => {
  const root = mkdtempSync(join(tmpdir(), 'drain-backfill-progress-'));
  try {
    const context = { contextComplete: true, prsByRepo: new Map([['o/r', [{ number: 7 }]]]) };
    const records = Array.from({ length: 101 }, (_, i) => newRunRecord({
      id: `review-pr-progress-${String(i).padStart(3, '0')}`, op: 'review-pr', input: { repo: 'o/r', pr: 7 },
    }));
    let complete = false;
    for (let tick = 0; tick < 5; tick++) {
      let openReads = 0, fullReads = 0;
      backfillDrainReviewRuns(context, { resolveDir: () => join(root, 'runs'),
        backfill: (_context, { maxParses = 50 }) => {
          openReads = maxParses; // An open pass that needs its entire allocation every tick.
          if (spend === 'throwing') throw Error('open pass unavailable after reading');
          if (spend === 'unknown') return {};
          return { complete: false, parsed: openReads };
        },
        backfillAll: options => {
          complete = backfillAllReviewRuns({ ...options,
            list: () => records.map(record => record.id), stat: () => ({ mtimeMs: 2000 }),
            read: id => { fullReads++; return records.find(record => record.id === id); },
          }).complete;
        },
      });
      expect(openReads + fullReads).toBeLessThanOrEqual(50);
    }
    expect(complete).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each(['persistence', 'listing churn', 'read warning'])('an aborted open-PR backfill leaves only the actual remainder after %s', failure => {
  const root = mkdtempSync(join(tmpdir(), 'drain-backfill-budget-'));
  try {
    const runsDir = join(root, 'runs');
    const context = { contextComplete: true, prsByRepo: new Map([['o/r', [{ number: 7 }]]]) };
    const records = Array.from({ length: 60 }, (_, i) => newRunRecord({
      id: `review-pr-budget-${String(i).padStart(2, '0')}`, op: 'review-pr', input: { repo: 'o/r', pr: 7 },
    }));
    const list = () => records.map(record => record.id);
    const stat = () => ({ mtimeMs: 2000 });
    let firstReads = 0, secondReads = 0, budget, warnings = 0;
    expect(backfillDrainReviewRuns(context, { resolveDir: () => runsDir,
      backfill: (received, options) => backfillOpenReviewRuns(received, { ...options, maxParses: 3, stat,
        list: () => failure === 'listing churn' ? (firstReads === 3 ? [] : list().slice(0, 3)) : list(),
        read: id => {
          firstReads++;
          if (firstReads === 3) {
            if (failure === 'persistence') mkdirSync(`${runsDir}-review-index.json.backfill`);
            if (failure === 'read warning') throw Error('unreadable');
          }
          return records.find(record => record.id === id);
        },
        warn: () => { if (++warnings === 1 && failure === 'read warning') throw Error('warning unavailable'); },
      }),
      backfillAll: options => {
        budget = options.maxParsesPerCall;
        return backfillAllReviewRuns({ ...options, list, stat, warn: () => {},
          read: id => { secondReads++; return records.find(record => record.id === id); },
        });
      },
    })).toBe(context);
    expect(firstReads).toBe(3);
    expect(budget).toBe(47);
    expect(secondReads).toBe(47);
    expect(firstReads + secondReads).toBe(50);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
    backfill: (_context, options) => { expect(options.maxParses).toBe(25); return { parsed }; },
    backfillAll: options => { budgets.push(options.maxParsesPerCall); } });
  run(20);
  expect(budgets).toEqual([30]);
  run(25);
  run(undefined);
  expect(budgets).toEqual([30, 25, 25]); // Exhausted or unknown open spend still leaves the reserved allocation.
  run(0);
  expect(budgets).toEqual([30, 25, 25, 50]);
  run(50); // Defensive accounting for an injected backfill that violates its allocation.
  expect(budgets).toEqual([30, 25, 25, 50]);
});
it('a throwing open-PR backfill retains the full reservation, and a throwing full backfill is soft', () => {
  const context = { contextComplete: true, prsByRepo: new Map() };
  let all = 0;
  backfillDrainReviewRuns(context, { resolveDir: () => 'runs', backfill: () => { throw Error('x'); },
    backfillAll: options => { all++; expect(options.maxParsesPerCall).toBe(25); } });
  expect(all).toBe(1);
  expect(backfillDrainReviewRuns(context, { resolveDir: () => 'runs', backfill: () => ({ parsed: 1 }),
    backfillAll: () => { throw Error('y'); } })).toBe(context);
});
it('drain backfill receives the resolved directory and local repository', () => {
  const context = { contextComplete: false };
  let received;
  expect(backfillDrainReviewRuns(context, { resolveDir: () => 'runs', localSlug: 'o/r',
    backfill: (...args) => { received = args; },
  })).toBe(context);
  expect(received).toEqual([context, { runsDir: 'runs', localSlug: 'o/r', maxParses: 25 }]);
});
