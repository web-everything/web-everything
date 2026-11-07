// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import b from './red-team-card-only-capped-scan.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);
const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const evidence = 'scripts/lib/drain-red-team-evidence.mjs';

it.each(['function cappedCardOnlyStatusHead(', 'exactHit.reason === RUN_SCAN_CAPPED.reason',
  'lookup: () => ({ ok: true, run: null, at: 0 })', 'read.netBasis?.rev !== oldHead',
  'const bounds = exactHit.settleBounds ?? {}', 'const complete = bounds.completeHeadRead({ pr, head, at })'])(
  'fix detection refuses missing guard %s', feature => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'soak-capped-fix-'));
    try {
      mkdirSync(dirname(join(sourceRoot, evidence)), { recursive: true });
      const source = readFileSync(join(ROOT, evidence), 'utf8');
      writeFileSync(join(sourceRoot, evidence), source);
      expect(b.fixPresent(sourceRoot)).toBe(true);
      writeFileSync(join(sourceRoot, evidence), source.replaceAll(feature, 'removed by fixture'));
      expect(b.fixPresent(sourceRoot)).toBe(false);
    } finally { rmSync(sourceRoot, { recursive: true, force: true }); }
  });

it('missing evidence module reports violations without crashing', async () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'soak-capped-missing-'));
  try {
    expect(b.fixPresent(sourceRoot)).toBe(false);
    expect(b.judge(await b.run({ sourceRoot }))).not.toEqual([]);
  } finally { rmSync(sourceRoot, { recursive: true, force: true }); }
});
