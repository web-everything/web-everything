import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import b from './mq-freeze-summary-cancelled-needs-retry.mjs';

it(b.title, async () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  expect(b.fixPresent(root)).toBe(true);
  expect(b.judge(await b.run({}))).toEqual([]);
});
