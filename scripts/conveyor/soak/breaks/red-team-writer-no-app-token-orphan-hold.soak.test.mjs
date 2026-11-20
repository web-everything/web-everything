import b from './red-team-writer-no-app-token-orphan-hold.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('detects fix presence synchronously on the requested tree without evaluating the writer', () => {
  const root = mkdtempSync(join(tmpdir(), 'rt-writer-presence-'));
  try {
    const dir = join(root, 'scripts/lib');
    mkdirSync(dir, { recursive: true });
    const source = join(dir, 'red-team-check-run.mjs');
    writeFileSync(source, "throw Error('presence probe must not import');\nexport const env = { WE_GH_AUTH_PERSONAL_FALLBACK: 'refuse' };\n");
    expect(b.fixPresent(root)).toBe(true);
    writeFileSync(source, "throw Error('presence probe must not import');\nexport const env = {};\n");
    expect(b.fixPresent(root)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

defineBreakTest(b);
