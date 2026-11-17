import { expect, it } from 'vitest';
import b from './rebuild-dry-run-json-timing.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

// Always require the repaired behavior, including when the source marker is absent.
it('keeps default CLI timing diagnostics out of JSON and text stdout', async () => {
  expect(b.judge(await b.run())).toEqual([]);
});
