import { expect, it, vi } from 'vitest';
import b, { fakeGh } from './drain-authorship-truncated-at-100.mjs';

it('fake-gh 101-commit live proof sees the human beyond the capped AI prefix', async () => {
  const exec = vi.fn(fakeGh);
  const report = await b.run({ exec });
  expect(exec).toHaveBeenCalledOnce();
  expect(b.judge(report)).toEqual([]);
  expect(report).toEqual({ unpagedAi: true, complete: true, count: 101, pagedAi: false, reason: null });
});
