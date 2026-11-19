import { test } from 'node:test';
import assert from 'node:assert/strict';
import b from './fast-drain-full-open-listing.mjs';

if (process.env.VITEST) {
  const { defineBreakTest } = await import('../define-break-test.mjs');
  defineBreakTest(b);
} else {
  test(`${b.id}: the real single-PR drain never lists every PR's checks`, async () => {
    assert.deepEqual(b.judge(await b.run()), []);
  });
}
