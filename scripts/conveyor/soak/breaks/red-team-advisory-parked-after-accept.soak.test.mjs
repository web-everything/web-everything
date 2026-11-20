import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import scenario from './red-team-advisory-parked-after-accept.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(scenario);

it('detects the fix by exercising the real witness against persisted review runs', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  expect(scenario.fixPresent(root)).toBe(true);
}, 35_000);

it('rejects a reader that still holds the accepted head as review-unfinished', () => {
  const root = mkdtempSync(join(tmpdir(), 'soak-red-team-advisory-unfixed-'));
  try {
    const lib = join(root, 'scripts', 'lib');
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, 'drain-red-team-evidence.mjs'), `
      export function readRecoveryWitness() { return { ok: false, reason: 'review-unfinished' }; }
    `);
    expect(scenario.fixPresent(root)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 35_000);
