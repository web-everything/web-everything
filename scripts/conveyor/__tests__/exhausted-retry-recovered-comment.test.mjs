// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
// Poison the transitive dependency: importing the leaf must never load the reconciler.
vi.mock('../reconcile-core.mjs', () => { throw Error('recovered renderer imported reconcile-core'); });

describe('recovered retry renderer leaf', () => {
  it('import graph never reaches reconcile-core', async () => {
    await expect(import('../exhausted-retry-recovered-comment.mjs')).resolves.toHaveProperty('buildExhaustedRetryRecoveredComment');
  });
  it.each(['ci-heal-exhausted', 'fix-loop-exhausted', 'exhaustion'])('renders byte-identical legacy output for %s', async kind => {
    const { buildExhaustedRetryRecoveredComment, EXHAUSTED_RETRY_RECOVERED_KINDS } = await import('../exhausted-retry-recovered-comment.mjs');
    const headSha = 'a'.repeat(40);
    expect(EXHAUSTED_RETRY_RECOVERED_KINDS).toContain(kind);
    expect(buildExhaustedRetryRecoveredComment({ kind, headSha })).toBe(`<!-- we:exhausted-retry-recovered -->\nthe automatic retry after ${kind} went green on aaaaaaa; the exhaustion and automatic retry budgets remain spent\nhead: ${headSha}`);
  });
});
