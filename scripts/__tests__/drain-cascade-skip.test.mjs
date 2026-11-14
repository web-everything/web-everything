import { describe, it, expect } from 'vitest';
import { boundedPool } from '../lib/bounded-pool.mjs';
import { shouldSkipCascade } from '../lib/drain-cascade-skip.mjs';

const evidence = { headSha: 'head', labels: ['ready-to-merge', 'review:changes'] };
describe('unchangeable cascade skips', () => {
  for (const kind of ['sent-back', 'mq-same-head-failed', 'ready-not-reached']) {
    it(`does not reprocess unchanged ${kind} in the same pass`, () => {
      expect(shouldSkipCascade({ ...evidence, kind, pass: 1 }, { ...evidence, pass: 1 })).toBe(true);
    });
    it(`${kind} is retried when the head, labels or pass change`, () => {
      const previous = { ...evidence, kind, pass: 1 };
      for (const change of [{ headSha: 'new' }, { labels: ['ready-to-merge'] }, { pass: 2 }]) {
        expect(shouldSkipCascade(previous, { ...evidence, pass: 1, ...change })).toBe(false);
      }
    });
  }
  it('never skips from unreadable evidence or an unknown reason', () => {
    for (const change of [{ headSha: null }, { labels: null }, { labels: [null] }, { pass: null }]) {
      expect(shouldSkipCascade({ ...evidence, kind: 'sent-back', pass: 1 }, { ...evidence, pass: 1, ...change })).toBe(false);
    }
    expect(shouldSkipCascade({ ...evidence, kind: 'checks-pending', pass: 1 }, { ...evidence, pass: 1 })).toBe(false);
  });
  it('unchangeable skips do not enter expensive prechecks or refreshes', async () => {
    const seen = [];
    const rows = ['sent-back', 'mq-same-head-failed', 'ready-not-reached', 'checks-pending'].map(kind => ({ ...evidence, kind, pass: 1 }));
    await boundedPool(rows, 3, async row => {
      if (shouldSkipCascade(row, { ...evidence, pass: 1 })) return;
      seen.push(row.kind);
    });
    expect(seen).toEqual(['checks-pending']);
  });
  it('compares label sets regardless of order or API label shape', () => {
    expect(shouldSkipCascade({ ...evidence, kind: 'sent-back', pass: 1 }, {
      headSha: 'head', labels: [{ name: 'review:changes' }, { name: 'ready-to-merge' }], pass: 1,
    })).toBe(true);
  });
});
