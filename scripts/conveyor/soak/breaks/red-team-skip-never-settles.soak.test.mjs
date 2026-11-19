// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import b from './red-team-skip-never-settles.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const settlement = 'scripts/lib/red-team-skip-outcome.mjs';
const recovery = 'scripts/lib/review-red-team-on-skip.mjs';
const job = 'scripts/operations/review-job.mjs';

it('settlement module alone is incomplete evidence of the daemon fix', () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'soak-skip-incomplete-fix-'));
  try {
    mkdirSync(dirname(join(sourceRoot, settlement)), { recursive: true });
    writeFileSync(join(sourceRoot, settlement), readFileSync(join(ROOT, settlement)));
    expect(b.fixPresent(sourceRoot)).toBe(false);
  } finally { rmSync(sourceRoot, { recursive: true, force: true }); }
});

it.each([
  ['stored-review authority', settlement, 'const storedClear = input.storedReviewPolicyClear === true'],
  ['stored-review classification', settlement, 'const classified = storedClear ?'],
  ['default daemon settlement', recovery, 'settle = settleRedTeamSkip'],
  ['daemon settlement call', recovery, "const result = settle({ redTeam: { status: 'not-owed' }"],
  ['daemon policy authority', recovery, 'storedReviewPolicyClear: true'],
  ['job settlement call', job, 'const settled = io.settleRedTeamSkip('],
])('fix detection refuses missing %s', (_name, path, feature) => {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'soak-skip-fix-detection-'));
  try {
    for (const file of [settlement, recovery, job]) {
      mkdirSync(dirname(join(sourceRoot, file)), { recursive: true });
      writeFileSync(join(sourceRoot, file), readFileSync(join(ROOT, file)));
    }
    expect(b.fixPresent(sourceRoot)).toBe(true);
    const source = readFileSync(join(sourceRoot, path), 'utf8');
    expect(source).toContain(feature);
    writeFileSync(join(sourceRoot, path), source.replaceAll(feature, 'removed by regression fixture'));
    expect(b.fixPresent(sourceRoot)).toBe(false);
  } finally { rmSync(sourceRoot, { recursive: true, force: true }); }
});

it('pre-fix tree with missing settlement module reports violations without crashing', async () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'soak-skip-pre-fix-'));
  try {
    expect(b.fixPresent(sourceRoot)).toBe(false);
    const report = await b.run({ sourceRoot });
    expect(b.judge(report)).toEqual([
      'missing scripts/lib/red-team-skip-outcome.mjs: skipped/unpublished red teams cannot settle',
    ]);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
  }
});
