import b from './overlay-main-sync-park-alert-pending.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

defineBreakTest(b);

it('detects the park alert fix by exercising delivery and acknowledgement in the requested checkout', () => {
  expect(b.fixPresent(fileURLToPath(new URL('../../../../', import.meta.url)))).toBe(true);
}, 90_000);

it('refuses to report the park alert fix when the requested implementation is unreadable', () => {
  const root = mkdtempSync(join(tmpdir(), 'park-alert-probe-missing-'));
  try { expect(b.fixPresent(root)).toBe(false); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
