import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateStaleGateBranches } from '../../../lib/stale-gate-update-branch.mjs';
import { expect, it } from 'vitest';
import b from './stale-failed-merge-gate-blocks-drain.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);
it('BEFORE: skipping BLOCKED heads strands cleared stale-failed gates', async () => {
  expect(b.judge(await b.run({ updateBranches: () => [] })))
    .toContain('stale-failed gate was not repaired with two pinned branch updates');
});

it('fix presence stays true when planner behavior regresses', () => {
  const root = mkdtempSync(join(tmpdir(), 'stale-static-'));
  try {
    mkdirSync(join(root, 'scripts/lib'), { recursive: true });
    const source = readFileSync(new URL('../../../lib/stale-gate-update-branch.mjs', import.meta.url), 'utf8');
    writeFileSync(join(root, 'scripts/lib/stale-gate-update-branch.mjs'), source.replace('return { head };', 'return null;'));
    expect(b.fixPresent(root)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('missing 422 logging fails even after approval-denial logs', async () => {
  const report = await b.run({ updateBranches: args => updateStaleGateBranches({ ...args,
    log: line => { if (!line.includes('422')) args.log(line); } }) });
  expect(b.judge(report)).toContain('422 was not logged once and retained as attempted');
});
