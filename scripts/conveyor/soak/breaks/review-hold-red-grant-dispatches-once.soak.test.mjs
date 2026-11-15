// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import b, { CORE, HOLD, FIX_MARKERS } from './review-hold-red-grant-dispatches-once.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);
const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PRE_FIX_COMMIT = '8f63c355c41b99a4c0c18e14485dffb68036bd20';

async function withRoot(check) {
  const root = mkdtempSync(join(tmpdir(), 'soak-review-hold-red-grant-'));
  try { await check(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

it('staleGateGrant true emits exactly one review dispatch instead of review-hold-red', async () => {
  const report = await b.run();
  expect(report.decisions.granted.staleGateGrant).toBe(true);
  expect(report.decisions.granted.dispatch).toEqual([expect.objectContaining({ kind: 'review', prNumber: 6769 })]);
  expect(report.decisions.granted.refusals.map(row => row.kind)).not.toContain('review-hold-red');
  expect(b.judge(report)).toEqual([]);
});

it('an S2b run spends the grant: staleGateGrant false refuses review-hold-red with no dispatch', async () => {
  const { decisions } = await b.run();
  expect(decisions.spent.staleGateGrant).toBe(false);
  expect(decisions.spent.dispatch).toEqual([]);
  expect(decisions.spent.refusals.map(row => row.kind)).toEqual(['review-hold-red']);
});

it.each(FIX_MARKERS)('fixPresent refuses omission in %s of %s', async (path, marker) => {
  await withRoot(root => {
    mkdirSync(join(root, 'scripts/conveyor'), { recursive: true });
    for (const file of [CORE, HOLD]) writeFileSync(join(root, file), readFileSync(join(ROOT, file), 'utf8'));
    expect(b.fixPresent(root)).toBe(true);
    const source = readFileSync(join(root, path), 'utf8');
    writeFileSync(join(root, path), source.replace(marker, '/* omitted safeguard */'));
    expect(b.fixPresent(root)).toBe(false);
  });
});

it('missing source fails closed with a scenario violation', async () => {
  await withRoot(async root => {
    expect(b.fixPresent(root)).toBe(false);
    expect(b.judge(await b.run({ sourceRoot: root }))).toEqual([expect.stringContaining('scenario failed:')]);
  });
});

it('pinned pre-fix source refuses the granted review and reproduces the break', async () => {
  await withRoot(async root => {
    // Overlay both changed modules; unchanged dependencies resolve from this checkout.
    for (const [dir, excluded] of [['', ['scripts']], ['scripts', ['conveyor']],
      ['scripts/conveyor', ['reconcile-core.mjs', 'review-referral-hold.mjs']]]) {
      mkdirSync(join(root, dir), { recursive: true });
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        if (excluded.includes(entry.name) || entry.name === '.git') continue;
        symlinkSync(join(ROOT, dir, entry.name), join(root, dir, entry.name), entry.isDirectory() ? 'dir' : 'file');
      }
    }
    for (const path of [CORE, HOLD]) {
      writeFileSync(join(root, path), execFileSync('git', ['show', `${PRE_FIX_COMMIT}:${path}`],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 }));
    }
    expect(b.fixPresent(root)).toBe(false);
    const report = await b.run({ sourceRoot: root });
    expect(b.judge(report)).toEqual([
      'granted: expected staleGateGrant=true',
      'granted: expected exactly one review dispatch',
      'granted: unexpected review-hold-red refusal',
      'spent: expected staleGateGrant=false',
    ]);
    expect(report.decisions.granted.dispatch).toEqual([]);
    expect(report.decisions.granted.refusals.map(row => row.kind)).toEqual(['review-hold-red']);
    expect(report.decisions.spent.dispatch).toEqual([]);
    expect(report.decisions.spent.refusals.map(row => row.kind)).toEqual(['review-hold-red']);
  });
});
