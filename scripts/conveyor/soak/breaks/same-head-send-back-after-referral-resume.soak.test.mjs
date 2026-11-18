// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import b, { FIX_MARKERS } from './same-head-send-back-after-referral-resume.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const CORE = 'scripts/conveyor/reconcile-core.mjs';
// origin/main before f08bcdca79; pin the negative fixture across future merges.
const PRE_FIX_COMMIT = 'e2bed0a8c3b86ff61617d318f55efeda18ff5b21';

function withSource(check) {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'soak-same-head-source-'));
  try {
    mkdirSync(join(sourceRoot, 'scripts/conveyor'), { recursive: true });
    check(sourceRoot);
  } finally { rmSync(sourceRoot, { recursive: true, force: true }); }
}

it('fixed tree retains review:human and dispatches exactly one #6945 fixer with no refusals', async () => {
  expect(b.fixPresent(ROOT)).toBe(true);
  const report = await b.run();
  expect(report.input.labels).toContainEqual({ name: 'review:human' });
  console.log('fixed replay:', JSON.stringify(report.requested));
  expect(report.requested, JSON.stringify(report.requested)).toMatchObject({
    dispatch: [{ kind: 'fix', prNumber: 6945, headRefOid: 'b'.repeat(40) }],
    refusals: [],
  });
  expect(report.requested.dispatch).toHaveLength(1);
});

it.each(FIX_MARKERS[CORE])('fixPresent refuses an incomplete repair without %s', marker => {
  withSource(sourceRoot => {
    const source = readFileSync(join(ROOT, CORE), 'utf8');
    expect(source).toContain(marker);
    writeFileSync(join(sourceRoot, CORE), source.replaceAll(marker, '/* omitted safeguard */'));
    expect(b.fixPresent(sourceRoot)).toBe(false);
  });
});

it('fixPresent fails closed on missing and incomplete source', () => {
  withSource(sourceRoot => {
    expect(b.fixPresent(sourceRoot)).toBe(false);
    writeFileSync(join(sourceRoot, CORE), 'function sendBackAfterFixAttempt(pr) {}');
    expect(b.fixPresent(sourceRoot)).toBe(false);
  });
});

it('pinned pre-fix main reproduces the missing #6945 fixer dispatch', () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'soak-same-head-pre-fix-'));
  try {
    // Archive to a file to bound child output; all production imports follow sourceRoot.
    const tarball = join(sourceRoot, 'pre-fix.tar');
    execFileSync('git', ['archive', '-o', tarball, PRE_FIX_COMMIT, 'scripts', 'src/_data', 'schemas', 'package.json'],
      { cwd: ROOT, timeout: 60_000 });
    execFileSync('tar', ['-xf', tarball, '-C', sourceRoot], { timeout: 60_000 });
    symlinkSync(join(ROOT, 'node_modules'), join(sourceRoot, 'node_modules'), 'dir');
    expect(b.fixPresent(sourceRoot)).toBe(false);
    // Use native imports in a child, as in fix-end-rearms-review, to avoid loading the old tree through vite-node.
    const script = `import(${JSON.stringify(new URL('./same-head-send-back-after-referral-resume.mjs', import.meta.url).href)})`
      + `.then(async ({ default: replay }) => { const report = await replay.run({ sourceRoot: ${JSON.stringify(sourceRoot)} });`
      + 'console.log(JSON.stringify({ report, violations: replay.judge(report) })); });';
    const out = execFileSync(process.execPath, ['--max-old-space-size=2048', '-e', script],
      { cwd: ROOT, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    const { report, violations } = JSON.parse(out.trim().split('\n').at(-1));
    console.log('pinned pre-fix replay:', JSON.stringify(report.requested));
    expect(report.requested.dispatch).toEqual([]);
    expect(report.requested.refusals).toMatchObject([{ kind: 'already-reviewed-head' }]);
    expect(report.requested.refusals).toHaveLength(1);
    expect(violations).toEqual([
      'same-head-send-back-not-dispatched: later pinned changes must dispatch exactly one fixer without refusal',
    ]);
  } finally { rmSync(sourceRoot, { recursive: true, force: true }); }
});

it('fails closed on incomplete planner reports', () => {
  expect(b.judge({})).toHaveLength(2);
});
