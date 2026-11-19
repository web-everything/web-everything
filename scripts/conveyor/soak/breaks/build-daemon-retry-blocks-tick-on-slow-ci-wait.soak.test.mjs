import b from './build-daemon-retry-blocks-tick-on-slow-ci-wait.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

defineBreakTest(b);

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
it('requires the landed retry bound instead of downgrading it to expected-fail', () => {
  expect(b.fixPresent(ROOT)).toBe(true);
});

it('does not recognize a retry implementation with its child timeout removed', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'retry-bound-marker-'));
  const rel = b.fixedBy.paths[0];
  try {
    mkdirSync(dirname(join(scratch, rel)), { recursive: true });
    const src = readFileSync(join(ROOT, rel), 'utf8');
    writeFileSync(join(scratch, rel), src.replace(/timeout:\s*(?:timeoutMs|remainingMs)\b/g, 'removedTimeout: true'));
    expect(b.fixPresent(scratch)).toBe(false);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
