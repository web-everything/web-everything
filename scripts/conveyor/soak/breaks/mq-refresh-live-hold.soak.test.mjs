import { expect, it } from 'vitest';
import b from './mq-refresh-live-hold.mjs';

it(b.title, async () => {
  const report = await b.run({});
  expect(b.judge(report)).toEqual([]);
});
