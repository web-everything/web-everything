// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import b, { CORE, FIX_MARKERS } from './legacy-human-hold-grant-once.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);
const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PRE_FIX_COMMIT = '08711091e02ba848baa3010299be287e70d50151';

async function withRoot(check) {
  const root = mkdtempSync(join(tmpdir(), 'soak-legacy-human-hold-'));
  try { await check(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

it('13 legacy human-only runs release exactly once before another attempt is recorded', async () => {
  const report = await b.run();
  expect(report.decisions.legacy).toBeNull();
  expect(b.judge(report)).toEqual([]);
});

it.each(['ordinary', 'completed', 'incomplete', 'stale-code', 's2b'])('%s evidence retains the exhausted same-head hold', async name => {
  const { decisions } = await b.run();
  expect(decisions[name]).toMatchObject({ kind: 'same-head', head: 'b'.repeat(40),
    noVerdict: { exhausted: true } });
});

it.each(FIX_MARKERS)('fixPresent refuses omission of %s', async marker => {
  await withRoot(root => {
    mkdirSync(join(root, 'scripts/conveyor'), { recursive: true });
    const source = readFileSync(join(ROOT, CORE), 'utf8');
    writeFileSync(join(root, CORE), source);
    expect(b.fixPresent(root)).toBe(true);
    writeFileSync(join(root, CORE), source.replace(marker, '/* omitted safeguard */'));
    expect(b.fixPresent(root)).toBe(false);
  });
});

it('missing source fails closed with a scenario violation', async () => {
  await withRoot(async root => {
    expect(b.fixPresent(root)).toBe(false);
    expect(b.judge(await b.run({ sourceRoot: root }))).toEqual([expect.stringContaining('scenario failed:')]);
  });
});

it('pinned pre-fix source reproduces repeated grants after completed and incomplete later attempts', async context => {
  // Historical reproduction is optional in shallow/squash checkouts; the current-tree
  // completed/incomplete/stale-code scenarios above must still run there.
  const available = spawnSync('git', ['cat-file', '-e', `${PRE_FIX_COMMIT}:${CORE}`],
    { cwd: ROOT, stdio: 'ignore', timeout: 10_000 });
  if (available.error) throw available.error;
  if (available.status !== 0) {
    context.skip();
    return;
  }
  await withRoot(async root => {
    // Overlay just the changed module; all unchanged dependencies resolve from this checkout.
    for (const [dir, excluded] of [['', 'scripts'], ['scripts', 'conveyor'], ['scripts/conveyor', 'review-referral-hold.mjs']]) {
      mkdirSync(join(root, dir), { recursive: true });
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        if (entry.name === excluded || entry.name === '.git') continue;
        symlinkSync(join(ROOT, dir, entry.name), join(root, dir, entry.name), entry.isDirectory() ? 'dir' : 'file');
      }
    }
    writeFileSync(join(root, CORE), execFileSync('git', ['show', `${PRE_FIX_COMMIT}:${CORE}`],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 }));
    expect(b.fixPresent(root)).toBe(false);
    const report = await b.run({ sourceRoot: root });
    expect(b.judge(report)).toEqual([
      'completed: expected same-head hold',
      'completed: expected exhausted no-verdict budget',
      'incomplete: expected same-head hold',
      'incomplete: expected exhausted no-verdict budget',
      'stale-code: expected same-head hold',
      'stale-code: expected exhausted no-verdict budget',
    ]);
    expect(report.decisions.legacy).toBeNull();
    expect(report.decisions.s2b).toMatchObject({ kind: 'same-head' });
  });
});
