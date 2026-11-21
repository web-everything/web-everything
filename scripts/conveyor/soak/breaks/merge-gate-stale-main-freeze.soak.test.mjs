import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import b from './merge-gate-stale-main-freeze.mjs';

it('stale freeze reruns once, permits review, observes green, and recovers the eleventh PR after ten API rejections', async () => {
  expect(b.judge(await b.run())).toEqual([]);
});

it('detects fix presence through stale freeze classification behaviour', () => {
  expect(b.fixPresent(fileURLToPath(new URL('../../../../', import.meta.url)))).toBe(true);
});
