import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import b, { runUnattributedBuilderRecovery } from './gh-log-escape-sequences-block-ci-heal.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { breakById } from './index.mjs';
import { restoreAtParent } from '../red-green.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
defineBreakTest(b);

it('reports unattributed builder evidence without dispatch, reservation or retry-state writes (R1035)', async () => {
  const report = await runUnattributedBuilderRecovery();
  expect(report.violations).toEqual([]);
}, 60_000);

it('discovers the break and requires the fix on this tree', () => {
  expect(breakById(b.id)).toBe(b);
  expect(b.fixPresent(ROOT)).toBe(true);
});

it('fails closed on escape-coded logs while dispatching the owed bounded ci-heal', async () => {
  const report = await b.run({});
  expect(b.judge(report)).toEqual([]);
  expect(report.evidence).toEqual({ eligible: false, reason: 'log-unreadable' });
  expect(report.plan.dispatch).toEqual([expect.objectContaining({ prNumber: 6911, kind: 'ci-heal', attempts: 0,
    ciLogEvidenceReason: 'log-unreadable', timeoutRetryFallback: 'log-unreadable' })]);
  expect(report.plan.refusals).toContainEqual(expect.objectContaining({ prNumber: 6911, kind: 'timeout-retry-ineligible',
    why: expect.stringContaining('log-unreadable') }));
  expect(report.plan.refusals.some(row => row.kind === 'timeout-evidence-unknown')).toBe(false);
  expect(report.reads.filter(({ args }) => args.at(-1).endsWith('/logs'))).toEqual([
    { command: 'gh', args: ['api', 'repos/o/r/actions/jobs/1/logs'] },
  ]);
  expect(report.pauses).toEqual([]);
});

it('reports violations against the pre-fix readers restored by the soak harness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gh-log-escape-soak-'));
  // fixedBy.sha is the lane tip (scan-manifest registration); this is the commit introducing the runtime fix.
  const firstFix = '5e6cd6ce39e0584e2ede946dff440a8c2930d27f';
  const paths = ['scripts/conveyor/reconcile-pass.mjs', 'scripts/conveyor/reconcile-core.mjs'];
  try {
    mkdirSync(join(root, 'scripts/conveyor'), { recursive: true });
    // Isolate the two historical readers; unchanged dependencies resolve through the real tree.
    // Avoid copyTree(), which commits its scratch index; this replay needs no commits or network.
    for (const name of readdirSync(join(ROOT, 'scripts'))) {
      if (name !== 'conveyor') symlinkSync(join(ROOT, 'scripts', name), join(root, 'scripts', name));
    }
    for (const name of readdirSync(join(ROOT, 'scripts/conveyor'))) {
      if (!paths.includes(`scripts/conveyor/${name}`)) {
        symlinkSync(join(ROOT, 'scripts/conveyor', name), join(root, 'scripts/conveyor', name));
      }
    }
    symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'));
    // This replay reverses the CI-heal transport only; builder recovery uses the current repaired tree.
    symlinkSync(join(ROOT, 'skills-src'), join(root, 'skills-src'));
    restoreAtParent(root, [firstFix], paths, ROOT);
    expect(b.fixPresent(root)).toBe(false);
    vi.stubEnv('SOAK_TREE_ROOT', root);
    const report = await b.run({});
    expect(report.reads.some(({ args }) => args.at(-1).endsWith('/logs'))).toBe(true);
    expect(report.evidence.reason).toContain('the response contains terminal escape sequences');
    expect(b.judge(report)).toContainEqual(expect.stringContaining('log refusal is not typed log-unreadable'));
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
