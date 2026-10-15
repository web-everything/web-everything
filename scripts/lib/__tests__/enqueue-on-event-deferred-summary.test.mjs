import { describe, expect, it } from 'vitest';
import { summarizeFastDrain } from '../enqueue-on-event.mjs';

const num = 5338;
const deferred = () => ({
  toMerge: [{ num }],
  deferred: [{ num, item: 'ready', waitOn: ['overlap-yield:#5309'],
    overlapYield: { pr: 5309, repo: 'owner/name', files: ['file.mjs'],
      untilMs: Date.UTC(2026, 9, 14, 1, 8), windowMinutes: 10 }, headSha: 'abc' }],
  skipReasons: [{ num, kind: 'overlap-yield' }],
  enqueueOutcomes: [],
});

describe('fast drain deferred summary', () => {
  it('reports overlap yield before the planned enqueue and missing-outcome fallback', () => {
    expect(summarizeFastDrain(deferred(), num)).toBe(
      'deferred: waits on overlap-yield:#5309 until 01:08Z — enqueue not attempted');
  });
  it('preserves a confirmed enqueue outcome', () => {
    expect(summarizeFastDrain({ ...deferred(), enqueueOutcomes: [{ num, outcome: 'enqueued' }] }, num))
      .toBe('passed every drain gate — enqueued');
  });
  it('preserves the missing-outcome verdict for a PR only planned to merge', () => {
    expect(summarizeFastDrain({ toMerge: [{ num }], enqueueOutcomes: [] }, num))
      .toBe('not enqueued: no enqueue outcome recorded');
  });
  it('does not label a merged PR deferred', () => {
    expect(summarizeFastDrain({ ...deferred(), toMerge: [], merged: [{ num }] }, num))
      .toBe('passed every drain gate — enqueued');
  });
  it('joins waits without an overlap deadline and caps the summary at 200 characters', () => {
    expect(summarizeFastDrain({ deferred: [{ num, waitOn: ['first', 'second'] }] }, num))
      .toBe('deferred: waits on first, second — enqueue not attempted');
    expect(summarizeFastDrain({ deferred: [{ num, waitOn: ['x'.repeat(250)] }] }, num)).toHaveLength(200);
  });
});
