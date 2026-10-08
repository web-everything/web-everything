/**
 * @file scripts/operations/__tests__/pre-pr-check-io.test.mjs
 * @description xcbwt4r — the REAL read behind `pre-pr-check`: real git in a real clone, no injected double.
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withBareOrigin } from './helpers/real-repo.mjs';
import { createPrePrCheckReader } from '../pre-pr-check-io.mjs';
import { assessPrePrCheck } from '../pre-pr-check.mjs';
import { treeOf, mergeBaseOf, RECEIPT_FILE } from '../../lib/pre-pr-review.mjs';

describe('createPrePrCheckReader (real git)', () => {
  it('a code-only commit with no prepared card reads as gated, with the receipt commands', async () => {
    await withBareOrigin(async ({ clone, commit }) => {
      commit({ 'src/a.mjs': 'export const a = 1;\n' }, 'feat: code');
      const v = assessPrePrCheck({ checkout: clone, decision: createPrePrCheckReader()({ checkout: clone }) });
      expect(v.gated).toBe(true);
      expect(v.reasons.join(' ')).toMatch(/no prepared card/);
      expect(v.next).toContain(`converge-cli.mjs receipt --lane=${clone}`);
    });
  });

  it('a card-only commit reads as not gated', async () => {
    await withBareOrigin(async ({ clone, commit }) => {
      commit({ 'backlog/1-x.md': '---\nkind: story\n---\n# x\n' }, 'card');
      const v = assessPrePrCheck({ checkout: clone, decision: createPrePrCheckReader()({ checkout: clone }) });
      expect(v).toMatchObject({ gated: false, needsReview: false });
    });
  });

  // The receipt path, through the REAL checkPrePrReview: a receipt for this tree and base is accepted; one for an
  // older tree is not, and the helper still says a review is needed.
  const writeReceipt = (clone, receipt) => writeFileSync(join(clone, '.git', RECEIPT_FILE), JSON.stringify(receipt));

  it('a valid receipt for the head reads as gated but not needing a review', async () => {
    await withBareOrigin(async ({ clone, commit }) => {
      commit({ 'src/a.mjs': 'export const a = 1;\n' }, 'feat: code');
      writeReceipt(clone, { tree: treeOf(clone), base: mergeBaseOf({ cwd: clone }), verdict: 'land' });
      const v = assessPrePrCheck({ checkout: clone, decision: createPrePrCheckReader()({ checkout: clone }) });
      expect(v).toMatchObject({ gated: true, needsReview: false, why: 'receipt', next: '' });
    });
  });

  it('a receipt for an older tree is stale: the helper still says a review is needed', async () => {
    await withBareOrigin(async ({ clone, commit }) => {
      commit({ 'src/a.mjs': 'export const a = 1;\n' }, 'feat: code');
      writeReceipt(clone, { tree: treeOf(clone), base: mergeBaseOf({ cwd: clone }), verdict: 'land' });
      commit({ 'src/b.mjs': 'export const b = 2;\n' }, 'feat: more code');
      const v = assessPrePrCheck({ checkout: clone, decision: createPrePrCheckReader()({ checkout: clone }) });
      expect(v).toMatchObject({ gated: true, needsReview: true, why: 'receipt-stale' });
    });
  });

  it('a receipt for another base is not accepted: the helper says a review is needed (receipt-base-mismatch)', async () => {
    await withBareOrigin(async ({ clone, commit }) => {
      commit({ 'src/a.mjs': 'export const a = 1;\n' }, 'feat: code');
      writeReceipt(clone, { tree: treeOf(clone), base: '0'.repeat(40), verdict: 'land' });
      const v = assessPrePrCheck({ checkout: clone, decision: createPrePrCheckReader()({ checkout: clone }) });
      expect(v).toMatchObject({ gated: true, needsReview: true, why: 'receipt-base-mismatch' });
    });
  });
});
