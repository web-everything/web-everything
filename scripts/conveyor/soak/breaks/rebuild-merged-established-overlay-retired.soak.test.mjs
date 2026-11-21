import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import b from './rebuild-merged-established-overlay-retired.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

describe('merged established-overlay behavioral fix detection', () => {
  it('fails closed when the requested source tree is unreadable', () => {
    expect(b.fixPresent(join(process.env.TMPDIR, 'missing-rebuild-source-tree'))).toBe(false);
  });
});
