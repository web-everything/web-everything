import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import b from './drain-numbering-preflight-before-push.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(b);

it('detects the fix by executing stale clones, read failures, slug renames, post-fork main collisions and valid numbering runs', () => {
  expect(b.fixPresent(fileURLToPath(new URL('../../../../', import.meta.url)))).toBe(true);
});
