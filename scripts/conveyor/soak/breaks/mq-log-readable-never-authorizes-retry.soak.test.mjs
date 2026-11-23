import { expect, it } from 'vitest';
import b from './mq-log-readable-never-authorizes-retry.mjs';

// A regression must fail even if fixPresent reports that the fix is absent.
it(b.title, async () => {
  expect(b.judge(await b.run({}))).toEqual([]);
});
