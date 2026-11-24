import b from './ci-heal-not-a-ci-break-blocks-red-team.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

defineBreakTest(b);

it('fixPresent throws when its behavioral probe crashes', () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-heal-probe-crash-'));
  try {
    const scripts = join(root, 'scripts/conveyor');
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, 'reconcile-core.mjs'), 'throw new Error("probe crashed");');
    writeFileSync(join(scripts, 'ci-heal-escalation-mark.mjs'), '');
    expect(() => b.fixPresent(root)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
