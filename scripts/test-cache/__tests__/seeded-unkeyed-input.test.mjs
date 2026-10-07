/**
 * @file scripts/test-cache/__tests__/seeded-unkeyed-input.test.mjs
 * @description prepare-124 S2 — the SEEDED false-skip fixture. Its outcome depends on a file that is in NO cache key:
 * the path comes from `SEEDED_UNKEYED_FILE` (an env var outside the key allowlist; not WE_-prefixed because vitest.setup.ts strips those). Unset, it passes, so the normal
 * suite is unaffected. To prove shadow mode detects a missed input: run this file once with the env var pointing at a
 * file containing `ok`, then again with the file changed to `broken` — the second run is a would-skip that fails, so
 * the shadow log must report a false-skip. A quiet log is only meaningful because this detector is proven to fire.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

describe('seeded un-keyed input (prepare-124 S2)', () => {
  it('passes unless the un-keyed file says broken', () => {
    const path = process.env.SEEDED_UNKEYED_FILE;
    const text = path && existsSync(path) ? readFileSync(path, 'utf8').trim() : 'ok';
    expect(text).not.toBe('broken');
  });
});
