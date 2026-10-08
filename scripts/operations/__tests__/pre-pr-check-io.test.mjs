/**
 * @file scripts/operations/__tests__/pre-pr-check-io.test.mjs
 * @description xcbwt4r — the REAL read behind `pre-pr-check`: real git in a real clone, no injected double.
 */
import { describe, it, expect } from 'vitest';
import { withBareOrigin } from './helpers/real-repo.mjs';
import { createPrePrCheckReader } from '../pre-pr-check-io.mjs';
import { assessPrePrCheck } from '../pre-pr-check.mjs';

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
});
